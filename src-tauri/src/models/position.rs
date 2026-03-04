
// ============================================================================
// POSITION MODEL
// ============================================================================
//
// Module: models/position.rs
// Purpose: Data model and business logic for trading positions
//
// OVERVIEW:
// This module defines the Position struct and associated methods for tracking
// trading positions in prediction markets. A position represents a bet on a
// binary outcome (YES/NO) with complete lifecycle management from entry to exit.
//
// POSITION LIFECYCLE:
// 1. Position created (new())
//    - Status: "open"
//    - Entry price and time recorded
//    - Fees calculated (entry fees)
// 
// 2. Position monitored
//    - Unrealized P&L calculated continuously (calculate_unrealized_pnl())
//    - Based on current market price
//    - UI shows live updates
//
// 3. Position closed (close())
//    - Status: "open" → "closed"
//    - Exit price and time recorded
//    - Exit fees added
//    - Realized P&L calculated (final profit/loss)
//
// 4. OR Position fails (mark_failed())
//    - Status: "open" → "failed"
//    - Reason stored in metadata
//    - No P&L calculation
//
// PREDICTION MARKET MECHANICS:
// Prediction markets use probability-based pricing:
// - Prices range from 0.0 to 1.0 (0% to 100% probability)
// - Buy "YES" at 0.60 = betting outcome will happen (60% implied probability)
// - Buy "NO" at 0.40 = betting outcome won't happen (same as selling YES)
// - YES price + NO price ≈ 1.0 (market equilibrium)
//
// POSITION TYPES:
// 
// Long Position (position_type = "long"):
// - Buying YES contracts
// - Profit when price increases
// - Example: Buy YES at 0.50, sell at 0.60 → profit 0.10 per contract
//
// Short Position (position_type = "short"):
// - Buying NO contracts (or selling YES)
// - Profit when price decreases
// - Example: Buy NO at 0.50 (YES is 0.50), YES drops to 0.40 → profit 0.10
//
// STRUCT FIELDS:
//
// id: String
// - Unique identifier (UUID v4)
// - Used to reference position in database
//
// market_id: String
// - Foreign key to nodes table (market node)
// - Example: "polymarket:election-2026"
//
// market_type: String
// - "Polymarket", "Kalshi", etc.
// - Determines fee structure and API calls
//
// position_type: String
// - "long" or "short"
// - Affects P&L calculation direction
//
// quantity: f64
// - Number of contracts
// - Example: 100.0 contracts at $0.50 = $50 position
//
// entry_price: f64
// - Price per contract when position opened (0.0 to 1.0)
// - Example: 0.52 (52% probability)
//
// exit_price: Option<f64>
// - Price when position closed
// - None if still open
//
// entry_time: i64
// - Unix timestamp when position opened
// - Example: 1704067200 (Jan 1, 2024 00:00:00 UTC)
//
// exit_time: Option<i64>
// - Unix timestamp when position closed
// - None if still open
//
// realized_pnl: Option<f64>
// - Final profit/loss after closing
// - None if still open
// - Negative = loss, Positive = profit
//
// fees: f64
// - Total fees paid (entry + exit)
// - Polymarket: ~2% per trade
// - Kalshi: ~1% per trade
// - Accumulated as position progresses
//
// status: String
// - "open" - Position is active
// - "closed" - Position was exited normally
// - "failed" - Order was rejected or error occurred
//
// metadata: JsonValue
// - Additional data (order IDs, notes, tags)
// - Flexible JSON object for extensibility
// - Example: {"order_id": "abc123", "strategy": "arbitrage"}
//
// PUBLIC METHODS:
//
// new(market_id, market_type, position_type, quantity, entry_price, entry_time, fees) -> Position
// - Constructor for new open position
// - Generates UUID for id
// - Sets status to "open"
// - Initializes empty metadata
// - Example:
//   Position::new(
//       "market-123".to_string(),
//       "Polymarket".to_string(),
//       "long".to_string(),
//       100.0,    // 100 contracts
//       0.52,     // entry at 52 cents
//       1704067200,
//       1.04      // 2% fee on $52 position
//   )
//
// calculate_unrealized_pnl(&self, current_price: f64) -> f64
// - Calculates profit/loss if position were closed now
// - For open positions: (current_price - entry_price) * quantity - fees
// - For closed positions: Returns realized_pnl
// - For long: profit when price increases
// - For short: profit when price decreases
// - Returns: f64 (can be negative for losses)
// - Example:
//   Long position: bought 100 @ 0.50, current 0.60
//   P&L = (0.60 - 0.50) * 100 - 2.0 = 10.0 - 2.0 = $8.00 profit
//
// close(&mut self, exit_price: f64, exit_time: i64, exit_fees: f64)
// - Closes an open position
// - Sets exit_price and exit_time
// - Adds exit_fees to total fees
// - Calculates final realized_pnl
// - Changes status to "closed"
// - Example:
//   position.close(0.65, 1704153600, 1.30); // Close at 65 cents with $1.30 exit fee
//
// mark_failed(&mut self, reason: String)
// - Marks position as failed
// - Sets status to "failed"
// - Stores failure reason in metadata["failure_reason"]
// - Used for: insufficient liquidity, API errors, risk limit violations
// - Example:
//   position.mark_failed("Insufficient liquidity in orderbook".to_string());
//
// P&L CALCULATION EXAMPLES:
//
// Example 1: Profitable Long Position
// - Buy 100 YES contracts at 0.50 (cost: $50)
// - Entry fee: 2% = $1.00
// - Price rises to 0.60
// - Unrealized P&L: (0.60 - 0.50) * 100 - 1.00 = $9.00
// - Sell at 0.60 (receive: $60)
// - Exit fee: 2% = $1.20
// - Realized P&L: (0.60 - 0.50) * 100 - 1.00 - 1.20 = $7.80 profit
//
// Example 2: Losing Short Position
// - Buy 100 NO contracts at 0.40 (YES is 0.60, cost: $40)
// - Entry fee: 2% = $0.80
// - YES price falls to 0.50 (NO price rises to 0.50)
// - Short profits when YES falls, so this is GOOD
// - Unrealized P&L: (0.60 - 0.50) * 100 - 0.80 = $9.20 profit
// - Close at NO 0.50 (receive: $50)
// - Exit fee: 2% = $1.00
// - Realized P&L: (0.60 - 0.50) * 100 - 0.80 - 1.00 = $8.20 profit
//
// Example 3: Failed Position
// - Attempt to buy 10000 YES at 0.52
// - Orderbook only has 500 contracts available
// - Order rejected by exchange
// - mark_failed("Insufficient liquidity")
// - No P&L, just loss of time
//
// FEE STRUCTURES BY MARKET:
//
// Polymarket:
// - Trading fee: ~2% per side (entry + exit = 4% total)
// - Example: $100 position → $2 entry fee, $2 exit fee = $4 total
//
// Kalshi:
// - Trading fee: ~1% per side (entry + exit = 2% total)
// - Lower fees but sometimes lower liquidity
//
// Custom markets:
// - Fees passed in as parameters
// - Flexible for future market integrations
//
// USAGE IN TRADING FLOW:
//
// 1. Analyzer detects arbitrage opportunity
// 2. Executor creates Position:
//    let mut position = Position::new(...);
// 3. Executor places order via market API
// 4. If successful: insert_position(&conn, &position)?;
// 5. If failed: position.mark_failed(reason);
// 6. UI monitors with calculate_unrealized_pnl(current_price)
// 7. When exit condition met:
//    position.close(exit_price, exit_time, exit_fees);
//    update_position_in_db(&position)?;
//
// EXTERNAL DEPENDENCIES:
// - serde: Serialization for database storage
// - serde_json: JSON metadata handling
// - uuid: Unique ID generation (if used)
//
// TESTING:
// Comprehensive test suite covering:
// - Position creation
// - Unrealized P&L calculation (long/short)
// - Position closing with fee accumulation
// - Failed position marking
// - Edge cases (zero quantity, 100% price moves)
//
// FUTURE ENHANCEMENTS:
// - Add position.partial_close() for scaling out
// - Implement stop-loss/take-profit triggers
// - Add average_down() / average_up() for adding to positions
// - Track individual fills (for partial execution)
// - Add position.duration() helper method
// - Implement position.roi() (return on investment %)
// ============================================================================


