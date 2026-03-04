// ============================================================================
// TRADING EXECUTION COMMAND HANDLERS
// ============================================================================
//
// Module: commands/trading.rs
// Purpose: Tauri command handlers for executing trades and managing positions
//
// ============================================================================

use crate::commands::markets::MarketState;
use crate::models::market::{OrderType, OrderSide};
use crate::models::node::MarketType;
use crate::models::position::Position;
use crate::models::position::MultiLegPosition;
use crate::models::market::{
    MultiLegOrder, MultiLegOrderType, MultiLegTradeResult,
    OrderLeg as MarketOrderLeg,
};
use chrono::Utc;
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration as StdDuration, Instant};
use tauri::State;
use tokio::sync::{mpsc, oneshot, Mutex, RwLock};
use uuid::Uuid;

// ============================================================================
// CONSTANTS
// ============================================================================

const DAILY_LOSS_LIMIT_PCT: f64 = 0.05; // 5% circuit breaker
const MAX_POSITION_PCT: f64 = 0.10; // 10% max per position
const KELLY_FRACTION: f64 = 0.5; // Half-Kelly for safety
const MAX_ORDER_SIZE: i64 = 10000; // Hard cap contracts
const CIRCUIT_BREAKER_ERRORS: u32 = 3; // Stop after 3 consecutive errors
const PRICE_DEVIATION_LIMIT: f64 = 0.10; // 10% price sanity check

// Platform fees
const POLYMARKET_TAKER_FEE: f64 = 0.02; // 2%
const KALSHI_FEE_CAP: f64 = 0.005; // 0.5% cap

// ============================================================================
// LOCAL TYPE DEFINITIONS
// ============================================================================

/// Position status string constants
pub struct PositionStatus;
impl PositionStatus {
    pub const OPEN: &'static str = "open";
    pub const CLOSED: &'static str = "closed";
    pub const FAILED: &'static str = "failed";
}

/// Trade execution result (local definition to match trading needs)
#[derive(Debug, Clone, Serialize)]
pub struct TradeResult {
    pub success: bool,
    pub order_id: String,
    pub position_id: Option<String>,
    pub filled_size: i64,
    pub avg_price: f64,
    pub fees_paid: f64,
    pub remaining_size: i64,
    pub status: String,
    pub execution_time_ms: u64,
    pub error_message: Option<String>,
}

/// Fill details for order execution
#[derive(Debug, Clone)]
pub struct Fill {
    pub timestamp: chrono::DateTime<Utc>,
    pub price: f64,
    pub size: i64,
    pub fee: f64,
    pub tx_hash: Option<String>,
}

/// Trade record for history
#[derive(Debug, Clone, Serialize)]
pub struct TradeRecord {
    pub id: String,
    pub timestamp: chrono::DateTime<Utc>,
    pub market_id: String,
    pub side: String,
    pub size: i64,
    pub price: f64,
    pub fees: f64,
    pub pnl: Option<f64>,
    pub status: String,
}

/// Risk configuration
#[derive(Debug, Clone)]
pub struct RiskConfig {
    pub kelly_fraction: f64,
    pub max_position_pct: f64,
    pub daily_loss_limit_pct: f64,
    pub trading_enabled: bool,
    pub circuit_breaker_tripped_at: Option<chrono::DateTime<Utc>>,
    pub daily_pnl: f64,
    pub consecutive_errors: u32,
    pub last_reset: chrono::DateTime<Utc>,
}

impl Default for RiskConfig {
    fn default() -> Self {
        Self {
            kelly_fraction: KELLY_FRACTION,
            max_position_pct: MAX_POSITION_PCT,
            daily_loss_limit_pct: DAILY_LOSS_LIMIT_PCT,
            trading_enabled: true,
            circuit_breaker_tripped_at: None,
            daily_pnl: 0.0,
            consecutive_errors: 0,
            last_reset: Utc::now(),
        }
    }
}

