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

use crate::models::market::{TradeSide, TradingSignal};
use crate::models::node::InfoSourceType;
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
#[derive(Debug, Clone)]
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
                    eprintln!("Failed to send signal: {}", e);
                }
            }
            
            // Check for momentum signals
            if let Some(signal) = self.check_momentum(&event).await {
                if let Err(e) = self.signal_tx.send(signal).await {
                    eprintln!("Failed to send signal: {}", e);
                }
            }
        }
        
        println!("Analyzer service stopped");
    }

    /// Update rolling correlation with new data point
    async fn update_correlation(&self, event: &DataEvent) {
        // Implementation using Welford's online algorithm
        // Update source_mean, market_mean, covariance, etc.
    }

    /// Check for arbitrage between markets
    async fn check_arbitrage(&self, _event: &DataEvent) -> Option<ArbitrageOpportunity> {
        // Scan market pairs for price discrepancies
        // Return opportunity if profit > threshold
        todo!()
    }

    /// Check for momentum-based signals
    async fn check_momentum(&self, event: &DataEvent) -> Option<TradingSignal> {
        // Calculate price change vs previous
        // Check if exceeds threshold
        todo!()
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
            timestamp: Utc::now().timestamp(),
            metadata: serde_json::json!(arb),
            ttl_ms: 5000, // Arbitrage opportunities are fleeting
        }
    }
}

/// Calculate Pearson correlation from cached statistics
pub fn calculate_correlation_from_stats(stats: &CorrelationData) -> f64 {
    if stats.sample_count < 2 {
        return 0.0;
    }
    
    let denom = (stats.source_variance * stats.market_variance).sqrt();
    if denom == 0.0 {
        return 0.0;
    }
    
    stats.covariance / denom
}

/// Detect if two markets are trading the same underlying event
pub fn is_same_event(market_a: &str, market_b: &str) -> bool {
    // Normalize market IDs, check for shared keywords/tags
    // Example: "BTC-100K-2024-POLY" and "BTC-100K-2024-KAL" → true
    todo!()
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
}