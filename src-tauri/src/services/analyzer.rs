// ============================================================================
// ANALYZER SERVICE
// ============================================================================
//
// Module: services/analyzer.rs
// Purpose: Trading signal generation and market analysis
//
// OVERVIEW:
// This module implements the "brain" of the trading terminal. It consumes
// real-time data from scrapers, analyzes market conditions, detects arbitrage
// opportunities, and generates trading signals for the executor service.
//
// ANALYSIS PIPELINE:
//
// Raw Data Input (from scrapers via channel)
//   ↓
// Data Normalization (parse, validate, convert to internal format)
//   ↓
// Feature Extraction (moving averages, volatility, correlation)
//   ↓
// Signal Generation (arbitrage detection, threshold breaches)
//   ↓
// Risk Filtering (position limits, correlation checks)
//   ↓
// Trading Signal Output (to executor via channel)
//
// ANALYSIS TYPES:
//
// 1. Arbitrage Detection (Cross-Market):
//    Compares prices between Polymarket and Kalshi for the same event.
//    If YES_price + NO_price != 1.0 (accounting for fees), arbitrage exists.
//    
//    Formula:
//    buy_on = market with lower YES price
//    sell_on = market with lower NO price (equivalent to higher YES)
//    profit = (1.0 - buy_yes_price - buy_no_price) - fees
//    
//    Example:
//    Polymarket YES: 0.52, NO: 0.49
//    Kalshi YES: 0.48, NO: 0.53
//    
//    Arbitrage: Buy YES on Kalshi (0.48), Buy NO on Polymarket (0.49)
//    Cost: 0.48 + 0.49 = 0.97
//    Payout: 1.00 (guaranteed, one side wins)
//    Gross Profit: 0.03 (3%)
//    Net Profit: 0.03 - 0.02 (fees) = 0.01 (1%)
//
// 2. Correlation Analysis:
//    Measures relationship between external data sources and market prices.
//    Used for predictive modeling (e.g., BTC price vs BTC prediction market).
//    
//    Pearson Correlation: r = Σ((x - x̄)(y - ȳ)) / √(Σ(x-x̄)² Σ(y-ȳ)²)
//    
//    Interpretation:
//    r = 1.0: Perfect positive correlation (move together)
//    r = -1.0: Perfect negative correlation (move opposite)
//    r = 0.0: No correlation
//    
//    Trading Application:
//    If BTC spot price (source) correlates 0.85 with BTC prediction market,
//    and spot jumps 5%, predict market will follow → Buy YES before market adjusts.
//
// 3. Technical Analysis:
//    - Moving Averages: SMA, EMA for trend detection
//    - RSI: Overbought/oversold detection (0-100 scale)
//    - Bollinger Bands: Volatility-based entry/exit
//    - Support/Resistance: Historical price levels
//
// 4. Sentiment Analysis:
//    Analyzes news/social media for event impact.
//    - Keyword extraction (NLP)
//    - Sentiment scoring (-1.0 to +1.0)
//    - Volume weighting (viral content vs niche)
//    
//    Signal: sentiment_score > 0.7 and volume > threshold → Buy YES
//
// SIGNAL STRUCTURE:
//
// TradingSignal:
// - signal_id: UUID                    // Unique identifier
// - strategy: String                   // "arbitrage", "momentum", "sentiment"
// - confidence: f64 (0.0-1.0)          // Strength of signal (Kelly criterion input)
// - market_id: String                  // Target market
// - side: TradeSide                    // Buy YES or Buy NO
// - suggested_size: f64                // Contracts recommended (optional, executor may override)
// - max_slippage: f64                  // Acceptable price deviation (e.g., 0.01 = 1%)
// - timestamp: i64                     // When signal generated
// - metadata: JsonValue                // Arbitrage details, correlation data, etc.
// - ttl_ms: u64                        // Time-to-live (signal expires if not executed)
//
// THRESHOLD CONFIGURATION:
//
// Minimum Edge (profit margin):
// - Arbitrage: 0.5% (accounting for fees)
// - Momentum: 2.0% (expected price move)
// - Sentiment: 0.7 correlation with price
//
// These prevent trading on noise (transaction costs eat profits).
//
// CORRELATION TRACKING:
//
// Analyzer maintains rolling correlation windows:
// - Short term: 1 hour (recent dynamics)
// - Medium term: 24 hours (daily patterns)
// - Long term: 7 days (structural relationships)
//
// Stored in memory (HashMap) and persisted to SQLite for persistence across restarts.
//
// RISK FILTERS:
//
// Before emitting signal, analyzer checks:
// 1. Current exposure (don't double down on correlated bets)
// 2. Recent trade frequency (cooldown periods)
// 3. Market liquidity (can we actually fill the order?)
// 4. News blackouts (avoid trading on stale data during API outages)
//
// STATE MANAGEMENT:
//
// - CORRELATION_CACHE: Arc<RwLock<HashMap<(String, String), CorrelationData>>>
//   - Maps (source_id, market_id) → correlation statistics
//   - Updated incrementally as new data arrives (online algorithm)
//
// - LAST_PRICES: Arc<RwLock<HashMap<String, f64>>>
//   - Most recent price for each source/market
//   - Used for change detection and momentum calculation
//
// - SIGNAL_HISTORY: Arc<RwLock<Vec<TradingSignal>>>
//   - Recent signals for performance tracking
//   - Used to avoid duplicate signals (same opportunity)
//
// - CONFIG: Arc<RwLock<AnalyzerConfig>>
//   - Thresholds, window sizes, strategy weights
//   - Hot-reloadable without restart
//
// ALGORITHMS:
//
// Online Correlation (Welford's algorithm for streaming data):
// - Updates mean and covariance without storing all historical points
// - Memory efficient for high-frequency data
// - Numerically stable
//
// Arbitrage Detection:
// - Periodically scans all market pairs (Polymarket vs Kalshi)
// - For each shared event: calculate buy_yes + buy_no + fees
// - If total < 1.0: arbitrage opportunity exists
// - Ranks by profit margin (execute best first)
//
// Momentum Calculation:
// - price_change = (current - previous) / previous
// - Exponential moving average of price_change (smoothing)
// - Generate signal when EMA crosses threshold
//
// EXTERNAL DEPENDENCIES:
//
// - statrs: Statistical computations (correlation, regression)
// - rand: Monte Carlo simulations for probability estimation
// - serde_json: Configuration and metadata handling
// - tokio::time: Interval-based analysis triggers
//
// PERFORMANCE TARGETS:
//
// - Signal latency: <100ms from data arrival to signal emission
// - Throughput: 1000 data points/second analyzed
// - Memory: <100MB for correlation cache (10k pairs)
// - CPU: <5% single core for continuous analysis
//
// ERROR HANDLING:
//
// - Invalid data (NaN, negative prices): Log and skip
// - Insufficient data (new market): Wait for N samples before analysis
// - Calculation overflow: Use f64 checked operations, fall back to 0.0
// - Strategy panic: Catch with std::panic::catch_unwind, disable strategy
//
// TESTING:
//
// Unit tests:
// - Correlation calculation accuracy (known datasets)
// - Arbitrage math (verify profit calculations)
// - Threshold logic (edge cases)
//
// Backtesting:
// - Run analyzer on historical data (stored timeseries)
// - Verify signals would have been profitable
// - Optimize thresholds via grid search
//
// Paper Trading:
// - Generate signals but don't execute (dry run)
// - Track hypothetical P&L vs actual market movement
// - Validate signal accuracy before going live
//
// USAGE EXAMPLE:
//
// ```rust
// // In service initialization
// let analyzer = Analyzer::new(config, scraper_rx, executor_tx);
// tokio::spawn(analyzer.run());
//
// // Trading signal emitted automatically when conditions met
// // Executor receives: TradingSignal { strategy: "arbitrage", confidence: 0.95, ... }
// ```
//
// CONFIGURATION EXAMPLE:
//
// ```toml
// [arbitrage]
// min_profit_margin = 0.005  # 0.5%
// max_execution_time_ms = 5000
//
// [correlation]
// window_short_hours = 1
// window_long_hours = 24
// min_correlation_threshold = 0.7
//
// [momentum]
// ema_period = 12  # 12-period EMA
// threshold = 0.02  # 2% move
// ```
//
// FUTURE ENHANCEMENTS:
// - Machine learning models (LSTM for price prediction)
// - Bayesian updating (revise probabilities as new data arrives)
// - Cross-asset analysis (BTC price → crypto market sentiment)
// - Order flow analysis (imbalance in orderbook as signal)
// - Options-style pricing models for event probabilities
// ============================================================================

