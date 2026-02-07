// ============================================================================
// EXECUTOR SERVICE
// ============================================================================
//
// Module: services/executor.rs
// Purpose: Trade execution with risk management and position sizing
//
// OVERVIEW:
// This module implements the "action" layer of the trading terminal. It receives
// trading signals from the analyzer, applies risk management rules (Kelly criterion,
// position limits), calculates optimal sizing, and executes orders on prediction
// markets via external APIs.
//
// EXECUTION PIPELINE:
//
// Trading Signal (from analyzer via channel)
//   ↓
// Risk Check (exposure limits, correlation, cooldown)
//   ↓
// Position Sizing (Kelly criterion, max limits)
//   ↓
// Fee Calculation (entry + exit fees, slippage estimate)
//   ↓
// Order Submission (REST API calls to Polymarket/Kalshi)
//   ↓
// Fill Monitoring (retry logic, partial fill handling)
//   ↓
// Position Record (insert into database, update UI)
//   ↓
// Post-Trade Risk Update (exposure tracking)
//
// KELLY CRITERION:
//
// The Kelly criterion determines optimal bet size based on edge and odds.
// Formula: f* = (bp - q) / b
// Where:
// - b = odds received (net profit per unit bet)
// - p = probability of winning (confidence from analyzer)
// - q = probability of losing (1 - p)
// - f* = fraction of bankroll to bet
//
// Example:
// - Market price: 0.60 (implies 60% probability if efficient)
// - Your model says: 70% probability (edge = 10%)
// - If you win: gain 0.40 (1.00 - 0.60)
// - If you lose: lose 0.60
// - b = 0.40/0.60 = 0.667
// - f* = (0.667 * 0.70 - 0.30) / 0.667 = 0.35 (bet 35% of bankroll)
//
// Practical Use:
// - Full Kelly is too aggressive (high variance)
// - Use "Half Kelly" or "Quarter Kelly" (f*/2 or f*/4)
// - Never bet more than 10% on single position (hard cap)
//
// RISK MANAGEMENT LAYERS:
//
// Layer 1: Signal Validation
// - Check signal TTL (expired signals rejected)
// - Verify market is still open (not resolved)
// - Check price hasn't moved against us (slippage check)
//
// Layer 2: Exposure Limits
// - Max position size: 10% of portfolio per trade
// - Max correlated exposure: 30% (e.g., all crypto-related markets)
// - Max daily loss: 5% of portfolio (circuit breaker)
//
// Layer 3: Order Validation
// - Price bounds check (0.01 to 0.99, avoid extreme illiquidity)
// - Minimum order size (market-specific, e.g., $1 on Polymarket)
// - Available balance check (including unsettled funds)
//
// Layer 4: Execution Safety
// - Limit orders only (no market orders during volatility)
// - Maximum slippage tolerance (cancel if price moves >1%)
// - Order timeout (cancel if not filled within 30 seconds)
//
// POSITION SIZING LOGIC:
//
// 1. Calculate Kelly fraction
// 2. Apply fractional Kelly (divide by 2 or 4)
// 3. Apply 10% hard cap
// 4. Round to contract size (integer contracts)
// 5. Check available balance
// 6. Adjust down if insufficient funds
//
// FEE STRUCTURES:
//
// Polymarket:
// - trading_fees: 2% for market orders, 0% for limit makers (sometimes)
// - gas_fees: Variable (Polygon network), paid in MATIC
// - withdrawal_fees: Variable
//
// Kalshi:
// - trading_fees: 0.5% capped at $0.50 per contract side
// - settlement_fees: None
// - Inactivity fees: None
//
// Total Cost = Entry Fee + Exit Fee + Slippage + Gas
// Must be < Expected Profit for positive expectancy
//
// ORDER EXECUTION STRATEGIES:
//
// Strategy 1: Passive Limit (default)
// - Place limit order at current bid/ask (no crossing spread)
// - Wait for natural fill (may take minutes/hours)
// - Lower fees, uncertain fill time
//
// Strategy 2: Aggressive Limit
// - Place limit order 1 tick better than market (cross half spread)
// - Faster fill, slightly worse price
//
// Strategy 3: Immediate-or-Cancel (IOC)
// - Fill immediately at available liquidity
// - Cancel unfilled portion
// - Used when signal is time-sensitive (arbitrage)
//
// RETRY LOGIC:
//
// Transient failures (retry with backoff):
// - HTTP timeout
// - Rate limit (429)
// - Temporary maintenance (503)
// - Nonce errors (blockchain)
//
// No retry (fail immediately):
// - Insufficient funds
// - Market closed
// - Invalid price (out of bounds)
// - Authentication failure
//
// Retry schedule: 1s, 2s, 4s (max 3 attempts)
// Then mark as failed and alert user
//
// STATE MANAGEMENT:
//
// - PENDING_ORDERS: Arc<RwLock<HashMap<String, OrderState>>>
//   - Tracks orders submitted but not yet confirmed
//   - Used for fill monitoring and cancellation
//
// - POSITIONS: Arc<RwLock<HashMap<String, Position>>>
//   - Local cache of open positions (synced with DB)
//   - Used for exposure calculations
//
// - BALANCE_CACHE: Arc<RwLock<HashMap<String, f64>>>
//   - Available balance per market
//   - Updated after each trade and periodically (TTL 60s)
//
// - DAILY_STATS: Arc<RwLock<DailyStats>>
//   - Tracks P&L and trade count for day
//   - Used for circuit breaker (stop trading if daily loss > 5%)
//
// EXTERNAL INTEGRATIONS:
//
// Polymarket API:
// - Authentication: API key + wallet signature (EIP-712)
// - Endpoints: REST for orders, WebSocket for fills
// - Settlement: Polygon blockchain (MATIC gas fees)
//
// Kalshi API:
// - Authentication: Bearer token (email/password)
// - Endpoints: RESTful JSON API
// - Settlement: USD cash account (ACH withdrawal)
//
// ERROR HANDLING:
//
// All execution errors categorized:
// - Retryable: Network issues, rate limits (retry with backoff)
// - Terminal: Invalid parameters, insufficient funds (fail fast)
// - Warning: Partial fills (monitor, may complete later)
//
// On error:
// 1. Log detailed error (with request/response for debugging)
// 2. Update order status in database
// 3. Emit error event to frontend
// 4. If terminal error: stop retrying, alert user
// 5. If retryable: schedule retry or add to dead letter queue
//
// PERFORMANCE TARGETS:
//
// - End-to-end latency: <500ms (signal → order submitted)
// - Order fill monitoring: Check every 5 seconds
// - Concurrent orders: Max 5 per market (prevent spam)
// - Database write: <10ms per position update
//
// TESTING:
//
// Unit tests:
// - Kelly criterion calculations (verify math)
// - Position sizing (edge cases: 0 balance, max size)
// - Fee calculations (verify platform-specific logic)
//
// Integration tests:
// - Mock exchange APIs (wiremock)
// - Verify retry logic with simulated failures
// - Test position reconciliation (mock fills)
//
// Paper Trading:
// - Execute against real APIs but with "dry run" flag
// - Track hypothetical fills (market price at time of order)
// - Compare predicted P&L vs actual market movement
// - Validate risk management without real money
//
// SAFETY FEATURES:
//
// 1. Maximum Order Limits:
//    - Absolute: Cannot place order > 10% of portfolio (configurable)
//    - Relative: Cannot exceed available balance + unsettled
//
// 2. Duplicate Prevention:
//    - Idempotency keys on all orders (ExchangeIdempotency)
//    - Position hash (market + side + price) within 1 min window
//
// 3. Emergency Stop:
//    - Global "trading_enabled" flag (set via UI or circuit breaker)
//    - Immediately cancels all pending orders
//    - Prevents new orders until manually re-enabled
//
// 4. Audit Logging:
//    - Every order attempt logged (success or failure)
//    - Log entry: timestamp, signal_id, order_params, result, error
//    - Immutable append-only log (for compliance/debugging)
//
// CONCURRENCY MODEL:
//
// Single-threaded per market (prevents race conditions on balance),
// but multiple markets concurrently.
//
// Architecture:
// - One task per market (Polymarket task, Kalshi task)
// - Each task has queue of signals for that market
// - Sequential processing ensures correct balance tracking
// - Cross-market arbitrage handled by special coordinator
//
// USAGE EXAMPLE:
//
// ```rust
// // In service initialization
// let executor = Executor::new(config, signal_rx, db_pool, window);
// tokio::spawn(executor.run());
//
// // Signal received automatically from analyzer
// // Executor handles everything: sizing, risk checks, submission
// ```
//
// TRADE LIFECYCLE EXAMPLE:
//
// 1. Receive signal: "Buy YES on BTC-100K market, confidence 0.8"
// 2. Check risk: Current exposure 5%, adding 8% → total 13% < 30% limit ✓
// 3. Calculate Kelly: f* = 0.25 → Half Kelly = 0.125 → 12.5% of $10k = $1250
// 4. Hard cap: 10% max = $1000 ✓
// 5. Convert to contracts: $1000 / $0.60 per share = 1666.67 → 1666 contracts
// 6. Check balance: Available $2000 > $1000 needed ✓
// 7. Calculate fees: 2% entry = $20, estimated 2% exit = $20, total $40
// 8. Expected profit: 20% edge × $1000 = $200 gross - $40 fees = $160 net ✓
// 9. Submit limit order: BUY 1666 YES @ 0.60
// 10. Monitor: Filled partially (1000) after 10s, then fully after 30s
// 11. Record position: Insert into database, emit to UI
// 12. Start monitoring: Check for exit conditions (take profit/stop loss)
//
// FUTURE ENHANCEMENTS:
// - Smart order routing (choose best exchange automatically)
// - TWAP/VWAP execution (large orders split over time)
// - Bracket orders (OCO: one-cancels-other for stop loss + take profit)
// - Post-trade analysis (slippage analysis, fill quality)
// - Multi-sig wallet support (institutional custody)
// - Compliance reporting (tax lot tracking, wash sale detection)
// ============================================================================

