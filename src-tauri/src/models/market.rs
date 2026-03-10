// ============================================================================
// MARKET DATA MODELS
// ============================================================================
//
// Purpose: Data structures for prediction market orderbooks, trades, and
// time-series data. Abstracts platform-specific formats (Polymarket, Kalshi)
// into unified internal representations.
//
// CORE TYPES:
//   Orderbook      - Bid/ask price levels with liquidity metrics and sequence
//                    numbers. Bids sorted descending, asks ascending.
//   OrderSide      - Buy (YES) or Sell (NO) direction
//   OrderType      - Limit(price) or Market execution
//   TimeInForce    - GTC, GTT, IOC, FOK order duration policies
//   TradeResult    - Execution confirmation with fill details, fees, and status
//   TimeseriesPoint - Single time-series observation (timestamp, source, metric, value)
//   DataPoint      - Alias for TimeseriesPoint used in batch operations
//
// PREDICTION MARKET PRICING:
//   Binary outcomes priced as probabilities 0.0-1.0. YES + NO ~ 1.0.
//   Payout is $1.00 if correct, $0.00 if incorrect.
//
// PLATFORM NORMALIZATION:
//   Polymarket CLOB orders are aggregated by price level.
//   Kalshi NO prices are converted to YES equivalents (1 - price).
// ============================================================================

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// Real-time orderbook snapshot for a prediction market
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Orderbook {
    /// Associated market node ID
    pub market_id: String,
    
    /// Buy orders: [[price, size], ...] sorted descending by price
    pub bids: Vec<[f64; 2]>,
    
    /// Sell orders: [[price, size], ...] sorted ascending by price  
    pub asks: Vec<[f64; 2]>,
    
    /// Unix timestamp when snapshot was taken
    pub timestamp: i64,
    
    /// Total liquidity in market (sum of bid/ask value)
    pub liquidity: f64,
    
    /// Bid-ask spread (best_ask - best_bid)
    pub spread: f64,
    
    /// Last trade price (if available)
    pub last_price: Option<f64>,
    
    /// Last trade size
    pub last_size: Option<f64>,
    
    /// Last trade timestamp
    pub last_trade_at: Option<i64>,
    
    /// Sequence number for ordering updates
    pub sequence: i64,
}

/// Order direction (betting FOR or AGAINST outcome)
/// Renamed from TradeSide to match TypeScript OrderSide naming
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum OrderSide {
    /// Buying YES contracts (betting event WILL happen)
    #[serde(rename = "buy")]
    Buy,
    
    /// Buying NO contracts OR selling YES (betting/event WON'T happen)
    #[serde(rename = "sell")]
    Sell,
}

/// Alias for backward compatibility
pub type TradeSide = OrderSide;

/// Time in force - how long order remains active
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum TimeInForce {
    /// Good till cancelled (default)
    #[serde(rename = "GTC")]
    GTC,
    
    /// Good till time (specify expiration)
    #[serde(rename = "GTT")]
    GTT,
    
    /// Immediate or cancel
    #[serde(rename = "IOC")]
    IOC,
    
    /// Fill or kill
    #[serde(rename = "FOK")]
    FOK,
}

/// Order execution type
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OrderType {
    /// Execute at specified price or better
    #[serde(rename = "limit")]
    Limit(f64),
    
    /// Execute immediately at market price
    #[serde(rename = "market")]
    Market,
}

/// Result of trade execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeResult {
    /// Exchange-assigned trade identifier
    pub trade_id: String,
    
    /// Market where trade occurred
    pub market_id: String,
    
    /// Direction of trade
    pub side: OrderSide,
    
    /// Limit or Market order
    pub order_type: OrderType,
    
    /// Contracts requested
    pub requested_size: f64,
    
    /// Contracts actually filled (may be partial)
    pub filled_size: f64,
    
    /// Average execution price
    pub avg_price: f64,
    
    /// Total fees paid
    pub fees_paid: f64,
    
    /// "filled", "partial", "failed", "pending"
    pub status: String,
    
    /// Execution timestamp
    pub timestamp: i64,
    
    /// Platform-specific details (tx hashes, order IDs)
    pub metadata: JsonValue,
}

