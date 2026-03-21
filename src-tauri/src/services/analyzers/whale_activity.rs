// ============================================================================
// WHALE ACTIVITY ANALYZER
// ============================================================================
//
// Detects whale activity (large trades) and trade spikes in market data.
// Monitors trade sizes and triggers signals when trades exceed configurable
// thresholds or when trade activity spikes above the rolling average.
//
// Input sources:
// - PolymarketUserTrades info source (trade data from specific wallets)
// - Polymarket/Kalshi market nodes (live orderbook/trade data)
//
// Signal triggers:
// 1. Single trade exceeds threshold (whale trade)
// 2. Trade activity spikes: current trade > mean + (sensitivity * std_dev)
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::VecDeque;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, WhaleActivityConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

/// Trade record for rolling window analysis
#[derive(Debug, Clone)]
struct TradeRecord {
    value_usd: f64,
    timestamp: i64,
    side: String,
}

pub struct WhaleActivityAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: WhaleActivityConfig,
    /// Rolling window of recent trades
    trade_history: VecDeque<TradeRecord>,
    /// Rolling statistics
    sum: f64,
    sum_sq: f64,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
    /// Whale trade count (for metrics)
    whale_trade_count: usize,
}

impl WhaleActivityAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: WhaleActivityConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            trade_history: VecDeque::with_capacity(1000),
            sum: 0.0,
            sum_sq: 0.0,
            latest_result: None,
            whale_trade_count: 0,
        }
    }

    /// Calculate mean of trade values
    fn mean(&self) -> f64 {
        if self.trade_history.is_empty() {
            0.0
        } else {
            self.sum / self.trade_history.len() as f64
        }
    }

    /// Calculate standard deviation of trade values
    fn std_dev(&self) -> f64 {
        let n = self.trade_history.len() as f64;
        if n < 2.0 {
            return 0.0;
        }
        let mean = self.mean();
        let variance = (self.sum_sq / n) - (mean * mean);
        variance.max(0.0).sqrt()
    }

    /// Add trade to rolling window, evict old trades
    fn add_trade(&mut self, trade: TradeRecord) {
        let window_start_ms = trade.timestamp - (self.config.window_size as i64 * 60 * 1000);
        
        // Remove old trades outside the window
        while let Some(oldest) = self.trade_history.front() {
            if oldest.timestamp < window_start_ms {
                let old = self.trade_history.pop_front().unwrap();
                self.sum -= old.value_usd;
                self.sum_sq -= old.value_usd * old.value_usd;
            } else {
                break;
            }
        }

        // Add new trade
        self.sum += trade.value_usd;
        self.sum_sq += trade.value_usd * trade.value_usd;
        self.trade_history.push_back(trade);
    }

    /// Detect if a trade is a spike based on statistical deviation
    fn is_spike(&self, value: f64) -> bool {
        if self.trade_history.len() < self.config.min_trades {
            return false;
        }
        let mean = self.mean();
        let std_dev = self.std_dev();
        
        // Spike detection: value > mean + (sensitivity_factor * std_dev)
        // Higher sensitivity (closer to 1.0) means more sensitive (lower threshold)
        // sensitivity 0.5 → factor ~2.0 (2 std devs)
        // sensitivity 0.8 → factor ~1.0 (1 std dev)
        // sensitivity 0.2 → factor ~4.0 (4 std devs)
        let sensitivity_factor = 1.0 + (1.0 - self.config.sensitivity) * 3.0;
        
        value > mean + (sensitivity_factor * std_dev)
    }
}

