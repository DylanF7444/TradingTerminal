// ============================================================================
// ENSEMBLE PROBABILITY ANALYZER
// ============================================================================
//
// Calculates probability of temperature outcomes from weather ensemble forecasts.
// Used for Kalshi KXHIGH temperature markets and Polymarket weather contracts.
//
// METHODOLOGY:
// P(temp > X) = count(ensemble_members > X) / total_members
// With 31-member GFS ensemble: P = n/31 where n members exceed threshold
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::VecDeque;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, EnsembleProbabilityConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

pub struct EnsembleProbabilityAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: EnsembleProbabilityConfig,
    /// Latest ensemble member values
    ensemble_values: Vec<f64>,
    /// Computed probabilities per bucket
    bucket_probabilities: Vec<(f64, f64, f64)>, // (lower, upper, probability)
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl EnsembleProbabilityAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: EnsembleProbabilityConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            ensemble_values: Vec::with_capacity(31),
            bucket_probabilities: Vec::new(),
            latest_result: None,
        }
    }

    /// Calculate probability that temperature falls within a bucket
    fn calculate_bucket_probability(&self, lower: f64, upper: f64) -> f64 {
        if self.ensemble_values.is_empty() {
            return 0.0;
        }
        
        let count = self.ensemble_values.iter()
            .filter(|&&v| v >= lower && v < upper)
            .count();
        
        count as f64 / self.ensemble_values.len() as f64
    }

    /// Calculate probability that temperature exceeds threshold
    fn calculate_above_probability(&self, threshold: f64) -> f64 {
        if self.ensemble_values.is_empty() {
            return 0.0;
        }
        
        let count = self.ensemble_values.iter()
            .filter(|&&v| v > threshold)
            .count();
        
        count as f64 / self.ensemble_values.len() as f64
    }

    /// Calculate probability that temperature is below threshold
    fn calculate_below_probability(&self, threshold: f64) -> f64 {
        if self.ensemble_values.is_empty() {
            return 0.0;
        }
        
        let count = self.ensemble_values.iter()
            .filter(|&&v| v < threshold)
            .count();
        
        count as f64 / self.ensemble_values.len() as f64
    }

    /// Calculate ensemble spread (standard deviation) for confidence
    fn calculate_spread(&self) -> f64 {
        if self.ensemble_values.len() < 2 {
            return 0.0;
        }
        
        let n = self.ensemble_values.len() as f64;
        let mean: f64 = self.ensemble_values.iter().sum::<f64>() / n;
        let variance: f64 = self.ensemble_values.iter()
            .map(|v| (v - mean).powi(2))
            .sum::<f64>() / (n - 1.0);
        
        variance.sqrt()
    }
}

