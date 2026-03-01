// ============================================================================
// ANALYZER IMPLEMENTATIONS MODULE
// ============================================================================
//
// Module: services/analyzers/mod.rs
// Purpose: Common trait and exports for all concrete analyzer implementations
// ============================================================================

pub mod correlation;
pub mod momentum;
pub mod arbitrage;
pub mod sentiment;
pub mod rsi;
pub mod volatility;

use crate::models::analyzer_node::{AnalyzerNode, AnalyzerResult, AnalyzerType};
use crate::models::TradingSignal;
use crate::services::analyzer::DataEvent;
use async_trait::async_trait;
use serde_json::Value as JsonValue;
use std::sync::Arc;
use tokio::sync::RwLock;

/// Trait that all concrete analyzers must implement.
///
/// Each analyzer instance processes data events and may produce
/// trading signals or cached results for UI display.
#[async_trait]
pub trait AnalyzerInstance: Send + Sync {
    /// Get the analyzer type
    fn analyzer_type(&self) -> AnalyzerType;

    /// Get the analyzer node ID
    fn analyzer_id(&self) -> &str;

    /// Get the parent graph node ID
    fn node_id(&self) -> &str;

    /// Process a single data event.
    /// Returns an optional trading signal if conditions are met.
    async fn process_event(&mut self, event: &DataEvent) -> Option<TradingSignal>;

    /// Process chained input from another analyzer's output.
    /// Returns an optional trading signal if conditions are met.
    async fn process_chained_input(&mut self, result: &AnalyzerResult) -> Option<TradingSignal> {
        // Default: ignore chained input
        let _ = result;
        None
    }

    /// Get the latest cached result for UI display
    async fn get_latest_result(&self) -> Option<AnalyzerResult>;

    /// Update the analyzer configuration at runtime
    fn update_config(&mut self, config: JsonValue) -> Result<(), String>;

    /// Reset analyzer state (clear buffers, history)
    fn reset(&mut self);

    /// Check if the analyzer is ready to produce signals
    fn is_ready(&self) -> bool;

    /// Get current status as JSON for UI
    fn status(&self) -> JsonValue;
}

/// Factory function to create an analyzer instance from configuration
pub fn create_analyzer(analyzer_node: &AnalyzerNode) -> Result<Box<dyn AnalyzerInstance>, String> {
    match analyzer_node.analyzer_type {
        AnalyzerType::Correlation => {
            let config = serde_json::from_value(analyzer_node.config.clone())
                .map_err(|e| format!("Invalid correlation config: {}", e))?;
            Ok(Box::new(correlation::CorrelationAnalyzer::new(
                analyzer_node.id.clone(),
                analyzer_node.node_id.clone(),
                config,
            )))
        }
        AnalyzerType::Momentum => {
            let config = serde_json::from_value(analyzer_node.config.clone())
                .map_err(|e| format!("Invalid momentum config: {}", e))?;
            Ok(Box::new(momentum::MomentumAnalyzer::new(
                analyzer_node.id.clone(),
                analyzer_node.node_id.clone(),
                config,
            )))
        }
        AnalyzerType::Arbitrage => {
            let config = serde_json::from_value(analyzer_node.config.clone())
                .map_err(|e| format!("Invalid arbitrage config: {}", e))?;
            Ok(Box::new(arbitrage::ArbitrageAnalyzer::new(
                analyzer_node.id.clone(),
                analyzer_node.node_id.clone(),
                config,
            )))
        }
        AnalyzerType::Sentiment => {
            let config = serde_json::from_value(analyzer_node.config.clone())
                .map_err(|e| format!("Invalid sentiment config: {}", e))?;
            Ok(Box::new(sentiment::SentimentAnalyzer::new(
                analyzer_node.id.clone(),
                analyzer_node.node_id.clone(),
                config,
            )))
        }
        AnalyzerType::RSI => {
            let config = serde_json::from_value(analyzer_node.config.clone())
                .map_err(|e| format!("Invalid RSI config: {}", e))?;
            Ok(Box::new(rsi::RSIAnalyzer::new(
                analyzer_node.id.clone(),
                analyzer_node.node_id.clone(),
                config,
            )))
        }
        AnalyzerType::Volatility => {
            let config = serde_json::from_value(analyzer_node.config.clone())
                .map_err(|e| format!("Invalid volatility config: {}", e))?;
            Ok(Box::new(volatility::VolatilityAnalyzer::new(
                analyzer_node.id.clone(),
                analyzer_node.node_id.clone(),
                config,
            )))
        }
        AnalyzerType::Custom => {
            Err("Custom analyzer requires a specific implementation".to_string())
        }
    }
}
