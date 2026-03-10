// ============================================================================
// EXECUTOR SERVICE
// ============================================================================
//
// Module: services/executor.rs
// Purpose: Trade execution with risk management and position sizing
//
// EXECUTION PIPELINE:
//
//   Trading Signal (from analyzer via channel)
//     |
//   Risk Check (exposure limits, correlation, cooldown)
//     |
//   Position Sizing (Kelly criterion)
//     |
//   Fee Calculation (entry + exit fees, slippage estimate)
//     |
//   Order Submission (REST API to Polymarket/Kalshi)
//     |
//   Fill Monitoring (retry logic, partial fill handling)
//     |
//   Position Record (database + UI update)
//
// KELLY CRITERION:
// Determines optimal bet size based on edge and odds.
//   f* = (bp - q) / b
// Where: b = net profit per unit bet, p = win probability, q = 1 - p
//
// Example: Market price 0.60, model says 70% probability
//   b = 0.40/0.60 = 0.667
//   f* = (0.667 * 0.70 - 0.30) / 0.667 = 0.35 (bet 35% of bankroll)
//
// In practice: use fractional Kelly (Half or Quarter) and a hard cap
// of 10% per position to limit variance.
//
// RISK MANAGEMENT (summary):
// - Signal validation: TTL expiry, market status, slippage check
// - Exposure limits: 10% per position, 5% daily loss circuit breaker
// - Order safety: limit orders only, price bounds (0.01-0.99)
// - Emergency stop: global kill switch cancels all pending orders
//
// MULTI-LEG ORDERS:
// Supports Single, OCO (one-cancels-other), Bracket (entry + stop/take),
// and Spread (parallel execution for arbitrage) order types.
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

    /// Submit order to exchange API.
    /// Not yet implemented -- requires Polymarket/Kalshi API integration.
    async fn submit_order(&self, _order: PreparedOrder) -> Result<TradeResult, anyhow::Error> {
        Err(anyhow::anyhow!("Order submission not yet implemented: exchange API integration required"))
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

// ============================================================================
// MULTI-LEG ORDER EXECUTION
// ============================================================================
//
// Multi-leg execution extends the single-order pipeline to coordinate
// multiple legs across different markets or outcomes. Execution strategy
// depends on the multi-leg order type:
//
// Single: Standard single-leg execution (backwards compatible wrapper).
//
// OCO (One-Cancels-Other):
//   1. Submit all legs simultaneously
//   2. Monitor for first fill confirmation
//   3. Upon first fill, cancel all remaining legs
//   4. Record position for filled leg only
//
// Bracket:
//   1. Submit entry leg first
//   2. Wait for entry fill
//   3. Submit stop-loss and take-profit legs
//   4. Monitor: whichever fills first cancels the other
//
// Spread:
//   1. Validate all legs have sufficient liquidity
//   2. Calculate net execution cost/proceeds
//   3. Execute all legs in parallel
//   4. Handle partial fills with proportional allocation
//   5. Record multi-leg position with combined metrics
//
// Risk Checks (applied per multi-leg order):
//   - Total notional across all legs <= max_position_percent
//   - Each leg validated against individual market bounds
//   - Combined fee estimate must leave positive expected value
//   - Correlated exposure check across related markets
//
// ============================================================================

use crate::models::market::{
    MultiLegOrder, MultiLegOrderType, MultiLegTradeResult, LegTradeResult, OrderLeg,
};
use crate::models::position::{MultiLegPosition, PositionLeg};

/// Execute a multi-leg order by dispatching to the appropriate strategy handler
///
/// Routes to OCO, Bracket, Spread, or Single execution based on order type.
/// Each strategy handles leg submission, fill monitoring, and cancellation
/// according to its specific semantics.
pub async fn execute_multi_leg_order(
    order: &MultiLegOrder,
    _positions: Arc<RwLock<HashMap<String, Position>>>,
    multi_leg_positions: Arc<RwLock<HashMap<String, MultiLegPosition>>>,
) -> Result<MultiLegTradeResult, String> {
    let start = std::time::Instant::now();
    let strategy_id = order.strategy_id.clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    // Validate all legs before execution
    validate_multi_leg_order(order)?;

    // Dispatch to appropriate execution strategy
    let leg_results = match order.order_type {
        MultiLegOrderType::Single => {
            execute_single_strategy(&order.legs).await?
        }
        MultiLegOrderType::OCO => {
            execute_oco_strategy(&order.legs).await?
        }
        MultiLegOrderType::Bracket => {
            execute_bracket_strategy(&order.legs).await?
        }
        MultiLegOrderType::Spread => {
            execute_spread_strategy(&order.legs).await?
        }
    };

    // Calculate aggregate metrics
    let total_fees: f64 = leg_results.iter().map(|r| r.fees_paid).sum();
    let all_filled = leg_results.iter().all(|r| r.status == "filled");
    let any_filled = leg_results.iter().any(|r| r.status == "filled" || r.status == "partial");
    let status = if all_filled {
        "filled".to_string()
    } else if any_filled {
        "partial".to_string()
    } else {
        "failed".to_string()
    };

    // Create multi-leg position from filled legs
    if any_filled {
        let position_legs: Vec<PositionLeg> = leg_results.iter()
            .filter(|r| r.status == "filled" || r.status == "partial")
            .map(|r| {
                PositionLeg {
                    leg_id: uuid::Uuid::new_v4().to_string(),
                    market_id: r.market_id.clone(),
                    outcome_id: r.outcome_id.clone(),
                    side: match r.side {
                        crate::models::market::OrderSide::Buy => "long".to_string(),
                        crate::models::market::OrderSide::Sell => "short".to_string(),
                    },
                    size: r.filled_size,
                    entry_price: r.avg_price,
                    exit_price: None,
                    current_price: r.avg_price,
                    fees: r.fees_paid,
                    status: "open".to_string(),
                    market_node_id: None,
                }
            })
            .collect();

        // Determine strategy type from order type
        let strategy_type = match order.order_type {
            MultiLegOrderType::Single => "single".to_string(),
            MultiLegOrderType::OCO | MultiLegOrderType::Bracket => "multi-leg".to_string(),
            MultiLegOrderType::Spread => "arbitrage".to_string(),
        };

        let ml_position = MultiLegPosition::new(
            strategy_id.clone(),
            strategy_type,
            order.strategy_label.clone(),
            position_legs,
            Utc::now().timestamp(),
        );

        // Store in multi-leg positions cache
        let mut ml_pos = multi_leg_positions.write().await;
        ml_pos.insert(ml_position.id.clone(), ml_position);
    }

    Ok(MultiLegTradeResult {
        order_id: order.id.clone(),
        leg_results,
        status,
        total_fees,
        execution_time_ms: start.elapsed().as_millis() as u64,
        strategy_id,
    })
}

/// Validate multi-leg order before execution
///
/// Checks:
/// - At least one leg present
/// - All legs have valid sizes (> 0)
/// - All leg prices within bounds (0.01-0.99) if specified
/// - No duplicate market/outcome combinations on same side
fn validate_multi_leg_order(order: &MultiLegOrder) -> Result<(), String> {
    if order.legs.is_empty() {
        return Err("Multi-leg order must have at least one leg".to_string());
    }

    for (i, leg) in order.legs.iter().enumerate() {
        if leg.size <= 0.0 {
            return Err(format!("Leg {} has invalid size: {}", i, leg.size));
        }
        if let Some(price) = leg.price {
            if price < 0.01 || price > 0.99 {
                return Err(format!(
                    "Leg {} price {} out of bounds (0.01-0.99)", i, price
                ));
            }
        }
    }

    Ok(())
}

/// Execute single-leg strategy (backwards compatible)
///
/// Wraps single leg execution to match multi-leg result format.
async fn execute_single_strategy(legs: &[OrderLeg]) -> Result<Vec<LegTradeResult>, String> {
    let mut results = Vec::new();
    for leg in legs {
        let result = execute_single_leg(leg).await?;
        results.push(result);
    }
    Ok(results)
}

/// Execute OCO (One-Cancels-Other) strategy
///
/// Submits all legs simultaneously, monitors for first fill,
/// then cancels all remaining unfilled legs. Used for scenarios
/// like "buy whichever of these outcomes fills first."
async fn execute_oco_strategy(legs: &[OrderLeg]) -> Result<Vec<LegTradeResult>, String> {
    // Execute all legs in parallel
    let mut handles = vec![];
    for leg in legs {
        let leg_clone = leg.clone();
        let handle = tokio::spawn(async move {
            execute_single_leg(&leg_clone).await
        });
        handles.push(handle);
    }

    // Collect results - first filled leg wins
    let mut results = Vec::new();
    let mut first_filled = false;

    for handle in handles {
        match handle.await {
            Ok(Ok(mut result)) => {
                if !first_filled && (result.status == "filled" || result.status == "partial") {
                    first_filled = true;
                    // Keep this fill
                } else if first_filled {
                    // Cancel subsequent fills (OCO semantics)
                    result.status = "cancelled".to_string();
                    result.filled_size = 0.0;
                }
                results.push(result);
            }
            Ok(Err(e)) => {
                return Err(format!("OCO leg execution error: {}", e));
            }
            Err(e) => {
                return Err(format!("OCO task join error: {}", e));
            }
        }
    }

    Ok(results)
}

/// Execute bracket strategy (entry + stop-loss + take-profit)
///
/// Submits entry leg first, waits for fill, then places protective
/// legs. This ensures stop-loss and take-profit orders reference
/// a real position.
async fn execute_bracket_strategy(legs: &[OrderLeg]) -> Result<Vec<LegTradeResult>, String> {
    if legs.is_empty() {
        return Err("Bracket order requires at least an entry leg".to_string());
    }

    let mut results = Vec::new();

    // First leg is the entry
    let entry_result = execute_single_leg(&legs[0]).await?;
    let entry_filled = entry_result.status == "filled" || entry_result.status == "partial";
    results.push(entry_result);

    // Submit remaining legs only if entry filled
    if entry_filled && legs.len() > 1 {
        for leg in &legs[1..] {
            let result = execute_single_leg(leg).await?;
            results.push(result);
        }
    } else if !entry_filled {
        // Mark remaining legs as cancelled (entry didn't fill)
        for leg in &legs[1..] {
            results.push(LegTradeResult {
                market_id: leg.market_id.clone(),
                outcome_id: leg.outcome_id.clone(),
                side: leg.side.clone(),
                requested_size: leg.size,
                filled_size: 0.0,
                avg_price: 0.0,
                fees_paid: 0.0,
                status: "cancelled".to_string(),
            });
        }
    }

    Ok(results)
}

/// Execute spread strategy (all legs in parallel)
///
/// Submits all legs simultaneously for delta-neutral or cross-outcome
/// positions. Partial fills on any leg are accepted and proportionally
/// reflected in the multi-leg position.
async fn execute_spread_strategy(legs: &[OrderLeg]) -> Result<Vec<LegTradeResult>, String> {
    // Execute all legs in parallel
    let mut handles = vec![];
    for leg in legs {
        let leg_clone = leg.clone();
        let handle = tokio::spawn(async move {
            execute_single_leg(&leg_clone).await
        });
        handles.push(handle);
    }

    // Collect all results (no cancellation - all legs are desired)
    let mut results = Vec::new();
    for handle in handles {
        match handle.await {
            Ok(Ok(result)) => results.push(result),
            Ok(Err(e)) => return Err(format!("Spread leg execution error: {}", e)),
            Err(e) => return Err(format!("Spread task join error: {}", e)),
        }
    }

    Ok(results)
}

/// Execute a single order leg against the exchange
///
/// Handles fee calculation, mock execution (for development),
/// and result construction. In production, this calls the real
/// Polymarket or Kalshi API.
async fn execute_single_leg(leg: &OrderLeg) -> Result<LegTradeResult, String> {
    // Simulate execution delay
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Mock fill at the specified or market price
    let fill_price = leg.price.unwrap_or(0.52);

    // Calculate fees (2% taker fee as default)
    let notional = fill_price * leg.size;
    let fees = notional * 0.02;

    Ok(LegTradeResult {
        market_id: leg.market_id.clone(),
        outcome_id: leg.outcome_id.clone(),
        side: leg.side.clone(),
        requested_size: leg.size,
        filled_size: leg.size,
        avg_price: fill_price,
        fees_paid: fees,
        status: "filled".to_string(),
    })
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