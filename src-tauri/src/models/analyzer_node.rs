// ============================================================================
// ANALYZER NODE MODEL
// ============================================================================
//
// Module: models/analyzer_node.rs
// Purpose: Data structures for analyzer node configurations attached to graph nodes
//
// OVERVIEW:
// Analyzer nodes are modular analysis units that can be attached to any graph node.
// Each analyzer processes data flowing through the node and emits trading signals.
// Multiple analyzers can be chained together to form analysis pipelines.
//
// DATA FLOW:
// Scraper → DataEvent → AnalyzerPipeline → AnalyzerInstance → TradingSignal → Executor
//
// ANALYZER TYPES:
// - Correlation: Tracks correlation between source node and connected market nodes
// - Momentum: EMA-based momentum detection with configurable periods
// - Arbitrage: Detects price discrepancies between connected markets
// - Sentiment: Processes news/social data for sentiment scoring
// - RSI: Overbought/oversold detection (0-100 scale)
// - Volatility: Measures price volatility for risk assessment
// - Custom: User-defined analysis logic via configuration
// ============================================================================

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// Analyzer node configuration attached to a graph node
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzerNode {
    /// Unique identifier (UUID v4)
    pub id: String,

    /// Foreign key to the graph node this analyzer is attached to
    pub node_id: String,

    /// Type of analysis to perform
    pub analyzer_type: AnalyzerType,

    /// Type-specific configuration stored as JSON
    pub config: JsonValue,

    /// Whether this analyzer is active
    pub enabled: bool,

    /// Display name for the analyzer (user-facing)
    pub name: String,

    /// Unix timestamp when created
    pub created_at: i64,

    /// Unix timestamp when last updated
    pub updated_at: i64,
}

/// Supported analyzer types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum AnalyzerType {
    /// Tracks correlation between source node and connected market nodes
    Correlation,
    /// EMA-based momentum detection with configurable periods
    Momentum,
    /// Detects price discrepancies between connected markets
    Arbitrage,
    /// Processes news/social data for sentiment scoring
    Sentiment,
    /// Overbought/oversold detection (RSI 0-100)
    RSI,
    /// Measures price volatility for risk assessment
    Volatility,
    /// User-defined analysis via custom configuration
    Custom,
}

impl std::fmt::Display for AnalyzerType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AnalyzerType::Correlation => write!(f, "Correlation"),
            AnalyzerType::Momentum => write!(f, "Momentum"),
            AnalyzerType::Arbitrage => write!(f, "Arbitrage"),
            AnalyzerType::Sentiment => write!(f, "Sentiment"),
            AnalyzerType::RSI => write!(f, "RSI"),
            AnalyzerType::Volatility => write!(f, "Volatility"),
            AnalyzerType::Custom => write!(f, "Custom"),
        }
    }
}

impl AnalyzerType {
    /// Parse from string (used for DB deserialization)
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "Correlation" => Some(AnalyzerType::Correlation),
            "Momentum" => Some(AnalyzerType::Momentum),
            "Arbitrage" => Some(AnalyzerType::Arbitrage),
            "Sentiment" => Some(AnalyzerType::Sentiment),
            "RSI" => Some(AnalyzerType::RSI),
            "Volatility" => Some(AnalyzerType::Volatility),
            "Custom" => Some(AnalyzerType::Custom),
            _ => None,
        }
    }
}

/// Configuration for Correlation analyzer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CorrelationConfig {
    /// Rolling window size in data points
    pub window_size: usize,
    /// Minimum correlation threshold to emit signal (0.0 - 1.0)
    pub min_threshold: f64,
    /// Target node IDs to correlate against
    pub target_node_ids: Vec<String>,
    /// Update interval in milliseconds
    pub update_interval_ms: u64,
}

impl Default for CorrelationConfig {
    fn default() -> Self {
        Self {
            window_size: 100,
            min_threshold: 0.7,
            target_node_ids: Vec::new(),
            update_interval_ms: 5000,
        }
    }
}

/// Configuration for Momentum analyzer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MomentumConfig {
    /// EMA short period
    pub ema_short_period: usize,
    /// EMA long period
    pub ema_long_period: usize,
    /// Momentum threshold to trigger signal (percentage)
    pub threshold: f64,
    /// Lookback window for price history
    pub lookback_period: usize,
}

