// ============================================================================
// NODE MODEL
// ============================================================================
//
// Module: models/node.rs
// Purpose: Core graph data structures for the visual node-based interface
//
// OVERVIEW:
// This module defines the fundamental building blocks of the trading terminal's
// node graph. Each Node represents either an information source (data input) or
// a prediction market (trading venue). Nodes are visualized on the Canvas as
// draggable vertices with connections representing data flow or trading relationships.
//
// GRAPH ARCHITECTURE:
// The terminal uses a directed graph (digraph) structure where:
// - Nodes are vertices with spatial positions (x, y coordinates)
// - Connections are edges linking data sources to markets
// - NodeType discriminates between data producers and trading venues
// - Metadata stores configuration specific to each node type
//
// NODE TYPES:
//
// 1. InfoSource (Data Input Nodes):
//    - CryptoPrices: Cryptocurrency price feeds (Bitcoin, Ethereum, etc.)
//    - FinancialPrices: Stock and forex data (S&P 500, EUR/USD)
//    - CommodityPrices: Physical commodity prices (Gold, Oil, Wheat)
//    - NewsSource: Textual news feeds (Reuters, AP, Bloomberg)
//    - SocialMedia: Sentiment analysis sources (Twitter/X, Reddit)
//    - Weather: Meteorological data (temperature, storms, rainfall)
//    - Livestream: Real-time video stream monitoring (debates, speeches)
//
// 2. Market (Trading Venue Nodes):
//    - Polymarket: Polygon-based prediction market
//    - Kalshi: Regulated US prediction market exchange
//
// VISUAL REPRESENTATION:
// - InfoSource nodes: Rendered as blue circles on the Canvas
// - Market nodes: Rendered as green squares on the Canvas
// - Selected nodes: Show detail panel in right sidebar
// - Connected nodes: Linked by lines with thickness indicating correlation strength
//
// CONNECTION SEMANTICS:
// - InfoSource → Market: Data flow (scraped data informs trading decisions)
// - Market → Market: Arbitrage relationships (price comparison)
// - InfoSource → InfoSource: Data correlation (e.g., BTC price vs sentiment)
//
// DATA STRUCTURES:
//
// Node (Struct):
// - id: String                     // UUID v4, unique graph identifier
// - node_type: NodeType            // Discriminated union (InfoSource vs Market)
// - position: (f64, f64)           // Canvas coordinates (x,y in pixels)
// - connections: Vec<String>       // IDs of connected nodes (adjacency list)
// - metadata: serde_json::Value    // Flexible configuration object
//
// NodeType (Enum):
// - InfoSource(InfoSourceType)     // Wrapper for source subtypes
// - Market(MarketType)             // Wrapper for market subtypes
//
// InfoSourceType (Enum):
// - CryptoPrices                   // CoinGecko, Binance API
// - FinancialPrices                // Yahoo Finance, Alpha Vantage
// - CommodityPrices                // Commodity APIs
// - NewsSource                     // RSS feeds, news APIs
// - SocialMedia                    // Twitter API, Reddit API
// - Weather                        // OpenWeatherMap, etc.
// - Livestream                     // YouTube Live, Twitch monitoring
//
// MarketType (Enum):
// - Polymarket                     // Web3/EVM based
// - Kalshi                         // Traditional REST/WebSocket
//
// METADATA SCHEMAS BY TYPE:
//
// CryptoPrices metadata:
// {
//   "symbols": ["BTC", "ETH", "SOL"],
//   "update_interval_seconds": 5,
//   "exchange": "binance",
//   "currency": "USD"
// }
//
// NewsSource metadata:
// {
//   "feeds": ["reuters", "ap"],
//   "keywords": ["election", "president"],
//   "language": "en",
//   "update_interval_minutes": 1
// }
//
// Polymarket metadata:
// {
//   "market_slug": "will-btc-hit-100k-in-2024",
//   "condition_id": "0x123...",
//   "api_key_reference": "secure://polymarket_api_key",
//   "websocket_url": "wss://..."
// }
//
// SERIALIZATION NOTES:
//
// JSON Representation:
// {
//   "id": "550e8400-e29b-41d4-a716-446655440000",
//   "nodeType": {
//     "InfoSource": "CryptoPrices"
//   },
//   "position": [100.0, 200.0],
//   "connections": ["node-456", "node-789"],
//   "metadata": {
//     "symbols": ["BTC"]
//   }
// }
//
// TypeScript Mapping:
// - Rust enum variants become discriminated unions in TypeScript
// - Tuple (f64, f64) becomes [number, number]
// - serde_json::Value becomes Record<string, any> or unknown
//
// DATABASE MAPPING:
//
// SQLite storage uses string representations:
// - NodeType::InfoSource(CryptoPrices) → ("InfoSource", "CryptoPrices")
// - NodeType::Market(Polymarket) → ("Market", "Polymarket")
//
// Conversion functions in db/sqlite.rs:
// - serialize_node_type() → (String, String)
// - deserialize_node() ← Row
//
// VALIDATION RULES:
// - ID must be valid UUID format (enforced by generator, not struct)
// - Position coordinates can be negative (Canvas allows panning)
// - Connections must reference existing node IDs (enforced by commands layer)
// - Metadata must be valid JSON (enforced by serde)
//
// DEFAULT VALUES:
// - position: (0.0, 0.0) - Appears at Canvas origin if not specified
// - connections: empty Vec - No edges on creation
// - metadata: empty object {} - No configuration yet
//
// CLONE BEHAVIOR:
// All types derive Clone for:
// - Passing copies to async tasks (scrapers, WebSocket handlers)
// - Storing in multiple states (active_scrapers cache + database)
// - Frontend state synchronization
//
// THREAD SAFETY:
// Node is Send + Sync (all fields are thread-safe):
// - String: Sync
// - Enums: Sync
// - (f64, f64): Sync
// - Vec<String>: Sync
// - serde_json::Value: Sync
//
// Can be safely shared across Tokio tasks and stored in Arc<Mutex<...>>.
//
// UI INTEGRATION:
//
// Drag and Drop:
// - position updates trigger UPDATE nodes SET position_x, position_y
// - Real-time sync to other users (if networked) via WebSocket
//
// Connection Drawing:
// - connections Vec<String> used to lookup target Node positions
// - Line rendered from self.position to target.position
// - Line thickness = connection strength (stored in connections table, not Node struct)
//
// Context Menus:
// - NodeType determines available right-click options
//   - InfoSource: "Configure Scraper", "Pause", "View Data"
//   - Market: "View Orderbook", "Place Trade", "Close Connection"
//
// USAGE PATTERNS:
//
// Creating a crypto price node:
// ```rust
// let node = Node {
//     id: uuid::Uuid::new_v4().to_string(),
//     node_type: NodeType::InfoSource(InfoSourceType::CryptoPrices),
//     position: (100.0, 100.0),
//     connections: vec![],
//     metadata: serde_json::json!({
//         "symbols": ["BTC", "ETH"],
//         "update_interval_seconds": 5
//     }),
// };
// ```
//
// Pattern matching on type:
// ```rust
// match &node.node_type {
//     NodeType::InfoSource(InfoSourceType::CryptoPrices) => {
//         start_crypto_scraper(&node.id, &node.metadata).await?;
//     },
//     NodeType::Market(MarketType::Polymarket) => {
//         connect_polymarket_ws(&node.id, &node.metadata).await?;
//     },
//     _ => println!("Unsupported node type"),
// }
// ```
//
// Updating position (Canvas drag):
// ```rust
// node.position = (new_x, new_y);
// db::update_node(&conn, &node)?;  // Persist new coordinates
// ```
//
// EXTENSIBILITY:
//
// Adding new InfoSourceType variants:
// 1. Add variant to enum (e.g., BlockchainData)
// 2. Update serialize_node_type() in db/sqlite.rs
// 3. Add scraper implementation in services/scraper.rs
// 4. Update TypeScript InfoSourceType enum in frontend
// 5. Add UI icon/component for new type
//
// Adding new MarketType variants:
// 1. Add variant to enum (e.g., Betfair)
// 2. Implement market API client in services/market_api/
// 3. Update fee calculation logic in trading.rs commands
//
// TESTING:
//
// Unit tests verify:
// - Serialization round-trips (no data loss)
// - Enum variant coverage (all types handled)
// - Position coordinate precision (f64 accuracy)
// - Metadata JSON flexibility (arbitrary keys)
//
// Integration tests verify:
// - Database serialization (Row <-> Node conversions)
// - Frontend TypeScript compatibility (JSON structure)
//
// FUTURE ENHANCEMENTS:
// - Add NodeLabel struct for display names (vs relying on ID)
// - Support node groups/clusters (nested graphs)
// - Add z-index for Canvas layering
// - Implement node colors/tags (visual categorization)
// - Add size field for importance weighting (visual scaling)
// ============================================================================

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// The core graph vertex representing either a data source or trading market
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    /// Unique identifier (UUID v4)
    pub id: String,
    
    /// Discriminated union of node categories
    pub node_type: NodeType,
    
    /// Visual position on Canvas (x, y coordinates in pixels)
    pub position: (f64, f64),
    
    /// Node size for resizable nodes (width, optional height)
    pub size: Option<(f64, Option<f64>)>,
    
    /// Graph edges: IDs of connected nodes
    pub connections: Vec<String>,
    
    /// Flexible configuration (scraper settings, API keys, etc.)
    pub metadata: JsonValue,
}

