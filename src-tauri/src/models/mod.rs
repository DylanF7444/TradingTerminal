// ============================================================================
// MODELS MODULE
// ============================================================================
//
// Central export module for all data structures shared between the Rust backend
// and TypeScript frontend. All structs and enums implement Serde serialization
// for JSON transfer via Tauri's IPC system.
//
// Models are organized by domain:
// - node.rs: Graph nodes (info sources and markets)
// - market.rs: Market data structures (orderbooks, trades, order types)
// - position.rs: Trading positions, fills, and P&L
// - trading_signal.rs: Trading signal definitions
// - remote.rs: Remote session and device credential types
// - analyzer_node.rs: Analyzer node configurations and results
//
// SERDE CONFIGURATION:
// - Enums are serialized as externally tagged variants by default
//   Example: NodeType::InfoSource(CryptoPrices) -> {"InfoSource": "CryptoPrices"}
// - Unit variants become strings: InfoSourceType::CryptoPrices -> "CryptoPrices"
// - This matches TypeScript discriminated unions in the frontend
//
// FRONTEND SYNCHRONIZATION:
// These types must remain compatible with their TypeScript counterparts in
// src/types/ (nodes.ts, markets.ts, sources.ts). When modifying enums, update
// both Rust and TypeScript definitions simultaneously.
//
// EXPORTS:
// - Node, NodeType, InfoSourceType, MarketType (node.rs)
// - Orderbook, TradeSide, OrderType, TradeResult (market.rs)
// - Position (position.rs)
// - TradingSignal (trading_signal.rs)
// - RemoteSession, DeviceCredentials, RemoteStatus, etc. (remote.rs)
// - AnalyzerNode, AnalyzerType, AnalyzerResult, etc. (analyzer_node.rs)
// ============================================================================

pub mod node;
pub mod market;
pub mod position;

// Core node graph types
pub use node::{
    Node,
    NodeType,
    InfoSourceType,
    MarketType
};

// Market data and trading types
pub use market::{
    Orderbook,
    TradeSide,
    OrderType,
    TradeResult
};

// Position tracking types
pub use position::{
    Position
};

// Trading signal types
pub mod trading_signal;
pub use trading_signal::TradingSignal;

// Analyzer node types
pub mod remote;
pub use remote::{
    RemoteSession,
    DeviceCredentials,
    RemoteStatus,
    RemoteCommand,
    RelayConfig,
    SessionStatus,
};

pub mod analyzer_node;
pub use analyzer_node::{
    AnalyzerNode,
    AnalyzerType,
    AnalyzerResult,
    AnalyzerChain,
    CorrelationConfig,
    MomentumConfig,
    ArbitrageConfig,
    SentimentConfig,
    RSIConfig,
    VolatilityConfig,
};
