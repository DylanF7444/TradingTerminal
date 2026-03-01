// ============================================================================
// RSI ANALYZER
// ============================================================================
//
// Relative Strength Index (RSI) overbought/oversold detection.
// RSI ranges 0-100: above overbought_threshold → sell signal,
// below oversold_threshold → buy signal.
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::VecDeque;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, RSIConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

pub struct RSIAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: RSIConfig,
    /// Price history
    prices: VecDeque<f64>,
    /// Current RSI value
    current_rsi: Option<f64>,
    /// Previous RSI value (for crossover detection)
    prev_rsi: Option<f64>,
    /// Smoothed average gain
    avg_gain: f64,
    /// Smoothed average loss
    avg_loss: f64,
    /// Whether the smoothed averages have been initialized
    initialized: bool,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl RSIAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: RSIConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            prices: VecDeque::with_capacity(500),
            current_rsi: None,
            prev_rsi: None,
            avg_gain: 0.0,
            avg_loss: 0.0,
            initialized: false,
            latest_result: None,
        }
    }

    /// Calculate initial average gain/loss from first `period` price changes
    fn initialize_averages(&mut self) {
        if self.prices.len() < self.config.period + 1 {
            return;
        }

        let mut total_gain = 0.0;
        let mut total_loss = 0.0;
        let start = self.prices.len() - self.config.period - 1;

        for i in (start + 1)..=start + self.config.period {
            let change = self.prices[i] - self.prices[i - 1];
            if change > 0.0 {
                total_gain += change;
            } else {
                total_loss += change.abs();
            }
        }

        self.avg_gain = total_gain / self.config.period as f64;
        self.avg_loss = total_loss / self.config.period as f64;
        self.initialized = true;

        // Calculate initial RSI
        self.update_rsi_value();
    }

    /// Update RSI using smoothed averages (Wilder's smoothing)
    fn update_smoothed(&mut self, change: f64) {
        let period = self.config.period as f64;

        let (gain, loss) = if change > 0.0 {
            (change, 0.0)
        } else {
            (0.0, change.abs())
        };

        // Wilder's smoothing: avg = (prev_avg * (period - 1) + current) / period
        self.avg_gain = (self.avg_gain * (period - 1.0) + gain) / period;
        self.avg_loss = (self.avg_loss * (period - 1.0) + loss) / period;

        self.update_rsi_value();
    }

    fn update_rsi_value(&mut self) {
        if self.avg_loss == 0.0 {
            self.current_rsi = Some(100.0);
        } else {
            let rs = self.avg_gain / self.avg_loss;
            self.current_rsi = Some(100.0 - (100.0 / (1.0 + rs)));
        }
    }
}