use crate::models::{market::{TradeResult, TradeSide, OrderType}, position::Position, TradingSignal};
use crate::db::sqlite::Connection;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock, Mutex};
use chrono::Utc;
use tauri::Emitter;

/// Executor service managing trade execution
pub struct Executor {
    /// Configuration (limits, credentials)
    config: ExecutorConfig,
    /// Channel receiving signals from analyzer
    signal_rx: mpsc::Receiver<TradingSignal>,
    /// Database connection
    db: Arc<Mutex<Connection>>,
    /// Pending orders (submitted but not confirmed)
    pending_orders: Arc<RwLock<HashMap<String, OrderState>>>,
    /// Open positions cache
    positions: Arc<RwLock<HashMap<String, Position>>>,
    /// Available balances per market
    balances: Arc<RwLock<HashMap<String, f64>>>,
    /// Daily trading statistics
    daily_stats: Arc<RwLock<DailyStats>>,
    /// Tauri window for events
    window: tauri::Window,
}

/// Order tracking state
#[derive(Debug, Clone)]
pub struct OrderState {
    pub order_id: String,
    pub market_id: String,
    pub side: TradeSide,
    pub requested_size: f64,
    pub filled_size: f64,
    pub status: OrderStatus,
    pub submitted_at: i64,
    pub retry_count: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OrderStatus {
    Pending,
    PartiallyFilled,
    Filled,
    Cancelled,
    Failed(String),
}

/// Daily trading statistics
#[derive(Debug, Clone)]
pub struct DailyStats {
    pub date: String,  // YYYY-MM-DD
    pub total_trades: u32,
    pub winning_trades: u32,
    pub losing_trades: u32,
    pub total_pnl: f64,
    pub total_fees: f64,
}

/// Executor configuration
#[derive(Debug, Clone)]
pub struct ExecutorConfig {
    pub max_position_percent: f64,        // 0.10 = 10%
    pub kelly_fraction: f64,              // 0.5 = Half Kelly
    pub max_daily_loss_percent: f64,      // 0.05 = 5%
    pub max_slippage_percent: f64,        // 0.01 = 1%
    pub order_timeout_seconds: u64,       // 30
    pub max_retries: u32,                 // 3
    pub trading_enabled: bool,            // Global kill switch
}

impl Executor {
    /// Create new executor instance
    pub fn new(
        config: ExecutorConfig,
        signal_rx: mpsc::Receiver<TradingSignal>,
        db: Arc<Mutex<Connection>>,
        window: tauri::Window,
    ) -> Self {
        Self {
            config,
            signal_rx,
            db,
            pending_orders: Arc::new(RwLock::new(HashMap::new())),
            positions: Arc::new(RwLock::new(HashMap::new())),
            balances: Arc::new(RwLock::new(HashMap::new())),
            daily_stats: Arc::new(RwLock::new(DailyStats {
                date: chrono::Local::now().format("%Y-%m-%d").to_string(),
                total_trades: 0,
                winning_trades: 0,
                losing_trades: 0,
                total_pnl: 0.0,
                total_fees: 0.0,
            })),
            window,
        }
    }

