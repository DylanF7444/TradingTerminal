// ============================================================================
// BIAS CORRECTION ANALYZER
// ============================================================================
//
// Computes and applies historical model bias correction.
// Used to adjust weather forecast ensemble probabilities.
//
// METHODOLOGY:
// bias = mean(forecast - actual) over lookback window
// corrected_forecast = raw_forecast - bias
// Per-city, per-month stratification for accuracy
// ============================================================================

use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::collections::{HashMap, VecDeque};

use crate::models::analyzer_node::{AnalyzerResult, AnalyzerType, BiasCorrectionConfig};
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use super::AnalyzerInstance;

#[derive(Debug, Clone)]
struct BiasObservation {
    timestamp: i64,
    forecast: f64,
    actual: f64,
    month: u8,
}

pub struct BiasCorrectionAnalyzer {
    analyzer_id: String,
    node_id: String,
    config: BiasCorrectionConfig,
    /// Historical forecast vs actual pairs
    observations: VecDeque<BiasObservation>,
    /// Computed bias by month (1-12, 0=all)
    bias_by_month: HashMap<u8, f64>,
    /// Overall bias
    overall_bias: f64,
    /// Latest computed result
    latest_result: Option<AnalyzerResult>,
}

impl BiasCorrectionAnalyzer {
    pub fn new(analyzer_id: String, node_id: String, config: BiasCorrectionConfig) -> Self {
        Self {
            analyzer_id,
            node_id,
            config,
            observations: VecDeque::with_capacity(1000),
            bias_by_month: HashMap::new(),
            overall_bias: 0.0,
            latest_result: None,
        }
    }

    /// Calculate bias from observations
    fn calculate_bias(&self, month_filter: Option<u8>) -> Option<f64> {
        let filtered: Vec<&BiasObservation> = self.observations.iter()
            .filter(|o| month_filter.map(|m| o.month == m).unwrap_or(true))
            .collect();

        if filtered.len() < self.config.min_samples {
            return None;
        }

        let sum: f64 = filtered.iter()
            .map(|o| o.forecast - o.actual)
            .sum();

        Some(sum / filtered.len() as f64)
    }

    /// Apply bias correction to a forecast
    pub fn correct_forecast(&self, raw_forecast: f64, month: u8) -> f64 {
        // Try month-specific bias first, fall back to overall
        let bias = self.bias_by_month.get(&month)
            .copied()
            .unwrap_or(self.overall_bias);

        match self.config.correction_type.as_str() {
            "multiplicative" => {
                if bias.abs() < 0.001 {
                    raw_forecast
                } else {
                    raw_forecast * (1.0 - bias / raw_forecast)
                }
            }
            _ => raw_forecast - bias, // Default: additive
        }
    }

    /// Update bias calculations from observations
    fn update_bias(&mut self) {
        // Calculate overall bias
        if let Some(bias) = self.calculate_bias(None) {
            self.overall_bias = bias;
        }

        // Calculate per-month bias
        self.bias_by_month.clear();
        for month in 1..=12 {
            if let Some(bias) = self.calculate_bias(Some(month)) {
                self.bias_by_month.insert(month, bias);
            }
        }
    }
}

