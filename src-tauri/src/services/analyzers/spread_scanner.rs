// ============================================================================
// SPREAD SCANNER ANALYZER
// ============================================================================
//
// Scans matched market pairs across platforms for arbitrage opportunities.
// Accounts for platform-specific fees when calculating profitable spreads.
//
// METHODOLOGY:
// For each matched pair (Polymarket, Kalshi):
//   spread = poly_yes_bid - kalshi_yes_ask (or vice versa)
//   min_profitable_spread = kalshi_fee + polymarket_fee + buffer
// Signal when spread > min_profitable_spread
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::HashMap;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, SpreadScannerConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

#[derive(Debug, Clone)]
pub struct MarketPrice {
    pub yes_bid: f64,
    pub yes_ask: f64,
    pub no_bid: f64,
    pub no_ask: f64,
    pub timestamp: i64,
}

pub struct SpreadScannerAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: SpreadScannerConfig,
    /// Polymarket prices by slug
    polymarket_prices: HashMap<String, MarketPrice>,
    /// Kalshi prices by ticker
    kalshi_prices: HashMap<String, MarketPrice>,
    /// Latest spreads detected
    latest_spreads: Vec<(String, String, f64)>, // (poly_slug, kalshi_ticker, spread)
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl SpreadScannerAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: SpreadScannerConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            polymarket_prices: HashMap::new(),
            kalshi_prices: HashMap::new(),
            latest_spreads: Vec::new(),
            latest_result: None,
        }
    }

    /// Calculate Kalshi fee for a given price
    /// Kalshi fee = fee_rate * P * (1-P), max at P=0.50
    fn kalshi_fee(&self, price: f64) -> f64 {
        self.config.kalshi_fee_rate * price * (1.0 - price)
    }

    /// Calculate minimum profitable spread given the prices
    fn min_profitable_spread(&self, poly_price: f64, kalshi_price: f64) -> f64 {
        let kalshi_fee = self.kalshi_fee(kalshi_price);
        let poly_fee = self.config.polymarket_fee_rate * poly_price * (1.0 - poly_price);
        
        // Minimum spread = both fees + required minimum
        kalshi_fee + poly_fee + self.config.min_spread
    }

    /// Calculate spread between two markets
    fn calculate_spread(&self, poly_slug: &str, kalshi_ticker: &str) -> Option<(f64, String)> {
        let poly = self.polymarket_prices.get(poly_slug)?;
        let kalshi = self.kalshi_prices.get(kalshi_ticker)?;

        // Check both directions:
        // 1. Buy Polymarket YES, Sell Kalshi YES
        let spread_buy_poly = poly.yes_ask - kalshi.yes_bid;
        // 2. Buy Kalshi YES, Sell Polymarket YES
        let spread_buy_kalshi = kalshi.yes_ask - poly.yes_bid;

        // Return the profitable direction
        if spread_buy_poly < 0.0 {
            // Can buy poly YES cheap, sell kalshi YES higher
            Some((-spread_buy_poly, "buy_poly_sell_kalshi".to_string()))
        } else if spread_buy_kalshi < 0.0 {
            // Can buy kalshi YES cheap, sell poly YES higher
            Some((-spread_buy_kalshi, "buy_kalshi_sell_poly".to_string()))
        } else {
            // No profitable spread
            None
        }
    }

    /// Scan all configured market pairs for opportunities
    fn scan_pairs(&mut self) -> Vec<(String, String, f64, String)> {
        let mut opportunities = Vec::new();

        for (poly_slug, kalshi_ticker) in &self.config.market_pairs {
            if let Some((spread, direction)) = self.calculate_spread(poly_slug, kalshi_ticker) {
                let poly_price = self.polymarket_prices.get(poly_slug)
                    .map(|p| p.yes_ask)
                    .unwrap_or(0.5);
                let kalshi_price = self.kalshi_prices.get(kalshi_ticker)
                    .map(|p| p.yes_ask)
                    .unwrap_or(0.5);

                let min_spread = self.min_profitable_spread(poly_price, kalshi_price);

                if spread > min_spread {
                    opportunities.push((
                        poly_slug.clone(),
                        kalshi_ticker.clone(),
                        spread,
                        direction,
                    ));
                }
            }
        }

        opportunities
    }
}

