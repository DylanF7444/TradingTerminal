// ============================================================================
// POSITION MODEL
// ============================================================================
//
// Purpose: Data model and business logic for trading positions in prediction markets.
//
// POSITION LIFECYCLE:
//   1. Created via new() -> status "open", entry price/time recorded
//   2. Monitored via calculate_unrealized_pnl(current_price)
//   3. Closed via close(exit_price, time, fees) -> status "closed", realized P&L computed
//   4. Or failed via mark_failed(reason) -> status "failed"
//
// POSITION TYPES:
//   Long  - Buying YES contracts, profit when price increases
//   Short - Buying NO contracts, profit when price decreases
//
// P&L CALCULATION:
//   Unrealized: (current_price - entry_price) * quantity - fees (long)
//   Short positions invert the price direction.
//   Realized P&L includes both entry and exit fees.
//
// FEE STRUCTURES:
//   Polymarket ~2% per side, Kalshi ~1% per side.
//   Fees are accumulated on the Position struct across entry and exit.
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