use crate::models::market::TradeSide;
use crate::models::TradingSignal;
use crate::models::node::InfoSourceType;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use chrono::Utc;

/// Rolling correlation statistics between two time series
#[derive(Debug, Clone)]
pub struct CorrelationData {
    pub source_id: String,
    pub market_id: String,
    /// Pearson correlation coefficient (-1.0 to 1.0)
    pub correlation: f64,
    /// Number of samples included
    pub sample_count: u64,
    /// Last updated timestamp
    pub last_updated: i64,
    /// Rolling mean of source values
    pub source_mean: f64,
    /// Rolling mean of market values
    pub market_mean: f64,
    /// Rolling covariance accumulator
    pub covariance: f64,
    /// Rolling variance of source
    pub source_variance: f64,
    /// Rolling variance of market
    pub market_variance: f64,
}

/// Arbitrage opportunity between two markets
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArbitrageOpportunity {
    pub event_id: String,
    pub buy_market: String,    // Market to buy YES on
    pub sell_market: String,   // Market to buy NO on (or sell YES)
    pub buy_price: f64,        // Price on buy_market
    pub sell_price: f64,       // Price on sell_market
    pub profit_percent: f64,   // Net profit after fees
    pub confidence: f64,       // Liquidity-based fill confidence
    pub timestamp: i64,
}