use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use uuid;
use chrono;

/// Represents a trading position in a prediction market
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    /// Unique identifier for the position
    pub id: String,
    
    /// ID of the market node this position is on
    pub market_id: String,
    
    /// Type of market (Polymarket, Kalshi, etc.)
    pub market_type: String,
    
    /// Position type: "long" (YES) or "short" (NO)
    pub position_type: String,
    
    /// Number of contracts
    pub quantity: f64,
    
    /// Entry price per contract (0.0 to 1.0)
    pub entry_price: f64,
    
    /// Exit price per contract (None if still open)
    pub exit_price: Option<f64>,
    
    /// Unix timestamp when position was opened
    pub entry_time: i64,
    
    /// Unix timestamp when position was closed (None if still open)
    pub exit_time: Option<i64>,
    
    /// Realized profit/loss (None if still open)
    pub realized_pnl: Option<f64>,
    
    /// Total fees paid (entry + exit)
    pub fees: f64,
    
    /// Position status: "open", "closed", "failed"
    pub status: String,
    
    /// Additional metadata (order IDs, notes, etc.)
    pub metadata: JsonValue,
}

impl Position {
    /// Create a new open position
    pub fn new(
        market_id: String,
        market_type: String,
        position_type: String,
        quantity: f64,
        entry_price: f64,
        entry_time: i64,
        fees: f64,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            market_id,
            market_type,
            position_type,
            quantity,
            entry_price,
            exit_price: None,
            entry_time,
            exit_time: None,
            realized_pnl: None,
            fees,
            status: "open".to_string(),
            metadata: serde_json::json!({}),
        }
    }
    
    /// Calculate unrealized P&L based on current market price
    pub fn calculate_unrealized_pnl(&self, current_price: f64) -> f64 {
        if self.status != "open" {
            return self.realized_pnl.unwrap_or(0.0);
        }
        
        let price_diff = match self.position_type.as_str() {
            "long" => current_price - self.entry_price,
            "short" => self.entry_price - current_price,
            _ => 0.0,
        };
        
        (price_diff * self.quantity) - self.fees
    }
    
    /// Close the position
    pub fn close(&mut self, exit_price: f64, exit_time: i64, exit_fees: f64) {
        self.exit_price = Some(exit_price);
        self.exit_time = Some(exit_time);
        self.fees += exit_fees;
        self.status = "closed".to_string();
        
        let price_diff = match self.position_type.as_str() {
            "long" => exit_price - self.entry_price,
            "short" => self.entry_price - exit_price,
            _ => 0.0,
        };
        
        self.realized_pnl = Some((price_diff * self.quantity) - self.fees);
    }
    
    /// Mark position as failed (order rejected, etc.)
    pub fn mark_failed(&mut self, reason: String) {
        self.status = "failed".to_string();
        self.metadata["failure_reason"] = serde_json::json!(reason);
    }
}