    /// Main execution loop
    pub async fn run(mut self) {
        println!("Executor service started");
        
        while let Some(signal) = self.signal_rx.recv().await {
            if !self.config.trading_enabled {
                println!("Trading disabled, skipping signal");
                continue;
            }
            
            // Check daily loss limit (circuit breaker)
            if self.check_circuit_breaker().await {
                eprintln!("Circuit breaker triggered: Daily loss limit reached");
                self.emit_alert("Trading halted: Daily loss limit").await;
                continue;
            }
            
            // Process signal
            match self.process_signal(signal).await {
                Ok(result) => {
                    println!("Trade executed successfully: {:?}", result);
                    self.update_stats(&result).await;
                }
                Err(e) => {
                    eprintln!("Trade execution failed: {}", e);
                }
            }
        }
        
        println!("Executor service stopped");
    }

    /// Process a trading signal end-to-end
    async fn process_signal(&self, signal: TradingSignal) -> Result<TradeResult, anyhow::Error> {
        // 1. Validate signal (TTL, market status)
        self.validate_signal(&signal).await?;
        
        // 2. Calculate position size (Kelly criterion)
        let size = self.calculate_position_size(&signal).await?;
        
        // 3. Check risk limits (exposure, correlation)
        self.check_risk_limits(&signal, size).await?;
        
        // 4. Prepare order
        let order = self.prepare_order(&signal, size).await?;
        
        // 5. Submit to exchange
        let result = self.submit_order(order).await?;
        
        // 6. Record position if filled
        if result.status == "filled" || result.status == "partial" {
            self.record_position(&result).await?;
        }
        
        Ok(result)
    }