#[async_trait]
impl AnalyzerInstance for SpreadScannerAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::SpreadScanner
    }

    fn analyzer_id(&self) -> &str {
        &self.analyzer_id
    }

    fn node_id(&self) -> &str {
        &self.node_id
    }

    async fn process_event(&mut self, event: &DataEvent) -> Option<TradingSignal> {
        // Accept events from any source (this analyzer monitors multiple markets)
        if event.metric_type != "orderbook" && event.metric_type != "price" {
            return None;
        }

        // Extract market identifier and platform from metadata
        let platform = event.metadata.as_ref()
            .and_then(|m| m.get("platform"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        let market_id = event.metadata.as_ref()
            .and_then(|m| m.get("market_id"))
            .and_then(|v| v.as_str())
            .unwrap_or(&event.source_id);

        // Extract prices
        let yes_bid = event.metadata.as_ref()
            .and_then(|m| m.get("yes_bid"))
            .and_then(|v| v.as_f64())
            .unwrap_or(event.value);

        let yes_ask = event.metadata.as_ref()
            .and_then(|m| m.get("yes_ask"))
            .and_then(|v| v.as_f64())
            .unwrap_or(event.value);

        let no_bid = event.metadata.as_ref()
            .and_then(|m| m.get("no_bid"))
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0 - yes_ask);

        let no_ask = event.metadata.as_ref()
            .and_then(|m| m.get("no_ask"))
            .and_then(|v| v.as_f64())
            .unwrap_or(1.0 - yes_bid);

        let price = MarketPrice {
            yes_bid,
            yes_ask,
            no_bid,
            no_ask,
            timestamp: event.timestamp,
        };

        // Store price based on platform
        match platform.to_lowercase().as_str() {
            "polymarket" => {
                self.polymarket_prices.insert(market_id.to_string(), price);
            }
            "kalshi" => {
                self.kalshi_prices.insert(market_id.to_string(), price);
            }
            _ => {
                // Try to infer platform from market_id format
                if market_id.starts_with("will-") || market_id.contains("-") && market_id.len() > 20 {
                    self.polymarket_prices.insert(market_id.to_string(), price);
                } else if market_id.contains("-") && market_id.chars().all(|c| c.is_alphanumeric() || c == '-') {
                    self.kalshi_prices.insert(market_id.to_string(), price);
                }
            }
        }

        // Scan for arbitrage opportunities
        let opportunities = self.scan_pairs();

        // Update latest spreads
        self.latest_spreads = opportunities.iter()
            .map(|(p, k, s, _)| (p.clone(), k.clone(), *s))
            .collect();

        // Cache result
        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "SpreadScanner".to_string(),
            value: opportunities.first().map(|(_, _, s, _)| *s).unwrap_or(0.0),
            confidence: if opportunities.is_empty() { 0.0 } else { 0.9 },
            metadata: serde_json::json!({
                "polymarket_markets": self.polymarket_prices.len(),
                "kalshi_markets": self.kalshi_prices.len(),
                "configured_pairs": self.config.market_pairs.len(),
                "opportunities": opportunities.iter().map(|(p, k, s, d)| {
                    serde_json::json!({
                        "polymarket_slug": p,
                        "kalshi_ticker": k,
                        "spread": s,
                        "direction": d,
                    })
                }).collect::<Vec<_>>(),
            }),
            timestamp: event.timestamp,
        });

        // Generate signal for best opportunity
        if let Some((poly_slug, kalshi_ticker, spread, direction)) = opportunities.first() {
            let (side, market) = if direction == "buy_poly_sell_kalshi" {
                (TradeSide::Buy, poly_slug.clone())
            } else {
                (TradeSide::Buy, kalshi_ticker.clone())
            };

            return Some(TradingSignal {
                signal_id: uuid::Uuid::new_v4().to_string(),
                strategy: "spread_scanner".to_string(),
                confidence: (*spread / 0.10).min(1.0), // Scale confidence by spread size
                market_id: market,
                side,
                suggested_size: 100.0,
                max_slippage: 0.01, // Tight slippage for arb
                timestamp: event.timestamp,
                metadata: serde_json::json!({
                    "polymarket_slug": poly_slug,
                    "kalshi_ticker": kalshi_ticker,
                    "spread": spread,
                    "direction": direction,
                    "is_arbitrage": true,
                    "analyzer_id": self.analyzer_id,
                }),
                ttl_ms: 30000, // 30 second TTL for arb (time-sensitive)
            });
        }

        None
    }

    async fn get_latest_result(&self) -> Option<AnalyzerResult> {
        self.latest_result.clone()
    }

    fn update_config(&mut self, config: JsonValue) -> Result<(), String> {
        self.config = serde_json::from_value(config)
            .map_err(|e| format!("Invalid spread scanner config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.polymarket_prices.clear();
        self.kalshi_prices.clear();
        self.latest_spreads.clear();
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        !self.polymarket_prices.is_empty() && !self.kalshi_prices.is_empty()
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "SpreadScanner",
            "ready": self.is_ready(),
            "polymarket_markets": self.polymarket_prices.len(),
            "kalshi_markets": self.kalshi_prices.len(),
            "configured_pairs": self.config.market_pairs.len(),
            "active_spreads": self.latest_spreads.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::node::InfoSourceType;

    fn make_orderbook_event(source_id: &str, platform: &str, market_id: &str, yes_bid: f64, yes_ask: f64, ts: i64) -> DataEvent {
        DataEvent {
            source_id: source_id.to_string(),
            source_type: InfoSourceType::CryptoPrices,
            metric_type: "orderbook".to_string(),
            value: (yes_bid + yes_ask) / 2.0,
            timestamp: ts,
            metadata: Some(serde_json::json!({
                "platform": platform,
                "market_id": market_id,
                "yes_bid": yes_bid,
                "yes_ask": yes_ask,
            })),
        }
    }

    #[tokio::test]
    async fn test_spread_detection() {
        let config = SpreadScannerConfig {
            market_pairs: vec![
                ("will-btc-100k".to_string(), "BTC-100K".to_string()),
            ],
            min_spread: 0.02,
            kalshi_fee_rate: 0.07,
            polymarket_fee_rate: 0.0,
            scan_interval_seconds: 60,
        };
        let mut analyzer = SpreadScannerAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Polymarket: YES bid=0.50, ask=0.52
        analyzer.process_event(&make_orderbook_event(
            "node-1", "polymarket", "will-btc-100k", 0.50, 0.52, 0
        )).await;

        // Kalshi: YES bid=0.60, ask=0.62 (higher than poly!)
        let signal = analyzer.process_event(&make_orderbook_event(
            "node-1", "kalshi", "BTC-100K", 0.60, 0.62, 1
        )).await;

        // Should detect arb: buy poly at 0.52, sell kalshi at 0.60 = 0.08 spread
        assert!(signal.is_some(), "Should detect arbitrage opportunity");
        if let Some(sig) = signal {
            assert_eq!(sig.strategy, "spread_scanner");
        }
    }

    #[test]
    fn test_kalshi_fee_calculation() {
        let config = SpreadScannerConfig::default();
        let analyzer = SpreadScannerAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Fee at 50 cents (maximum)
        let fee_50 = analyzer.kalshi_fee(0.50);
        assert!((fee_50 - 0.0175).abs() < 0.001); // 0.07 * 0.5 * 0.5 = 0.0175

        // Fee at 10 cents
        let fee_10 = analyzer.kalshi_fee(0.10);
        assert!((fee_10 - 0.0063).abs() < 0.001); // 0.07 * 0.1 * 0.9 = 0.0063
    }
}