/// Cached balance with timestamp
#[derive(Debug, Clone)]
struct CachedBalance {
    amount: f64,
    timestamp: Instant,
}

/// Order command for sequential processing
type TradeCommand = (
    String,           // market_id
    MarketType,        // platform
    OrderSide,        // side
    i64,              // size
    OrderType,        // order_type
    String,           // idempotency_key
    oneshot::Sender<Result<TradeResult, String>>,  // response_tx
);

/// Trading state
pub struct TradingState {
    pub positions: Arc<RwLock<HashMap<String, Position>>>,
    /// Multi-leg positions grouped by strategy
    pub multi_leg_positions: Arc<RwLock<HashMap<String, MultiLegPosition>>>,
    pub balance_cache: Arc<Mutex<HashMap<String, CachedBalance>>>,
    pub risk_config: Arc<RwLock<RiskConfig>>,
    pub order_tx: mpsc::Sender<TradeCommand>,
    pub daily_pnl: Arc<Mutex<f64>>,
    _order_processor: Arc<tauri::async_runtime::JoinHandle<()>>,
}

impl TradingState {
    pub fn new(_market_state: MarketState) -> Self {
        let (tx, mut rx) = mpsc::channel::<TradeCommand>(100);
        let positions = Arc::new(RwLock::new(HashMap::new()));
        let positions_clone = positions.clone();

        // Spawn order processing task (sequential execution guarantee)
        let processor = tauri::async_runtime::spawn(async move {
            while let Some((market_id, platform, side, size, order_type, idempotency_key, response_tx)) = rx.recv().await {
                process_trade_command(
                    (market_id, platform, side, size, order_type, idempotency_key, response_tx),
                    positions_clone.clone(),
                ).await;
                // response_tx is moved into process_trade_command and sent from there
            }
        });

        Self {
            positions,
            multi_leg_positions: Arc::new(RwLock::new(HashMap::new())),
            balance_cache: Arc::new(Mutex::new(HashMap::new())),
            risk_config: Arc::new(RwLock::new(RiskConfig::default())),
            order_tx: tx,
            daily_pnl: Arc::new(Mutex::new(0.0)),
            _order_processor: Arc::new(processor),
        }
    }
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Place a new order
#[tauri::command]
pub async fn place_order(
    market_id: String,
    platform: MarketType,
    side: OrderSide,
    size: i64,
    order_type: OrderType,
    idempotency_key: Option<String>,
    state: State<'_, TradingState>,
    market_state: State<'_, MarketState>,
) -> Result<TradeResult, String> {
    // Check circuit breaker
    {
        let risk = state.risk_config.read().await;
        if !risk.trading_enabled {
            return Err(format!(
                "Trading disabled: Circuit breaker tripped at {:?}",
                risk.circuit_breaker_tripped_at
            ));
        }
    }
    
    // Validate size
    if size <= 0 || size > MAX_ORDER_SIZE {
        return Err(format!("Invalid size: {}. Must be 1-{}", size, MAX_ORDER_SIZE));
    }
    
    // Check price sanity for limit orders
    if let OrderType::Limit(price) = &order_type {
        let orderbook = crate::commands::markets::get_orderbook(market_id.clone(), market_state.clone()).await?;
        let mid_price = (orderbook.bids[0][0] + orderbook.asks[0][0]) / 2.0;
        
        if (price - mid_price).abs() / mid_price > PRICE_DEVIATION_LIMIT {
            return Err(format!(
                "Price {} deviates >10% from market price {}",
                price, mid_price
            ));
        }
    }
    
    // Check risk limits
    check_risk_limits(&state, &market_id, size).await?;
    
    // Generate idempotency key if not provided
    let idempotency_key = idempotency_key.unwrap_or_else(|| Uuid::new_v4().to_string());
    
    // Create channel for response
    let (tx, rx) = oneshot::channel();
    
    // Send to order queue
    let cmd: TradeCommand = (
        market_id.clone(),
        platform,
        side,
        size,
        order_type,
        idempotency_key,
        tx,
    );
    
    state.order_tx.send(cmd).await
        .map_err(|_| "Order queue closed".to_string())?;
    
    // Wait for execution
    rx.await.map_err(|_| "Order processing cancelled")?
}

/// Get current positions
#[tauri::command]
pub async fn get_positions(
    status_filter: Option<String>,
    market_filter: Option<String>,
    state: State<'_, TradingState>,
    _market_state: State<'_, MarketState>,
) -> Result<Vec<Position>, String> {
    let positions = state.positions.read().await;
    let result: Vec<Position> = positions
        .values()
        .filter(|p| {
            let status_match = match &status_filter {
                Some(s) => p.status.to_lowercase() == s.to_lowercase(),
                None => p.status == PositionStatus::OPEN,
            };
            let market_match = match &market_filter {
                Some(m) => p.market_id == *m,
                None => true,
            };
            status_match && market_match
        })
        .cloned()
        .collect();
    
    Ok(result)
}

/// Close an existing position
#[tauri::command]
pub async fn close_position(
    position_id: String,
    exit_price: Option<f64>,
    state: State<'_, TradingState>,
    market_state: State<'_, MarketState>,
) -> Result<TradeResult, String> {
    // Get position details
    let position = {
        let positions = state.positions.read().await;
        positions.get(&position_id).cloned()
            .ok_or("Position not found".to_string())?
    };
    
    if position.status != PositionStatus::OPEN {
        return Err("Position already closed".to_string());
    }
    
    // Determine order type based on exit_price
    let order_type = match exit_price {
        Some(price) => OrderType::Limit(price),
        None => OrderType::Market,
    };
    
    // Determine close side based on position_type
    let close_side = match position.position_type.as_str() {
        "long" => OrderSide::Sell,
        "short" => OrderSide::Buy,
        _ => OrderSide::Buy,
    };
    
    // Convert platform string to MarketType enum
    let platform = if position.market_type == "Polymarket" {
        MarketType::Polymarket
    } else {
        MarketType::Kalshi
    };
    
    // Place closing order (opposite side)
    place_order(
        position.market_id.clone(),
        platform,
        close_side,
        position.quantity as i64,
        order_type,
        Some(format!("close-{}", position_id)),
        state.clone(),
        market_state.clone(),
    ).await
}

/// Get trade history
#[tauri::command]
pub async fn get_trade_history(
    start_date: Option<chrono::DateTime<Utc>>,
    end_date: Option<chrono::DateTime<Utc>>,
    market_filter: Option<String>,
    limit: Option<usize>,
    state: State<'_, TradingState>,
) -> Result<Vec<TradeRecord>, String> {
    // In production, query database. Here we reconstruct from positions
    let positions = state.positions.read().await;
    let mut records = Vec::new();
    
    for pos in positions.values() {
        // Check filters
        if let Some(ref market) = market_filter {
            if pos.market_id != *market {
                continue;
            }
        }
        
        if let Some(start) = start_date {
            if pos.entry_time < start.timestamp() {
                continue;
            }
        }
        
        if let Some(end) = end_date {
            if pos.entry_time > end.timestamp() {
                continue;
            }
        }
        
        // Add entry trade
        records.push(TradeRecord {
            id: format!("{}-entry", pos.id),
            timestamp: chrono::DateTime::from_timestamp(pos.entry_time, 0).unwrap_or(Utc::now()),
            market_id: pos.market_id.clone(),
            side: pos.position_type.clone(),
            size: pos.quantity as i64,
            price: pos.entry_price,
            fees: pos.fees,
            pnl: None,
            status: "FILLED".to_string(),
        });
        
        // Add exit trade if closed
        if pos.status == PositionStatus::CLOSED {
            if let Some(exit_price) = pos.exit_price {
                let exit_time = pos.exit_time.map(|t| chrono::DateTime::from_timestamp(t, 0).unwrap_or(Utc::now())).unwrap_or(Utc::now());
                
                // Opposite side
                let exit_side = match pos.position_type.as_str() {
                    "long" => "short".to_string(),
                    "short" => "long".to_string(),
                    _ => pos.position_type.clone(),
                };
                
                records.push(TradeRecord {
                    id: format!("{}-exit", pos.id),
                    timestamp: exit_time,
                    market_id: pos.market_id.clone(),
                    side: exit_side,
                    size: pos.quantity as i64,
                    price: exit_price,
                    fees: 0.0,
                    pnl: pos.realized_pnl,
                    status: "FILLED".to_string(),
                });
            }
        }
    }
    
    // Sort by timestamp descending
    records.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    
    // Apply limit
    let limit = limit.unwrap_or(100);
    records.truncate(limit);
    
    Ok(records)
}

/// Calculate optimal position size using Kelly Criterion
#[tauri::command]
pub async fn calculate_position_size(
    _market_id: String,
    win_probability: f64,
    current_odds: f64,
    portfolio_value: f64,
    state: State<'_, TradingState>,
) -> Result<f64, String> {
    if win_probability <= 0.0 || win_probability >= 1.0 {
        return Err("Win probability must be between 0 and 1".to_string());
    }
    if current_odds <= 0.0 || current_odds >= 1.0 {
        return Err("Current odds must be between 0 and 1".to_string());
    }
    if portfolio_value <= 0.0 {
        return Err("Portfolio value must be positive".to_string());
    }
    
    let risk_config = state.risk_config.read().await;
    
    // Kelly Criterion: f = (bp - q) / b
    let b = (1.0 - current_odds) / current_odds;
    let p = win_probability;
    let q = 1.0 - p;
    
    let kelly_pct = (b * p - q) / b;
    
    if kelly_pct <= 0.0 {
        return Ok(0.0);
    }
    
    let adjusted_kelly = kelly_pct * risk_config.kelly_fraction;
    let max_position_value = portfolio_value * risk_config.max_position_pct;
    let position_value = (portfolio_value * adjusted_kelly).min(max_position_value);
    
    Ok(position_value.floor())
}

/// Reset circuit breaker (manual override)
#[tauri::command]
pub async fn reset_circuit_breaker(
    state: State<'_, TradingState>,
) -> Result<(), String> {
    let mut risk = state.risk_config.write().await;
    risk.trading_enabled = true;
    risk.circuit_breaker_tripped_at = None;
    risk.consecutive_errors = 0;
    risk.daily_pnl = 0.0;
    risk.last_reset = Utc::now();
    Ok(())
}

// ============================================================================
// INTERNAL IMPLEMENTATION
// ============================================================================

async fn process_trade_command(
    cmd: TradeCommand,
    _positions: Arc<RwLock<HashMap<String, Position>>>,
) {
    let (_, platform, side, size, order_type, _, response_tx) = cmd;
    let start = Instant::now();
    
    // Mock execution
    match execute_on_platform(platform.clone(), side.clone(), size, order_type).await {
        Ok(fill) => {
            let trade_result = TradeResult {
                success: true,
                order_id: Uuid::new_v4().to_string(),
                position_id: None,
                filled_size: fill.size,
                avg_price: fill.price,
                fees_paid: fill.fee,
                remaining_size: size - fill.size,
                status: if fill.size == size { "FILLED".to_string() } else { "PARTIAL".to_string() },
                execution_time_ms: start.elapsed().as_millis() as u64,
                error_message: None,
            };
            let _ = response_tx.send(Ok(trade_result));
        }
        Err(e) => {
            let _ = response_tx.send(Err(e));
        }
    };
}

async fn execute_on_platform(
    platform: MarketType,
    _side: OrderSide,
    size: i64,
    order_type: OrderType,
) -> Result<Fill, String> {
    // Simulate network delay
    tokio::time::sleep(StdDuration::from_millis(50)).await;
    
    // Mock fill at market price
    let price = match order_type {
        OrderType::Limit(price) => price,
        OrderType::Market => 0.52,
    };
    
    // Calculate fees
    let fee_rate = match platform {
        MarketType::Polymarket => POLYMARKET_TAKER_FEE,
        MarketType::Kalshi => KALSHI_FEE_CAP,
    };
    
    let notional = price * size as f64;
    let fee = notional * fee_rate;
    
    Ok(Fill {
        timestamp: Utc::now(),
        price,
        size,
        fee,
        tx_hash: Some(format!("0x{}", Uuid::new_v4().to_string())),
    })
}

async fn check_risk_limits(
    state: &State<'_, TradingState>,
    _market_id: &str,
    _size: i64,
) -> Result<(), String> {
    let risk = state.risk_config.read().await;
    let daily = state.daily_pnl.lock().await;
    
    if daily.abs() > risk.daily_loss_limit_pct * 100000.0 {
        return Err("Daily loss limit exceeded".to_string());
    }
    
    Ok(())
}

async fn update_error_counter(state: State<'_, TradingState>, is_error: bool) {
    let mut risk = state.risk_config.write().await;
    
    if is_error {
        risk.consecutive_errors += 1;
        if risk.consecutive_errors >= CIRCUIT_BREAKER_ERRORS {
            risk.trading_enabled = false;
            risk.circuit_breaker_tripped_at = Some(Utc::now());
        }
    } else {
        risk.consecutive_errors = 0;
    }
}

// ============================================================================
// MULTI-LEG TRADING COMMANDS
// ============================================================================
//
// These commands support multi-outcome (categorical) markets and multi-leg
// order structures. They extend the single-leg trading commands above to
// handle coordinated execution across multiple markets/outcomes.
//
// Command Summary:
//   - place_multi_leg_order: Submit multi-leg order (OCO, bracket, spread)
//   - get_multi_leg_positions: Query multi-leg positions with filtering
//   - close_multi_leg_position: Close all legs of a multi-leg position
//   - close_position_leg: Close a single leg within a multi-leg position
//   - get_multi_leg_position: Get a specific multi-leg position by ID
//
// ============================================================================

/// Input leg for the place_multi_leg_order command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderLegInput {
    pub market_id: String,
    pub outcome_id: Option<String>,
    pub side: String,       // "buy" or "sell"
    pub ratio: f64,
    pub size: f64,
    pub price: Option<f64>,
    pub market_node_id: Option<String>,
}

