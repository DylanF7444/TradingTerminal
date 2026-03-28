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
    /// Detects whale activity and trade spikes
    WhaleActivity,
    /// Weather ensemble → probability calculation
    EnsembleProbability,
    /// Historical model bias adjustment
    BiasCorrection,
    /// Options-based probability pricing (Black-Scholes N(d2))
    BlackScholes,
    /// Count process modeling (tweets, events)
    Poisson,
    /// Cleveland Fed vs market deviation
    NowcastDeviation,
    /// Hawkish/dovish Fed speech classification
    FedSentiment,
    /// Crypto funding rate regime detection
    FundingRegime,
    /// Cross-platform arbitrage spread detection
    SpreadScanner,
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
            AnalyzerType::WhaleActivity => write!(f, "WhaleActivity"),
            AnalyzerType::EnsembleProbability => write!(f, "EnsembleProbability"),
            AnalyzerType::BiasCorrection => write!(f, "BiasCorrection"),
            AnalyzerType::BlackScholes => write!(f, "BlackScholes"),
            AnalyzerType::Poisson => write!(f, "Poisson"),
            AnalyzerType::NowcastDeviation => write!(f, "NowcastDeviation"),
            AnalyzerType::FedSentiment => write!(f, "FedSentiment"),
            AnalyzerType::FundingRegime => write!(f, "FundingRegime"),
            AnalyzerType::SpreadScanner => write!(f, "SpreadScanner"),
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
            "WhaleActivity" => Some(AnalyzerType::WhaleActivity),
            "EnsembleProbability" => Some(AnalyzerType::EnsembleProbability),
            "BiasCorrection" => Some(AnalyzerType::BiasCorrection),
            "BlackScholes" => Some(AnalyzerType::BlackScholes),
            "Poisson" => Some(AnalyzerType::Poisson),
            "NowcastDeviation" => Some(AnalyzerType::NowcastDeviation),
            "FedSentiment" => Some(AnalyzerType::FedSentiment),
            "FundingRegime" => Some(AnalyzerType::FundingRegime),
            "SpreadScanner" => Some(AnalyzerType::SpreadScanner),
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

/// Configuration for WhaleActivity analyzer
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WhaleActivityConfig {
    /// Trade size in USD to flag as "whale" activity
    pub threshold: f64,
    /// Rolling window size in minutes for analysis
    pub window_size: usize,
    /// Sensitivity for spike detection (0.0 - 1.0)
    /// Higher values require larger deviations to trigger
    pub sensitivity: f64,
    /// Minimum number of trades before analysis
    pub min_trades: usize,
}

impl Default for WhaleActivityConfig {
    fn default() -> Self {
        Self {
            threshold: 10000.0, // $10k threshold for whale activity
            window_size: 60,    // 60 minute window
            sensitivity: 0.5,   // Medium sensitivity
            min_trades: 10,     // Need at least 10 trades for meaningful stats
        }
    }
}

// ============================================================================
// NEW ANALYZER CONFIGS FOR PREDICTION MARKET PIPELINES
// ============================================================================

/// Configuration for EnsembleProbability analyzer (Weather markets)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnsembleProbabilityConfig {
    /// Number of ensemble members (default: 31 for GFS)
    pub ensemble_size: usize,
    /// Temperature unit: "fahrenheit" or "celsius"
    pub temperature_unit: String,
    /// Target bucket boundaries [lower, upper] for probability calculation
    pub target_buckets: Vec<(f64, f64)>,
    /// Minimum probability edge vs market (e.g., 0.08 = 8%)
    pub min_edge_threshold: f64,
    /// City station codes for NWS verification
    pub station_codes: Vec<String>,
}

impl Default for EnsembleProbabilityConfig {
    fn default() -> Self {
        Self {
            ensemble_size: 31,
            temperature_unit: "fahrenheit".to_string(),
            target_buckets: vec![(75.0, 80.0), (80.0, 85.0), (85.0, 90.0)],
            min_edge_threshold: 0.08,
            station_codes: vec!["OKX".to_string()], // NYC
        }
    }
}

/// Configuration for BiasCorrection analyzer (Weather markets)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BiasCorrectionConfig {
    /// Lookback period in days for bias calculation
    pub lookback_days: usize,
    /// City identifier for per-city bias
    pub city: String,
    /// Month for seasonal adjustment (1-12, 0 = all)
    pub month: u8,
    /// Minimum samples required for valid bias estimate
    pub min_samples: usize,
    /// Apply additive or multiplicative correction
    pub correction_type: String,
}

impl Default for BiasCorrectionConfig {
    fn default() -> Self {
        Self {
            lookback_days: 730, // 2 years
            city: "NYC".to_string(),
            month: 0, // All months
            min_samples: 30,
            correction_type: "additive".to_string(),
        }
    }
}

/// Configuration for BlackScholes analyzer (Crypto options pricing)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlackScholesConfig {
    /// Risk-free rate (annualized, e.g., 0.05 = 5%)
    pub risk_free_rate: f64,
    /// Default IV to use if market IV unavailable (e.g., 0.80 = 80%)
    pub default_iv: f64,
    /// Minimum probability edge vs market price
    pub min_edge_threshold: f64,
    /// Asset for pricing (BTC, ETH, etc.)
    pub asset: String,
    /// Use DVOL index as IV source
    pub use_dvol: bool,
}

impl Default for BlackScholesConfig {
    fn default() -> Self {
        Self {
            risk_free_rate: 0.05,
            default_iv: 0.80,
            min_edge_threshold: 0.05, // 5 cents
            asset: "BTC".to_string(),
            use_dvol: true,
        }
    }
}