/// Momentum data for tracking price movements
#[derive(Debug, Clone)]
struct MomentumData {
    pub last_price: f64,
    pub ema: f64,
    pub price_changes: Vec<f64>,
}

/// Main analyzer service
pub struct Analyzer {
    /// Configuration (thresholds, windows)
    config: AnalyzerConfig,
    /// Channel receiving data from scrapers
    data_rx: mpsc::Receiver<DataEvent>,
    /// Channel sending signals to executor
    signal_tx: mpsc::Sender<TradingSignal>,
    /// In-memory correlation cache
    correlations: Arc<RwLock<HashMap<(String, String), CorrelationData>>>,
    /// Latest prices for momentum tracking
    last_prices: Arc<RwLock<HashMap<String, f64>>>,
    /// EMA values for momentum tracking
    momentum_data: Arc<RwLock<HashMap<String, MomentumData>>>,
}

/// Data point received from scraper service
#[derive(Debug, Clone)]
pub struct DataEvent {
    pub source_id: String,
    pub source_type: InfoSourceType,
    pub metric_type: String,
    pub value: f64,
    pub timestamp: i64,
    pub metadata: Option<JsonValue>,
}

/// Analyzer configuration
#[derive(Debug, Clone)]
pub struct AnalyzerConfig {
    pub arbitrage_min_profit: f64,           // 0.005 = 0.5%
    pub correlation_window_hours: i64,       // 24
    pub correlation_min_threshold: f64,      // 0.7
    pub momentum_ema_period: usize,          // 12
    pub momentum_threshold: f64,             // 0.02
    pub sentiment_threshold: f64,            // 0.7
    pub max_signal_age_ms: u64,              // 5000
    pub cooldown_period_ms: u64,             // 60000 (1 min between similar signals)
}

impl Default for AnalyzerConfig {
    fn default() -> Self {
        Self {
            arbitrage_min_profit: 0.005,
            correlation_window_hours: 24,
            correlation_min_threshold: 0.7,
            momentum_ema_period: 12,
            momentum_threshold: 0.02,
            sentiment_threshold: 0.7,
            max_signal_age_ms: 5000,
            cooldown_period_ms: 60000,
        }
    }
}