/// Top-level node category discriminator
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "subtype")]
pub enum NodeType {
    /// Data input source (price feeds, news, etc.)
    #[serde(rename = "InfoSource")]
    InfoSource(InfoSourceType),
    
    /// Prediction market trading venue
    #[serde(rename = "Market")]
    Market(MarketType),
}

/// Specific types of information sources
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum InfoSourceType {
    /// Cryptocurrency price data (Bitcoin, Ethereum, etc.)
    CryptoPrices,
    
    /// Traditional financial markets (stocks, forex)
    FinancialPrices,
    
    /// Physical commodity prices (gold, oil, agriculture)
    CommodityPrices,
    
    /// News articles and headlines (Reuters, AP, etc.)
    NewsSource,
    
    /// Social media sentiment (Twitter/X, Reddit)
    SocialMedia,
    
    /// Weather data (temperature, storms, natural disasters)
    Weather,
    
    /// Live video stream monitoring (debates, press conferences)
    Livestream,
    
    /// Economic indicators (CPI, unemployment, GDP)
    EconomicIndicators,
    
    /// On-chain metrics (transaction volume, gas fees)
    OnChainData,
}

/// Supported prediction market platforms
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MarketType {
    /// Polymarket (Polygon blockchain-based)
    Polymarket,
    
    /// Kalshi (regulated US exchange)
    Kalshi,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_node_serialization() {
        let node = Node {
            id: "test-123".to_string(),
            node_type: NodeType::InfoSource(InfoSourceType::CryptoPrices),
            position: (100.0, 200.0),
            size: None,
            connections: vec!["market-456".to_string()],
            metadata: serde_json::json!({"test": "value"}),
        };
        
        let json = serde_json::to_string(&node).unwrap();
        assert!(json.contains("\"test-123\""));
        assert!(json.contains("CryptoPrices"));
        
        let deserialized: Node = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.id, node.id);
        assert_eq!(deserialized.position, (100.0, 200.0));
    }

    #[test]
    fn test_node_type_variants() {
        let types = vec![
            NodeType::InfoSource(InfoSourceType::CryptoPrices),
            NodeType::InfoSource(InfoSourceType::NewsSource),
            NodeType::Market(MarketType::Polymarket),
        ];
        
        for node_type in types {
            let json = serde_json::to_string(&node_type).unwrap();
            let _: NodeType = serde_json::from_str(&json).unwrap();
        }
    }
}