#[async_trait]
impl AnalyzerInstance for EnsembleProbabilityAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::EnsembleProbability
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

        // Process ensemble data - expects metric_type "ensemble_temperature"
        // with metadata containing "member_values" array
        if event.metric_type != "ensemble_temperature" {
            return None;
        }

        // Extract ensemble member values from metadata
        if let Some(metadata) = &event.metadata {
            if let Some(members) = metadata.get("member_values") {
                if let Some(arr) = members.as_array() {
                    self.ensemble_values = arr.iter()
                        .filter_map(|v| v.as_f64())
                        .collect();
                }
            }
        }

        if self.ensemble_values.len() < self.config.ensemble_size / 2 {
            return None; // Not enough members
        }

        // Calculate probabilities for configured buckets
        self.bucket_probabilities.clear();
        for &(lower, upper) in &self.config.target_buckets {
            let prob = self.calculate_bucket_probability(lower, upper);
            self.bucket_probabilities.push((lower, upper, prob));
        }

        let spread = self.calculate_spread();
        let mean: f64 = self.ensemble_values.iter().sum::<f64>() / self.ensemble_values.len() as f64;

        // Cache result
        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "EnsembleProbability".to_string(),
            value: mean,
            confidence: if spread < 1.5 { 1.0 } else if spread > 4.0 { 0.3 } else { 
                1.0 - (spread - 1.5) / 5.0 
            },
            metadata: serde_json::json!({
                "ensemble_mean": mean,
                "ensemble_spread": spread,
                "member_count": self.ensemble_values.len(),
                "bucket_probabilities": self.bucket_probabilities.iter()
                    .map(|(l, u, p)| serde_json::json!({"lower": l, "upper": u, "probability": p}))
                    .collect::<Vec<_>>(),
            }),
            timestamp: event.timestamp,
        });

        // Check for edge opportunities
        // This would compare model probability to market price if available
        // For now, emit a signal if we have high confidence and significant probability
        if spread < 2.0 {
            // High confidence from low spread
            for &(lower, upper, prob) in &self.bucket_probabilities {
                if prob > 0.6 {
                    // Strong signal - majority of ensemble in this bucket
                    return Some(TradingSignal {
                        signal_id: uuid::Uuid::new_v4().to_string(),
                        strategy: "ensemble_probability".to_string(),
                        confidence: prob,
                        market_id: self.node_id.clone(),
                        side: TradeSide::Buy, // Buy YES on high-probability bucket
                        suggested_size: 100.0 * (1.0 - spread / 4.0), // Scale by confidence
                        max_slippage: 0.02,
                        timestamp: event.timestamp,
                        metadata: serde_json::json!({
                            "bucket_lower": lower,
                            "bucket_upper": upper,
                            "model_probability": prob,
                            "ensemble_spread": spread,
                            "analyzer_id": self.analyzer_id,
                        }),
                        ttl_ms: 300000, // 5 minute TTL for weather signals
                    });
                }
            }
        }

        None
    }

    async fn get_latest_result(&self) -> Option<AnalyzerResult> {
        self.latest_result.clone()
    }

    fn update_config(&mut self, config: JsonValue) -> Result<(), String> {
        self.config = serde_json::from_value(config)
            .map_err(|e| format!("Invalid ensemble probability config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.ensemble_values.clear();
        self.bucket_probabilities.clear();
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        self.ensemble_values.len() >= self.config.ensemble_size / 2
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "EnsembleProbability",
            "ready": self.is_ready(),
            "member_count": self.ensemble_values.len(),
            "expected_members": self.config.ensemble_size,
            "bucket_count": self.bucket_probabilities.len(),
            "spread": self.calculate_spread(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::node::InfoSourceType;

    fn make_ensemble_event(source_id: &str, members: Vec<f64>, ts: i64) -> DataEvent {
        DataEvent {
            source_id: source_id.to_string(),
            source_type: InfoSourceType::Weather,
            metric_type: "ensemble_temperature".to_string(),
            value: members.iter().sum::<f64>() / members.len() as f64,
            timestamp: ts,
            metadata: Some(serde_json::json!({
                "member_values": members
            })),
        }
    }

    #[tokio::test]
    async fn test_ensemble_probability_calculation() {
        let config = EnsembleProbabilityConfig {
            ensemble_size: 10,
            temperature_unit: "fahrenheit".to_string(),
            target_buckets: vec![(75.0, 80.0), (80.0, 85.0)],
            min_edge_threshold: 0.08,
            station_codes: vec!["OKX".to_string()],
        };
        let mut analyzer = EnsembleProbabilityAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // 6 members between 75-80, 4 members between 80-85
        let members = vec![76.0, 77.0, 78.0, 79.0, 75.5, 79.5, 81.0, 82.0, 83.0, 84.0];
        analyzer.process_event(&make_ensemble_event("node-1", members, 0)).await;

        // Check bucket probabilities
        assert_eq!(analyzer.bucket_probabilities.len(), 2);
        assert!((analyzer.bucket_probabilities[0].2 - 0.6).abs() < 0.01); // 6/10 = 0.6
        assert!((analyzer.bucket_probabilities[1].2 - 0.4).abs() < 0.01); // 4/10 = 0.4
    }
}