/// Configuration for Poisson analyzer (Tweet/event count markets)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PoissonConfig {
    /// Historical window for λ estimation (days)
    pub lookback_days: usize,
    /// Exponential decay factor for recent data (0.0-1.0)
    pub decay_factor: f64,
    /// Bucket boundaries for count probability
    pub buckets: Vec<(u64, u64)>,
    /// Minimum edge threshold
    pub min_edge_threshold: f64,
    /// Account/entity being tracked
    pub entity_id: String,
}

impl Default for PoissonConfig {
    fn default() -> Self {
        Self {
            lookback_days: 28, // 4 weeks
            decay_factor: 0.3,
            buckets: vec![(200, 249), (250, 299), (300, 349)],
            min_edge_threshold: 0.10, // 10 cents for tweet markets
            entity_id: "elonmusk".to_string(),
        }
    }
}

/// Configuration for NowcastDeviation analyzer (CPI/NFP markets)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NowcastDeviationConfig {
    /// Indicator type: "cpi", "core_cpi", "pce", "core_pce", "nfp"
    pub indicator: String,
    /// Standard deviation for probability distribution
    pub std_dev: f64,
    /// Minimum deviation to trigger signal (percentage points)
    pub min_deviation: f64,
    /// Days before release to start monitoring
    pub pre_release_days: usize,
}

impl Default for NowcastDeviationConfig {
    fn default() -> Self {
        Self {
            indicator: "cpi".to_string(),
            std_dev: 0.15, // ~0.15% for CPI
            min_deviation: 0.10, // 0.1 percentage points
            pre_release_days: 7,
        }
    }
}

/// Configuration for FedSentiment analyzer (FOMC markets)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FedSentimentConfig {
    /// Hawkish keywords and their weights
    pub hawkish_keywords: Vec<(String, f64)>,
    /// Dovish keywords and their weights
    pub dovish_keywords: Vec<(String, f64)>,
    /// Threshold for classification (-1.0 to 1.0)
    pub hawkish_threshold: f64,
    pub dovish_threshold: f64,
    /// Decay factor for older speeches
    pub decay_factor: f64,
}

impl Default for FedSentimentConfig {
    fn default() -> Self {
        Self {
            hawkish_keywords: vec![
                ("inflation".to_string(), 0.3),
                ("rate hike".to_string(), 0.5),
                ("tighten".to_string(), 0.4),
                ("restrictive".to_string(), 0.4),
            ],
            dovish_keywords: vec![
                ("rate cut".to_string(), 0.5),
                ("accommodate".to_string(), 0.4),
                ("labor market slack".to_string(), 0.4),
                ("pause".to_string(), 0.3),
            ],
            hawkish_threshold: 0.3,
            dovish_threshold: -0.3,
            decay_factor: 0.9,
        }
    }
}

/// Configuration for FundingRegime analyzer (Crypto funding rate)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FundingRegimeConfig {
    /// Extreme positive funding threshold (annualized %)
    pub extreme_positive: f64,
    /// Extreme negative funding threshold (annualized %)
    pub extreme_negative: f64,
    /// Probability adjustment when funding is extreme
    pub probability_adjustment: f64,
    /// Assets to monitor
    pub assets: Vec<String>,
}

impl Default for FundingRegimeConfig {
    fn default() -> Self {
        Self {
            extreme_positive: 0.55, // 55% annualized
            extreme_negative: -0.30, // -30% annualized
            probability_adjustment: 0.05, // Adjust by 5%
            assets: vec!["BTC".to_string(), "ETH".to_string()],
        }
    }
}

/// Configuration for SpreadScanner analyzer (Cross-platform arb)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpreadScannerConfig {
    /// Market pairs to scan (Polymarket slug, Kalshi ticker)
    pub market_pairs: Vec<(String, String)>,
    /// Minimum spread after fees to trigger signal
    pub min_spread: f64,
    /// Kalshi fee rate (e.g., 0.07 for 7% of P*(1-P))
    pub kalshi_fee_rate: f64,
    /// Polymarket fee rate (usually 0)
    pub polymarket_fee_rate: f64,
    /// Scan interval in seconds
    pub scan_interval_seconds: u64,
}

impl Default for SpreadScannerConfig {
    fn default() -> Self {
        Self {
            market_pairs: Vec::new(),
            min_spread: 0.03, // 3 cents minimum
            kalshi_fee_rate: 0.07,
            polymarket_fee_rate: 0.0,
            scan_interval_seconds: 60,
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
            AnalyzerType::WhaleActivity => serde_json::to_value(WhaleActivityConfig::default()).unwrap(),
            AnalyzerType::EnsembleProbability => serde_json::to_value(EnsembleProbabilityConfig::default()).unwrap(),
            AnalyzerType::BiasCorrection => serde_json::to_value(BiasCorrectionConfig::default()).unwrap(),
            AnalyzerType::BlackScholes => serde_json::to_value(BlackScholesConfig::default()).unwrap(),
            AnalyzerType::Poisson => serde_json::to_value(PoissonConfig::default()).unwrap(),
            AnalyzerType::NowcastDeviation => serde_json::to_value(NowcastDeviationConfig::default()).unwrap(),
            AnalyzerType::FedSentiment => serde_json::to_value(FedSentimentConfig::default()).unwrap(),
            AnalyzerType::FundingRegime => serde_json::to_value(FundingRegimeConfig::default()).unwrap(),
            AnalyzerType::SpreadScanner => serde_json::to_value(SpreadScannerConfig::default()).unwrap(),
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
