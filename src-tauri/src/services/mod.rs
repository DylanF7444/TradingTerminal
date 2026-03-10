// ============================================================================
// SERVICES MODULE
// ============================================================================
//
// Purpose: Re-exports all background service sub-modules for the prediction
// market terminal.
//
// ARCHITECTURE:
// The services layer implements a pipeline architecture:
//
// [Scraper Service] -> [Analysis Service] -> [Execution Service]
//        |                    |                     |
//   Raw Data          Trading Signals          Orders Placed
//   (Prices,          (Buy/Sell/Hold)          (Positions
//   Sentiment)                                 Opened)
//
// Each service runs as independent Tokio tasks communicating via channels.
// This ensures that slow scrapers don't block analysis, and failed trades
// don't crash the data ingestion.
//
// Services are designed to fail independently:
// - Scraper fails (API down): Analyzer continues with stale data
// - Analyzer fails (bug): Executor stops trading (safer than blind trading)
// - Executor fails (auth error): Scraper/Analyzer continue accumulating signals
//
// SUB-MODULES:
//
// scraper            - Data ingestion from external APIs (HTTP polling,
//                      rate limiting, data validation)
// analyzer           - Signal generation and trading logic
// analyzers          - Individual analyzer implementations
// analyzer_pipeline  - Orchestrates analyzers into a processing pipeline
// node_analyzer_manager - Per-node analyzer lifecycle management
// executor           - Order execution and risk management
// orderbook          - In-memory orderbook construction from market data
// persistent_orderbook - Disk-backed orderbook with historical tracking
// websocket_manager  - WebSocket connection lifecycle and multiplexing
// websocket_scraper  - Real-time data ingestion over WebSocket feeds
// remote_gateway     - Communication with remote analysis services
// startup            - Application startup sequence and service wiring
//
// Service initialization is handled in main.rs via the startup module.
// ============================================================================

pub mod scraper;
pub mod analyzer;
pub mod executor;
pub mod orderbook;
pub mod websocket_manager;
pub mod websocket_scraper;
pub mod startup;
pub mod analyzers;
pub mod analyzer_pipeline;
pub mod node_analyzer_manager;
pub mod remote_gateway;
pub mod persistent_orderbook;