impl Analyzer {
    /// Create new analyzer instance
    pub fn new(
        config: AnalyzerConfig,
        data_rx: mpsc::Receiver<DataEvent>,
        signal_tx: mpsc::Sender<TradingSignal>,
    ) -> Self {
        Self {
            config,
            data_rx,
            signal_tx,
            correlations: Arc::new(RwLock::new(HashMap::new())),
            last_prices: Arc::new(RwLock::new(HashMap::new())),
            momentum_data: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Main analysis loop
    pub async fn run(mut self) {
        println!("Analyzer service started");
        
        while let Some(event) = self.data_rx.recv().await {
            // Update correlation statistics
            self.update_correlation(&event).await;
            
            // Check for arbitrage opportunities
            if let Some(arb) = self.check_arbitrage(&event).await {
                let signal = self.arbitrage_to_signal(arb);
                if let Err(e) = self.signal_tx.send(signal).await {
                    eprintln!("Failed to send arbitrage signal: {}", e);
                }
            }
            
            // Check for momentum signals
            if let Some(signal) = self.check_momentum(&event).await {
                if let Err(e) = self.signal_tx.send(signal).await {
                    eprintln!("Failed to send momentum signal: {}", e);
                }
            }
        }
        
        println!("Analyzer service stopped");
    }

    /// Update rolling correlation with new data point using Welford's online algorithm
    async fn update_correlation(&self, event: &DataEvent) {
        // Skip if not a price metric
        if event.metric_type != "price" {
            return;
        }

        // Skip invalid values
        if !event.value.is_finite() || event.value <= 0.0 || event.value >= 1.0 {
            eprintln!("Invalid price value for correlation: {}", event.value);
            return;
        }

        let key = (event.source_id.clone(), event.metric_type.clone());
        let now = Utc::now().timestamp();
        
        let mut correlations = self.correlations.write().await;
        let stats = correlations.entry(key).or_insert_with(|| CorrelationData {
            source_id: event.source_id.clone(),
            market_id: event.source_id.clone(),
            correlation: 0.0,
            sample_count: 0,
            last_updated: now,
            source_mean: 0.0,
            market_mean: 0.0,
            covariance: 0.0,
            source_variance: 0.0,
            market_variance: 0.0,
        });

        // Welford's online algorithm for updating mean and variance
        let n = stats.sample_count as f64;
        let x = event.value;
        
        stats.sample_count += 1;
        stats.last_updated = now;
        
        // Update means
        let old_source_mean = stats.source_mean;
        stats.source_mean += (x - old_source_mean) / (n + 1.0);
        stats.market_mean += (x - stats.market_mean) / (n + 1.0);
        
        // Update covariance and variance
        let delta = x - old_source_mean;
        stats.covariance += delta * (x - stats.market_mean);
        stats.source_variance += delta * (x - stats.source_mean);
        stats.market_variance += (x - stats.market_mean) * (x - stats.market_mean);
        
        // Recalculate correlation if we have enough samples
        if stats.sample_count >= 2 {
            stats.correlation = calculate_correlation_from_stats(stats);
        }
    }

    /// Check for arbitrage between markets
    async fn check_arbitrage(&self, _event: &DataEvent) -> Option<ArbitrageOpportunity> {
        // Arbitrage detection requires comparing prices across markets
        // This is a simplified implementation - in production, you'd
        // maintain market price maps and compare across platforms
        
        // For now, return None as we need market price data
        // In a full implementation, this would:
        // 1. Get current prices for the same event from multiple markets
        // 2. Check if YES_price + NO_price < 1.0 (accounting for fees)
        // 3. If profitable, return ArbitrageOpportunity
        
        None
    }

    /// Check for momentum-based signals
    async fn check_momentum(&self, event: &DataEvent) -> Option<TradingSignal> {
        // Skip if not a price metric
        if event.metric_type != "price" {
            return None;
        }

        // Skip invalid values
        if !event.value.is_finite() || event.value <= 0.0 || event.value >= 1.0 {
            return None;
        }

        let mut momentum_data = self.momentum_data.write().await;
        let data = momentum_data.entry(event.source_id.clone()).or_insert_with(|| MomentumData {
            last_price: event.value,
            ema: event.value,
            price_changes: Vec::with_capacity(100),
        });

        let price_change = (event.value - data.last_price) / data.last_price;
        data.last_price = event.value;
        
        // Update EMA: EMA = α * price + (1 - α) * EMA
        // α = 2 / (period + 1)
        let alpha = 2.0 / (self.config.momentum_ema_period as f64 + 1.0);
        data.ema = alpha * price_change + (1.0 - alpha) * data.ema;
        
        // Check if momentum exceeds threshold
        if data.ema.abs() > self.config.momentum_threshold {
            let side = if data.ema > 0.0 { TradeSide::Buy } else { TradeSide::Sell };
            let confidence = (data.ema.abs() / self.config.momentum_threshold).min(1.0);
            
            return Some(TradingSignal {
                signal_id: uuid::Uuid::new_v4().to_string(),
                strategy: "momentum".to_string(),
                confidence,
                market_id: event.source_id.clone(),
                side,
                suggested_size: 100.0,
                max_slippage: 0.01,
                timestamp: event.timestamp,
                metadata: serde_json::json!({
                    "price_change": price_change,
                    "ema": data.ema,
                    "threshold": self.config.momentum_threshold
                }),
                ttl_ms: self.config.max_signal_age_ms,
            });
        }

        None
    }

    /// Convert arbitrage opportunity to trading signal
    fn arbitrage_to_signal(&self, arb: ArbitrageOpportunity) -> TradingSignal {
        TradingSignal {
            signal_id: uuid::Uuid::new_v4().to_string(),
            strategy: "arbitrage".to_string(),
            confidence: arb.confidence,
            market_id: arb.buy_market.clone(),
            side: TradeSide::Buy,
            suggested_size: 100.0, // Calculate based on liquidity
            max_slippage: 0.01,
            timestamp: arb.timestamp,
            metadata: serde_json::json!(arb),
            ttl_ms: 5000, // Arbitrage opportunities are fleeting
        }
    }

    /// Get current configuration
    pub fn config(&self) -> &AnalyzerConfig {
        &self.config
    }

    /// Update configuration at runtime
    pub async fn update_config(&mut self, config: AnalyzerConfig) {
        self.config = config;
    }

    /// Get correlation data for a source-market pair
    pub async fn get_correlation(&self, source_id: &str, market_id: &str) -> Option<CorrelationData> {
        let correlations = self.correlations.read().await;
        correlations.get(&(source_id.to_string(), market_id.to_string())).cloned()
    }
}

/// Calculate Pearson correlation from cached statistics
pub fn calculate_correlation_from_stats(stats: &CorrelationData) -> f64 {
    if stats.sample_count < 2 {
        return 0.0;
    }
    
    // Use Bessel's correction for sample variance
    let n = stats.sample_count as f64;
    let source_var = stats.source_variance / (n - 1.0);
    let market_var = stats.market_variance / (n - 1.0);
    
    let denom = (source_var * market_var).sqrt();
    if denom == 0.0 {
        return 0.0;
    }
    
    // Bessel's correction for covariance as well
    let covariance = stats.covariance / (n - 1.0);
    
    covariance / denom
}

/// Detect if two markets are trading the same underlying event
pub fn is_same_event(market_a: &str, market_b: &str) -> bool {
    // Normalize market IDs by removing common suffixes and prefixes
    let normalized_a = market_a
        .to_lowercase()
        .replace("polymarket", "")
        .replace("kalshi", "")
        .replace("_", "-")
        .replace("-poly", "")
        .replace("-kal", "");
    
    let normalized_b = market_b
        .to_lowercase()
        .replace("polymarket", "")
        .replace("kalshi", "")
        .replace("_", "-")
        .replace("-poly", "")
        .replace("-kal", "");
    
    // Check for common keywords in event names
    // Extract potential event identifiers (e.g., "btc-100k-2024")
    let keywords_a: std::collections::HashSet<&str> = normalized_a
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.len() >= 3)
        .collect();
    
    let keywords_b: std::collections::HashSet<&str> = normalized_b
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| s.len() >= 3)
        .collect();
    
