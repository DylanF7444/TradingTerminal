// ============================================================================
// NOWCAST DEVIATION ANALYZER
// ============================================================================
//
// Detects deviation between economic nowcasts and market implied probabilities.
// Used for CPI/NFP prediction markets on Polymarket/Kalshi.
//
// METHODOLOGY:
// P(CPI > X) = Φ((nowcast_mean - X) / nowcast_stddev) using normal CDF
// Signal when |P_nowcast - P_market| > threshold
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, NowcastDeviationConfig};
use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

pub struct NowcastDeviationAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: NowcastDeviationConfig,
    /// Latest nowcast value
    nowcast_value: Option<f64>,
    /// Latest nowcast confidence interval
    nowcast_stddev: Option<f64>,
    /// Days until release
    days_to_release: Option<u32>,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl NowcastDeviationAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: NowcastDeviationConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            nowcast_value: None,
            nowcast_stddev: None,
            days_to_release: None,
            latest_result: None,
        }
    }

    /// Standard normal CDF approximation
    fn norm_cdf(x: f64) -> f64 {
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

    /// Calculate P(indicator > threshold) using nowcast distribution
    pub fn probability_above(&self, threshold: f64) -> Option<f64> {
        let mean = self.nowcast_value?;
        let std = self.nowcast_stddev.unwrap_or(self.config.std_dev);

        if std <= 0.0 {
            return Some(if mean > threshold { 1.0 } else { 0.0 });
        }

        let z = (mean - threshold) / std;
        Some(Self::norm_cdf(z))
    }

    /// Calculate P(indicator < threshold)
    pub fn probability_below(&self, threshold: f64) -> Option<f64> {
        self.probability_above(threshold).map(|p| 1.0 - p)
    }

    /// Calculate P(indicator in [low, high])
    pub fn probability_between(&self, low: f64, high: f64) -> Option<f64> {
        let p_above_low = self.probability_above(low)?;
        let p_above_high = self.probability_above(high)?;
        Some(p_above_low - p_above_high)
    }
}

#[async_trait]
impl AnalyzerInstance for NowcastDeviationAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::NowcastDeviation
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

        // Process nowcast data events
        if event.metric_type == "nowcast" || event.metric_type == "cleveland_fed" || event.metric_type == "economic_indicator" {
            // Check if this is the indicator we're tracking
            let indicator = event.metadata.as_ref()
                .and_then(|m| m.get("indicator"))
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if !indicator.is_empty() && indicator.to_lowercase() != self.config.indicator.to_lowercase() {
                return None;
            }

            self.nowcast_value = Some(event.value);

            // Extract stddev if available
            if let Some(metadata) = &event.metadata {
                if let Some(std) = metadata.get("stddev").and_then(|v| v.as_f64()) {
                    self.nowcast_stddev = Some(std);
                }
                if let Some(days) = metadata.get("days_to_release").and_then(|v| v.as_u64()) {
                    self.days_to_release = Some(days as u32);
                }
            }
        }

        let nowcast = self.nowcast_value?;
        let std = self.nowcast_stddev.unwrap_or(self.config.std_dev);

        // Extract market target and price if available
        let target = event.metadata.as_ref()
            .and_then(|m| m.get("target_threshold"))
            .and_then(|v| v.as_f64());

        let market_price = event.metadata.as_ref()
            .and_then(|m| m.get("market_price"))
            .and_then(|v| v.as_f64());

        // Calculate model probability if we have a target
        let (model_prob, threshold) = if let Some(t) = target {
            (self.probability_above(t).unwrap_or(0.5), t)
        } else {
            // Default: use nowcast as the target
            (0.5, nowcast)
        };

        // Confidence based on days to release (higher closer to release, lower in final 24h)
        let confidence = match self.days_to_release {
            Some(d) if d == 0 => 0.3, // Final day, sharps dominate
            Some(d) if d <= 1 => 0.5,
            Some(d) if d <= 3 => 0.7,
            Some(d) if d <= 7 => 0.9,
            _ => 0.6,
        };

        // Cache result
        self.latest_result = Some(AnalyzerResult {
            id: uuid::Uuid::new_v4().to_string(),
            analyzer_id: self.analyzer_id.clone(),
            result_type: "NowcastDeviation".to_string(),
            value: nowcast,
            confidence,
            metadata: serde_json::json!({
                "nowcast_value": nowcast,
                "nowcast_stddev": std,
                "indicator": self.config.indicator,
                "model_probability": model_prob,
                "threshold": threshold,
                "days_to_release": self.days_to_release,
            }),
            timestamp: event.timestamp,
        });

        // Generate signal if we have market price to compare
        if let Some(mp) = market_price {
            let deviation = (model_prob - mp).abs();

            // Check if deviation exceeds threshold and we're in the optimal window
            let in_window = self.days_to_release
                .map(|d| d > 1 && d <= self.config.pre_release_days as u32)
                .unwrap_or(true);

            if deviation > self.config.min_deviation && in_window {
                let side = if model_prob > mp {
                    TradeSide::Buy // Nowcast says higher prob
                } else {
                    TradeSide::Sell // Nowcast says lower prob
                };

                return Some(TradingSignal {
                    signal_id: uuid::Uuid::new_v4().to_string(),
                    strategy: "nowcast_deviation".to_string(),
                    confidence: confidence * (deviation / 0.15).min(1.0),
                    market_id: self.node_id.clone(),
                    side,
                    suggested_size: 100.0,
                    max_slippage: 0.02,
                    timestamp: event.timestamp,
                    metadata: serde_json::json!({
                        "nowcast_value": nowcast,
                        "model_probability": model_prob,
                        "market_price": mp,
                        "deviation": deviation,
                        "indicator": self.config.indicator,
                        "days_to_release": self.days_to_release,
                        "analyzer_id": self.analyzer_id,
                    }),
                    ttl_ms: 300000, // 5 minute TTL
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
            .map_err(|e| format!("Invalid nowcast deviation config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.nowcast_value = None;
        self.nowcast_stddev = None;
        self.days_to_release = None;
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        self.nowcast_value.is_some()
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "NowcastDeviation",
            "ready": self.is_ready(),
            "nowcast_value": self.nowcast_value,
            "nowcast_stddev": self.nowcast_stddev,
            "indicator": self.config.indicator,
            "days_to_release": self.days_to_release,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_probability_calculation() {
        let config = NowcastDeviationConfig {
            indicator: "cpi".to_string(),
            std_dev: 0.15,
            min_deviation: 0.10,
            pre_release_days: 7,
        };
        let mut analyzer = NowcastDeviationAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        analyzer.nowcast_value = Some(3.0); // CPI at 3.0%
        analyzer.nowcast_stddev = Some(0.15);

        // P(CPI > 3.0) should be ~50%
        let prob_above_3 = analyzer.probability_above(3.0).unwrap();
        assert!((prob_above_3 - 0.5).abs() < 0.01);

        // P(CPI > 2.7) should be > 95% (two stddevs below mean)
        let prob_above_27 = analyzer.probability_above(2.7).unwrap();
        assert!(prob_above_27 > 0.95);

        // P(CPI > 3.3) should be < 5% (two stddevs above mean)
        let prob_above_33 = analyzer.probability_above(3.3).unwrap();
        assert!(prob_above_33 < 0.05);
    }
}
