// ============================================================================
// CORRELATION ANALYZER
// ============================================================================
//
// Tracks correlation between the source node and connected market nodes
// using Welford's online algorithm for streaming data.
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::HashMap;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, CorrelationConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

/// Rolling statistics for one pair
#[derive(Debug, Clone)]
struct PairStats {
    count: u64,
    mean_x: f64,
    mean_y: f64,
    m2_x: f64,
    m2_y: f64,
    co_moment: f64,
}

impl PairStats {
    fn new() -> Self {
        Self {
            count: 0,
            mean_x: 0.0,
            mean_y: 0.0,
            m2_x: 0.0,
            m2_y: 0.0,
            co_moment: 0.0,
        }
    }

    /// Update with a new (x, y) pair using Welford's online algorithm
    fn update(&mut self, x: f64, y: f64) {
        self.count += 1;
        let n = self.count as f64;

        let dx = x - self.mean_x;
        self.mean_x += dx / n;
        let dx2 = x - self.mean_x;
        self.m2_x += dx * dx2;

        let dy = y - self.mean_y;
        self.mean_y += dy / n;
        let dy2 = y - self.mean_y;
        self.m2_y += dy * dy2;

        // Co-moment update
        self.co_moment += dx * dy2;
    }

    /// Calculate Pearson correlation coefficient
    fn correlation(&self) -> f64 {
        if self.count < 2 {
            return 0.0;
        }
        let var_x = self.m2_x / (self.count as f64 - 1.0);
        let var_y = self.m2_y / (self.count as f64 - 1.0);
        let denom = (var_x * var_y).sqrt();
        if denom == 0.0 {
            return 0.0;
        }
        let cov = self.co_moment / (self.count as f64 - 1.0);
        (cov / denom).clamp(-1.0, 1.0)
    }
}

pub struct CorrelationAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: CorrelationConfig,
    /// Stats per target node: target_node_id → PairStats
    pair_stats: HashMap<String, PairStats>,
    /// Latest value from the source node
    latest_source_value: Option<f64>,
    /// Latest values from target nodes
    latest_target_values: HashMap<String, f64>,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl CorrelationAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: CorrelationConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            pair_stats: HashMap::new(),
            latest_source_value: None,
            latest_target_values: HashMap::new(),
            latest_result: None,
        }
    }
}

