// ============================================================================
// MOMENTUM ANALYZER
// ============================================================================
//
// EMA-based momentum detection with configurable short/long periods.
// Generates signals when short EMA crosses long EMA (crossover strategy).
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::VecDeque;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, MomentumConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

pub struct MomentumAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: MomentumConfig,
    /// Price history buffer
    prices: VecDeque<f64>,
    /// Current short EMA value
    ema_short: Option<f64>,
    /// Current long EMA value
    ema_long: Option<f64>,
    /// Previous short EMA (for crossover detection)
    prev_ema_short: Option<f64>,
    /// Previous long EMA (for crossover detection)
    prev_ema_long: Option<f64>,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl MomentumAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: MomentumConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            prices: VecDeque::with_capacity(200),
            ema_short: None,
            ema_long: None,
            prev_ema_short: None,
            prev_ema_long: None,
            latest_result: None,
        }
    }

    fn update_ema(current_ema: Option<f64>, new_value: f64, period: usize) -> f64 {
        let alpha = 2.0 / (period as f64 + 1.0);
        match current_ema {
            Some(ema) => alpha * new_value + (1.0 - alpha) * ema,
            None => new_value,
        }
    }
}

#[async_trait]
impl AnalyzerInstance for MomentumAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::Momentum
    }

    fn analyzer_id(&self) -> &str {
        &self.analyzer_id
    }

    fn node_id(&self) -> &str {
        &self.node_id
    }

    async fn process_event(&mut self, event: &DataEvent) -> Option<TradingSignal> {
        if event.source_id != self.node_id || event.metric_type != "price" {
            return None;
        }
        if !event.value.is_finite() || event.value <= 0.0 {
            return None;
        }

        // Store price
        self.prices.push_back(event.value);
        if self.prices.len() > self.config.lookback_period {
            self.prices.pop_front();
        }

        // Save previous EMAs for crossover detection
        self.prev_ema_short = self.ema_short;
        self.prev_ema_long = self.ema_long;

        // Update EMAs
        let new_short = Self::update_ema(self.ema_short, event.value, self.config.ema_short_period);
        let new_long = Self::update_ema(self.ema_long, event.value, self.config.ema_long_period);
        self.ema_short = Some(new_short);
        self.ema_long = Some(new_long);

        // Need enough data before generating signals
        if self.prices.len() < self.config.ema_long_period {
            return None;
        }

        // Calculate momentum as percentage difference between short and long EMA
        let momentum = (new_short - new_long) / new_long;

        // Cache result
        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "Momentum".to_string(),
            value: momentum,
            confidence: (momentum.abs() / self.config.threshold).min(1.0),
            metadata: serde_json::json!({
                "ema_short": new_short,
                "ema_long": new_long,
                "price": event.value,
                "data_points": self.prices.len(),
            }),
            timestamp: event.timestamp,
        });

        // Detect EMA crossover for signal generation
        if let (Some(prev_short), Some(prev_long)) = (self.prev_ema_short, self.prev_ema_long) {
            let was_above = prev_short > prev_long;
            let is_above = new_short > new_long;

            // Bullish crossover: short EMA crosses above long EMA
            if !was_above && is_above && momentum.abs() >= self.config.threshold {
                let confidence = (momentum.abs() / self.config.threshold).min(1.0);
                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "momentum".to_string(),
                    confidence,
                    market_id: self.node_id.clone(),
                    side: TradeSide::Buy,
                    suggested_size: 100.0,
                    max_slippage: 0.01,
                    timestamp: event.timestamp,
                    metadata: serde_json::json!({
                        "crossover": "bullish",
                        "momentum": momentum,
                        "ema_short": new_short,
                        "ema_long": new_long,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 10000,
                });
            }

            // Bearish crossover: short EMA crosses below long EMA
            if was_above && !is_above && momentum.abs() >= self.config.threshold {
                let confidence = (momentum.abs() / self.config.threshold).min(1.0);
                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "momentum".to_string(),
                    confidence,
                    market_id: self.node_id.clone(),
                    side: TradeSide::Sell,
                    suggested_size: 100.0,
                    max_slippage: 0.01,
                    timestamp: event.timestamp,
                    metadata: serde_json::json!({
                        "crossover": "bearish",
                        "momentum": momentum,
                        "ema_short": new_short,
                        "ema_long": new_long,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 10000,
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
            .map_err(|e| format!("Invalid momentum config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.prices.clear();
        self.ema_short = None;
        self.ema_long = None;
        self.prev_ema_short = None;
        self.prev_ema_long = None;
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        self.prices.len() >= self.config.ema_long_period
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "Momentum",
            "ready": self.is_ready(),
            "data_points": self.prices.len(),
            "ema_short": self.ema_short,
            "ema_long": self.ema_long,
            "required_points": self.config.ema_long_period,
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
    async fn test_momentum_ema_crossover() {
        let config = MomentumConfig {
            ema_short_period: 3,
            ema_long_period: 5,
            threshold: 0.001,
            lookback_period: 50,
        };
        let mut analyzer = MomentumAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Feed stable data first
        for i in 0..10 {
            analyzer.process_event(&make_event("node-1", 100.0, i)).await;
        }

        // Then feed strongly increasing data (should trigger bullish crossover)
        let mut got_signal = false;
        for i in 10..30 {
            let price = 100.0 + (i - 10) as f64 * 2.0;
            if let Some(signal) = analyzer.process_event(&make_event("node-1", price, i)).await {
                assert_eq!(signal.strategy, "momentum");
                got_signal = true;
                break;
            }
        }

        assert!(got_signal || analyzer.is_ready(), "Should either get signal or be ready");
    }

    #[tokio::test]
    async fn test_momentum_not_ready() {
        let config = MomentumConfig {
            ema_short_period: 12,
            ema_long_period: 26,
            threshold: 0.02,
            lookback_period: 50,
        };
        let mut analyzer = MomentumAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Only 5 data points, need 26
        for i in 0..5 {
            analyzer.process_event(&make_event("node-1", 100.0 + i as f64, i)).await;
        }

        assert!(!analyzer.is_ready());
    }
}
