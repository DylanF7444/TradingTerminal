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
//!
//! ## Naming Convention (CRITICAL)
//!
//! All Tauri commands MUST follow a consistent naming convention to ensure frontend-backend compatibility:
//!
//! ### Backend (Rust) Naming:
//! - Command functions in this module are named descriptively: `add_data_source`, `get_positions`, etc.
//! - Commands registered in `main.rs` MUST use the `_cmd` suffix: `add_data_source_cmd`, `get_positions_cmd`
//! - This is achieved by defining wrapper functions in `main.rs` with the `_cmd` suffix
//!
//! ### Frontend (TypeScript) Naming:
//! - Frontend MUST invoke commands using the exact name registered in `main.rs` (with `_cmd` suffix)
//! - Example: `invoke('get_positions_cmd', { ... })` NOT `invoke('get_positions', { ... })`
//!
//! ### Why the `_cmd` suffix?
//! - Prevents naming conflicts with Rust keywords and reserved names
//! - Makes it explicit that the function is a Tauri IPC command
//! - Consistent pattern across all commands in the codebase
//!
//! ### Command Registration Flow:
//! 1. Define command logic in `commands/*.rs` (e.g., `pub async fn add_data_source(...)`)
//! 2. Re-export from `commands/mod.rs`
//! 3. Create wrapper in `main.rs` with `#[tauri::command]` and `_cmd` suffix
//! 4. Register in `tauri::generate_handler![]` macro
//! 5. Frontend invokes using the `_cmd` name
//!
//! ### Example:
//! ```rust
//! // In commands/data_sources.rs:
//! pub async fn add_data_source(...) -> Result<Node, String> { ... }
//!
//! // In main.rs:
//! #[tauri::command]
//! async fn add_data_source_cmd(...) -> Result<Node, String> {
//!     data_sources::add_data_source(...).await
//! }
//!
//! // In invoke_handler:
//! tauri::generate_handler![add_data_source_cmd, ...]
//! ```
//!
//! ```typescript
//! // In frontend:
//! await invoke('add_data_source_cmd', { ... });
//! ```

pub mod data_sources;
pub mod markets;
pub mod trading;
pub mod storage;
pub mod orderbook;
pub mod api_keys;

// Re-export all commands for main.rs invoke_handler registration

// Data Sources: Info source node management
pub use data_sources::{add_data_source, remove_data_source, get_data_sources, update_node_position_cmd, update_node_size_cmd};

// Markets: includes state initializer for main.rs
pub use markets::{
    add_market, 
    remove_market, 
    get_markets, 
    get_orderbook,
    refresh_market_connection,
    get_market_status,
    init_state as init_market_state,
    MarketState,
};

pub use trading::{
    place_order, 
    get_positions, 
    close_position
};

pub use storage::{
    store_timeseries, 
    query_timeseries, 
    get_correlation_data,
    get_node_stored_data,
    delete_node_stored_data,
    NodeStoredData,
    WebsocketMessage,
};

pub use orderbook::{
    // Legacy commands (backward compatible)
    subscribe_orderbook_cmd,
    subscribe_polymarket_market_cmd,
    unsubscribe_orderbook_cmd,
    get_orderbook_subscriptions_cmd,
    unsubscribe_all_orderbooks_cmd,
    reconnect_orderbook_cmd,
    subscribe_kalshi_orderbook_with_auth_cmd,
    // New consolidated commands
    subscribe_consolidated_cmd,
    unsubscribe_consolidated_cmd,
    get_consolidated_subscriptions_cmd,
    unsubscribe_platform_cmd,
    set_kalshi_credentials_cmd,
    clear_kalshi_credentials_cmd,
    // State initializer
    init_state as init_orderbook_state,
    OrderbookState,
    SubscriptionInfo,
    ConsolidatedSubscriptionInfo,
};

// API Keys: Secure credential storage for trading platforms
pub use api_keys::{
    save_api_key_command,
    get_api_key_command,
    get_all_api_keys_command,
    delete_api_key_command,
    has_api_key_command,
    get_configured_platforms_command,
    SaveApiKeyRequest,
    ApiKeyResponse,
    ApiKeySummary,
};