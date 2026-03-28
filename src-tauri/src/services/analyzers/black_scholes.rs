// ============================================================================
// BLACK-SCHOLES PROBABILITY ANALYZER
// ============================================================================
//
// Computes probability of price outcomes using Black-Scholes N(d2) formula.
// Used for crypto price target markets on Polymarket/Kalshi.
//
// METHODOLOGY:
// P(S_T > K) = N(d2) where d2 = [ln(S/K) + (r - σ²/2)T] / (σ√T)
// Uses Deribit DVOL or options IV for σ (implied volatility)
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::f64::consts::PI;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, BlackScholesConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

pub struct BlackScholesAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: BlackScholesConfig,
    /// Current spot price
    spot_price: Option<f64>,
    /// Current implied volatility (annualized)
    implied_vol: Option<f64>,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl BlackScholesAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: BlackScholesConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            spot_price: None,
            implied_vol: None,
            latest_result: None,
        }
    }

    /// Standard normal CDF approximation (Abramowitz & Stegun)
    fn norm_cdf(x: f64) -> f64 {
        // Constants for approximation
        const A1: f64 = 0.254829592;
        const A2: f64 = -0.284496736;
        const A3: f64 = 1.421413741;
        const A4: f64 = -1.453152027;
        const A5: f64 = 1.061405429;
        const P: f64 = 0.3275911;

        let sign = if x < 0.0 { -1.0 } else { 1.0 };
        let x = x.abs();

        let t = 1.0 / (1.0 + P * x);
        let y = 1.0 - (((((A5 * t + A4) * t) + A3) * t + A2) * t + A1) * t 
            * (-x * x / 2.0).exp();

        0.5 * (1.0 + sign * y)
    }

    /// Calculate d2 for Black-Scholes
    fn calculate_d2(&self, spot: f64, strike: f64, time_to_expiry: f64, vol: f64) -> f64 {
        let r = self.config.risk_free_rate;
        let ln_ratio = (spot / strike).ln();
        let drift = (r - vol * vol / 2.0) * time_to_expiry;
        let diffusion = vol * time_to_expiry.sqrt();
        
        (ln_ratio + drift) / diffusion
    }

    /// Calculate probability that spot > strike at expiry
    pub fn probability_above(&self, strike: f64, time_to_expiry_years: f64) -> Option<f64> {
        let spot = self.spot_price?;
        let vol = self.implied_vol.unwrap_or(self.config.default_iv);
        
        if vol <= 0.0 || time_to_expiry_years <= 0.0 || strike <= 0.0 {
            return None;
        }

        let d2 = self.calculate_d2(spot, strike, time_to_expiry_years, vol);
        Some(Self::norm_cdf(d2))
    }

    /// Calculate probability that spot < strike at expiry
    pub fn probability_below(&self, strike: f64, time_to_expiry_years: f64) -> Option<f64> {
        self.probability_above(strike, time_to_expiry_years)
            .map(|p| 1.0 - p)
    }

    /// Calculate probability that spot is between low and high strikes
    pub fn probability_between(&self, low: f64, high: f64, time_to_expiry_years: f64) -> Option<f64> {
        let p_above_low = self.probability_above(low, time_to_expiry_years)?;
        let p_above_high = self.probability_above(high, time_to_expiry_years)?;
        Some(p_above_low - p_above_high)
    }
}