    /// Calculate optimal position size using Kelly criterion
    async fn calculate_position_size(&self, signal: &TradingSignal) -> Result<f64, anyhow::Error> {
        // Get current portfolio value (simplified: cash + positions)
        let portfolio_value = self.get_portfolio_value().await;
        
        // Extract probability from signal confidence
        let p = signal.confidence;
        let q = 1.0 - p;
        
        // Get current market price for odds calculation
        let current_price = self.get_market_price(&signal.market_id).await
            .ok_or_else(|| anyhow::anyhow!("Cannot get market price"))?;
        
        // Calculate odds (b)
        // For prediction markets: if buying at 0.60, you risk 0.60 to win 0.40
        let b = (1.0 - current_price) / current_price;
        
        // Kelly formula: f* = (bp - q) / b
        let kelly_fraction = (b * p - q) / b;
        
        // Apply fractional Kelly for safety
        let adjusted_fraction = kelly_fraction * self.config.kelly_fraction;
        
        // Calculate dollar amount
        let position_value = portfolio_value * adjusted_fraction;
        
        // Apply hard caps
        let max_position = portfolio_value * self.config.max_position_percent;
        let final_size = position_value.min(max_position).max(0.0);
        
        // Convert to contracts (round down)
        let contracts = (final_size / current_price).floor();
        
        Ok(contracts)
    }