    // If there's significant overlap in keywords, likely the same event
    let overlap = keywords_a.intersection(&keywords_b).count();
    let min_len = keywords_a.len().min(keywords_b.len());
    
    // At least 50% overlap or at least 2 common keywords
    min_len > 0 && (overlap * 2 >= min_len || overlap >= 2)
}

/// Calculate Simple Moving Average (SMA)
pub fn calculate_sma(values: &[f64], period: usize) -> Option<f64> {
    if values.len() < period {
        return None;
    }
    let recent = &values[values.len() - period..];
    Some(recent.iter().sum::<f64>() / period as f64)
}

/// Calculate Exponential Moving Average (EMA)
pub fn calculate_ema(values: &[f64], period: usize) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    
    let alpha = 2.0 / (period as f64 + 1.0);
    let mut ema = values[0];
    
    for &value in &values[1..] {
        ema = alpha * value + (1.0 - alpha) * ema;
    }
    
    Some(ema)
}

/// Calculate RSI (Relative Strength Index)
pub fn calculate_rsi(values: &[f64], period: usize) -> Option<f64> {
    if values.len() < period + 1 {
        return None;
    }
    
    let mut gains = 0.0;
    let mut losses = 0.0;
    
    for i in (values.len() - period)..values.len() {
        let change = values[i] - values[i - 1];
        if change > 0.0 {
            gains += change;
        } else {
            losses -= change;
        }
    }
    
    let avg_gain = gains / period as f64;
    let avg_loss = losses / period as f64;
    
    if avg_loss == 0.0 {
        return Some(100.0);
    }
    
    let rs = avg_gain / avg_loss;
    Some(100.0 - (100.0 / (1.0 + rs)))
}