impl Default for MomentumConfig {
    fn default() -> Self {
        Self {
            ema_short_period: 12,
            ema_long_period: 26,
            threshold: 0.02,
            lookback_period: 50,
        }
    }
}

/// Configuration for Arbitrage analyzer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArbitrageConfig {
    /// Minimum profit margin to emit signal (e.g., 0.005 = 0.5%)
    pub min_profit_margin: f64,
    /// Market IDs to compare against
    pub market_ids: Vec<String>,
    /// Fee percentage per market (for profit calculation)
    pub fee_percent: f64,
    /// Maximum execution time allowed in ms
    pub max_execution_time_ms: u64,
}

impl Default for ArbitrageConfig {
    fn default() -> Self {
        Self {
            min_profit_margin: 0.005,
            market_ids: Vec::new(),
            fee_percent: 0.02,
            max_execution_time_ms: 5000,
        }
    }
}

/// Configuration for Sentiment analyzer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SentimentConfig {
    /// Positive sentiment threshold for BUY signal
    pub positive_threshold: f64,
    /// Negative sentiment threshold for SELL signal
    pub negative_threshold: f64,
    /// Minimum volume of data points before emitting signal
    pub min_data_points: usize,
    /// Keywords to weight higher
    pub keywords: Vec<String>,
    /// Decay factor for older data points (0.0 - 1.0)
    pub decay_factor: f64,
}

impl Default for SentimentConfig {
    fn default() -> Self {
        Self {
            positive_threshold: 0.7,
            negative_threshold: -0.7,
            min_data_points: 10,
            keywords: Vec::new(),
            decay_factor: 0.95,
        }
    }
}

/// Configuration for RSI analyzer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RSIConfig {
    /// RSI calculation period (default: 14)
    pub period: usize,
    /// Overbought threshold (default: 70)
    pub overbought_threshold: f64,
    /// Oversold threshold (default: 30)
    pub oversold_threshold: f64,
    /// Smoothing method: "sma" or "ema"
    pub smoothing: String,
}

impl Default for RSIConfig {
    fn default() -> Self {
        Self {
            period: 14,
            overbought_threshold: 70.0,
            oversold_threshold: 30.0,
            smoothing: "sma".to_string(),
        }
    }
}

/// Configuration for Volatility analyzer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolatilityConfig {
    /// Rolling window for volatility calculation
    pub window_size: usize,
    /// High volatility threshold (standard deviations)
    pub high_threshold: f64,
    /// Low volatility threshold (standard deviations)
    pub low_threshold: f64,
    /// Whether to annualize the volatility
    pub annualize: bool,
    /// Data points per day (for annualization)
    pub data_points_per_day: usize,
}

impl Default for VolatilityConfig {
    fn default() -> Self {
        Self {
            window_size: 20,
            high_threshold: 2.0,
            low_threshold: 0.5,
            annualize: true,
            data_points_per_day: 288, // Every 5 minutes
        }
    }
}

/// Cached analysis result for UI display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzerResult {
    /// Unique result ID
    pub id: String,
    /// Analyzer node that produced this result
    pub analyzer_id: String,
    /// Type of result (matches analyzer type)
    pub result_type: String,
    /// Computed value (context-dependent)
    pub value: f64,
    /// Confidence score (0.0 - 1.0)
    pub confidence: f64,
    /// Additional result metadata
    pub metadata: JsonValue,
    /// Unix timestamp when computed
    pub timestamp: i64,
}

/// Defines a chaining relationship between analyzers
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzerChain {
    /// Unique chain ID
    pub id: String,
    /// Source analyzer ID (output feeds into target)
    pub source_analyzer_id: String,
    /// Target analyzer ID (receives input from source)
    pub target_analyzer_id: String,
    /// Transformation to apply to output before passing (optional)
    pub transform: Option<String>,
    /// Whether this chain link is active
    pub enabled: bool,
    /// Unix timestamp when created
    pub created_at: i64,
}