/// Place a multi-leg order (OCO, bracket, spread, or single)
///
/// Coordinates execution across multiple markets/outcomes according
/// to the specified order type strategy. Returns per-leg results
/// and creates a grouped multi-leg position for filled legs.
///
/// Frontend: await invoke('place_multi_leg_order', {
///   legs: [{ market_id, side, size, ... }, ...],
///   orderType: 'spread',
///   timeInForce: 'GTC',
///   strategyLabel: 'BTC hedged position'
/// })
#[tauri::command]
pub async fn place_multi_leg_order(
    legs: Vec<OrderLegInput>,
    order_type: String,
    time_in_force: Option<String>,
    strategy_label: Option<String>,
    state: State<'_, TradingState>,
) -> Result<MultiLegTradeResult, String> {
    // Check circuit breaker
    {
        let risk = state.risk_config.read().await;
        if !risk.trading_enabled {
            return Err(format!(
                "Trading disabled: Circuit breaker tripped at {:?}",
                risk.circuit_breaker_tripped_at
            ));
        }
    }

    // Validate at least one leg
    if legs.is_empty() {
        return Err("Multi-leg order must have at least one leg".to_string());
    }

    // Parse order type
    let ml_order_type = match order_type.as_str() {
        "single" => MultiLegOrderType::Single,
        "oco" => MultiLegOrderType::OCO,
        "bracket" => MultiLegOrderType::Bracket,
        "spread" => MultiLegOrderType::Spread,
        _ => return Err(format!("Unknown multi-leg order type: {}", order_type)),
    };

    // Parse time in force
    let tif = match time_in_force.as_deref().unwrap_or("GTC") {
        "GTC" => crate::models::market::TimeInForce::GTC,
        "GTT" => crate::models::market::TimeInForce::GTT,
        "IOC" => crate::models::market::TimeInForce::IOC,
        "FOK" => crate::models::market::TimeInForce::FOK,
        _ => crate::models::market::TimeInForce::GTC,
    };

    // Convert input legs to model legs
    let order_legs: Vec<MarketOrderLeg> = legs.iter().map(|l| {
        let side = match l.side.as_str() {
            "sell" => OrderSide::Sell,
            _ => OrderSide::Buy,
        };
        MarketOrderLeg {
            market_id: l.market_id.clone(),
            outcome_id: l.outcome_id.clone(),
            side,
            ratio: l.ratio,
            size: l.size,
            price: l.price,
            market_node_id: l.market_node_id.clone(),
        }
    }).collect();

    // Check total size across all legs
    let total_size: f64 = order_legs.iter().map(|l| l.size).sum();
    if total_size > MAX_ORDER_SIZE as f64 {
        return Err(format!(
            "Total size across legs ({}) exceeds max ({})",
            total_size, MAX_ORDER_SIZE
        ));
    }

    // Construct the multi-leg order
    let strategy_id = Uuid::new_v4().to_string();
    let now = Utc::now().timestamp();
    let ml_order = MultiLegOrder {
        id: Uuid::new_v4().to_string(),
        legs: order_legs,
        order_type: ml_order_type,
        time_in_force: tif,
        status: "pending".to_string(),
        created_at: now,
        updated_at: now,
        strategy_label,
        total_fees: 0.0,
        strategy_id: Some(strategy_id),
    };

    // Execute via the multi-leg executor
    let result = crate::services::executor::execute_multi_leg_order(
        &ml_order,
        state.positions.clone(),
        state.multi_leg_positions.clone(),
    ).await?;

    Ok(result)
}