#[async_trait]
impl AnalyzerInstance for CorrelationAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::Correlation
    }

    fn analyzer_id(&self) -> &str {
        &self.analyzer_id
    }

    fn node_id(&self) -> &str {
        &self.node_id
    }

    async fn process_event(&mut self, event: &DataEvent) -> Option<TradingSignal> {
        if event.metric_type != "price" || !event.value.is_finite() {
            return None;
        }

        // If event is from our source node, store it
        if event.source_id == self.node_id {
            self.latest_source_value = Some(event.value);
        }

        // If event is from a target node, store it
        if self.config.target_node_ids.contains(&event.source_id) {
            self.latest_target_values.insert(event.source_id.clone(), event.value);
        }

        // Try to update correlation pairs
        if let Some(source_val) = self.latest_source_value {
            for target_id in &self.config.target_node_ids {
                if let Some(&target_val) = self.latest_target_values.get(target_id) {
                    let stats = self.pair_stats
                        .entry(target_id.clone())
                        .or_insert_with(PairStats::new);
                    stats.update(source_val, target_val);
                }
            }
        }

        // Find the strongest correlation above threshold
        let mut best_correlation = 0.0f64;
        let mut best_target = String::new();

        for (target_id, stats) in &self.pair_stats {
            if stats.count >= self.config.window_size as u64 {
                let corr = stats.correlation();
                if corr.abs() > best_correlation.abs() && corr.abs() >= self.config.min_threshold {
                    best_correlation = corr;
                    best_target = target_id.clone();
                }
            }
        }

        // Cache result
        if !best_target.is_empty() {
            let result = AnalyzerResult {
                id: uuid::Uuid::new_v4().to_string(),
                analyzer_id: self.analyzer_id.clone(),
                result_type: "Correlation".to_string(),
                value: best_correlation,
                confidence: best_correlation.abs(),
                metadata: serde_json::json!({
                    "target_node_id": best_target,
                    "sample_count": self.pair_stats.get(&best_target).map(|s| s.count).unwrap_or(0),
                }),
                timestamp: event.timestamp,
            };
            self.latest_result = Some(result);

            // Emit signal if correlation is strong enough
            let side = if best_correlation > 0.0 { TradeSide::Buy } else { TradeSide::Sell };
            return Some(TradingSignal {
                signal_id: uuid::Uuid::new_v4().to_string(),
                strategy: "correlation".to_string(),
                confidence: best_correlation.abs(),
                market_id: best_target,
                side,
                suggested_size: 100.0,
                max_slippage: 0.01,
                timestamp: event.timestamp,
                metadata: serde_json::json!({
                    "correlation": best_correlation,
                    "analyzer_id": self.analyzer_id,
                }),
                ttl_ms: 10000,
            });
        }

        None
    }

    async fn get_latest_result(&self) -> Option<AnalyzerResult> {
        self.latest_result.clone()
    }

    fn update_config(&mut self, config: JsonValue) -> Result<(), String> {
        self.config = serde_json::from_value(config)
            .map_err(|e| format!("Invalid correlation config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.pair_stats.clear();
        self.latest_source_value = None;
        self.latest_target_values.clear();
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        self.pair_stats.values().any(|s| s.count >= self.config.window_size as u64)
    }

    fn status(&self) -> JsonValue {
        let correlations: HashMap<String, f64> = self.pair_stats.iter()
            .map(|(k, v)| (k.clone(), v.correlation()))
            .collect();
        serde_json::json!({
            "type": "Correlation",
            "ready": self.is_ready(),
            "pairs_tracked": self.pair_stats.len(),
            "correlations": correlations,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::node::InfoSourceType;

    fn make_event(source_id: &str, value: f64, ts: i64) -> DataEvent {
        DataEvent {
            source_id: source_id.to_string(),
            source_type: InfoSourceType::CryptoPrices,
            metric_type: "price".to_string(),
            value,
            timestamp: ts,
            metadata: None,
        }
    }

    #[tokio::test]
    async fn test_correlation_perfect_positive() {
        let config = CorrelationConfig {
            window_size: 5,
            min_threshold: 0.5,
            target_node_ids: vec!["target-1".to_string()],
            update_interval_ms: 1000,
        };
        let mut analyzer = CorrelationAnalyzer::new(
            "an-1".to_string(),
            "source-1".to_string(),
            config,
        );

        // Feed perfectly correlated data
        for i in 0..10 {
            let val = (i as f64) * 0.01 + 0.5;
            analyzer.process_event(&make_event("source-1", val, i)).await;
            analyzer.process_event(&make_event("target-1", val * 2.0, i)).await;
        }

        let result = analyzer.get_latest_result().await;
        assert!(result.is_some());
        let r = result.unwrap();
        assert!(r.value > 0.95, "Expected strong positive correlation, got {}", r.value);
    }

    #[tokio::test]
    async fn test_correlation_insufficient_data() {
        let config = CorrelationConfig {
            window_size: 100,
            min_threshold: 0.5,
            target_node_ids: vec!["target-1".to_string()],
            update_interval_ms: 1000,
        };
        let mut analyzer = CorrelationAnalyzer::new(
            "an-1".to_string(),
            "source-1".to_string(),
            config,
        );

        // Only feed 5 points (need 100)
        for i in 0..5 {
            analyzer.process_event(&make_event("source-1", 0.5 + i as f64 * 0.01, i)).await;
            analyzer.process_event(&make_event("target-1", 0.6 + i as f64 * 0.01, i)).await;
        }

        assert!(!analyzer.is_ready());
    }
}