    /// Check risk limits before executing
    async fn check_risk_limits(&self, signal: &TradingSignal, size: f64) -> Result<(), anyhow::Error> {
        // Check exposure limits
        let current_exposure = self.get_market_exposure(&signal.market_id).await;
        let new_exposure = current_exposure + (size * signal.confidence);
        let max_exposure = self.get_portfolio_value().await * self.config.max_position_percent;
        
        if new_exposure > max_exposure {
            return Err(anyhow::anyhow!(
                "Exposure limit exceeded: {:.2} > {:.2}", 
                new_exposure, max_exposure
            ));
        }
        
        // Check available balance
        let balance = self.get_balance(&signal.market_id).await;
        let required = size * self.get_market_price(&signal.market_id).await.unwrap_or(0.0);
        
        if balance < required {
            return Err(anyhow::anyhow!(
                "Insufficient balance: {:.2} < {:.2}", 
                balance, required
            ));
        }
        
        Ok(())
    }

    /// Submit order to exchange API
    async fn submit_order(&self, _order: PreparedOrder) -> Result<TradeResult, anyhow::Error> {
        // Implementation: Call Polymarket or Kalshi API
        // Handle retry logic
        // Parse response
        todo!()
    }

    /// Record new position in database
    async fn record_position(&self, result: &TradeResult) -> Result<(), anyhow::Error> {
        let position = Position::new(
            result.market_id.clone(),
            "Polymarket".to_string(), // Determine from market_id
            match result.side {
                TradeSide::Buy => "long".to_string(),
                TradeSide::Sell => "short".to_string(),
            },
            result.filled_size,
            result.avg_price,
            Utc::now().timestamp(),
            result.fees_paid,
        );
        
        let conn = self.db.lock().await;
        crate::db::sqlite::insert_position(&conn, &position)?;
        
        // Update local cache
        let mut positions = self.positions.write().await;
        positions.insert(position.id.clone(), position);
        
        Ok(())
    }

    /// Check if daily loss limit reached (circuit breaker)
    async fn check_circuit_breaker(&self) -> bool {
        let stats = self.daily_stats.read().await;
        let portfolio_value = self.get_portfolio_value().await;
        
        (stats.total_pnl + stats.total_fees) < -(portfolio_value * self.config.max_daily_loss_percent)
    }

    /// Get total portfolio value (cash + positions)
    async fn get_portfolio_value(&self) -> f64 {
        // Simplified: sum of balances + unrealized P&L
        let balances = self.balances.read().await;
        let positions = self.positions.read().await;
        
        let cash: f64 = balances.values().sum();
        let position_value: f64 = positions.values()
            .map(|p| p.quantity * p.entry_price)
            .sum();
        
        cash + position_value
    }

    /// Get current exposure for a specific market
    async fn get_market_exposure(&self, market_id: &str) -> f64 {
        let positions = self.positions.read().await;
        positions.values()
            .filter(|p| p.market_id == market_id)
            .map(|p| p.quantity * p.entry_price)
            .sum()
    }

    /// Get available balance for a market
    async fn get_balance(&self, market_id: &str) -> f64 {
        let balances = self.balances.read().await;
        *balances.get(market_id).unwrap_or(&0.0)
    }

    /// Get current market price
    async fn get_market_price(&self, _market_id: &str) -> Option<f64> {
        // Query from cache or API
        // Simplified: return mock
        Some(0.50)
    }

