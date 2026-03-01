// ============================================================================
// ARBITRAGE ANALYZER
// ============================================================================
//
// Detects price discrepancies between connected markets for the same event.
// Emits signals when buy_yes + buy_no < 1.0 - fees (guaranteed profit).
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::HashMap;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, ArbitrageConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

/// Price snapshot for a single market
#[derive(Debug, Clone)]
struct MarketPrice {
    yes_price: f64,
    no_price: f64,
    timestamp: i64,
}

pub struct ArbitrageAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: ArbitrageConfig,
    /// Current prices per market: market_id → MarketPrice
    market_prices: HashMap<String, MarketPrice>,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl ArbitrageAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: ArbitrageConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            market_prices: HashMap::new(),
            latest_result: None,
        }
    }

    /// Check all market pairs for arbitrage opportunities
    fn check_arbitrage_pairs(&self) -> Option<(String, String, f64, f64)> {
        let market_ids: Vec<&String> = self.market_prices.keys().collect();

        for i in 0..market_ids.len() {
            for j in (i + 1)..market_ids.len() {
                let market_a = &self.market_prices[market_ids[i]];
                let market_b = &self.market_prices[market_ids[j]];

                // Strategy 1: Buy YES on A, Buy NO on B
                let cost_1 = market_a.yes_price + market_b.no_price;
                let profit_1 = 1.0 - cost_1 - (2.0 * self.config.fee_percent);

                if profit_1 >= self.config.min_profit_margin {
                    return Some((
                        market_ids[i].clone(),
                        market_ids[j].clone(),
                        profit_1,
                        market_a.yes_price,
                    ));
                }

                // Strategy 2: Buy YES on B, Buy NO on A
                let cost_2 = market_b.yes_price + market_a.no_price;
                let profit_2 = 1.0 - cost_2 - (2.0 * self.config.fee_percent);

                if profit_2 >= self.config.min_profit_margin {
                    return Some((
                        market_ids[j].clone(),
                        market_ids[i].clone(),
                        profit_2,
                        market_b.yes_price,
                    ));
                }
            }
        }

        None
    }
}

#[async_trait]
impl AnalyzerInstance for ArbitrageAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::Arbitrage
    }

    fn analyzer_id(&self) -> &str {
        &self.analyzer_id
    }

    fn node_id(&self) -> &str {
        &self.node_id
    }

    async fn process_event(&mut self, event: &DataEvent) -> Option<TradingSignal> {
        // Only process price events from monitored markets
        if !self.config.market_ids.contains(&event.source_id) && event.source_id != self.node_id {
            return None;
        }

        if !event.value.is_finite() || event.value <= 0.0 || event.value >= 1.0 {
            return None;
        }

        // Update market price based on metric_type
        let entry = self.market_prices
            .entry(event.source_id.clone())
            .or_insert_with(|| MarketPrice {
                yes_price: 0.5,
                no_price: 0.5,
                timestamp: event.timestamp,
            });

        match event.metric_type.as_str() {
            "price" | "yes_price" => {
                entry.yes_price = event.value;
                entry.no_price = 1.0 - event.value; // Implied
            }
            "no_price" => {
                entry.no_price = event.value;
            }
            _ => return None,
        }
        entry.timestamp = event.timestamp;

        // Check for arbitrage across all pairs
        if let Some((buy_market, sell_market, profit, buy_price)) = self.check_arbitrage_pairs() {
            let confidence = (profit / self.config.min_profit_margin).min(1.0);

            self.latest_result = Some(AnalyzerResult {
                id: uuid::Uuid::new_v4().to_string(),
                analyzer_id: self.analyzer_id.clone(),
                result_type: "Arbitrage".to_string(),
                value: profit,
                confidence,
                metadata: serde_json::json!({
                    "buy_market": buy_market,
                    "sell_market": sell_market,
                    "profit_percent": profit,
                    "buy_price": buy_price,
                }),
                timestamp: event.timestamp,
            });

            return Some(TradingSignal {
                signal_id: uuid::Uuid::new_v4().to_string(),
                strategy: "arbitrage".to_string(),
                confidence,
                market_id: buy_market.clone(),
                side: TradeSide::Buy,
                suggested_size: 100.0,
                max_slippage: profit / 2.0, // Allow up to half the profit as slippage
                timestamp: event.timestamp,
                metadata: serde_json::json!({
                    "buy_market": buy_market,
                    "sell_market": sell_market,
                    "profit_percent": profit,
                    "analyzer_id": self.analyzer_id,
                }),
                ttl_ms: self.config.max_execution_time_ms,
            });
        }

        None
    }

    async fn get_latest_result(&self) -> Option<AnalyzerResult> {
        self.latest_result.clone()
    }

    fn update_config(&mut self, config: JsonValue) -> Result<(), String> {
        self.config = serde_json::from_value(config)
            .map_err(|e| format!("Invalid arbitrage config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.market_prices.clear();
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        self.market_prices.len() >= 2
    }

    fn status(&self) -> JsonValue {
        let prices: HashMap<String, JsonValue> = self.market_prices.iter()
            .map(|(k, v)| (k.clone(), serde_json::json!({
                "yes": v.yes_price,
                "no": v.no_price,
            })))
            .collect();
        serde_json::json!({
            "type": "Arbitrage",
            "ready": self.is_ready(),
            "markets_tracked": self.market_prices.len(),
            "prices": prices,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::node::InfoSourceType;

    fn make_event(source_id: &str, metric: &str, value: f64, ts: i64) -> DataEvent {
        DataEvent {
            source_id: source_id.to_string(),
            source_type: InfoSourceType::CryptoPrices,
            metric_type: metric.to_string(),
            value,
            timestamp: ts,
            metadata: None,
        }
    }

    #[tokio::test]
    async fn test_arbitrage_detection() {
        let config = ArbitrageConfig {
            min_profit_margin: 0.005, // 0.5%
            market_ids: vec!["market-a".to_string(), "market-b".to_string()],
            fee_percent: 0.01,
            max_execution_time_ms: 5000,
        };
        let mut analyzer = ArbitrageAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Market A: YES at 0.48 → NO implied at 0.52
        analyzer.process_event(&make_event("market-a", "yes_price", 0.48, 1)).await;
        // Market B: YES at 0.55 → NO implied at 0.45
        // Arb: Buy YES on A (0.48) + Buy NO on B (0.45) = 0.93 + fees 0.02 = 0.95 < 1.0
        let signal = analyzer.process_event(&make_event("market-b", "yes_price", 0.55, 2)).await;

        assert!(signal.is_some(), "Should detect arbitrage opportunity");
        let s = signal.unwrap();
        assert_eq!(s.strategy, "arbitrage");
        assert!(s.confidence > 0.0);
    }

    #[tokio::test]
    async fn test_no_arbitrage() {
        let config = ArbitrageConfig {
            min_profit_margin: 0.005,
            market_ids: vec!["market-a".to_string(), "market-b".to_string()],
            fee_percent: 0.02,
            max_execution_time_ms: 5000,
        };
        let mut analyzer = ArbitrageAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Market A and B have same price - no arb
        analyzer.process_event(&make_event("market-a", "yes_price", 0.50, 1)).await;
        let signal = analyzer.process_event(&make_event("market-b", "yes_price", 0.50, 2)).await;

        assert!(signal.is_none(), "Should not find arbitrage when prices are equal");
    }
}