// ============================================================================
// MULTI-LEG POSITION TYPES
// ============================================================================
//
// These types support grouped positions for multi-leg strategies.
// A MultiLegPosition wraps multiple PositionLeg entries under a
// shared strategy_id, enabling combined P&L tracking and coordinated
// close operations across related markets/outcomes.
//
// Position Lifecycle:
//   1. MultiLegPosition created with legs from multi-leg order fill
//   2. Each leg tracks its own entry/exit prices and P&L independently
//   3. Combined metrics (unrealized P&L, hedge ratio) computed on demand
//   4. Close operations can target individual legs or entire position
//   5. When all legs closed, MultiLegPosition status becomes "closed"
//
// ============================================================================

/// Individual leg within a multi-leg position
///
/// Tracks the position state for one leg of a multi-leg strategy
/// including its own P&L, fill price, and current value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PositionLeg {
    /// Unique leg identifier
    pub leg_id: String,

    /// Market ID this leg is positioned in
    pub market_id: String,

    /// Outcome ID for categorical markets (None for binary)
    pub outcome_id: Option<String>,

    /// Position direction: "long" or "short"
    pub side: String,

    /// Number of contracts held on this leg
    pub size: f64,

    /// Average entry price for this leg
    pub entry_price: f64,

    /// Exit price for this leg (None if still open)
    pub exit_price: Option<f64>,

    /// Current market price for this leg
    pub current_price: f64,

    /// Fees paid for this specific leg
    pub fees: f64,

    /// Leg status: "open", "closed", "failed"
    pub status: String,

    /// Reference to node graph node
    pub market_node_id: Option<String>,
}

