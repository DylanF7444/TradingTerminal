// ============================================================================
// SENTIMENT ANALYZER
// ============================================================================
//
// Processes news/social data for sentiment scoring.
// Uses keyword weighting and temporal decay for signal generation.
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::VecDeque;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, SentimentConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

/// A single sentiment data point
#[derive(Debug, Clone)]
struct SentimentPoint {
    score: f64,
    weight: f64,
    timestamp: i64,
}

pub struct SentimentAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: SentimentConfig,
    /// Recent sentiment readings
    readings: VecDeque<SentimentPoint>,
    /// Current aggregate sentiment score
    aggregate_score: f64,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl SentimentAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: SentimentConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            readings: VecDeque::with_capacity(500),
            aggregate_score: 0.0,
            latest_result: None,
        }
    }

    /// Calculate weighted aggregate sentiment with temporal decay
    fn calculate_aggregate(&self) -> f64 {
        if self.readings.is_empty() {
            return 0.0;
        }

        let latest_ts = self.readings.back().map(|r| r.timestamp).unwrap_or(0);
        let mut total_weight = 0.0;
        let mut weighted_sum = 0.0;

        for reading in &self.readings {
            // Apply temporal decay based on age
            let age = (latest_ts - reading.timestamp).max(0) as f64;
            let decay = self.config.decay_factor.powf(age / 3600.0); // Decay per hour
            let w = reading.weight * decay;
            weighted_sum += reading.score * w;
            total_weight += w;
        }

        if total_weight == 0.0 {
            0.0
        } else {
            weighted_sum / total_weight
        }
    }

    /// Check if event metadata contains any configured keywords
    fn keyword_weight(&self, event: &DataEvent) -> f64 {
        if self.config.keywords.is_empty() {
            return 1.0;
        }

        let text = event.metadata
            .as_ref()
            .and_then(|m| m.get("text"))
            .and_then(|t| t.as_str())
            .unwrap_or("");

        let text_lower = text.to_lowercase();
        let matches: usize = self.config.keywords.iter()
            .filter(|kw| text_lower.contains(&kw.to_lowercase()))
            .count();

        if matches == 0 {
            0.5 // Base weight for non-keyword content
        } else {
            1.0 + (matches as f64 * 0.5) // Boost per keyword match
        }
    }
}

#[async_trait]
impl AnalyzerInstance for SentimentAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::Sentiment
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

        // Accept sentiment metric types
        if event.metric_type != "sentiment" && event.metric_type != "score" {
            return None;
        }

        // Validate sentiment score range (-1.0 to 1.0)
        if !event.value.is_finite() || event.value < -1.0 || event.value > 1.0 {
            return None;
        }

        let weight = self.keyword_weight(event);

        self.readings.push_back(SentimentPoint {
            score: event.value,
            weight,
            timestamp: event.timestamp,
        });

        // Limit buffer size
        while self.readings.len() > 1000 {
            self.readings.pop_front();
        }

        // Wait for minimum data points
        if self.readings.len() < self.config.min_data_points {
            return None;
        }

        self.aggregate_score = self.calculate_aggregate();

        // Cache result
        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "Sentiment".to_string(),
            value: self.aggregate_score,
            confidence: self.aggregate_score.abs(),
            metadata: serde_json::json!({
                "data_points": self.readings.len(),
                "latest_score": event.value,
                "aggregate": self.aggregate_score,
            }),
            timestamp: event.timestamp,
        });

        // Generate signal if sentiment crosses threshold
        if self.aggregate_score >= self.config.positive_threshold {
            return Some(TradingSignal {
                signal_id: uuid::Uuid::new_v4().to_string(),
                strategy: "sentiment".to_string(),
                confidence: self.aggregate_score.abs().min(1.0),
                market_id: self.node_id.clone(),
                side: TradeSide::Buy,
                suggested_size: 100.0,
                max_slippage: 0.02,
                timestamp: event.timestamp,
                metadata: serde_json::json!({
                    "sentiment": self.aggregate_score,
                    "direction": "positive",
                    "data_points": self.readings.len(),
                    "analyzer_id": self.analyzer_id,
                }),
                ttl_ms: 30000, // Sentiment signals valid longer
            });
        }

        if self.aggregate_score <= self.config.negative_threshold {
            return Some(TradingSignal {
                signal_id: uuid::Uuid::new_v4().to_string(),
                strategy: "sentiment".to_string(),
                confidence: self.aggregate_score.abs().min(1.0),
                market_id: self.node_id.clone(),
                side: TradeSide::Sell,
                suggested_size: 100.0,
                max_slippage: 0.02,
                timestamp: event.timestamp,
                metadata: serde_json::json!({
                    "sentiment": self.aggregate_score,
                    "direction": "negative",
                    "data_points": self.readings.len(),
                    "analyzer_id": self.analyzer_id,
                }),
                ttl_ms: 30000,
            });
        }

        None
    }

    async fn get_latest_result(&self) -> Option<AnalyzerResult> {
        self.latest_result.clone()
    }

    fn update_config(&mut self, config: JsonValue) -> Result<(), String> {
        self.config = serde_json::from_value(config)
            .map_err(|e| format!("Invalid sentiment config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.readings.clear();
        self.aggregate_score = 0.0;
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        self.readings.len() >= self.config.min_data_points
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "Sentiment",
            "ready": self.is_ready(),
            "data_points": self.readings.len(),
            "aggregate_score": self.aggregate_score,
            "required_points": self.config.min_data_points,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::node::InfoSourceType;

    fn make_sentiment_event(source_id: &str, value: f64, ts: i64) -> DataEvent {
        DataEvent {
            source_id: source_id.to_string(),
            source_type: InfoSourceType::NewsSource,
            metric_type: "sentiment".to_string(),
            value,
            timestamp: ts,
            metadata: Some(serde_json::json!({"text": "Bitcoin price surges"})),
        }
    }

    #[tokio::test]
    async fn test_positive_sentiment_signal() {
        let config = SentimentConfig {
            positive_threshold: 0.6,
            negative_threshold: -0.6,
            min_data_points: 3,
            keywords: vec!["bitcoin".to_string()],
            decay_factor: 0.99,
        };
        let mut analyzer = SentimentAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Feed positive sentiment
        for i in 0..5 {
            let signal = analyzer.process_event(
                &make_sentiment_event("node-1", 0.8, i * 100)
            ).await;
            if signal.is_some() {
                let s = signal.unwrap();
                assert_eq!(s.strategy, "sentiment");
                assert_eq!(s.side, TradeSide::Buy);
                return;
            }
        }

        // Should have generated at least one signal
        assert!(analyzer.aggregate_score > 0.5, "Aggregate should be positive");
    }

    #[tokio::test]
    async fn test_negative_sentiment_signal() {
        let config = SentimentConfig {
            positive_threshold: 0.6,
            negative_threshold: -0.6,
            min_data_points: 3,
            keywords: vec![],
            decay_factor: 0.99,
        };
        let mut analyzer = SentimentAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        for i in 0..5 {
            let signal = analyzer.process_event(
                &make_sentiment_event("node-1", -0.9, i * 100)
            ).await;
            if signal.is_some() {
                let s = signal.unwrap();
                assert_eq!(s.side, TradeSide::Sell);
                return;
            }
        }

        assert!(analyzer.aggregate_score < -0.5, "Aggregate should be negative");
    }
}
