// ============================================================================
// FUNDING REGIME ANALYZER
// ============================================================================
//
// Detects extreme funding rate regimes in crypto perpetual markets.
// Used to adjust probability estimates for crypto price target markets.
//
// METHODOLOGY:
// When funding > extreme_positive (e.g., 0.05% per 8h = 55% annualized):
//   Market is overextended long → mean reversion risk
//   Adjust probability downward for aggressive upside targets
// When funding < extreme_negative:
//   Market is overextended short → squeeze risk
//   Adjust probability upward for upside targets
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::{HashMap, VecDeque};

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, FundingRegimeConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum FundingRegime {
    ExtremeLong,   // Funding very positive - crowded long
    Neutral,       // Normal funding
    ExtremeShort,  // Funding very negative - crowded short
}

#[derive(Debug, Clone)]
struct FundingData {
    rate: f64,           // 8h funding rate
    annualized: f64,     // Annualized rate
    timestamp: i64,
}

pub struct FundingRegimeAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: FundingRegimeConfig,
    /// Funding rates by asset
    funding_rates: HashMap<String, VecDeque<FundingData>>,
    /// Current regime by asset
    current_regime: HashMap<String, FundingRegime>,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl FundingRegimeAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: FundingRegimeConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            funding_rates: HashMap::new(),
            current_regime: HashMap::new(),
            latest_result: None,
        }
    }

    /// Convert 8h funding rate to annualized
    fn annualize_funding(rate_8h: f64) -> f64 {
        // 3 funding periods per day, 365 days
        rate_8h * 3.0 * 365.0
    }

    /// Classify funding regime
    fn classify_regime(&self, annualized_rate: f64) -> FundingRegime {
        if annualized_rate > self.config.extreme_positive {
            FundingRegime::ExtremeLong
        } else if annualized_rate < self.config.extreme_negative {
            FundingRegime::ExtremeShort
        } else {
            FundingRegime::Neutral
        }
    }

    /// Get probability adjustment based on regime and target direction
    pub fn get_adjustment(&self, asset: &str, is_bullish_target: bool) -> f64 {
        let regime = self.current_regime.get(asset).copied()
            .unwrap_or(FundingRegime::Neutral);

        match (regime, is_bullish_target) {
            (FundingRegime::ExtremeLong, true) => -self.config.probability_adjustment, // Reduce upside prob
            (FundingRegime::ExtremeLong, false) => self.config.probability_adjustment,  // Increase downside prob
            (FundingRegime::ExtremeShort, true) => self.config.probability_adjustment,  // Increase upside prob (squeeze)
            (FundingRegime::ExtremeShort, false) => -self.config.probability_adjustment, // Reduce downside prob
            (FundingRegime::Neutral, _) => 0.0,
        }
    }

    /// Get average funding rate for an asset
    fn average_funding(&self, asset: &str) -> Option<f64> {
        let rates = self.funding_rates.get(asset)?;
        if rates.is_empty() {
            return None;
        }

        let sum: f64 = rates.iter().map(|d| d.annualized).sum();
        Some(sum / rates.len() as f64)
    }
}