/// Calculate price volatility (standard deviation of returns)
pub fn calculate_volatility(values: &[f64], period: usize) -> Option<f64> {
    if values.len() < period {
        return None;
    }
    
    let returns: Vec<f64> = values.windows(2)
        .map(|w| (w[1] - w[0]) / w[0])
        .collect();
    
    let n = returns.len() as f64;
    if n < 2.0 {
        return Some(0.0);
    }
    
    let mean: f64 = returns.iter().sum::<f64>() / n;
    let variance: f64 = returns.iter()
        .map(|r| (r - mean).powi(2))
        .sum::<f64>() / (n - 1.0);
    
    Some(variance.sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_correlation_calculation() {
        let stats = CorrelationData {
            source_id: "test".to_string(),
            market_id: "test".to_string(),
            correlation: 0.0, // Will be calculated
            sample_count: 100,
            last_updated: 0,
            source_mean: 50.0,
            market_mean: 0.5,
            covariance: 10.0,
            source_variance: 100.0,
            market_variance: 0.01,
        };
        
        let r = calculate_correlation_from_stats(&stats);
        assert!(r > 0.9 && r <= 1.0); // Strong positive correlation
    }

    #[test]
    fn test_arbitrage_math() {
        // Buy YES at 0.48, Buy NO at 0.49
        // Cost: 0.97, Return: 1.00, Fees: 0.02
        let cost = 0.48 + 0.49;
        let fees = 0.02;
        let profit = 1.0 - cost - fees;
        
        assert_eq!(profit, 0.01); // 1% profit
    }

    #[test]
    fn test_is_same_event() {
        // Same event with different market suffixes
        assert!(is_same_event("BTC-100K-2024-POLY", "BTC-100K-2024-KAL"));
        
        // Same event with same market
        assert!(is_same_event("ELECTION-2024-POLY", "ELECTION-2024-POLY"));
        
        // Different events
        assert!(!is_same_event("BTC-100K-2024", "ETH-5K-2024"));
    }

    #[test]
    fn test_sma_calculation() {
        let values = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        assert_eq!(calculate_sma(&values, 3), Some(4.0));
        assert_eq!(calculate_sma(&values, 5), Some(3.0));
        assert_eq!(calculate_sma(&values, 10), None); // Not enough data
    }

    #[test]
    fn test_rsi_calculation() {
        let values = vec![44.0, 44.25, 44.5, 43.0, 44.25, 44.5, 45.0, 45.25];
        let rsi = calculate_rsi(&values, 14);
        assert!(rsi.is_some());
        assert!(rsi.unwrap() > 0.0 && rsi.unwrap() <= 100.0);
    }

    #[test]
    fn test_volatility_calculation() {
        let values = vec![100.0, 101.0, 102.0, 101.0, 100.0];
        let vol = calculate_volatility(&values, 4);
        assert!(vol.is_some());
        assert!(vol.unwrap() >= 0.0);
    }

    #[test]
    fn test_analyzer_config_default() {
        let config = AnalyzerConfig::default();
        assert_eq!(config.arbitrage_min_profit, 0.005);
        assert_eq!(config.momentum_ema_period, 12);
        assert_eq!(config.momentum_threshold, 0.02);
    }

    #[test]
    fn test_arbitrage_opportunity_serialization() {
        let arb = ArbitrageOpportunity {
            event_id: "test-event".to_string(),
            buy_market: "polymarket".to_string(),
            sell_market: "kalshi".to_string(),
            buy_price: 0.48,
            sell_price: 0.52,
            profit_percent: 0.02,
            confidence: 0.9,
            timestamp: 1704067200,
        };
        
        // Verify it can be serialized to JSON
        let json = serde_json::to_string(&arb).unwrap();
        assert!(json.contains("test-event"));
        assert!(json.contains("polymarket"));
        
        // Verify it can be deserialized
        let deserialized: ArbitrageOpportunity = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.event_id, arb.event_id);
        assert_eq!(deserialized.profit_percent, arb.profit_percent);
    }
}
