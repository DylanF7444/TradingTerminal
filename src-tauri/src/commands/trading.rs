// ============================================================================
// TRADING EXECUTION COMMAND HANDLERS
// ============================================================================
//
// Module: commands/trading.rs
// Purpose: Tauri command handlers for executing trades and managing positions
//
// OVERVIEW:
// This module handles the complete trade lifecycle: order placement, position
// tracking, risk management, and profit/loss calculation. Implements the Kelly
// criterion for optimal position sizing and maintains comprehensive audit logs.
//
// Trading Workflow:
// 1. Signal Generation: External analyzer detects opportunity
// 2. Risk Check: Kelly criterion calculates safe position size
// 3. Pre-trade Validation: Balance check, limits verification
// 4. Order Execution: Submit to market API with retry logic
// 5. Fill Monitoring: Track partial fills and completion
// 6. Position Update: Record in database, update UI
// 7. P&L Calculation: Real-time unrealized, finalized realized P&L
//
// Risk Management:
// - Kelly Criterion: f = (bp - q) / b, where b=odds, p=win probability
// - Maximum position size: 10% of portfolio per trade
// - Daily loss limits: Circuit breaker after 5% daily drawdown
// - Fee accounting: Includes platform fees in profit calculations
//
// COMMANDS (Tauri-callable functions):
//
// 1. place_order(market_id, side, size, price, order_type) -> Result<TradeResult, String>
//    - Executes buy/sell orders on connected markets
//    - Validates sufficient balance and position limits
//    - Calculates fees (Polymarket: 2% taker, Kalshi: 0.5% cap)
//    - Submits order via REST API with retry logic
//    - Returns: TradeResult with fill details, fees paid, execution time
//    - Side: "YES"/"NO" for binary markets, or "BUY"/"SELL"
//
// 2. get_positions(filter) -> Result<Vec<Position>, String>
//    - Retrieves current open positions and optionally closed history
//    - Calculates unrealized P&L using current market prices
//    - Filters: by market, by date range, by status (open/closed)
//    - Returns: Array of Position objects with P&L metrics
//    - Real-time updates via WebSocket (no API call needed for price updates)
//
// 3. close_position(position_id, exit_price?) -> Result<TradeResult, String>
//    - Closes existing position by placing opposite order
//    - Automatically calculates exit size to close full position
//    - Optional exit_price: limit order (omit for market order)
//    - Updates realized P&L after fees
//    - Archives position to history
//
// 4. get_trade_history(filters) -> Result<Vec<TradeRecord>, String>
//    - Retrieves historical trades for performance analysis
//    - Includes failed/cancelled orders for debugging
//    - Filters: date range, market, profit/loss threshold
//    - Pagination support for large histories
//
// 5. calculate_position_size(market_id, confidence, odds) -> Result<f64, String>
//    - Pre-trade calculator using Kelly Criterion
//    - Returns recommended contract size based on:
//      - Current portfolio value
//      - Win probability estimate (confidence)
//      - Market odds (implied probability)
//      - Available balance
//    - Respects maximum position limits
//
// STATE MANAGEMENT:
// - ACTIVE_POSITIONS: Arc<RwLock<HashMap<String, Position>>>
//   - Maps position_id → Position struct
//   - In-memory cache for fast UI updates
//   - Persisted to SQLite for durability
//   - RwLock allows concurrent position updates (e.g., price tick updates P&L)
//
// - BALANCE_CACHE: Arc<Mutex<HashMap<String, f64>>>
//   - Maps market_type → available_balance
//   - Updated after each trade
//   - TTL 60 seconds, refreshed from API if stale
//   - Prevents over-trading due to stale balance data
//
// - ORDER_QUEUE: mpsc::Sender<TradeCommand>
//   - Sequential order processing channel
//   - Ensures balance checks and execution are atomic
//   - Prevents race conditions between concurrent trades
//   - Buffer size: 100 orders (backpressure protection)
//
// - RISK_CONFIG: Arc<RwLock<RiskConfiguration>>
//   - Kelly fraction multiplier (conservative: 0.5x Kelly)
//   - Max position size percentage (default: 10%)
//   - Daily loss limit (default: 5% of portfolio)
//   - Circuit breaker state (trading_enabled: bool)
//
// EXTERNAL METHODS CALLED:
//
// Market API execution (services/executor.rs):
// - submit_order_polymarket(order) -> Result<Fill, Error>
//   - POST /exchange/v1/orders
//   - Handles signature generation (EIP-712 for Polygon)
//   - Returns fill details including partial fills
//   - Retry logic: 3 attempts with exponential backoff
//
// - submit_order_kalshi(order) -> Result<Fill, Error>
//   - POST /portfolio/orders
//   - REST-based order submission
//   - Handles order validation errors
//
// - check_balance(market_type) -> Result<f64, Error>
//   - Fetches available collateral from platform
//   - Cached for 60 seconds to reduce API calls
//
// Risk management (services/risk.rs):
// - calculate_kelly_size(portfolio_value, probability, odds) -> f64
//   - Pure calculation function
//   - Returns 0.0 if no edge detected (negative expected value)
//   - Applies fractional Kelly (0.5) for safety
//
// - check_risk_limits(order) -> Result<(), RiskError>
//   - Validates against daily loss limits
//   - Checks maximum position concentration
//   - Verifies correlation limits (avoid correlated bets)
//
// Database operations (db/sqlite.rs):
// - insert_position(position) -> Result<String, Error>
//   - Returns generated position_id UUID
//   - Inserts into 'positions' table
//
// - update_position_fill(position_id, fill) -> Result<(), Error>
//   - Updates filled_size, avg_entry_price
//   - Appends to fills array (JSON)
//
// - close_position_db(position_id, exit_fill) -> Result<Position, Error>
//   - Calculates realized P&L: (exit_price - entry_price) * size - fees
//   - Updates status to 'closed'
//   - Moves to 'position_history' table
//
// Notification (services/notifier.rs):
// - notify_trade_executed(trade_result) -> ()
//   - Emits WebSocket event to frontend
//   - Sends OS notification if enabled
//   - Logs to trading journal
//
// DEPENDENCIES:
// - crate::models::position::{Position, TradeResult, TradeSide}
// - crate::models::market::Orderbook (for current pricing)
// - crate::services::risk::RiskManager
// - crate::services::executor::OrderExecutor
// - tokio::sync::{RwLock, mpsc} (async state management)
// - chrono (timestamp generation)
// - uuid (position IDs)
// - rust_decimal (precise monetary calculations, avoids float errors)
//
// ERROR HANDLING:
// All commands return Result<T, String> for Tauri compatibility
// Error types:
// - InsufficientFundsError: Balance < required collateral + fees
// - RiskLimitError: Position exceeds Kelly criterion or max size limits
// - MarketNotConnectedError: Attempted trade on removed market
// - OrderRejectedError: Platform rejected order (price out of bounds, etc.)
// - NetworkError: API timeout or connection failure
// - FillError: Partial fill handling failures
//
// Atomicity Guarantees:
// - Balance checks and order submission are sequential via ORDER_QUEUE
// - Database writes use transactions (position insert + balance update)
// - Failed orders do not deduct balance or create ghost positions
//
// PERFORMANCE NOTES:
// - Order execution latency target: <200ms (platform API dependent)
// - In-memory position cache updates in <1ms
// - Database writes async (fire-and-forget for logging, await for positions)
// - Supports 10+ orders/second sustained throughput
// - Batch position updates every 100ms to reduce UI re-renders
//
// SAFETY FEATURES:
// - Circuit breaker: Stops trading after 3 consecutive errors
// - Maximum order size validation (hard cap 10000 contracts)
// - Price sanity checks (reject orders >10% away from last price)
// - Duplicate order detection (idempotency keys)
// - Automatic position reconciliation with platform API every 5 minutes
//
// TESTING:
// - Unit tests for Kelly criterion calculations
// - Mock executor for testing order logic without real trades
// - Property-based testing for P&L calculations (fuzzing)
// - Integration tests with testnet APIs (no real money)
//
// USAGE EXAMPLE (from frontend):
// ```typescript
// import { invoke } from '@tauri-apps/api/tauri';
// 
// // Execute a trade
// const result = await invoke('place_order', {
//   marketId: 'poly-btc-100k',
//   side: 'YES',
//   size: 100,
//   price: 0.52,
//   orderType: 'LIMIT'
// });
// 
// console.log('Filled:', result.filled_size, 'at', result.avg_price);
// console.log('Fees:', result.fees_paid);
// 
// // Monitor positions
// const positions = await invoke('get_positions', {
//   filter: { status: 'OPEN' }
// });
// ```
//
// FUTURE ENHANCEMENTS:
// - Advanced order types: Stop-loss, take-profit, bracket orders
// - Position averaging (DCA) automation
// - Cross-market hedging (correlation-based)
// - Paper trading mode (simulated execution)
// - Trade journaling with notes/tags
// - Performance analytics (Sharpe ratio, win rate by strategy)
// ============================================================================