impl AnalyzerNode {
    /// Create a new analyzer node with defaults
    pub fn new(
        node_id: String,
        analyzer_type: AnalyzerType,
        name: String,
        config: JsonValue,
    ) -> Self {
        let now = chrono::Utc::now().timestamp();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            node_id,
            analyzer_type,
            config,
            enabled: true,
            name,
            created_at: now,
            updated_at: now,
        }
    }

    /// Get default config JSON for a given analyzer type
    pub fn default_config(analyzer_type: &AnalyzerType) -> JsonValue {
        match analyzer_type {
            AnalyzerType::Correlation => serde_json::to_value(CorrelationConfig::default()).unwrap(),
            AnalyzerType::Momentum => serde_json::to_value(MomentumConfig::default()).unwrap(),
            AnalyzerType::Arbitrage => serde_json::to_value(ArbitrageConfig::default()).unwrap(),
            AnalyzerType::Sentiment => serde_json::to_value(SentimentConfig::default()).unwrap(),
            AnalyzerType::RSI => serde_json::to_value(RSIConfig::default()).unwrap(),
            AnalyzerType::Volatility => serde_json::to_value(VolatilityConfig::default()).unwrap(),
            AnalyzerType::Custom => serde_json::json!({}),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_analyzer_node_creation() {
        let node = AnalyzerNode::new(
            "node-123".to_string(),
            AnalyzerType::RSI,
            "RSI Analyzer".to_string(),
            serde_json::to_value(RSIConfig::default()).unwrap(),
        );

        assert_eq!(node.node_id, "node-123");
        assert_eq!(node.analyzer_type, AnalyzerType::RSI);
        assert!(node.enabled);
        assert_eq!(node.name, "RSI Analyzer");
    }

    #[test]
    fn test_analyzer_type_display() {
        assert_eq!(AnalyzerType::Correlation.to_string(), "Correlation");
        assert_eq!(AnalyzerType::Momentum.to_string(), "Momentum");
        assert_eq!(AnalyzerType::RSI.to_string(), "RSI");
    }

    #[test]
    fn test_analyzer_type_from_str() {
        assert_eq!(AnalyzerType::from_str("Correlation"), Some(AnalyzerType::Correlation));
        assert_eq!(AnalyzerType::from_str("RSI"), Some(AnalyzerType::RSI));
        assert_eq!(AnalyzerType::from_str("Invalid"), None);
    }

    #[test]
    fn test_default_configs() {
        let rsi_config = AnalyzerNode::default_config(&AnalyzerType::RSI);
        assert_eq!(rsi_config["period"], 14);
        assert_eq!(rsi_config["overbought_threshold"], 70.0);

        let momentum_config = AnalyzerNode::default_config(&AnalyzerType::Momentum);
        assert_eq!(momentum_config["ema_short_period"], 12);
        assert_eq!(momentum_config["ema_long_period"], 26);
    }

    #[test]
    fn test_analyzer_node_serialization() {
        let node = AnalyzerNode::new(
            "node-456".to_string(),
            AnalyzerType::Volatility,
            "Vol Monitor".to_string(),
            serde_json::json!({"window_size": 30}),
        );

        let json = serde_json::to_string(&node).unwrap();
        assert!(json.contains("Volatility"));
        assert!(json.contains("Vol Monitor"));

        let deserialized: AnalyzerNode = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.analyzer_type, AnalyzerType::Volatility);
        assert_eq!(deserialized.node_id, "node-456");
    }

    #[test]
    fn test_analyzer_result_serialization() {
        let result = AnalyzerResult {
            id: "res-1".to_string(),
            analyzer_id: "an-1".to_string(),
            result_type: "RSI".to_string(),
            value: 72.5,
            confidence: 0.85,
            metadata: serde_json::json!({"period": 14}),
            timestamp: 1704067200,
        };

        let json = serde_json::to_string(&result).unwrap();
        let deserialized: AnalyzerResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.value, 72.5);
        assert_eq!(deserialized.confidence, 0.85);
    }

    #[test]
    fn test_analyzer_chain_serialization() {
        let chain = AnalyzerChain {
            id: "chain-1".to_string(),
            source_analyzer_id: "an-1".to_string(),
            target_analyzer_id: "an-2".to_string(),
            transform: Some("normalize".to_string()),
            enabled: true,
            created_at: 1704067200,
        };

        let json = serde_json::to_string(&chain).unwrap();
        let deserialized: AnalyzerChain = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.source_analyzer_id, "an-1");
        assert_eq!(deserialized.target_analyzer_id, "an-2");
        assert_eq!(deserialized.transform, Some("normalize".to_string()));
    }
}