#[async_trait]
impl AnalyzerInstance for BiasCorrectionAnalyzer {
    fn analyzer_type(&self) -> AnalyzerType {
        AnalyzerType::BiasCorrection
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

        // Process historical data events for bias training
        if event.metric_type == "historical" || event.metric_type == "bias_training" {
            if let Some(metadata) = &event.metadata {
                let forecast = metadata.get("forecast").and_then(|v| v.as_f64());
                let actual = metadata.get("actual").and_then(|v| v.as_f64());
                let month = metadata.get("month")
                    .and_then(|v| v.as_u64())
                    .map(|m| m as u8)
                    .unwrap_or(0);

                if let (Some(f), Some(a)) = (forecast, actual) {
                    self.observations.push_back(BiasObservation {
                        timestamp: event.timestamp,
                        forecast: f,
                        actual: a,
                        month,
                    });

                    // Trim to lookback window
                    while self.observations.len() > self.config.lookback_days {
                        self.observations.pop_front();
                    }

                    // Update bias calculations
                    self.update_bias();
                }
            }
        }

        // Process forecast events for correction
        if event.metric_type == "ensemble_temperature" || event.metric_type == "forecast" {
            let raw_forecast = event.value;
            let month = event.metadata.as_ref()
                .and_then(|m| m.get("month"))
                .and_then(|v| v.as_u64())
                .map(|m| m as u8)
                .unwrap_or(self.config.month);

            let corrected = self.correct_forecast(raw_forecast, month);
            let bias_applied = self.bias_by_month.get(&month)
                .copied()
                .unwrap_or(self.overall_bias);

            // Cache result
            self.latest_result = Some(AnalyzerResult {
                id: uuid::Uuid::new_v4().to_string(),
                analyzer_id: self.analyzer_id.clone(),
                result_type: "BiasCorrection".to_string(),
                value: corrected,
                confidence: if self.observations.len() >= self.config.min_samples { 0.8 } else { 0.3 },
                metadata: serde_json::json!({
                    "raw_forecast": raw_forecast,
                    "corrected_forecast": corrected,
                    "bias_applied": bias_applied,
                    "city": self.config.city,
                    "month": month,
                    "observation_count": self.observations.len(),
                    "overall_bias": self.overall_bias,
                    "bias_by_month": self.bias_by_month,
                }),
                timestamp: event.timestamp,
            });
        }

        // Bias correction doesn't generate trading signals directly
        // It provides corrected values for downstream analyzers
        None
    }

    async fn process_chained_input(&mut self, result: &AnalyzerResult) -> Option<TradingSignal> {
        // Apply bias correction to chained ensemble probability results
        if result.result_type == "EnsembleProbability" {
            let month = result.metadata.get("month")
                .and_then(|v| v.as_u64())
                .map(|m| m as u8)
                .unwrap_or(0);

            // Correct the mean temperature in the result
            if let Some(mean) = result.metadata.get("ensemble_mean").and_then(|v| v.as_f64()) {
                let corrected = self.correct_forecast(mean, month);
                
                // Update our result with corrected value
                self.latest_result = Some(AnalyzerResult {
                    id: uuid::Uuid::new_v4().to_string(),
                    analyzer_id: self.analyzer_id.clone(),
                    result_type: "BiasCorrection".to_string(),
                    value: corrected,
                    confidence: result.confidence * 0.9,
                    metadata: serde_json::json!({
                        "raw_mean": mean,
                        "corrected_mean": corrected,
                        "bias_applied": self.overall_bias,
                        "source_analyzer": result.analyzer_id,
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
            .map_err(|e| format!("Invalid bias correction config: {}", e))?;
        Ok(())
    }

    fn reset(&mut self) {
        self.observations.clear();
        self.bias_by_month.clear();
        self.overall_bias = 0.0;
        self.latest_result = None;
    }

    fn is_ready(&self) -> bool {
        self.observations.len() >= self.config.min_samples
    }

    fn status(&self) -> JsonValue {
        serde_json::json!({
            "type": "BiasCorrection",
            "ready": self.is_ready(),
            "observation_count": self.observations.len(),
            "min_samples": self.config.min_samples,
            "overall_bias": self.overall_bias,
            "city": self.config.city,
            "months_with_bias": self.bias_by_month.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::node::InfoSourceType;

    #[tokio::test]
    async fn test_bias_calculation() {
        let config = BiasCorrectionConfig {
            lookback_days: 100,
            city: "NYC".to_string(),
            month: 0,
            min_samples: 3,
            correction_type: "additive".to_string(),
        };
        let mut analyzer = BiasCorrectionAnalyzer::new(
            "an-1".to_string(),
            "node-1".to_string(),
            config,
        );

        // Add observations: forecast consistently 2°F too high
        for i in 0..10 {
            analyzer.observations.push_back(BiasObservation {
                timestamp: i,
                forecast: 80.0,
                actual: 78.0, // Actual is 2°F lower
                month: 7, // July
            });
        }

        analyzer.update_bias();

        // Bias should be approximately +2°F
        assert!((analyzer.overall_bias - 2.0).abs() < 0.1);

        // Corrected forecast should subtract bias
        let corrected = analyzer.correct_forecast(80.0, 7);
        assert!((corrected - 78.0).abs() < 0.1);
    }
}