#[async_trait]
impl AnalyzerInstance for FundingRegimeAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::FundingRegime
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

        // Process funding rate events
        if event.metric_type != "funding_rate" && event.metric_type != "funding" {
            return None;
        }

        // Extract asset symbol
        let asset = event.metadata.as_ref()
            .and_then(|m| m.get("asset"))
            .and_then(|v| v.as_str())
            .or_else(|| event.metadata.as_ref()
                .and_then(|m| m.get("symbol"))
                .and_then(|v| v.as_str()))
            .unwrap_or("BTC")
            .to_uppercase();

        // Check if we're tracking this asset
        if !self.config.assets.iter().any(|a| a.to_uppercase() == asset) {
            return None;
        }

        // Get funding rate (expected as 8h rate, e.g., 0.0001 = 0.01%)
        let rate_8h = event.value;
        let annualized = Self::annualize_funding(rate_8h);

        // Store funding data
        let rates = self.funding_rates.entry(asset.clone()).or_insert_with(VecDeque::new);
        rates.push_back(FundingData {
            rate: rate_8h,
            annualized,
            timestamp: event.timestamp,
        });

        // Keep last 24 hours of funding (9 funding periods)
        while rates.len() > 9 {
            rates.pop_front();
        }

        // Get previous regime
        let prev_regime = self.current_regime.get(&asset).copied();

        // Update regime
        let avg_funding = self.average_funding(&asset).unwrap_or(annualized);
        let new_regime = self.classify_regime(avg_funding);
        self.current_regime.insert(asset.clone(), new_regime);

        // Build regime summary
        let regime_summary: HashMap<String, String> = self.current_regime.iter()
            .map(|(k, v)| (k.clone(), format!("{:?}", v)))
            .collect();

        // Cache result
        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "FundingRegime".to_string(),
            value: avg_funding,
            confidence: if new_regime == FundingRegime::Neutral { 0.5 } else { 0.8 },
            metadata: serde_json::json!({
                "asset": asset,
                "latest_rate_8h": rate_8h,
                "annualized_rate": annualized,
                "average_annualized": avg_funding,
                "regime": format!("{:?}", new_regime),
                "extreme_positive_threshold": self.config.extreme_positive,
                "extreme_negative_threshold": self.config.extreme_negative,
                "regime_summary": regime_summary,
            }),
            timestamp: event.timestamp,
        });

        // Generate signal on regime change
        if let Some(prev) = prev_regime {
            if prev != new_regime && new_regime != FundingRegime::Neutral {
                let (side, description) = match new_regime {
                    FundingRegime::ExtremeLong => (TradeSide::Sell, "extreme_long"),
                    FundingRegime::ExtremeShort => (TradeSide::Buy, "extreme_short"),
                    FundingRegime::Neutral => return None,
                };

                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "funding_regime".to_string(),
                    confidence: (avg_funding.abs() / self.config.extreme_positive).min(1.0),
                    market_id: self.node_id.clone(),
                    side,
                    suggested_size: 100.0,
                    max_slippage: 0.02,
                    timestamp: event.timestamp,
                    metadata: serde_json::json!({
                        "asset": asset,
                        "regime": description,
                        "annualized_funding": avg_funding,
                        "adjustment": self.config.probability_adjustment,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 480000, // 8 minute TTL (until next funding)
                });
            }
        }

        None
    }

    async fn process_chained_input(&mut self, result: &AnalyzerResult) -> Option<TradingSignal> {
        // Adjust BlackScholes probability based on funding regime
        if result.result_type == "BlackScholes" {
            let asset = result.metadata.get("asset")
                .and_then(|v| v.as_str())
                .unwrap_or("BTC");

            let probability = result.value;
            let is_bullish = probability > 0.5;

            let adjustment = self.get_adjustment(asset, is_bullish);
            let adjusted_prob = (probability + adjustment).max(0.0).min(1.0);

            // Update result if significant adjustment
            if adjustment.abs() > 0.01 {
                self.latest_result = Some(AnalyzerResult {
                    id: uuid::Uuid::new_v4().to_string(),
                    analyzer_id: self.analyzer_id.clone(),
                    result_type: "FundingAdjusted".to_string(),
                    value: adjusted_prob,
                    confidence: result.confidence,
                    metadata: serde_json::json!({
                        "original_probability": probability,
                        "adjustment": adjustment,
                        "adjusted_probability": adjusted_prob,
                        "asset": asset,
                        "regime": self.current_regime.get(asset).map(|r| format!("{:?}", r)),
                    }),
                    timestamp: result.timestamp,
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
            .map_err(|e| format!("Invalid funding regime config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.funding_rates.clear();
        self.current_regime.clear();
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        !self.funding_rates.is_empty()
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "FundingRegime",
            "ready": self.is_ready(),
            "tracked_assets": self.config.assets,
            "current_regimes": self.current_regime.iter()
                .map(|(k, v)| (k.clone(), format!("{:?}", v)))
                .collect::<HashMap<_, _>>(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::node::InfoSourceType;

    fn make_funding_event(source_id: &str, asset: &str, rate_8h: f64, ts: i64) -> DataEvent {
        DataEvent {
            source_id: source_id.to_string(),
            source_type: InfoSourceType::CryptoPrices,
            metric_type: "funding_rate".to_string(),
            value: rate_8h,
            timestamp: ts,
            metadata: Some(serde_json::json!({
                "asset": asset
            })),
        }
    }

    #[tokio::test]
    async fn test_extreme_long_detection() {
        let config = FundingRegimeConfig {
            extreme_positive: 0.55,
            extreme_negative: -0.30,
            probability_adjustment: 0.05,
            assets: vec!["BTC".to_string()],
        };
        let mut analyzer = FundingRegimeAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // 0.05% per 8h = 0.0005, annualized = 0.0005 * 3 * 365 = 0.5475 = 54.75%
        // This should be just under the extreme threshold
        analyzer.process_event(&make_funding_event("node-1", "BTC", 0.0005, 0)).await;

        // 0.06% per 8h should trigger extreme long
        let signal = analyzer.process_event(&make_funding_event("node-1", "BTC", 0.0006, 1)).await;

        assert_eq!(
            analyzer.current_regime.get("BTC"),
            Some(&FundingRegime::ExtremeLong)
        );
    }

    #[test]
    fn test_annualize_funding() {
        // 0.01% per 8h
        let rate_8h = 0.0001;
        let annualized = FundingRegimeAnalyzer::annualize_funding(rate_8h);
        
        // Should be ~10.95% annualized
        assert!((annualized - 0.1095).abs() < 0.001);
    }
}
