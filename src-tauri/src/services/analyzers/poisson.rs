// ============================================================================
// POISSON ANALYZER
// ============================================================================
//
// Models count-based processes using Poisson distribution.
// Used for tweet count markets (e.g., "Elon Musk tweets X-Y times this week")
//
// METHODOLOGY:
// Tweet counts follow Poisson(λ) where λ = observed_rate per day
// P(weekly_count in [a,b]) = Σ Poisson(λ×7, k) for k in [a,b]
// Mid-week update: condition on observed counts for Bayesian update
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::VecDeque;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, PoissonConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

pub struct PoissonAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: PoissonConfig,
    /// Daily counts history for λ estimation
    daily_counts: VecDeque<(i64, u64)>, // (day_timestamp, count)
    /// Current week's observed count
    current_week_count: u64,
    /// Days elapsed in current week
    days_elapsed: u8,
    /// Estimated λ (rate per day)
    lambda: Option<f64>,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl PoissonAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: PoissonConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            daily_counts: VecDeque::with_capacity(90),
            current_week_count: 0,
            days_elapsed: 0,
            lambda: None,
            latest_result: None,
        }
    }

    /// Compute Poisson PMF: P(X = k) = (λ^k * e^(-λ)) / k!
    fn poisson_pmf(lambda: f64, k: u64) -> f64 {
        if lambda <= 0.0 {
            return if k == 0 { 1.0 } else { 0.0 };
        }
        
        // Use log-space for numerical stability
        let log_prob = k as f64 * lambda.ln() - lambda - Self::log_factorial(k);
        log_prob.exp()
    }

    /// Compute log(k!) using Stirling approximation for large k
    fn log_factorial(k: u64) -> f64 {
        if k <= 1 {
            return 0.0;
        }
        
        // For small k, compute exactly
        if k <= 20 {
            let mut result = 0.0;
            for i in 2..=k {
                result += (i as f64).ln();
            }
            return result;
        }
        
        // Stirling approximation for large k
        let k = k as f64;
        k * k.ln() - k + 0.5 * (2.0 * std::f64::consts::PI * k).ln()
    }

    /// Compute P(X in [lower, upper]) for Poisson(λ)
    fn poisson_range_probability(&self, lambda: f64, lower: u64, upper: u64) -> f64 {
        let mut prob = 0.0;
        for k in lower..=upper {
            prob += Self::poisson_pmf(lambda, k);
        }
        prob
    }

    /// Estimate λ from historical daily counts with exponential decay weighting
    fn estimate_lambda(&self) -> f64 {
        if self.daily_counts.is_empty() {
            return 0.0;
        }

        let mut weighted_sum = 0.0;
        let mut weight_sum = 0.0;
        let decay = self.config.decay_factor;

        for (i, (_day, count)) in self.daily_counts.iter().rev().enumerate() {
            let weight = decay.powi(i as i32);
            weighted_sum += *count as f64 * weight;
            weight_sum += weight;
        }

        if weight_sum > 0.0 {
            weighted_sum / weight_sum
        } else {
            0.0
        }
    }

    /// Mid-week Bayesian update: P(total in bucket | observed so far)
    fn conditional_bucket_probability(&self, bucket_lower: u64, bucket_upper: u64) -> f64 {
        let lambda = self.lambda.unwrap_or_else(|| self.estimate_lambda());
        
        if self.days_elapsed == 0 || lambda <= 0.0 {
            // Beginning of week: use straight Poisson
            return self.poisson_range_probability(lambda * 7.0, bucket_lower, bucket_upper);
        }

        // Compute remaining days
        let remaining_days = 7 - self.days_elapsed as u64;
        let remaining_lambda = lambda * remaining_days as f64;

        // Compute P(remaining in [bucket_lower - observed, bucket_upper - observed])
        let adjusted_lower = bucket_lower.saturating_sub(self.current_week_count);
        let adjusted_upper = bucket_upper.saturating_sub(self.current_week_count);

        if self.current_week_count > bucket_upper {
            // Already exceeded bucket
            return 0.0;
        }
        if self.current_week_count >= bucket_lower && self.current_week_count <= bucket_upper {
            // Already in bucket - need 0 to (upper - current) more
            return self.poisson_range_probability(remaining_lambda, 0, adjusted_upper);
        }

        self.poisson_range_probability(remaining_lambda, adjusted_lower, adjusted_upper)
    }
}