#[async_trait]
impl AnalyzerInstance for WhaleActivityAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::WhaleActivity
    }

    fn analyzer_id(&self) -> &str {
        &self.analyzer_id
    }

    fn node_id(&self) -> &str {
        &self.node_id
    }

    async fn process_event(&mut self, event: &DataEvent) -> Option<TradingSignal> {
        // Accept trade events from the connected node
        if event.source_id != self.node_id {
            return None;
        }

        // Accept trade-related metrics
        let is_trade_metric = event.metric_type == "trade" 
            || event.metric_type.starts_with("trade:")
            || event.metric_type == "total_volume_usd"
            || event.metric_type == "largest_trade_usd";

        if !is_trade_metric || !event.value.is_finite() || event.value <= 0.0 {
            return None;
        }

        let trade_value = event.value;
        
        // Extract side from metadata if available
        let side = event.metadata
            .as_ref()
            .and_then(|m| m.get("side"))
            .and_then(|s| s.as_str())
            .unwrap_or("BUY")
            .to_string();

        // Add to rolling window
        self.add_trade(TradeRecord {
            value_usd: trade_value,
            timestamp: event.timestamp,
            side: side.clone(),
        });

        // Check for whale trade (exceeds absolute threshold)
        let is_whale = trade_value >= self.config.threshold;
        
        // Check for spike (exceeds statistical threshold)
        let is_spike = self.is_spike(trade_value);

        if is_whale {
            self.whale_trade_count += 1;
        }

        // Update cached result
        let mean = self.mean();
        let std_dev = self.std_dev();
        let z_score = if std_dev > 0.0 {
            (trade_value - mean) / std_dev
        } else {
            0.0
        };

        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "WhaleActivity".to_string(),
            value: trade_value,
            confidence: if is_whale || is_spike {
                // Higher confidence for larger deviations
                (z_score / 5.0).min(1.0).max(0.0)
            } else {
                0.0
            },
            metadata: serde_json::json!({
                "trade_value_usd": trade_value,
                "is_whale": is_whale,
                "is_spike": is_spike,
                "side": side,
                "mean": mean,
                "std_dev": std_dev,
                "z_score": z_score,
                "threshold": self.config.threshold,
                "trade_count_in_window": self.trade_history.len(),
                "whale_trade_count": self.whale_trade_count,
            }),
            timestamp: event.timestamp,
        });

        // Generate signal if whale trade or spike detected
        if is_whale || is_spike {
            let confidence = (z_score / 5.0).min(1.0).max(0.3);
            
            // Signal side follows the trade direction
            let signal_side = if side == "SELL" {
                TradeSide::Sell
            } else {
                TradeSide::Buy
            };

            return Some(TradingSignal {
                signal_id: uuid::Uuid::new_v4().to_string(),
                strategy: "whale_activity".to_string(),
                confidence,
                market_id: self.node_id.clone(),
                side: signal_side,
                suggested_size: (trade_value * 0.1).min(1000.0), // 10% of whale trade, max $1000
                max_slippage: 0.02,
                timestamp: event.timestamp,
                metadata: serde_json::json!({
                    "trigger": if is_whale { "whale_trade" } else { "trade_spike" },
                    "trade_value_usd": trade_value,
                    "threshold": self.config.threshold,
                    "z_score": z_score,
                    "analyzer_id": self.analyzer_id,
                }),
                ttl_ms: 30000, // 30 second validity
            });
        }

        None
    }

    async fn process_chained_input(&mut self, result: &AnalyzerResult) -> Option<TradingSignal> {
        // Accept price/momentum data from upstream analyzers to combine signals
        if result.result_type == "Momentum" || result.result_type == "RSI" {
            // If momentum is strong and we've seen recent whale activity, boost signal
            if self.whale_trade_count > 0 && result.confidence > 0.5 {
                let combined_confidence = (result.confidence + 0.2).min(1.0);
                
                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "whale_momentum_chain".to_string(),
                    confidence: combined_confidence,
                    market_id: self.node_id.clone(),
                    side: if result.value > 0.0 { TradeSide::Buy } else { TradeSide::Sell },
                    suggested_size: 150.0,
                    max_slippage: 0.02,
                    timestamp: result.timestamp,
                    metadata: serde_json::json!({
                        "chain_type": "momentum_whale",
                        "upstream_value": result.value,
                        "whale_count": self.whale_trade_count,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 20000,
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
            .map_err(|e| format!("Invalid WhaleActivity config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.trade_history.clear();
        self.sum = 0.0;
        self.sum_sq = 0.0;
        self.latest_result = None;
        self.whale_trade_count = 0;
    }

    fn is_ready(&self) -> bool {
        self.trade_history.len() >= self.config.min_trades
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "WhaleActivity",
            "ready": self.is_ready(),
            "trades_in_window": self.trade_history.len(),
            "mean_trade_value": self.mean(),
            "std_dev": self.std_dev(),
            "whale_count": self.whale_trade_count,
            "threshold": self.config.threshold,
            "window_size_minutes": self.config.window_size,
            "sensitivity": self.config.sensitivity,
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
            source_type: InfoSourceType::PolymarketUserTrades,
            metric_type: "trade".to_string(),
            value,
            timestamp: ts,
            metadata: Some(serde_json::json!({ "side": "BUY" })),
        }
    }

    #[tokio::test]
    async fn test_whale_detection() {
        let config = WhaleActivityConfig {
            threshold: 10000.0,
            window_size: 60,
            sensitivity: 0.5,
            min_trades: 5,
        };
        let mut analyzer = WhaleActivityAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Add some small trades first
        for i in 0..10 {
            let ts = 1704067200000 + (i * 1000);
            analyzer.process_event(&make_event("node-1", 100.0, ts)).await;
        }

        assert!(analyzer.is_ready());

        // Add a whale trade
        let whale_ts = 1704067200000 + 20000;
        let signal = analyzer.process_event(&make_event("node-1", 15000.0, whale_ts)).await;

        assert!(signal.is_some(), "Should detect whale trade");
        let signal = signal.unwrap();
        assert_eq!(signal.strategy, "whale_activity");
        
        let trigger = signal.metadata.get("trigger").and_then(|v| v.as_str());
        assert!(trigger == Some("whale_trade") || trigger == Some("trade_spike"));
    }

    #[tokio::test]
    async fn test_spike_detection() {
        let config = WhaleActivityConfig {
            threshold: 100000.0, // High threshold so we detect via spike instead
            window_size: 60,
            sensitivity: 0.8, // High sensitivity
            min_trades: 5,
        };
        let mut analyzer = WhaleActivityAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Add normal trades (~100 each)
        for i in 0..20 {
            let ts = 1704067200000 + (i * 1000);
            analyzer.process_event(&make_event("node-1", 100.0 + (i as f64 * 5.0), ts)).await;
        }

        // Add a spike trade (10x normal)
        let spike_ts = 1704067200000 + 30000;
        let signal = analyzer.process_event(&make_event("node-1", 1500.0, spike_ts)).await;

        assert!(signal.is_some(), "Should detect trade spike");
    }

    #[tokio::test]
    async fn test_rolling_window() {
        let config = WhaleActivityConfig {
            threshold: 10000.0,
            window_size: 1, // 1 minute window
            sensitivity: 0.5,
            min_trades: 2,
        };
        let mut analyzer = WhaleActivityAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Add trades over time
        let base_ts = 1704067200000i64;
        
        // First trade at t=0
        analyzer.process_event(&make_event("node-1", 100.0, base_ts)).await;
        assert_eq!(analyzer.trade_history.len(), 1);

        // Second trade at t=30s
        analyzer.process_event(&make_event("node-1", 200.0, base_ts + 30000)).await;
        assert_eq!(analyzer.trade_history.len(), 2);

        // Third trade at t=2min (should evict first trade)
        analyzer.process_event(&make_event("node-1", 300.0, base_ts + 120000)).await;
        assert!(analyzer.trade_history.len() <= 2, "Old trades should be evicted");
    }
}
