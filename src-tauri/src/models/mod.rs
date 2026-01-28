// ============================================================================
// MODELS MODULE
// ============================================================================
//
// Module: models/mod.rs
// Purpose: Central export module for all data structures used across the application
//
// OVERVIEW:
// This module serves as the single source of truth for data models shared between
// the Rust backend and TypeScript frontend. All structs and enums defined here
// implement Serde serialization for seamless JSON transfer via Tauri's IPC system.
//
// ARCHITECTURE PATTERN:
// Models are organized by domain:
// - node.rs: Graph nodes (info sources and markets)
// - market.rs: Market data structures (orderbooks, trades)
// - position.rs: Trading positions and P&L
//
// Cross-Cutting Concerns:
// - All types derive Serialize/Deserialize for Tauri compatibility
// - Enums use #[serde(rename_all = "camelCase")] or explicit naming to maintain
//   TypeScript conventions in the frontend
// - Database-facing types include conversion methods to/from SQLite rows
// - Graph coordinates use (f64, f64) tuples for Canvas rendering
//
// SERDE CONFIGURATION:
// - Enums are serialized as externally tagged variants by default
//   Example: NodeType::InfoSource(CryptoPrices) → {"InfoSource": "CryptoPrices"}
// - This matches TypeScript discriminated unions in the frontend
// - Unit variants become strings: InfoSourceType::CryptoPrices → "CryptoPrices"
//
// TYPE SAFETY GUARANTEES:
// - NodeType ensures you cannot connect two incompatible node types at compile time
// - MarketType restricts trading commands to valid market platforms
// - InfoSourceType validates scraper configurations (weather API vs crypto API)
//
// FRONTEND SYNCHRONIZATION:
// These types must remain compatible with:
// - src/types/nodes.ts (Node, NodeType, InfoSourceType, MarketType)
// - src/types/markets.ts (Orderbook, TradeResult)
// - src/types/sources.ts (Source configurations)
//
// When modifying enums, update both Rust and TypeScript definitions simultaneously.
//
// TESTING:
// All model modules contain #[cfg(test)] unit tests verifying:
// - Serialization round-trips (Rust → JSON → Rust)
// - Enum variant coverage
// - Database row conversions
// - Business logic invariants (e.g., orderbook price sorting)
//
// MODULE EXPORTS:
// - Node: Core graph vertex with position, connections, and metadata
// - NodeType: Discriminated union of InfoSource vs Market
// - InfoSourceType: Specific data source categories (Crypto, News, Weather, etc.)
// - MarketType: Supported prediction markets (Polymarket, Kalshi)
// - Orderbook: Real-time market depth (bids/asks)
// - TradeSide/OrderType: Trading command enumerations
// - TradeResult: Execution confirmation with fill details
// - TimeseriesPoint: Single data point for storage module
// - Position: Trading position (defined in position.rs)
//
// DEPENDENCIES:
// - serde: serialization frameworks
// - serde_json: JSON value type for metadata fields
// - chrono: timestamps (via feature flags)
//
// USAGE EXAMPLES:
//
// Creating a node:
// ```rust
// use crate::models::{Node, NodeType, InfoSourceType};
//
// let node = Node {
//     id: "node-123".to_string(),
//     node_type: NodeType::InfoSource(InfoSourceType::CryptoPrices),
//     position: (100.0, 200.0),
//     connections: vec!["market-456".to_string()],
//     metadata: serde_json::json!({"symbols": ["BTC", "ETH"]}),
// };
// ```
//
// Deserializing from frontend:
// ```rust
// #[tauri::command]
// fn process_node(node: Node) {  // Automatically deserialized from JSON
//     match node.node_type {
//         NodeType::Market(MarketType::Polymarket) => handle_polymarket(node),
//         _ => println!("Other node type"),
//     }
// }
// ```
//
// FUTURE EXTENSIONS:
// - Add validation traits (Validate) for input sanitization
// - Implement Default constructors for UI initial state
// - Add GraphQL types feature flag for API flexibility
// ============================================================================

pub mod node;
pub mod market;
pub mod position;

pub use node::{Node, NodeType, InfoSourceType, MarketType};
pub use market::{Orderbook, TradeSide, OrderType, TradeResult, TimeseriesPoint, DataPoint};
pub use position::Position;