#[async_trait]
impl AnalyzerInstance for PoissonAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::Poisson
    }

    fn analyzer_id(&self) -> &str {
        &self.analyzer_id
    }

    fn node_id(&self) -> &str {
        &self.node_id
    }

    async fn process_event(&mut self, event: &DataEvent) -> Option<TradingSignal> {
        if event.source_id != self.node_id {
            return None;
        }

        // Process count events
        if event.metric_type != "tweet_count" && event.metric_type != "event_count" {
            return None;
        }

        let count = event.value as u64;

        // Extract day information from metadata
        let is_daily_total = event.metadata.as_ref()
            .and_then(|m| m.get("is_daily_total"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if is_daily_total {
            // Add to historical data
            self.daily_counts.push_back((event.timestamp, count));
            
            // Trim to lookback window
            while self.daily_counts.len() > self.config.lookback_days {
                self.daily_counts.pop_front();
            }

            // Update lambda estimate
            self.lambda = Some(self.estimate_lambda());
        }

        // Extract week progress info
        if let Some(metadata) = &event.metadata {
            if let Some(week_count) = metadata.get("current_week_count").and_then(|v| v.as_u64()) {
                self.current_week_count = week_count;
            }
            if let Some(days) = metadata.get("days_elapsed").and_then(|v| v.as_u64()) {
                self.days_elapsed = days as u8;
            }
        }

        let lambda = self.lambda.unwrap_or_else(|| self.estimate_lambda());
        if lambda <= 0.0 {
            return None;
        }

        // Calculate probabilities for each configured bucket
        let mut bucket_probs = Vec::new();
        for &(lower, upper) in &self.config.buckets {
            let prob = self.conditional_bucket_probability(lower, upper);
            bucket_probs.push((lower, upper, prob));
        }

        // Find best bucket (highest probability)
        let best_bucket = bucket_probs.iter()
            .max_by(|a, b| a.2.partial_cmp(&b.2).unwrap_or(std::cmp::Ordering::Equal));

        // Cache result
        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "Poisson".to_string(),
            value: lambda,
            confidence: if self.days_elapsed >= 3 { 0.8 } else { 0.5 }, // Higher confidence mid-week
            metadata: serde_json::json!({
                "lambda_per_day": lambda,
                "lambda_per_week": lambda * 7.0,
                "current_week_count": self.current_week_count,
                "days_elapsed": self.days_elapsed,
                "historical_days": self.daily_counts.len(),
                "bucket_probabilities": bucket_probs.iter()
                    .map(|(l, u, p)| serde_json::json!({"lower": l, "upper": u, "probability": p}))
                    .collect::<Vec<_>>(),
                "entity": self.config.entity_id,
            }),
            timestamp: event.timestamp,
        });

        // Check for trading signals
        // Compare model probability to market price if available
        let market_price = event.metadata.as_ref()
            .and_then(|m| m.get("market_price"))
            .and_then(|v| v.as_f64());

        if let (Some(&(lower, upper, model_prob)), Some(mp)) = (best_bucket, market_price) {
            let edge = (model_prob - mp).abs();

            // Higher threshold early in week, lower mid-week
            let adjusted_threshold = if self.days_elapsed >= 4 {
                self.config.min_edge_threshold * 0.5 // Thursday+ = lower threshold
            } else {
                self.config.min_edge_threshold
            };

            if edge > adjusted_threshold && model_prob > 0.3 {
                let side = if model_prob > mp {
                    TradeSide::Buy
                } else {
                    TradeSide::Sell
                };

                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "poisson".to_string(),
                    confidence: model_prob * (1.0 + self.days_elapsed as f64 * 0.1).min(1.5),
                    market_id: self.node_id.clone(),
                    side,
                    suggested_size: 100.0,
                    max_slippage: 0.03,
                    timestamp: event.timestamp,
                    metadata: serde_json::json!({
                        "bucket_lower": lower,
                        "bucket_upper": upper,
                        "model_probability": model_prob,
                        "market_price": mp,
                        "edge": edge,
                        "lambda": lambda,
                        "days_elapsed": self.days_elapsed,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 600000, // 10 minute TTL for tweet markets
                });
            }
        }

        None
    }

    async fn get_latest_result(&self) -> Option<AnalyzerResult> {
        self.latest_result.clone()
    }

    fn update_config(&mut self, config: JsonValue) -> Result<(), String> {
        self.config = serde_json::from_value(config)
            .map_err(|e| format!("Invalid Poisson config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.daily_counts.clear();
        self.current_week_count = 0;
        self.days_elapsed = 0;
        self.lambda = None;
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        self.daily_counts.len() >= 7 // At least 1 week of data
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "Poisson",
            "ready": self.is_ready(),
            "lambda": self.lambda,
            "historical_days": self.daily_counts.len(),
            "current_week_count": self.current_week_count,
            "days_elapsed": self.days_elapsed,
            "entity": self.config.entity_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::node::InfoSourceType;

    #[test]
    fn test_poisson_pmf() {
        // P(X=0) for λ=1 should be e^(-1) ≈ 0.368
        let p0 = PoissonAnalyzer::poisson_pmf(1.0, 0);
        assert!((p0 - 0.368).abs() < 0.01);

        // P(X=1) for λ=1 should be e^(-1) ≈ 0.368
        let p1 = PoissonAnalyzer::poisson_pmf(1.0, 1);
        assert!((p1 - 0.368).abs() < 0.01);

        // P(X=5) for λ=5 should be about 0.175
        let p5 = PoissonAnalyzer::poisson_pmf(5.0, 5);
        assert!((p5 - 0.175).abs() < 0.01);
    }

    #[test]
    fn test_log_factorial() {
        assert!((PoissonAnalyzer::log_factorial(0) - 0.0).abs() < 0.001);
        assert!((PoissonAnalyzer::log_factorial(1) - 0.0).abs() < 0.001);
        assert!((PoissonAnalyzer::log_factorial(5) - 4.787).abs() < 0.01); // ln(120)
        assert!((PoissonAnalyzer::log_factorial(10) - 15.104).abs() < 0.1); // ln(3628800)
    }

    #[tokio::test]
    async fn test_lambda_estimation() {
        let config = PoissonConfig {
            lookback_days: 7,
            decay_factor: 1.0, // No decay for testing
            buckets: vec![(200, 249), (250, 299)],
            min_edge_threshold: 0.10,
            entity_id: "test".to_string(),
        };
        let mut analyzer = PoissonAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Add 7 days of counts
        for i in 0..7 {
            analyzer.daily_counts.push_back((i, 35)); // 35 per day
        }

        let lambda = analyzer.estimate_lambda();
        assert!((lambda - 35.0).abs() < 0.1);
    }
}