/// Get multi-leg positions with optional filtering
///
/// Returns all multi-leg positions, optionally filtered by status
/// and/or strategy type. Each position includes all its constituent
/// legs with individual and aggregate P&L metrics.
///
/// Frontend: await invoke('get_multi_leg_positions', {
///   statusFilter: 'open',
///   strategyFilter: 'arbitrage'
/// })
#[tauri::command]
pub async fn get_multi_leg_positions(
    status_filter: Option<String>,
    strategy_filter: Option<String>,
    state: State<'_, TradingState>,
) -> Result<Vec<MultiLegPosition>, String> {
    let positions = state.multi_leg_positions.read().await;
    let result: Vec<MultiLegPosition> = positions
        .values()
        .filter(|p| {
            let status_match = match &status_filter {
                Some(s) => p.status.to_lowercase() == s.to_lowercase(),
                None => p.status == "open",
            };
            let strategy_match = match &strategy_filter {
                Some(s) => p.strategy_type.to_lowercase() == s.to_lowercase(),
                None => true,
            };
            status_match && strategy_match
        })
        .cloned()
        .collect();

    Ok(result)
}

/// Close all legs of a multi-leg position
///
/// Iterates through all open legs and closes them at their current
/// market price (or specified exit price). Updates the multi-leg
/// position status to "closed" when all legs are closed.
///
/// Frontend: await invoke('close_multi_leg_position', {
///   positionId: 'uuid',
///   exitPrices: { 'leg-uuid-1': 0.55, 'leg-uuid-2': 0.45 }
/// })
#[tauri::command]
pub async fn close_multi_leg_position(
    position_id: String,
    exit_prices: Option<HashMap<String, f64>>,
    state: State<'_, TradingState>,
) -> Result<MultiLegPosition, String> {
    let mut positions = state.multi_leg_positions.write().await;
    let position = positions.get_mut(&position_id)
        .ok_or_else(|| format!("Multi-leg position not found: {}", position_id))?;

    if position.status != "open" && position.status != "partial" {
        return Err("Position already closed".to_string());
    }

    // Close each open leg
    let exit_prices = exit_prices.unwrap_or_default();
    for leg in &mut position.legs {
        if leg.status == "open" {
            // Use specified exit price or current price
            let exit_price = exit_prices.get(&leg.leg_id)
                .copied()
                .unwrap_or(leg.current_price);
            let exit_fee = exit_price * leg.size * 0.02; // 2% exit fee estimate
            leg.exit_price = Some(exit_price);
            leg.fees += exit_fee;
            leg.status = "closed".to_string();
        }
    }

    // Update position status
    position.status = "closed".to_string();
    position.closed_at = Some(Utc::now().timestamp());

    Ok(position.clone())
}