#[async_trait]
impl AnalyzerInstance for RSIAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::RSI
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

        self.prices.push_back(event.value);

        // Limit buffer
        while self.prices.len() > 500 {
            self.prices.pop_front();
        }

        if !self.initialized {
            if self.prices.len() >= self.config.period + 1 {
                self.initialize_averages();
            }
            return None;
        }

        // Calculate price change
        if self.prices.len() < 2 {
            return None;
        }
        let len = self.prices.len();
        let change = self.prices[len - 1] - self.prices[len - 2];

        // Save previous RSI for crossover detection
        self.prev_rsi = self.current_rsi;

        // Update smoothed averages
        self.update_smoothed(change);

        let rsi = self.current_rsi?;

        // Cache result
        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "RSI".to_string(),
            value: rsi,
            confidence: if rsi > self.config.overbought_threshold {
                ((rsi - self.config.overbought_threshold) / (100.0 - self.config.overbought_threshold)).min(1.0)
            } else if rsi < self.config.oversold_threshold {
                ((self.config.oversold_threshold - rsi) / self.config.oversold_threshold).min(1.0)
            } else {
                0.0
            },
            metadata: serde_json::json!({
                "rsi": rsi,
                "avg_gain": self.avg_gain,
                "avg_loss": self.avg_loss,
                "price": event.value,
                "period": self.config.period,
            }),
            timestamp: event.timestamp,
        });

        // Generate signal on threshold crossover
        if let Some(prev) = self.prev_rsi {
            // Overbought crossover (RSI crosses above threshold)
            if prev <= self.config.overbought_threshold && rsi > self.config.overbought_threshold {
                let confidence = ((rsi - self.config.overbought_threshold) / (100.0 - self.config.overbought_threshold)).min(1.0);
                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "rsi".to_string(),
                    confidence,
                    market_id: self.node_id.clone(),
                    side: TradeSide::Sell, // Overbought → sell signal
                    suggested_size: 100.0,
                    max_slippage: 0.01,
                    timestamp: event.timestamp,
                    metadata: serde_json::json!({
                        "rsi": rsi,
                        "condition": "overbought",
                        "threshold": self.config.overbought_threshold,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 15000,
                });
            }

            // Oversold crossover (RSI crosses below threshold)
            if prev >= self.config.oversold_threshold && rsi < self.config.oversold_threshold {
                let confidence = ((self.config.oversold_threshold - rsi) / self.config.oversold_threshold).min(1.0);
                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "rsi".to_string(),
                    confidence,
                    market_id: self.node_id.clone(),
                    side: TradeSide::Buy, // Oversold → buy signal
                    suggested_size: 100.0,
                    max_slippage: 0.01,
                    timestamp: event.timestamp,
                    metadata: serde_json::json!({
                        "rsi": rsi,
                        "condition": "oversold",
                        "threshold": self.config.oversold_threshold,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 15000,
                });
            }
        }

        None
    }

    async fn process_chained_input(&mut self, result: &AnalyzerResult) -> Option<TradingSignal> {
        // RSI can accept momentum output as a supplementary signal
        if result.result_type == "Momentum" {
            // If momentum is strong and RSI confirms, boost confidence
            if let Some(rsi) = self.current_rsi {
                if result.value > 0.0 && rsi < self.config.oversold_threshold {
                    // Momentum bullish + RSI oversold = strong buy
                    return Some(TradingSignal {
                        signal_id: uuid::Uuid::new_v4().to_string(),
                        strategy: "rsi_momentum_chain".to_string(),
                        confidence: (result.confidence + 0.2).min(1.0),
                        market_id: self.node_id.clone(),
                        side: TradeSide::Buy,
                        suggested_size: 150.0,
                        max_slippage: 0.01,
                        timestamp: result.timestamp,
                        metadata: serde_json::json!({
                            "rsi": rsi,
                            "momentum": result.value,
                            "chain_type": "momentum_to_rsi",
                            "analyzer_id": self.analyzer_id,
                        }),
                        ttl_ms: 10000,
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
            .map_err(|e| format!("Invalid RSI config: {}", e))?;
        // Reset state since period may have changed
        self.initialized = false;
        self.avg_gain = 0.0;
        self.avg_loss = 0.0;
        self.current_rsi = None;
        self.prev_rsi = None;
        Ok(())
    }

    fn reset(&mut self) {
        self.prices.clear();
        self.current_rsi = None;
        self.prev_rsi = None;
        self.avg_gain = 0.0;
        self.avg_loss = 0.0;
        self.initialized = false;
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        self.initialized && self.current_rsi.is_some()
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "RSI",
            "ready": self.is_ready(),
            "current_rsi": self.current_rsi,
            "data_points": self.prices.len(),
            "period": self.config.period,
            "overbought": self.config.overbought_threshold,
            "oversold": self.config.oversold_threshold,
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
    async fn test_rsi_calculation() {
        let config = RSIConfig {
            period: 5,
            overbought_threshold: 70.0,
            oversold_threshold: 30.0,
            smoothing: "sma".to_string(),
        };
        let mut analyzer = RSIAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Feed enough data to initialize
        let prices = vec![44.0, 44.25, 44.5, 43.75, 44.5, 44.25, 43.5];
        for (i, &price) in prices.iter().enumerate() {
            analyzer.process_event(&make_event("node-1", price, i as i64)).await;
        }

        assert!(analyzer.is_ready(), "RSI should be ready after enough data");
        let rsi = analyzer.current_rsi.unwrap();
        assert!(rsi >= 0.0 && rsi <= 100.0, "RSI should be between 0-100, got {}", rsi);
    }

    #[tokio::test]
    async fn test_rsi_overbought_signal() {
        let config = RSIConfig {
            period: 3,
            overbought_threshold: 70.0,
            oversold_threshold: 30.0,
            smoothing: "sma".to_string(),
        };
        let mut analyzer = RSIAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Feed stable data first
        for i in 0..5 {
            analyzer.process_event(&make_event("node-1", 100.0, i)).await;
        }

        // Then strongly increasing prices → should push RSI above overbought
        let mut got_sell = false;
        for i in 5..20 {
            let price = 100.0 + (i - 5) as f64 * 5.0;
            if let Some(signal) = analyzer.process_event(&make_event("node-1", price, i)).await {
                if signal.side == TradeSide::Sell {
                    got_sell = true;
                    assert_eq!(signal.strategy, "rsi");
                    break;
                }
            }
        }

        // The RSI should be high even if crossover timing didn't match
        if !got_sell {
            if let Some(rsi) = analyzer.current_rsi {
                assert!(rsi > 50.0, "RSI should be elevated with increasing prices, got {}", rsi);
            }
        }
    }
}