/// Single time-series observation for storage
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeseriesPoint {
    /// Unix epoch seconds
    pub timestamp: i64,
    
    /// Node ID or market ID
    pub source_id: String,
    
    /// "price", "volume", "spread", "sentiment"
    pub metric_type: String,
    
    /// Numeric value
    pub value: f64,
    
    /// Additional context (exchange, confidence)
    pub metadata: Option<JsonValue>,
}

/// Convenience alias for batch operations
pub type DataPoint = TimeseriesPoint;

// ============================================================================
// MULTI-LEG / MULTI-OUTCOME ORDER TYPES
// ============================================================================
//
// These types support multi-outcome (categorical) markets and multi-leg
// order structures. Multi-outcome markets (e.g., "Who will be the Republican
// nominee?") require selecting from multiple outcomes, not just YES/NO.
//
// Multi-leg orders coordinate execution across multiple markets or outcomes:
//   - Single: backwards-compatible single-market order
//   - OCO: One-Cancels-Other (first fill cancels remaining legs)
//   - Bracket: entry + stop-loss + take-profit as atomic unit
//   - Spread: simultaneous buy/sell across related outcomes
//
// ============================================================================

/// Multi-leg order execution strategy
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum MultiLegOrderType {
    /// Standard single-market order (backwards compatible)
    #[serde(rename = "single")]
    Single,

    /// One-Cancels-Other: first leg fill cancels remaining legs
    #[serde(rename = "oco")]
    OCO,

    /// Bracket: entry + stop-loss + take-profit as atomic unit
    #[serde(rename = "bracket")]
    Bracket,

    /// Spread: simultaneous buy/sell across related outcomes
    #[serde(rename = "spread")]
    Spread,
}

/// Single leg within a multi-leg order
///
/// Each leg targets a specific market and outcome with its own
/// side, size, and optional price. The ratio field supports
/// proportional sizing (e.g., 2:1 leg ratios for hedged positions).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderLeg {
    /// Target market ID for this leg
    pub market_id: String,

    /// Outcome ID for categorical markets (None for binary)
    pub outcome_id: Option<String>,

    /// Buy or sell direction for this leg
    pub side: OrderSide,

    /// Relative sizing ratio (e.g., 2 in a 2:1 spread)
    pub ratio: f64,

    /// Absolute contract size for this leg
    pub size: f64,

    /// Limit price for this leg (None for market orders)
    pub price: Option<f64>,

    /// Reference to node graph node for this leg's market
    pub market_node_id: Option<String>,
}

/// Multi-leg order for coordinated execution across markets/outcomes
///
/// Wraps multiple OrderLeg entries with shared execution parameters.
/// The executor processes legs according to the order_type strategy
/// (parallel for spreads, sequential with cancellation for OCO).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiLegOrder {
    /// Unique order ID
    pub id: String,

    /// Array of order legs to execute
    pub legs: Vec<OrderLeg>,

    /// Execution strategy for the legs
    pub order_type: MultiLegOrderType,

    /// Time in force applies to all legs
    pub time_in_force: TimeInForce,

    /// Current status: "pending", "partial", "filled", "cancelled", "failed"
    pub status: String,

    /// Creation timestamp
    pub created_at: i64,

    /// Last update timestamp
    pub updated_at: i64,

    /// User-defined strategy label
    pub strategy_label: Option<String>,

    /// Total fees paid across all legs
    pub total_fees: f64,

    /// Associated strategy/position group ID
    pub strategy_id: Option<String>,
}