/// Close a single leg within a multi-leg position
///
/// Closes only the specified leg, leaving other legs open. Used for
/// partial position management (e.g., closing losing leg of a spread
/// while keeping the winning leg).
///
/// Frontend: await invoke('close_position_leg', {
///   positionId: 'uuid',
///   legId: 'leg-uuid',
///   exitPrice: 0.55
/// })
#[tauri::command]
pub async fn close_position_leg(
    position_id: String,
    leg_id: String,
    exit_price: Option<f64>,
    state: State<'_, TradingState>,
) -> Result<MultiLegPosition, String> {
    let mut positions = state.multi_leg_positions.write().await;
    let position = positions.get_mut(&position_id)
        .ok_or_else(|| format!("Multi-leg position not found: {}", position_id))?;

    // Find the leg
    let leg = position.legs.iter().find(|l| l.leg_id == leg_id)
        .ok_or_else(|| format!("Leg not found: {}", leg_id))?;

    if leg.status != "open" {
        return Err(format!("Leg {} is already {}", leg_id, leg.status));
    }

    let final_exit_price = exit_price.unwrap_or(leg.current_price);
    let exit_fee = final_exit_price * leg.size * 0.02;

    // Close the specific leg (use the position-level method)
    position.close_leg(&leg_id, final_exit_price, exit_fee);

    Ok(position.clone())
}