#[async_trait]
impl AnalyzerInstance for BlackScholesAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::BlackScholes
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

        // Update spot price from price events
        if event.metric_type == "price" {
            if event.value.is_finite() && event.value > 0.0 {
                self.spot_price = Some(event.value);
            }
        }

        // Update IV from DVOL or options data
        if event.metric_type == "dvol" || event.metric_type == "implied_volatility" {
            if event.value.is_finite() && event.value > 0.0 {
                // DVOL is usually in percentage points (e.g., 80 = 80%)
                // Convert to decimal if needed
                let iv = if event.value > 5.0 { event.value / 100.0 } else { event.value };
                self.implied_vol = Some(iv);
            }
        }

        // Need both spot and IV to calculate probabilities
        let spot = self.spot_price?;
        let vol = self.implied_vol.unwrap_or(self.config.default_iv);

        // Extract target strike and expiry from metadata if available
        let strike = event.metadata.as_ref()
            .and_then(|m| m.get("target_strike"))
            .and_then(|v| v.as_f64());
        let expiry_days = event.metadata.as_ref()
            .and_then(|m| m.get("days_to_expiry"))
            .and_then(|v| v.as_f64())
            .unwrap_or(7.0); // Default to 1 week

        let time_to_expiry = expiry_days / 365.0;

        // Calculate probability for the target if available
        let (probability, strike_price) = if let Some(k) = strike {
            (self.probability_above(k, time_to_expiry).unwrap_or(0.5), k)
        } else {
            // Default: probability of 10% move up
            let default_strike = spot * 1.10;
            (self.probability_above(default_strike, time_to_expiry).unwrap_or(0.5), default_strike)
        };

        // Confidence based on IV reliability
        let confidence = if self.implied_vol.is_some() { 0.85 } else { 0.6 };

        // Cache result
        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "BlackScholes".to_string(),
            value: probability,
            confidence,
            metadata: serde_json::json!({
                "spot_price": spot,
                "implied_volatility": vol,
                "strike_price": strike_price,
                "days_to_expiry": expiry_days,
                "probability_above": probability,
                "probability_below": 1.0 - probability,
                "asset": self.config.asset,
            }),
            timestamp: event.timestamp,
        });

        // Extract market price for edge calculation if available
        let market_price = event.metadata.as_ref()
            .and_then(|m| m.get("market_price"))
            .and_then(|v| v.as_f64());

        if let Some(mp) = market_price {
            let edge = (probability - mp).abs();
            
            if edge > self.config.min_edge_threshold {
                // Significant edge detected
                let side = if probability > mp {
                    TradeSide::Buy // Model says higher prob than market
                } else {
                    TradeSide::Sell // Model says lower prob than market
                };

                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "black_scholes".to_string(),
                    confidence: confidence * (edge / 0.10).min(1.0), // Scale by edge size
                    market_id: self.node_id.clone(),
                    side,
                    suggested_size: 100.0,
                    max_slippage: 0.02,
                    timestamp: event.timestamp,
                    metadata: serde_json::json!({
                        "model_probability": probability,
                        "market_price": mp,
                        "edge": edge,
                        "strike": strike_price,
                        "implied_vol": vol,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 60000, // 1 minute TTL
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
            .map_err(|e| format!("Invalid Black-Scholes config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.spot_price = None;
        self.implied_vol = None;
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        self.spot_price.is_some()
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "BlackScholes",
            "ready": self.is_ready(),
            "spot_price": self.spot_price,
            "implied_vol": self.implied_vol,
            "default_iv": self.config.default_iv,
            "asset": self.config.asset,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::node::InfoSourceType;

    #[test]
    fn test_norm_cdf() {
        // Test standard normal CDF at key points
        assert!((BlackScholesAnalyzer::norm_cdf(0.0) - 0.5).abs() < 0.001);
        assert!((BlackScholesAnalyzer::norm_cdf(-1.96) - 0.025).abs() < 0.01);
        assert!((BlackScholesAnalyzer::norm_cdf(1.96) - 0.975).abs() < 0.01);
    }

    #[test]
    fn test_probability_at_money() {
        let config = BlackScholesConfig {
            risk_free_rate: 0.05,
            default_iv: 0.80,
            min_edge_threshold: 0.05,
            asset: "BTC".to_string(),
            use_dvol: true,
        };
        let mut analyzer = BlackScholesAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        analyzer.spot_price = Some(100000.0);
        analyzer.implied_vol = Some(0.80);

        // At-the-money call with 1 year to expiry
        let prob = analyzer.probability_above(100000.0, 1.0).unwrap();
        // With drift = r - σ²/2 = 0.05 - 0.32 = -0.27, slightly less than 50%
        assert!(prob < 0.55 && prob > 0.35, "ATM prob should be near 50%, got {}", prob);
    }

    #[test]
    fn test_probability_deep_itm() {
        let config = BlackScholesConfig {
            risk_free_rate: 0.05,
            default_iv: 0.50,
            min_edge_threshold: 0.05,
            asset: "BTC".to_string(),
            use_dvol: true,
        };
        let mut analyzer = BlackScholesAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        analyzer.spot_price = Some(100000.0);
        analyzer.implied_vol = Some(0.50);

        // Deep ITM: spot at 100k, strike at 50k, 1 week to expiry
        let prob = analyzer.probability_above(50000.0, 7.0 / 365.0).unwrap();
        assert!(prob > 0.99, "Deep ITM should be near 100%, got {}", prob);
    }
}
