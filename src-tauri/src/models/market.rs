// ============================================================================
// MARKET DATA MODELS
// ============================================================================
//
// Module: models/market.rs
// Purpose: Data structures for prediction market orderbooks, trades, and market data
//
// OVERVIEW:
// This module defines the structures necessary for interacting with prediction
// markets, including orderbook representations, trade execution results, and
// time-series data points. It abstracts platform-specific formats (Polymarket vs
// Kalshi) into unified internal representations.
//
// PREDICTION MARKET MECHANICS:
// Unlike traditional exchanges with continuous prices, prediction markets trade
// binary outcomes (YES/NO) priced as probabilities between $0.00 and $1.00.
//
// Key Concepts:
// - Contract: A share representing a bet on an outcome
// - Price: Probability of occurrence (0.0 to 1.0)
// - Payout: $1.00 if correct, $0.00 if incorrect
// - Implied Probability: Market consensus on likelihood
// - Binary Outcome: Event either happens (YES pays) or doesn't (NO pays)
//
// Example Market: "Will it rain tomorrow?"
// - YES price: 0.30 (30% chance)
// - NO price: 0.72 (72% chance, includes spread)
// - Buying 100 YES shares at $0.30 costs $30
// - If it rains: receive $100 (profit $70)
// - If no rain: receive $0 (loss $30)
//
// DATA STRUCTURES:
//
// Orderbook (Struct):
// Represents the current liquidity available for trading. Prediction markets
// typically use limit order books similar to stock exchanges, but with binary
// constraints (prices must be 0.0-1.0).
//
// Fields:
// - market_id: String          // Associated market node ID
// - bids: Vec<[f64; 2]>        // Buy orders [price, size]
// - asks: Vec<[f64; 2]>        // Sell orders [price, size]
// - timestamp: i64             // Unix timestamp of snapshot
// - liquidity: f64             // Total value available (sum of bids + asks)
// - spread: f64                // Difference between best ask and best bid
// - last_price: Option<f64>    // Last trade price
// - last_size: Option<f64>     // Last trade size
// - last_trade_at: Option<i64>  // Last trade timestamp
// - sequence: i64              // Sequence number for ordering updates
//
// Bids are sorted descending (highest price first - best bid)
// Asks are sorted ascending (lowest price first - best ask)
// Example:
//   bids: [[0.52, 1000], [0.51, 500], [0.50, 200]]
//   asks: [[0.53, 800], [0.54, 1200]]
//   spread: 0.53 - 0.52 = 0.01 (1 cent)
//
// OrderSide (Enum - renamed from TradeSide to match TypeScript):
// Direction of trade relative to the outcome:
// - Buy: Purchasing YES contracts (betting event WILL happen)
// - Sell: Purchasing NO contracts (betting event WON'T happen)
//   OR selling previously bought YES contracts (closing long)
//
// Note: In prediction markets, "Buy NO" is equivalent to "Sell YES" in terms
// of directional exposure, but has different margin requirements.
//
// OrderType (Enum):
// Execution strategy for the trade:
// - Limit(price): Execute only at specified price or better
//   - Buy limit: Fill at price or lower (cheaper)
//   - Sell limit: Fill at price or higher (more expensive)
// - Market: Execute immediately at best available price
//   - Accepts current spread (slippage)
//   - Guaranteed fill, uncertain price
//
// TimeInForce (Enum - added to match TypeScript):
// How long order remains active:
// - GTC: Good till cancelled
// - GTT: Good till time
// - IOC: Immediate or cancel
// - FOK: Fill or kill
//
// TradeResult (Struct):
// Confirmation of executed trade with actual fill details.
// Fields:
// - trade_id: String           // Exchange-assigned trade identifier
// - market_id: String          // Market where trade occurred  
// - side: OrderSide            // Direction (Buy/Sell)
// - order_type: OrderType      // Limit or Market
// - requested_size: f64        // Contracts requested
// - filled_size: f64           // Contracts actually filled (partial fills)
// - avg_price: f64             // Volume-weighted average fill price
// - fees_paid: f64             // Total fees (entry + platform fees)
// - status: String             // "filled", "partial", "failed", "pending"
// - timestamp: i64             // Execution time
// - metadata: JsonValue        // Platform-specific details (tx hashes, etc.)
//
// TimeseriesPoint (Struct):
// Single observation for storage in time-series database.
// Fields:
// - timestamp: i64             // Unix epoch seconds
// - source_id: String          // Node ID or market ID
// - metric_type: String        // "price", "volume", "spread", "liquidity"
// - value: f64                 // Numeric value
// - metadata: Option<JsonValue>// Additional context
//
// Used by storage.rs for historical data persistence.
//
// DataPoint (Type Alias):
// Convenience alias for TimeseriesPoint used in batch operations.
//
// PLATFORM ADAPTERS:
//
// The trading terminal normalizes different market APIs into these structures:
//
// Polymarket → Orderbook conversion:
// - Polymarket uses CLOB (Central Limit Order Book) with order IDs
// - Bids: tokenId + price + size
// - Asks: tokenId + price + size  
// - Normalization aggregates by price level (ignoring order IDs)
//
// Kalshi → Orderbook conversion:
// - Kalshi uses REST snapshot + WebSocket deltas
// - Format: {"yes": [[price, count], ...], "no": [[price, count], ...]}
// - Normalization converts NO prices to YES equivalents (1 - price) for consistency
//
// API RESPONSE HANDLING:
//
// Successful trades:
// - TradeResult.status = "filled"
// - filled_size == requested_size
// - avg_price within slippage tolerance of expected
//
// Partial fills:
// - TradeResult.status = "partial"
// - filled_size < requested_size
// - Remaining size stays as open order (until cancelled or filled)
// - Common in low-liquidity markets
//
// Failed trades:
// - TradeResult.status = "failed"
// - reasons: insufficient_funds, market_closed, price_out_of_bounds, rate_limited
// - fees_paid = 0.0
// - metadata contains error details from exchange
//
// MATH UTILITIES:
//
// Bid-Ask Spread calculation:
// if !bids.is_empty() && !asks.is_empty() {
//     spread = asks[0][0] - bids[0][0];  // Best ask - Best bid
// }
//
// Midpoint price (fair value estimate):
// midpoint = (best_bid + best_ask) / 2.0;
//
// Liquidity calculation:
// total_liquidity = bids.iter().map(|b| b[0] * b[1]).sum::<f64>() +
//                   asks.iter().map(|a| a[0] * a[1]).sum::<f64>();
//
// SERIALIZATION NOTES:
//
// Orderbook JSON format optimized for frontend charting libraries:
// {
//   "marketId": "poly-123",
//   "bids": [[0.52, 1000], [0.51, 500]],
//   "asks": [[0.53, 800], [0.54, 1200]],
//   "timestamp": 1706200000,
//   "spread": 0.01,
//   "liquidity": 25000.00
// }
//
// TradeResult includes platform-specific details in metadata:
// Polymarket: {"transactionHash": "0x...", "orderId": "...", "gasPaid": "0.001"}
// Kalshi: {"orderId": "uuid", "commission": 0.50}
//
// DATABASE MAPPING:
//
// Orderbooks are typically transient (stored in memory cache), but can be
// snapshotted to timeseries table for analysis:
// - metric_type: "bid_ask_spread", "best_bid", "liquidity"
// - source_id: market node ID
//
// TradeResults are stored in positions table (entry/exit details) and
// event_log table (audit trail).
//
// VALIDATION RULES:
//
// Orderbook:
// - All prices must be 0.0 <= price <= 1.0
// - All sizes must be > 0.0
// - Bids must be < Asks (otherwise arbitrage exists)
// - Timestamp must be recent (< 60 seconds for "live" data)
//
// TradeResult:
// - filled_size <= requested_size
// - 0.0 <= avg_price <= 1.0
// - fees_paid >= 0.0
// - timestamp >= entry_time (for closing positions)
//
// USAGE PATTERNS:
//
// Creating an orderbook from WebSocket update:
// ```rust
// let orderbook = Orderbook {
//     market_id: "market-123".to_string(),
//     bids: vec![[0.52, 1000.0], [0.51, 500.0]],
//     asks: vec![[0.53, 800.0], [0.54, 1200.0]],
//     timestamp: Utc::now().timestamp(),
//     liquidity: 25000.0,
//     spread: 0.01,
// };
// ```
//
// Executing a trade:
// ```rust
// let result = TradeResult {
//     trade_id: "trade-789".to_string(),
//     market_id: "market-123".to_string(),
//     side: TradeSide::Buy,
//     order_type: OrderType::Limit(0.52),
//     requested_size: 100.0,
//     filled_size: 100.0,
//     avg_price: 0.52,
//     fees_paid: 2.04,  // 2% of 102
//     status: "filled".to_string(),
//     timestamp: Utc::now().timestamp(),
//     metadata: serde_json::json!({}),
// };
// ```
//
// PRICE NORMALIZATION BETWEEN MARKETS:
//
// When comparing Polymarket and Kalshi for arbitrage:
// - Polymarket YES at 0.52 means 52 cents to bet YES
// - Kalshi NO at 0.48 means 48 cents to bet NO
// - These are equivalent positions (YES 0.52 vs NO 0.48)
// - Arbitrage exists if: YES_price + NO_price != 1.0 (accounting for fees)
//
// TESTING:
//
// Unit tests verify:
// - Orderbook sorting (bids descending, asks ascending)
// - TradeResult validation (filled <= requested)
// - Price bounds checking (0.0-1.0)
// - JSON serialization symmetry
//
// Integration tests:
// - Platform-specific JSON parsing (Polymarket/Kalshi samples)
// - Spread calculations with edge cases (empty books, single-sided)
//
// FUTURE ENHANCEMENTS:
// - Add Candlestick struct for OHLC aggregations
// - Implement Orderbook diff/patch for efficient WebSocket updates
// - Add TradeHistory struct for position reconciliation
// - Support decimal precision (Decimal128) for exact arithmetic
// - Add OrderbookImbalance calculation (bid volume vs ask volume)
// - Implement VWAP (Volume Weighted Average Price) calculations
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