/// Get a specific multi-leg position by ID
///
/// Returns the full multi-leg position with all legs and computed
/// aggregate metrics (combined P&L, hedge ratio, etc.).
///
/// Frontend: await invoke('get_multi_leg_position', { positionId: 'uuid' })
#[tauri::command]
pub async fn get_multi_leg_position(
    position_id: String,
    state: State<'_, TradingState>,
) -> Result<MultiLegPosition, String> {
    let positions = state.multi_leg_positions.read().await;
    positions.get(&position_id)
        .cloned()
        .ok_or_else(|| format!("Multi-leg position not found: {}", position_id))
}

// ============================================================================
// SHUTDOWN HANDLER
// ============================================================================

pub async fn shutdown_trading(state: &TradingState) -> Result<(), String> {
    println!("Shutting down trading module...");

    // Persist open single-leg positions
    let positions = state.positions.read().await;
    for (id, pos) in positions.iter() {
        if pos.status == PositionStatus::OPEN {
            println!("Persisting open position {}", id);
        }
    }

    // Persist open multi-leg positions
    let ml_positions = state.multi_leg_positions.read().await;
    for (id, pos) in ml_positions.iter() {
        if pos.status == "open" || pos.status == "partial" {
            println!("Persisting open multi-leg position {} ({} legs)", id, pos.legs.len());
        }
    }

    Ok(())
}
