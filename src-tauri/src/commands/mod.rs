//! # Commands Module
//! 
//! This module serves as the central registry for all Tauri command handlers exposed to the frontend.
//! Commands are Rust functions annotated with `#[tauri::command]` that form the IPC (Inter-Process Communication)
//! boundary between the React frontend and Rust backend.
//! 
//! ## Architecture Pattern
//! - **Command Functions**: Act as thin HTTP-like controllers - they validate input, acquire resources from the
//!   application state, and delegate to service layers in `crate::services`
//! - **State Management**: Uses Tauri's managed state (`AppHandle`, `State<T>`) to share expensive resources
//!   (DB connections, HTTP clients, background task handles) across command invocations
//! - **Error Handling**: Commands return `Result<T, String>` where errors are serialized for frontend display
//!   (production apps should use structured error types)
//! 
//! ## Concurrency Model
//! Commands are executed on Tokio's async runtime (configured in `main.rs`). Long-running operations
//! (scraping, API calls) are spawned as background tasks to prevent blocking the frontend.
//! 
//! ## Security Considerations
//! - API keys and sensitive config are NEVER logged or returned to frontend
//! - Input validation happens at boundary before passing to services
//! - Rate limiting is enforced before external API calls

pub mod data_sources;
pub mod markets;
pub mod trading;
pub mod storage;

// Re-export all commands for main.rs invoke_handler registration
pub use data_sources::{add_data_source, remove_data_source, get_data_sources};
pub use markets::{add_market, remove_market, get_markets, get_orderbook};
pub use trading::{place_order, get_positions, close_position};
pub use storage::{store_timeseries, query_timeseries, get_correlation_data};