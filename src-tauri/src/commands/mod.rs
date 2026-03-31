//! # Commands Module
//!
//! Central registry for all Tauri command handlers exposed to the frontend.
//! Commands are `#[tauri::command]` functions forming the IPC boundary between
//! the React frontend and Rust backend.
//!
//! ## Architecture
//! - **Thin Controllers**: Commands validate input, acquire state, and delegate
//!   to service layers in `crate::services`. Business logic lives in services.
//! - **State Management**: Uses Tauri's managed state (`AppHandle`, `State<T>`)
//!   to share DB connections, HTTP clients, and task handles across invocations.
//! - **Error Handling**: Commands return `Result<T, String>` where errors are
//!   serialized for frontend display.
//! - **Concurrency**: Runs on Tokio async runtime. Long-running operations are
//!   spawned as background tasks to avoid blocking the frontend.
//!
//! ## Naming Convention (CRITICAL)
//!
//! All commands follow a `_cmd` suffix pattern for frontend-backend compatibility:
//!
//! 1. Define logic in `commands/*.rs`: `pub async fn add_data_source(...)`
//! 2. Re-export from this module
//! 3. Create `#[tauri::command]` wrapper in `main.rs` with `_cmd` suffix
//! 4. Register in `tauri::generate_handler![]`
//! 5. Frontend invokes with the `_cmd` name: `invoke('add_data_source_cmd', { ... })`
//!
//! The suffix prevents naming conflicts with Rust keywords and makes IPC
//! boundaries explicit. See README for full examples.

pub mod data_sources;
pub mod markets;
pub mod trading;
pub mod storage;
pub mod orderbook;
pub mod api_keys;
pub mod analyzers;
pub mod remote;

// Re-export all commands for main.rs invoke_handler registration

// Data Sources: Info source node management
pub use data_sources::{add_data_source, remove_data_source, get_data_sources, update_node_position_cmd, update_node_size_cmd, get_curated_social_sources};

// Markets: includes state initializer for main.rs
pub use markets::{
    add_market,
    remove_market,
    get_markets,
    get_orderbook,
    refresh_market_connection,
    get_market_status,
    search_events,
    search_series,
    EventSearchResult,
    EventSearchResponse,
    SeriesMarketItem,
    SeriesSearchResult,
    SeriesSearchResponse,
    init_state as init_market_state,
    MarketState,
    // Series API functions (two-step hierarchical)
    list_series,
    get_series_full,
    SeriesListItem,
    SeriesListResponse,
    SeriesEventData,
    SeriesFullData,
    // Legacy series API functions
    get_series,
    get_series_markets,
    parse_market_url_fn,
    fetch_from_url,
    // Series types
    SeriesInfo,
    ParsedMarketUrl,
    SeriesSettings,
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

// Analyzers: Analyzer node management
pub use analyzers::{
    create_analyzer,
    update_analyzer,
    delete_analyzer,
    get_node_analyzers,
    get_analyzer_results,
    get_analyzer,
    toggle_analyzer,
    create_chain,
    delete_chain,
    get_node_chains,
    get_analyzer_types,
    CreateAnalyzerRequest,
    UpdateAnalyzerRequest,
    CreateChainRequest,
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

// Remote Access: Remote desktop gateway management
pub use remote::{
    enable_remote_access,
    disable_remote_access,
    get_remote_status,
    generate_pairing_code,
    submit_pairing_code,
    revoke_remote_device,
    get_paired_devices,
    update_relay_config,
    EnableRemoteRequest,
    PairedDeviceSummary,
};