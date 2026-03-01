// ============================================================================
// VOLATILITY ANALYZER
// ============================================================================
//
// Measures price volatility using rolling standard deviation of returns.
// Emits signals when volatility crosses configured thresholds.
// High volatility → risk warning, Low volatility → opportunity signal.
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::VecDeque;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, VolatilityConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

pub struct VolatilityAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: VolatilityConfig,
    /// Price history for return calculation
    prices: VecDeque<f64>,
    /// Returns history
    returns: VecDeque<f64>,
    /// Current volatility value
    current_volatility: Option<f64>,
    /// Previous volatility (for crossover detection)
    prev_volatility: Option<f64>,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl VolatilityAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: VolatilityConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            prices: VecDeque::with_capacity(500),
            returns: VecDeque::with_capacity(500),
            current_volatility: None,
            prev_volatility: None,
            latest_result: None,
        }
    }

    /// Calculate rolling standard deviation of returns
    fn calculate_volatility(&self) -> Option<f64> {
        if self.returns.len() < self.config.window_size {
            return None;
        }

        let window: Vec<f64> = self.returns.iter()
            .rev()
            .take(self.config.window_size)
            .copied()
            .collect();

        let n = window.len() as f64;
        if n < 2.0 {
            return Some(0.0);
        }

        let mean: f64 = window.iter().sum::<f64>() / n;
        let variance: f64 = window.iter()
            .map(|r| (r - mean).powi(2))
            .sum::<f64>() / (n - 1.0);

        let std_dev = variance.sqrt();

        if self.config.annualize {
            // Annualize: multiply by sqrt(data_points_per_year)
            let annual_factor = (self.config.data_points_per_day as f64 * 365.0).sqrt();
            Some(std_dev * annual_factor)
        } else {
            Some(std_dev)
        }
    }
}

#[async_trait]
impl AnalyzerInstance for VolatilityAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::Volatility
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

        // Calculate return if we have a previous price
        if let Some(&prev_price) = self.prices.back() {
            if prev_price > 0.0 {
                let log_return = (event.value / prev_price).ln();
                self.returns.push_back(log_return);
                while self.returns.len() > 500 {
                    self.returns.pop_front();
                }
            }
        }

        self.prices.push_back(event.value);
        while self.prices.len() > 500 {
            self.prices.pop_front();
        }

        // Save previous volatility
        self.prev_volatility = self.current_volatility;

        // Calculate current volatility
        self.current_volatility = self.calculate_volatility();

        let vol = self.current_volatility?;

        // Cache result
        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "Volatility".to_string(),
            value: vol,
            confidence: if vol > self.config.high_threshold {
                ((vol - self.config.high_threshold) / self.config.high_threshold).min(1.0)
            } else if vol < self.config.low_threshold {
                ((self.config.low_threshold - vol) / self.config.low_threshold).min(1.0)
            } else {
                0.0
            },
            metadata: serde_json::json!({
                "volatility": vol,
                "annualized": self.config.annualize,
                "window_size": self.config.window_size,
                "data_points": self.returns.len(),
                "price": event.value,
            }),
            timestamp: event.timestamp,
        });

        // Generate signals on threshold crossings
        if let Some(prev_vol) = self.prev_volatility {
            // High volatility breakout → risk warning (sell to reduce exposure)
            if prev_vol <= self.config.high_threshold && vol > self.config.high_threshold {
                let confidence = ((vol - self.config.high_threshold) / self.config.high_threshold).min(1.0);
                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "volatility".to_string(),
                    confidence,
                    market_id: self.node_id.clone(),
                    side: TradeSide::Sell, // High volatility → reduce position
                    suggested_size: 50.0,  // Smaller size during volatility
                    max_slippage: 0.02,
                    timestamp: event.timestamp,
                    metadata: serde_json::json!({
                        "volatility": vol,
                        "condition": "high_volatility",
                        "threshold": self.config.high_threshold,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 20000,
                });
            }

            // Low volatility → accumulation opportunity (buy)
            if prev_vol >= self.config.low_threshold && vol < self.config.low_threshold {
                let confidence = ((self.config.low_threshold - vol) / self.config.low_threshold).min(1.0);
                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "volatility".to_string(),
                    confidence,
                    market_id: self.node_id.clone(),
                    side: TradeSide::Buy, // Low volatility → good entry
                    suggested_size: 100.0,
                    max_slippage: 0.01,
                    timestamp: event.timestamp,
                    metadata: serde_json::json!({
                        "volatility": vol,
                        "condition": "low_volatility",
                        "threshold": self.config.low_threshold,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 30000,
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
            .map_err(|e| format!("Invalid volatility config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.prices.clear();
        self.returns.clear();
        self.current_volatility = None;
        self.prev_volatility = None;
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        self.returns.len() >= self.config.window_size
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "Volatility",
            "ready": self.is_ready(),
            "current_volatility": self.current_volatility,
            "data_points": self.returns.len(),
            "required_points": self.config.window_size,
            "high_threshold": self.config.high_threshold,
            "low_threshold": self.config.low_threshold,
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
    async fn test_volatility_stable_prices() {
        let config = VolatilityConfig {
            window_size: 5,
            high_threshold: 0.5,
            low_threshold: 0.01,
            annualize: false,
            data_points_per_day: 288,
        };
        let mut analyzer = VolatilityAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Feed very stable prices
        for i in 0..10 {
            analyzer.process_event(&make_event("node-1", 100.0 + (i as f64 * 0.01), i)).await;
        }

        if let Some(vol) = analyzer.current_volatility {
            assert!(vol < 0.01, "Stable prices should have low volatility, got {}", vol);
        }
    }

    #[tokio::test]
    async fn test_volatility_volatile_prices() {
        let config = VolatilityConfig {
            window_size: 5,
            high_threshold: 0.1,
            low_threshold: 0.001,
            annualize: false,
            data_points_per_day: 288,
        };
        let mut analyzer = VolatilityAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Feed very volatile prices (swinging wildly)
        let prices = vec![100.0, 110.0, 95.0, 115.0, 90.0, 120.0, 85.0, 125.0];
        for (i, &price) in prices.iter().enumerate() {
            analyzer.process_event(&make_event("node-1", price, i as i64)).await;
        }

        if let Some(vol) = analyzer.current_volatility {
            assert!(vol > 0.05, "Volatile prices should have high volatility, got {}", vol);
        }
    }
}