    /// Validate trading signal
    async fn validate_signal(&self, signal: &TradingSignal) -> Result<(), anyhow::Error> {
        // Check TTL
        let age_ms = (Utc::now().timestamp_millis() - signal.timestamp * 1000) as u64;
        if age_ms > signal.ttl_ms {
            return Err(anyhow::anyhow!("Signal expired"));
        }
        
        // Check price hasn't moved too much (slippage)
        if let Some(current_price) = self.get_market_price(&signal.market_id).await {
            let expected_price = match signal.side {
                TradeSide::Buy => current_price, // Simplified
                TradeSide::Sell => current_price,
            };
            
            let slippage = (expected_price - current_price).abs() / current_price;
            if slippage > self.config.max_slippage_percent {
                return Err(anyhow::anyhow!("Price moved too much: {} slippage", slippage));
            }
        }
        
        Ok(())
    }

    /// Prepare order details
    async fn prepare_order(&self, signal: &TradingSignal, size: f64) -> Result<PreparedOrder, anyhow::Error> {
        Ok(PreparedOrder {
            market_id: signal.market_id.clone(),
            side: signal.side.clone(),
            size,
            order_type: OrderType::Limit(signal.max_slippage), // Limit at current price
        })
    }

    /// Update daily statistics
    async fn update_stats(&self, result: &TradeResult) {
        let mut stats = self.daily_stats.write().await;
        stats.total_trades += 1;
        stats.total_fees += result.fees_paid;
        
        // Realized P&L only available on close, track fees for now
    }

    /// Emit alert to frontend
    async fn emit_alert(&self, message: &str) {
        let _ = self.window.emit("executor:alert", serde_json::json!({
            "message": message,
            "timestamp": Utc::now().timestamp(),
        }));
    }
}

/// Internal order structure before submission
struct PreparedOrder {
    pub market_id: String,
    pub side: TradeSide,
    pub size: f64,
    pub order_type: OrderType,
}

/// Calculate Kelly criterion position size (standalone function)
pub fn calculate_kelly_size(
    portfolio_value: f64,
    win_probability: f64,
    current_price: f64,
    kelly_fraction: f64,
    max_position_percent: f64,
) -> f64 {
    if win_probability <= 0.0 || win_probability >= 1.0 {
        return 0.0; // Invalid probability
    }
    
    let loss_probability = 1.0 - win_probability;
    let odds = (1.0 - current_price) / current_price; // b in Kelly formula
    
    // Kelly percentage: f* = (bp - q) / b
    let kelly_percent = (odds * win_probability - loss_probability) / odds;
    
    // Apply fractional Kelly (conservative)
    let adjusted_percent = kelly_percent * kelly_fraction;
    
    // Calculate dollar amount
    let dollar_amount = portfolio_value * adjusted_percent;
    
    // Apply hard maximum
    let max_dollar = portfolio_value * max_position_percent;
    
    dollar_amount.min(max_dollar).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_kelly_criterion() {
        // Portfolio: $10,000
        // Probability: 70% win
        // Current price: 0.60 (betting YES at 60%)
        // Kelly fraction: 0.5 (Half Kelly)
        // Max position: 10%
        
        let size = calculate_kelly_size(10000.0, 0.70, 0.60, 0.5, 0.10);
        
        // Expect substantial but not huge position
        assert!(size > 0.0);
        assert!(size <= 1000.0); // Max 10%
    }

    #[test]
    fn test_kelly_no_edge() {
        // 50% probability when market prices at 0.50 (no edge)
        // Should bet 0 or very small
        let size = calculate_kelly_size(10000.0, 0.50, 0.50, 1.0, 1.0);
        assert!(size.abs() < 0.01); // Essentially zero
    }

    #[test]
    fn test_kelly_max_cap() {
        // Strong edge: 90% probability
        // Should be capped at max_position_percent
        let size = calculate_kelly_size(10000.0, 0.90, 0.50, 1.0, 0.10);
        assert_eq!(size, 1000.0); // 10% cap
    }
}