/// Result of a multi-leg trade execution
///
/// Contains per-leg fill results and aggregate status. Partial fills
/// are tracked per-leg so risk management can handle incomplete
/// multi-leg positions appropriately.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiLegTradeResult {
    /// Overall multi-leg order ID
    pub order_id: String,

    /// Per-leg execution results
    pub leg_results: Vec<LegTradeResult>,

    /// Aggregate status: "filled", "partial", "failed"
    pub status: String,

    /// Total fees across all legs
    pub total_fees: f64,

    /// Total execution time in milliseconds
    pub execution_time_ms: u64,

    /// Strategy ID for position grouping
    pub strategy_id: String,
}

/// Execution result for a single leg within a multi-leg order
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegTradeResult {
    /// Market ID for this leg
    pub market_id: String,

    /// Outcome ID (for categorical markets)
    pub outcome_id: Option<String>,

    /// Trade direction
    pub side: OrderSide,

    /// Contracts requested
    pub requested_size: f64,

    /// Contracts actually filled
    pub filled_size: f64,

    /// Average execution price
    pub avg_price: f64,

    /// Fees paid for this leg
    pub fees_paid: f64,

    /// Leg status: "filled", "partial", "failed", "cancelled"
    pub status: String,
}

impl Orderbook {
    /// Calculate best bid price
    pub fn best_bid(&self) -> Option<f64> {
        self.bids.first().map(|b| b[0])
    }
    
    /// Calculate best ask price  
    pub fn best_ask(&self) -> Option<f64> {
        self.asks.first().map(|a| a[0])
    }
    
    /// Calculate midpoint price (fair value estimate)
    pub fn midpoint(&self) -> Option<f64> {
        match (self.best_bid(), self.best_ask()) {
            (Some(bid), Some(ask)) => Some((bid + ask) / 2.0),
            _ => self.best_bid().or_else(|| self.best_ask()),
        }
    }
    
    /// Validate orderbook consistency
    pub fn is_valid(&self) -> bool {
        // Check price bounds
        let valid_prices = self.bids.iter().all(|b| b[0] > 0.0 && b[0] <= 1.0) &&
                          self.asks.iter().all(|a| a[0] > 0.0 && a[0] <= 1.0);
        
        // Check spread is positive (if both sides present)
        let valid_spread = match (self.best_bid(), self.best_ask()) {
            (Some(bid), Some(ask)) => ask > bid,
            _ => true,
        };
        
        valid_prices && valid_spread
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_orderbook_midpoint() {
        let book = Orderbook {
            market_id: "test".to_string(),
            bids: vec![[0.50, 100.0], [0.49, 200.0]],
            asks: vec![[0.52, 100.0], [0.53, 200.0]],
            timestamp: 1000,
            liquidity: 1000.0,
            spread: 0.02,
            last_price: Some(0.51),
            last_size: Some(50.0),
            last_trade_at: Some(900),
            sequence: 1,
        };
        
        assert_eq!(book.best_bid(), Some(0.50));
        assert_eq!(book.best_ask(), Some(0.52));
        assert_eq!(book.midpoint(), Some(0.51));
        assert!(book.is_valid());
    }

    #[test]
    fn test_trade_result_serialization() {
        let result = TradeResult {
            trade_id: "trade-123".to_string(),
            market_id: "market-456".to_string(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit(0.52),
            requested_size: 100.0,
            filled_size: 100.0,
            avg_price: 0.52,
            fees_paid: 2.04,
            status: "filled".to_string(),
            timestamp: 1000000,
            metadata: serde_json::json!({"tx_hash": "0xabc"}),
        };
        
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"buy\""));
        assert!(json.contains("\"limit\""));
        
        let deserialized: TradeResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.trade_id, result.trade_id);
    }

    #[test]
    fn test_invalid_orderbook() {
        // Ask below bid (invalid)
        let invalid = Orderbook {
            market_id: "bad".to_string(),
            bids: vec![[0.60, 100.0]],
            asks: vec![[0.50, 100.0]], // Lower than bid!
            timestamp: 1000,
            liquidity: 0.0,
            spread: -0.10,
            last_price: None,
            last_size: None,
            last_trade_at: None,
            sequence: 0,
        };
        
        assert!(!invalid.is_valid());
    }
}