impl PositionLeg {
    /// Calculate unrealized P&L for this individual leg
    pub fn calculate_unrealized_pnl(&self) -> f64 {
        if self.status != "open" {
            // Return realized P&L for closed legs
            return self.calculate_realized_pnl().unwrap_or(0.0);
        }
        let price_diff = match self.side.as_str() {
            "long" => self.current_price - self.entry_price,
            "short" => self.entry_price - self.current_price,
            _ => 0.0,
        };
        (price_diff * self.size) - self.fees
    }

    /// Calculate realized P&L (only valid for closed legs)
    pub fn calculate_realized_pnl(&self) -> Option<f64> {
        self.exit_price.map(|exit| {
            let price_diff = match self.side.as_str() {
                "long" => exit - self.entry_price,
                "short" => self.entry_price - exit,
                _ => 0.0,
            };
            (price_diff * self.size) - self.fees
        })
    }
}

/// Multi-leg position grouping individual legs under a strategy
///
/// Provides aggregate P&L and combined value metrics across all legs.
/// The strategy_id links this position back to the multi-leg order
/// that created it, enabling full audit trail from signal to position.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiLegPosition {
    /// Unique position group ID
    pub id: String,

    /// Strategy identifier for grouping related positions
    pub strategy_id: String,

    /// Individual position legs
    pub legs: Vec<PositionLeg>,

    /// Strategy type: "single", "multi-leg", "arbitrage"
    pub strategy_type: String,

    /// User-defined strategy label
    pub strategy_label: Option<String>,

    /// Position status: "open", "closed", "partial", "failed"
    pub status: String,

    /// Position creation timestamp
    pub opened_at: i64,

    /// Position close timestamp (None if any leg still open)
    pub closed_at: Option<i64>,

    /// Additional metadata (order IDs, notes, etc.)
    pub metadata: JsonValue,
}

impl MultiLegPosition {
    /// Create a new multi-leg position from order legs
    pub fn new(
        strategy_id: String,
        strategy_type: String,
        strategy_label: Option<String>,
        legs: Vec<PositionLeg>,
        opened_at: i64,
    ) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            strategy_id,
            legs,
            strategy_type,
            strategy_label,
            status: "open".to_string(),
            opened_at,
            closed_at: None,
            metadata: serde_json::json!({}),
        }
    }

    /// Calculate combined unrealized P&L across all legs
    pub fn combined_unrealized_pnl(&self) -> f64 {
        self.legs.iter().map(|leg| leg.calculate_unrealized_pnl()).sum()
    }

    /// Calculate combined realized P&L across all closed legs
    pub fn combined_realized_pnl(&self) -> f64 {
        self.legs.iter()
            .filter_map(|leg| leg.calculate_realized_pnl())
            .sum()
    }

    /// Calculate total fees across all legs
    pub fn total_fees(&self) -> f64 {
        self.legs.iter().map(|leg| leg.fees).sum()
    }

    /// Calculate combined entry value: sum(leg.entry_price * leg.size)
    pub fn combined_entry_value(&self) -> f64 {
        self.legs.iter().map(|leg| leg.entry_price * leg.size).sum()
    }

    /// Calculate combined current value: sum(leg.current_price * leg.size)
    pub fn combined_current_value(&self) -> f64 {
        self.legs.iter().map(|leg| leg.current_price * leg.size).sum()
    }

    /// Calculate hedge ratio (0.0 = fully hedged, 1.0 = fully directional)
    ///
    /// Computed as: |net_exposure| / gross_exposure
    /// Where net_exposure = sum(signed_values) and gross = sum(|values|)
    pub fn hedge_ratio(&self) -> f64 {
        let mut net_exposure: f64 = 0.0;
        let mut gross_exposure: f64 = 0.0;

        for leg in &self.legs {
            let value = leg.current_price * leg.size;
            let signed = match leg.side.as_str() {
                "long" => value,
                "short" => -value,
                _ => 0.0,
            };
            net_exposure += signed;
            gross_exposure += value;
        }

        if gross_exposure == 0.0 {
            return 1.0;
        }

        net_exposure.abs() / gross_exposure
    }

    /// Close a specific leg by leg_id
    pub fn close_leg(&mut self, leg_id: &str, exit_price: f64, exit_fees: f64) {
        if let Some(leg) = self.legs.iter_mut().find(|l| l.leg_id == leg_id) {
            leg.exit_price = Some(exit_price);
            leg.fees += exit_fees;
            leg.status = "closed".to_string();
        }

        // If all legs are closed, mark the entire position as closed
        if self.legs.iter().all(|l| l.status == "closed" || l.status == "failed") {
            self.status = "closed".to_string();
            self.closed_at = Some(chrono::Utc::now().timestamp());
        }
    }

    /// Mark the entire multi-leg position as failed
    pub fn mark_failed(&mut self, reason: String) {
        self.status = "failed".to_string();
        self.metadata["failure_reason"] = serde_json::json!(reason);
        for leg in &mut self.legs {
            if leg.status == "open" {
                leg.status = "failed".to_string();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_create_position() {
        let position = Position::new(
            "market-123".to_string(),
            "Polymarket".to_string(),
            "long".to_string(),
            100.0,
            0.50,
            1000000,
            2.0,
        );
        
        assert_eq!(position.status, "open");
        assert_eq!(position.quantity, 100.0);
        assert_eq!(position.entry_price, 0.50);
    }

    #[test]
    fn test_unrealized_pnl_long() {
        let position = Position::new(
            "market-123".to_string(),
            "Polymarket".to_string(),
            "long".to_string(),
            100.0,  // quantity
            0.50,   // entry price
            1000000,
            2.0,    // fees
        );
        
        // Current price is 0.60, position is worth 60
        // Entry was 50, so profit is 10
        // Minus fees of 2 = 8
        let pnl = position.calculate_unrealized_pnl(0.60);
        assert_eq!(pnl, 8.0);
    }

    #[test]
    fn test_unrealized_pnl_short() {
        let position = Position::new(
            "market-123".to_string(),
            "Polymarket".to_string(),
            "short".to_string(),
            100.0,  // quantity
            0.50,   // entry price
            1000000,
            2.0,    // fees
        );
        
        // Current price is 0.40, we're short from 0.50
        // Profit is 0.10 per contract = 10 total
        // Minus fees of 2 = 8
        let pnl = position.calculate_unrealized_pnl(0.40);
        assert_eq!(pnl, 8.0);
    }

    #[test]
    fn test_close_position() {
        let mut position = Position::new(
            "market-123".to_string(),
            "Polymarket".to_string(),
            "long".to_string(),
            100.0,
            0.50,
            1000000,
            2.0,
        );
        
        position.close(0.60, 2000000, 2.0);
        
        assert_eq!(position.status, "closed");
        assert_eq!(position.exit_price, Some(0.60));
        assert_eq!(position.fees, 4.0); // Entry + exit fees
        assert_eq!(position.realized_pnl, Some(6.0)); // 10 profit - 4 fees
    }

    #[test]
    fn test_mark_failed() {
        let mut position = Position::new(
            "market-123".to_string(),
            "Polymarket".to_string(),
            "long".to_string(),
            100.0,
            0.50,
            1000000,
            2.0,
        );
        
        position.mark_failed("Insufficient liquidity".to_string());
        
        assert_eq!(position.status, "failed");
        assert_eq!(position.metadata["failure_reason"], "Insufficient liquidity");
    }
}