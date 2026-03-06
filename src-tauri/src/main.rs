// ============================================================================
// PREDICTION MARKET TERMINAL - MAIN ENTRY POINT
// ============================================================================
//
// File: src-tauri/src/main.rs
// Purpose: Application bootstrap, initialization, and lifecycle management
//
// OVERVIEW:
// This is the entry point for the Tauri desktop application. It initializes
// the SQLite database, starts background services (scrapers, analyzer, executor),
// registers Tauri commands for frontend IPC, and manages application lifecycle
// including graceful shutdown.
//
// WHY TAURI (vs Electron):
// - Binary size: ~5MB vs ~150MB (no bundled Chromium)
// - Memory usage: ~50MB vs ~300MB RAM idle
// - Security: Rust memory safety, OS-native webview sandboxing
// - Performance: Native Rust backend, no Node.js bridge overhead
// - CPU efficiency: Critical for 24/7 trading operations
//
// APPLICATION ARCHITECTURE:
//
// Main Thread (Tauri):
//   - UI event loop (macOS/Android requirement)
//   - Command dispatch (invoke_handler)
//   - Window management
//
// Tokio Runtime (Async):
//   - Database connection pool
//   - HTTP client connections (reqwest)
//   - Scraper tasks (one per data source)
//   - Analyzer task (signal processing)
//   - Executor task (trade execution)
//   - WebSocket listeners (market data feeds)
//
// THREADING MODEL:
//
// There's no true "main thread" blocking in Tauri apps. Instead:
// 1. main() runs briefly to build the Tauri app
// 2. .run() enters the native event loop (platform-specific)
// 3. Tokio runtime (configured by Tauri) handles async work
// 4. Commands are dispatched on Tokio threads
// 5. State is shared via Arc<Mutex<T>> across threads
//
// BOOT SEQUENCE:
//
// 1. Parse command line arguments (if any)
// 2. Initialize logging (env_logger/tracing)
// 3. Configure panic hooks (graceful crash reporting)
// 4. Build Tauri application:
//    a. setup() hook runs:
//       - Resolve app data directory (platform-specific)
//       - Create SQLite database file if missing
//       - Initialize schema (tables, indexes)
//       - Apply performance pragmas (WAL mode, etc.)
//       - Start background services (scrapers, analyzer, executor)
//       - Register global state (DB pool, HTTP client, service handles)
//    b. Configure menu / system tray
//    c. Configure window attributes
// 5. Register command handlers (IPC functions callable from frontend)
// 6. Configure event handlers:
//    - Window close requested (graceful shutdown)
//    - System tray click
//    - Deep links (future: handle market URLs)
// 7. Run application (blocks until exit)
// 8. Cleanup on exit:
//    - Shutdown signal to all services
//    - Wait for scrapers to finish current iteration
//    - Close database connections
//    - Flush logs
//
// STATE MANAGEMENT:
//
// Tauri uses "managed state" pattern - objects stored in AppHandle and accessible
// to all commands via State<'_, T>. We store:
//
// - Database: Arc<Mutex<Connection>> (or deadpool/r2d2 pool in production)
// - HttpClient: reqwest::Client (shared across all HTTP requests)
// - ServiceHandles: Abort handles for scrapers, analyzer, executor
// - Config: ApplicationSettings (hot-reloadable config)
//
// SAFETY:
// - Database path uses app_data_dir() (sandboxed, user-writable)
// - Fallback to temp dir if data_dir unavailable (rare edge case)
// - All unwraps/expects are for programmer errors (config missing), not runtime
// - Database migrations are idempotent (CREATE TABLE IF NOT EXISTS)
//
// ERROR HANDLING STRATEGY:
//
// - Database initialization failure: Fatal, show error dialog, exit
// - Service startup failure: Log error, continue with degraded functionality
// - Command errors: Return Result<T, String> to frontend for display
// - Panics: Catch and log to file, attempt graceful shutdown
//
// PLATFORM CONSIDERATIONS:
//
// macOS:
//   -_app_data_dir: ~/Library/Application Support/com.yourcompany.terminal/
//   - Requires Info.plist for bundle ID
//   - Menu bar integration expected
//
// Windows:
//   - app_data_dir: %APPDATA%/YourCompany/terminal/
//   - System tray recommended for background operation
//   - Console window hidden in release (windows_subsystem)
//
// Linux:
//   - app_data_dir: ~/.local/share/terminal/ or $XDG_DATA_HOME
//   - Follows XDG Base Directory Specification
//
// SECURITY:
//
// - Database file permissions: User-only read/write (0o600 on Unix)
// - API keys: Never logged, retrieved from keyring on demand
// - CORS: Not applicable (desktop app, no web server)
// - CSP: Configured in tauri.conf.json to prevent XSS
// - Updater: Verify signatures before installing updates
//
// PERFORMANCE OPTIMIZATIONS:
//
// - Single HTTP client instance (connection pooling)
// - Database WAL mode (reads don't block writes)
// - Batch inserts for time-series data
// - Lazy loading of heavy modules
//
// ENVIRONMENT VARIABLES:
//
// RUST_LOG=debug          # Enable verbose logging
// RUST_BACKTRACE=1        # Show backtraces on panic
// APP_DATA_DIR=/path      # Override data directory (dev only)
//
// EXIT CODES:
//
// 0: Clean exit
// 1: Initialization error (database, config)
// 2: Runtime panic
// 130: Ctrl+C interrupt (SIGINT)
//
// TESTING:
//
// Integration tests don't use main.rs directly. Instead test individual
// commands via Tauri::test::mock_builder(). See tests/integration.rs.
//
// FUTURE ENHANCEMENTS:
//
// - Single Instance: Prevent multiple app instances (tauri-plugin-single-instance)
// - Updater: Auto-update via GitHub releases (tauri-plugin-updater)
// - CLI: Command-line interface for headless operation (tauri-cli)
// - Plugin System: Dynamic loading of custom scrapers (libloading)
// - Multi-Window: Detached charts in separate windows
// - Protocol Handler: Register app for market://deep/links
// ============================================================================

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Module declarations
mod commands;
mod db;
mod models;
mod services;

// Standard library imports
use std::sync::Arc;
use std::path::PathBuf;
use std::time::Duration;

// External crate imports
use tauri::{Manager, State, RunEvent, WindowEvent};
use tokio::sync::Mutex;
use log::info;

// Internal imports
use crate::commands::{
    data_sources,
    markets,
    trading,
    storage,
    update_node_position_cmd,
    update_node_size_cmd,
    orderbook::{self, OrderbookState},
    api_keys,
    analyzers,
    remote,
};
use crate::db::sqlite::{self, Connection, create_connection, setup_schema, apply_optimizations};
use crate::services::{scraper, startup};
use crate::services::websocket_manager::{WebSocketManager, create_websocket_manager, NetworkMetricsSnapshot};
use crate::services::remote_gateway::{RemoteConnectionManager, create_remote_manager};
use crate::services::persistent_orderbook::{
    PersistentOrderbookState,
    create_persistent_monitor,
};
use sysinfo::SystemExt;
use rusqlite::params;

/// System monitor for CPU/memory metrics

/// Global system monitor (initialized once)
static SYSTEM_MONITOR: std::sync::Mutex<Option<sysinfo::System>> = std::sync::Mutex::new(None);

fn get_system_monitor() -> std::sync::MutexGuard<'static, Option<sysinfo::System>> {
    let mut guard = SYSTEM_MONITOR.lock().unwrap();
    if guard.is_none() {
        let mut sys = sysinfo::System::new_all();
        // First refresh initializes CPU tracking baseline
        sys.refresh_all();
        // Second refresh provides actual CPU usage reading
        sys.refresh_all();
        *guard = Some(sys);
    }
    guard
}

/// Application state shared across all commands and services
/// 
/// This structure is managed by Tauri and accessible via State<'_, AppState>
pub struct AppState {
    /// SQLite database connection (wrapped in Arc<Mutex> for thread safety)
    /// 
    /// In production, replace with connection pool (r2d2/deadpool)
    pub db: Arc<Mutex<Connection>>,
    
    /// Shared HTTP client for all external API calls
    /// 
    /// Benefits: Connection pooling, shared timeout config, user-agent
    pub http_client: reqwest::Client,
    
    /// Active scraper handles for graceful shutdown
    /// 
    /// Map of node_id -> ScraperHandle (contains abort handle and shutdown channel)
    pub active_scrapers: Arc<Mutex<std::collections::HashMap<String, scraper::ScraperHandle>>>,
    
    /// Analyzer service handle (signal processing)
    pub analyzer_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    
    /// Executor service handle (trade execution)
    pub executor_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    
    /// Application configuration (hot-reloadable)
    pub config: Arc<Mutex<AppConfig>>,
    
    /// WebSocket manager for market data streams
    pub ws_manager: Arc<WebSocketManager>,
    
    /// Remote connection manager for remote desktop gateway
    /// 
    /// Manages WebSocket relay connections for remote device access.
    /// Enables the trading terminal to be accessed from remote devices
    /// through a relay server, proxying market data and commands.
    pub remote_manager: Arc<RemoteConnectionManager>,
}

/// Application configuration structure
#[derive(Debug, Clone)]
pub struct AppConfig {
    /// Maximum concurrent scrapers allowed
    pub max_scrapers: usize,
    
    /// Trading enabled global flag (kill switch)
    pub trading_enabled: bool,
    
    /// Log level (debug, info, warn, error)
    pub log_level: String,
    
    /// Database path (usually auto-detected, but can be overridden)
    pub db_path: Option<PathBuf>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            max_scrapers: 50,
            trading_enabled: true,
            log_level: "info".to_string(),
            db_path: None,
        }
    }
}

/// Main entry point
/// 
/// Initializes the Tauri application and enters the event loop
fn main() {
    // Initialize logging (RUST_LOG environment variable controls level)
    env_logger::init();
    info!("Starting Prediction Market Terminal");
    
    // Configure panic hook for graceful crash reporting
    std::panic::set_hook(Box::new(|info| {
        eprintln!("Application panic: {}", info);
        // In production: write to crash log, send telemetry, show dialog
    }));
    
    // Build and run Tauri application
    tauri::Builder::default()
        // Setup hook runs once during application initialization
        .setup(setup_application)
        
        // Register all IPC command handlers
        // These functions can be called from frontend via @tauri-apps/api/tauri
        //
        // NAMING CONVENTION (CRITICAL):
        // All commands registered here MUST use the `_cmd` suffix.
        // This matches the frontend invoke() calls which use the same suffix.
        //
        // Example:
        //   Backend: fn get_positions_cmd(...) -> Result<Vec<Position>, String>
        //   Frontend: invoke('get_positions_cmd', { ... })
        //
        // When adding a new command:
        //   1. Define the logic in commands/*.rs (e.g., pub async fn get_positions(...))
        //   2. Create a wrapper here with #[tauri::command] and `_cmd` suffix
        //   3. Register it in this generate_handler![] macro
        //   4. Frontend invokes using the exact `_cmd` name
        //
        .invoke_handler(tauri::generate_handler![
            // Data source commands
            add_data_source_cmd,
            remove_data_source_cmd,
            get_data_sources_cmd,
            update_data_source_cmd,
            get_data_source_status_cmd,
            update_node_position_cmd,
            update_node_size_cmd,
            add_node_cmd,
            
            // Connection commands
            add_connection_cmd,
            remove_connection_cmd,
            get_all_connections_cmd,
            
            // Market commands
            add_market_cmd,
            remove_market_cmd,
            get_markets_cmd,
            get_orderbook_cmd,
            refresh_market_connection_cmd,
            search_markets_cmd,
            
            // Trading commands
            place_order_cmd,
            get_positions_cmd,
            close_position_cmd,
            get_trade_history_cmd,

            // Multi-leg trading commands (multi-outcome/categorical markets)
            place_multi_leg_order_cmd,
            get_multi_leg_positions_cmd,
            close_multi_leg_position_cmd,
            close_position_leg_cmd,
            get_multi_leg_position_cmd,
            
            // Storage commands
            store_timeseries_cmd,
            query_timeseries_cmd,
            get_correlation_data_cmd,
            get_storage_stats_cmd,
            get_node_stored_data_cmd,
            delete_node_stored_data_cmd,
            
            // System commands
            get_system_info_cmd,
            get_network_metrics_cmd,
            get_database_stats_cmd,
            vacuum_database_cmd,
            
            // Orderbook commands (legacy)
            subscribe_orderbook_cmd,
            subscribe_polymarket_market_cmd,
            unsubscribe_orderbook_cmd,
            get_orderbook_subscriptions_cmd,
            unsubscribe_all_orderbooks_cmd,
            reconnect_orderbook_cmd,
            subscribe_kalshi_orderbook_auth_cmd,
            
            // Consolidated WebSocket commands (NEW)
            subscribe_consolidated_cmd,
            unsubscribe_consolidated_cmd,
            get_consolidated_subscriptions_cmd,
            unsubscribe_platform_cmd,
            set_kalshi_credentials_cmd,
            clear_kalshi_credentials_cmd,
            
            // Persistent orderbook monitoring commands (ALWAYS-ON)
            monitor_market_orderbook_cmd,
            unmonitor_market_orderbook_cmd,
            get_cached_orderbook_cmd,
            get_orderbook_monitoring_summary_cmd,
            
            // WebSocket commands
            reconnect_websocket_cmd,
            disconnect_websocket_cmd,
            
            // Order management commands
            modify_order_cmd,
            cancel_order_cmd,
            get_balance_cmd,
            
            // Utility commands
            log_frontend_error,
            report_error,
            restart_app,
            frontend_ready,
            
            // API Key management commands (stored credentials for trading platforms)
            // - save_api_key_cmd: Store/update API credentials for a platform
            // - get_api_key_cmd: Retrieve stored credentials for a platform
            // - get_all_api_keys_cmd: List all stored keys (summary only, no secrets)
            // - delete_api_key_cmd: Remove stored credentials
            // - has_api_key_cmd: Check if credentials exist for a platform
            // - get_configured_platforms_cmd: Get list of platforms with stored keys
            save_api_key_cmd,
            get_api_key_cmd,
            get_all_api_keys_cmd,
            delete_api_key_cmd,
            has_api_key_cmd,
            get_configured_platforms_cmd,
            
            // Analyzer commands
            create_analyzer_cmd,
            update_analyzer_cmd,
            delete_analyzer_cmd,
            get_node_analyzers_cmd,
            get_analyzer_results_cmd,
            get_analyzer_cmd,
            toggle_analyzer_cmd,
            create_chain_cmd,
            delete_chain_cmd,
            get_node_chains_cmd,
            get_analyzer_types_cmd,
            
            // Remote access commands (gateway management for remote desktop connections)
            // - enable_remote_access_cmd: Connect to relay server, begin accepting remotes
            // - disable_remote_access_cmd: Disconnect relay and all remote sessions
            // - get_remote_status_cmd: Current gateway status (connections, uptime, etc.)
            // - generate_pairing_code_cmd: Create 6-digit code for device enrollment
            // - revoke_remote_device_cmd: Revoke a paired device's access
            // - get_paired_devices_cmd: List all paired devices (sans auth tokens)
            // - update_relay_config_cmd: Change relay server URL/settings
            enable_remote_access_cmd,
            disable_remote_access_cmd,
            get_remote_status_cmd,
            generate_pairing_code_cmd,
            revoke_remote_device_cmd,
            get_paired_devices_cmd,
            update_relay_config_cmd,
        ])
        
        // Run the application
        .build(tauri::generate_context!())
        .expect("Error building Tauri application")
        .run(handle_run_event);
}

/// Application setup hook
/// 
/// Called once during initialization, before window is shown.
/// Used for database setup, service initialization, and state registration.
fn setup_application(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    info!("Initializing application...");
    
    // 1. Resolve application data directory
    let app_dir = app.path().app_data_dir().unwrap_or_else(|_| {
        std::env::temp_dir().join("prediction_market_terminal")
    });
    
    std::fs::create_dir_all(&app_dir)?;
    info!("App directory: {:?}", app_dir);
    
    // 2. Initialize database
    let db_path = app_dir.join("terminal.db");
    
    // Initialize the global database connection (for commands using get_connection())
    db::init_db(&db_path).map_err(|e| format!("Database init failed: {}", e))?;
    
    // Also create a connection for AppState
    let conn = create_connection(&db_path)?;
    setup_schema(&conn)?;
    apply_optimizations(&conn)?;
    info!("Database initialized at: {:?}", db_path);
    
    // 3. Create shared HTTP client
    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("PredictionMarketTerminal/1.0")
        .build()?;
    
    // 4. Initialize application state
    // Create WebSocket manager first (needed for both state and startup)
    let ws_manager = create_websocket_manager(app.handle().clone());
    
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        http_client,
        active_scrapers: Arc::new(Mutex::new(std::collections::HashMap::new())),
        analyzer_handle: Arc::new(Mutex::new(None)),
        executor_handle: Arc::new(Mutex::new(None)),
        config: Arc::new(Mutex::new(AppConfig::default())),
        ws_manager: ws_manager.clone(),
        remote_manager: create_remote_manager(app.handle().clone()),
    };
    
    // 5. Manage state (accessible to all commands via State<'_, AppState>)
    app.manage(state);

    // 5a. Initialize and manage trading state (multi-leg support)
    let market_state_for_trading = markets::MarketState::new();
    let trading_state = trading::TradingState::new(market_state_for_trading);
    app.manage(trading_state);

    // 5b. Initialize and manage orderbook state
    let orderbook_state = orderbook::init_state(app.handle().clone(), ws_manager.clone());
    app.manage(orderbook_state);
    
    // 5c. Initialize persistent orderbook monitor (ALWAYS-ON monitoring)
    let persistent_monitor = create_persistent_monitor(ws_manager.clone(), app.handle().clone());
    app.manage(persistent_monitor.clone());
    
    // 6. Start background services (scraper supervisor, analyzer, executor)
    // Initialize all saved nodes and start their websockets/scrapers
    tauri::async_runtime::spawn(start_background_services(app.handle().clone(), ws_manager, persistent_monitor));
    
    info!("Application initialization complete");
    Ok(())
}

/// Background services starter
/// 
/// Spawns analyzer and executor services. Scrapers are started on-demand
/// when users add data sources.
async fn start_background_services(app_handle: tauri::AppHandle, ws_manager: Arc<WebSocketManager>, persistent_monitor: PersistentOrderbookState) {
    info!("Starting background services...");
    
    let state: State<'_, AppState> = app_handle.state();
    
    // Initialize all saved nodes from database
    match startup::initialize_saved_nodes(
        state.db.clone(),
        ws_manager,
        app_handle.clone(),
    ).await {
        Ok(active_services) => {
            // Store the active scrapers in state
            let mut scrapers = state.active_scrapers.lock().await;
            *scrapers = active_services.scrapers;
            info!("Saved nodes initialized successfully");
            
            // ================================================================
            // AUTO-SUBSCRIBE EXISTING MARKET NODES (ALWAYS-ON MONITORING)
            // ================================================================
            // After loading saved nodes, subscribe their orderbooks
            // so monitoring begins immediately at startup.
            // ================================================================
            for market_info in &active_services.market_subscriptions {
                if let Err(e) = persistent_monitor
                    .subscribe_market(
                        &market_info.node_id,
                        &market_info.market_id,
                        &market_info.platform,
                    )
                    .await
                {
                    eprintln!(
                        "[PersistentOrderbook] Failed to auto-subscribe market {} ({}): {}",
                        market_info.market_id, market_info.platform, e
                    );
                }
            }
        }
        Err(e) => {
            eprintln!("Failed to initialize saved nodes: {}", e);
        }
    }
    
    // ====================================================================
    // START ORDERBOOK UPDATE CACHE LISTENER
    // ====================================================================
    // Listen for all orderbook:update events and cache them in the
    // persistent monitor. This ensures the central cache is always
    // up-to-date regardless of which UI components are mounted.
    // ====================================================================
    let monitor_for_listener = persistent_monitor.clone();
    let app_for_listener = app_handle.clone();
    tokio::spawn(async move {
        use tauri::Listener;
        // Listen for orderbook updates and cache them
        app_for_listener.listen("orderbook:update", move |event| {
            let monitor = monitor_for_listener.clone();
            // In Tauri 2, event.payload() returns &str directly
            let payload_str = event.payload();
            if let Ok(update) = serde_json::from_str::<crate::services::orderbook::OrderbookUpdate>(payload_str) {
                tokio::spawn(async move {
                    monitor.handle_update(&update).await;
                });
            }
        });
    });
    
    // ====================================================================
    // PERIODIC STALENESS CHECK
    // ====================================================================
    let monitor_for_stale = persistent_monitor.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            monitor_for_stale.check_staleness().await;
        }
    });
    
    // Start analyzer service (consumes data, produces signals)
    // TODO: Create channels between analyzer and executor
    // TODO: Spawn analyzer task
    
    // Start executor service (consumes signals, executes trades)
    // TODO: Create channels between analyzer and executor  
    // TODO: Spawn executor task
    
    info!("Background services started");
}

/// Handle application run events
/// 
/// Called for lifecycle events like window close, system signals, etc.
fn handle_run_event(app_handle: &tauri::AppHandle, event: RunEvent) {
    match event {
        RunEvent::WindowEvent { label, event: window_event, .. } => {
            if label == "main" {
                match window_event {
                    WindowEvent::CloseRequested { api, .. } => {
                        // Prevent immediate close, do graceful shutdown
                        info!("Window close requested, initiating graceful shutdown...");
                        
                        let app_handle = app_handle.clone();
                        tauri::async_runtime::spawn(async move {
                            graceful_shutdown(app_handle).await;
                            std::process::exit(0);
                        });
                        
                        // Prevent default close (we'll exit manually after cleanup)
                        api.prevent_close();
                    }
                    _ => {}
                }
            }
        }
        RunEvent::ExitRequested { .. } => {
            info!("Exit requested");
        }
        RunEvent::Exit => {
            info!("Application exiting");
        }
        _ => {}
    }
}

/// Graceful shutdown sequence
/// 
/// 1. Stop all scrapers (finish current iteration)
/// 2. Stop analyzer (drain signal queue)
/// 3. Stop executor (finish pending orders)
/// 4. Close database connections
/// 5. Flush logs
async fn graceful_shutdown(app_handle: tauri::AppHandle) {
    info!("Starting graceful shutdown...");
    
    let state: State<'_, AppState> = app_handle.state();
    
    // 1. Stop all active scrapers
    let scrapers = state.active_scrapers.lock().await;
    for (node_id, handle) in scrapers.iter() {
        info!("Stopping scraper: {}", node_id);
        if let Err(e) = scraper::stop_scraper(handle).await {
            eprintln!("Error stopping scraper {}: {}", node_id, e);
        }
    }
    drop(scrapers); // Release lock
    
    // 2. Stop analyzer
    let mut analyzer = state.analyzer_handle.lock().await;
    if let Some(handle) = analyzer.take() {
        info!("Stopping analyzer");
        handle.abort();
    }
    
    // 3. Stop executor
    let mut executor = state.executor_handle.lock().await;
    if let Some(handle) = executor.take() {
        info!("Stopping executor");
        handle.abort();
    }
    
    // 4. Shutdown remote gateway
    if let Err(e) = state.remote_manager.shutdown().await {
        eprintln!("Error shutting down remote gateway: {}", e);
    }
    info!("Remote gateway shut down");
    
    // 5. Database cleanup (VACUUM if needed, close connections)
    {
        let _db = state.db.lock().await;
        // sqlite::vacuum_database(&db).ok();
        info!("Database connections closed");
    }
    
    info!("Graceful shutdown complete");
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================
//
// These functions are exposed to the frontend via Tauri's IPC system.
// They are async (run on Tokio runtime) and receive State<'_, AppState>
// for database and service access.
//
// Naming convention: *_cmd suffix distinguishes from internal functions
// in commands/ modules.
// ============================================================================

// -------------------------------------------------------------------------
// Data Source Commands
// -------------------------------------------------------------------------

/// Add a new data source (info node) and start scraping
/// 
/// Frontend: await invoke('add_data_source_cmd', { sourceType: 'CryptoPrices', config: {...} })
#[tauri::command]
async fn add_data_source_cmd(
    source_type: String,  // Should be InfoSourceType, string for JSON simplicity
    config: serde_json::Value,
    state: State<'_, AppState>,
    window: tauri::Window,
) -> Result<serde_json::Value, String> {
    info!("Adding data source: {:?}", source_type);
    
    // Parse source type
    let source_type = match source_type.as_str() {
        "CryptoPrices" => models::node::InfoSourceType::CryptoPrices,
        "NewsSource" => models::node::InfoSourceType::NewsSource,
        "Weather" => models::node::InfoSourceType::Weather,
        "SocialMedia" => models::node::InfoSourceType::SocialMedia,
        "FinancialPrices" => models::node::InfoSourceType::FinancialPrices,
        "CommodityPrices" => models::node::InfoSourceType::CommodityPrices,
        "Livestream" => models::node::InfoSourceType::Livestream,
        _ => return Err(format!("Unknown source type: {}", source_type)),
    };
    
    // Create node in database
    let node = tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        let node = models::node::Node {
            id: uuid::Uuid::new_v4().to_string(),
            node_type: models::node::NodeType::InfoSource(source_type.clone()),
            position: (100.0, 100.0), // Default position
            size: None,
            connections: vec![],
            metadata: config.clone(),
        };
        
        if let Err(e) = sqlite::insert_node(&conn, &node) {
            return Err(format!("Database error: {}", e));
        }
        Ok(node)
    })?;
    
    // Start scraper
    let db = state.db.clone();
    let network_metrics = state.ws_manager.network_metrics();
    let scraper_handle = scraper::spawn_scraper(
        node.id.clone(),
        source_type,
        config,
        db,
        window,
        network_metrics,
    ).await.map_err(|e| e.to_string())?;
    
    // Store handle for later shutdown
    state.active_scrapers.lock().await.insert(node.id.clone(), scraper_handle);
    
    Ok(serde_json::json!({
        "success": true,
        "node": node
    }))
}

/// Remove a data source and stop scraping
#[tauri::command]
async fn remove_data_source_cmd(
    node_id: String,
    state: State<'_, AppState>,
) -> Result<sqlite::DeleteNodeStats, String> {
    info!("Removing data source: {}", node_id);
    
    // Stop scraper
    if let Some(handle) = state.active_scrapers.lock().await.remove(&node_id) {
        scraper::stop_scraper(&handle).await.map_err(|e| e.to_string())?;
    }
    
    // Delete node and all associated data (cascade delete)
    let stats = tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::delete_node_cascade(&conn, &node_id)
            .map_err(|e| format!("Database error: {}", e))
    })?;
    
    info!("Data source removed: {} (deleted {} timeseries, {} websocket messages, {} connections)", 
        node_id, stats.timeseries_deleted, stats.websocket_messages_deleted, stats.connections_deleted);
    
    Ok(stats)
}

/// Get all active data sources and restart their scrapers
#[tauri::command]
async fn get_data_sources_cmd(
    state: State<'_, AppState>,
    window: tauri::Window,
) -> Result<Vec<models::node::Node>, String> {
    let nodes = tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::get_all_active_nodes(&conn)
            .map_err(|e| format!("Database error: {}", e))
    })?;
    
    // Start scrapers for any InfoSource nodes that don't have active scrapers
    for node in &nodes {
        if let models::node::NodeType::InfoSource(ref source_type) = node.node_type {
            // Check if scraper is already running
            let already_running = state.active_scrapers.lock().await.contains_key(&node.id);
            
            if !already_running {
                info!("Starting scraper for existing node: {} ({:?})", node.id, source_type);
                
                let db = state.db.clone();
                let node_id = node.id.clone();
                let source_type = source_type.clone();
                let config = node.metadata.clone();
                let window_clone = window.clone();
                let network_metrics = state.ws_manager.network_metrics();
                
                match scraper::spawn_scraper(
                    node_id.clone(),
                    source_type,
                    config,
                    db,
                    window_clone,
                    network_metrics,
                ).await {
                    Ok(handle) => {
                        state.active_scrapers.lock().await.insert(node_id, handle);
                    }
                    Err(e) => {
                        eprintln!("Failed to start scraper for node {}: {}", node.id, e);
                    }
                }
            }
        }
    }
    
    Ok(nodes)
}

/// Update data source configuration
#[tauri::command]
async fn update_data_source_cmd(
    node_id: String,
    config: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<models::node::Node, String> {
    info!("Updating data source: {}", node_id);
    
    // Fetch existing node from database
    let mut node = tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::get_node_by_id(&conn, &node_id)
            .map_err(|e| format!("Database error: {}", e))
    })?;
    
    // Update metadata with new config
    node.metadata = config.clone();
    
    // Save updated node to database
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::update_node(&conn, &node)
            .map_err(|e| format!("Database error: {}", e))
    })?;
    
    // If this is a WebSocket scraper with storage_interval_seconds, update it
    if let Some(storage_interval_ms) = config.get("storageIntervalMs").and_then(|v| v.as_u64()) {
        // Check if there's an active scraper for this node
        let scrapers = state.active_scrapers.lock().await;
        if let Some(handle) = scrapers.get(&node_id) {
            // Send command to update storage interval if the scraper supports it
            if let Some(ref command_tx) = handle.command_tx {
                use crate::services::websocket_scraper::ScraperCommand;
                if let Err(e) = command_tx.send(ScraperCommand::SetStorageInterval(storage_interval_ms)).await {
                    eprintln!("Failed to update storage interval: {}", e);
                } else {
                    info!("Updated storage interval for {} to {}ms", node_id, storage_interval_ms);
                }
            }
        }
    }
    
    Ok(node)
}

/// Get scraper health status
#[tauri::command]
async fn get_data_source_status_cmd(
    node_id: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    // TODO: Query scraper statistics
    Ok(serde_json::json!({
        "node_id": node_id,
        "active": true,
        "last_update": chrono::Utc::now().timestamp(),
        "data_points_collected": 1234,
    }))
}

/// Add a generic node to the database (for demo nodes and persistence)
/// This command saves a node without starting any scraper
#[tauri::command]
async fn add_node_cmd(
    node_id: String,
    node_type: String,
    node_subtype: String,
    position_x: f64,
    position_y: f64,
    metadata: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    info!("Adding node: {} ({}/{})", node_id, node_type, node_subtype);
    
    // Parse node type
    let node_type = match node_type.as_str() {
        "InfoSource" => {
            let info_type = match node_subtype.as_str() {
                "CryptoPrices" => models::node::InfoSourceType::CryptoPrices,
                "NewsSource" => models::node::InfoSourceType::NewsSource,
                "Weather" => models::node::InfoSourceType::Weather,
                "SocialMedia" => models::node::InfoSourceType::SocialMedia,
                "FinancialPrices" => models::node::InfoSourceType::FinancialPrices,
                "CommodityPrices" => models::node::InfoSourceType::CommodityPrices,
                "Livestream" => models::node::InfoSourceType::Livestream,
                _ => return Err(format!("Unknown InfoSource type: {}", node_subtype)),
            };
            models::node::NodeType::InfoSource(info_type)
        }
        "Market" => {
            let market_type = match node_subtype.as_str() {
                "Polymarket" => models::node::MarketType::Polymarket,
                "Kalshi" => models::node::MarketType::Kalshi,
                _ => return Err(format!("Unknown Market type: {}", node_subtype)),
            };
            models::node::NodeType::Market(market_type)
        }
        "Analyzer" => {
            let analyzer_type = match node_subtype.as_str() {
                "Correlation" => models::analyzer_node::AnalyzerType::Correlation,
                "Momentum" => models::analyzer_node::AnalyzerType::Momentum,
                "Arbitrage" => models::analyzer_node::AnalyzerType::Arbitrage,
                "Sentiment" => models::analyzer_node::AnalyzerType::Sentiment,
                "RSI" => models::analyzer_node::AnalyzerType::RSI,
                "Volatility" => models::analyzer_node::AnalyzerType::Volatility,
                "Custom" => models::analyzer_node::AnalyzerType::Custom,
                _ => return Err(format!("Unknown Analyzer type: {}", node_subtype)),
            };
            models::node::NodeType::Analyzer(analyzer_type)
        }
        _ => return Err(format!("Unknown node type: {}", node_type)),
    };
    
    // Parse metadata JSON
    let metadata: serde_json::Value = serde_json::from_str(&metadata)
        .unwrap_or(serde_json::json!({}));
    
    // Create node
    let node = models::node::Node {
        id: node_id.clone(),
        node_type,
        position: (position_x, position_y),
        size: None,
        connections: vec![],
        metadata,
    };
    
    // Save to database
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::insert_node(&conn, &node)
            .map_err(|e| format!("Database error: {}", e))
    })?;
    
    info!("Node saved to database: {}", node_id);
    
    Ok(serde_json::json!({
        "success": true,
        "node_id": node_id
    }))
}

// -------------------------------------------------------------------------
// Connection Commands
// -------------------------------------------------------------------------

/// Add a connection between two nodes (persisted to SQLite)
#[tauri::command]
async fn add_connection_cmd(
    source: String,
    target: String,
    strength: f64,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    info!("Adding connection: {} -> {} (strength: {})", source, target, strength);
    
    let connection_id = uuid::Uuid::new_v4().to_string();
    
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::insert_connection(&conn, &connection_id, &source, &target, strength, None, None)
            .map_err(|e| format!("Database error: {}", e))
    })?;
    
    Ok(serde_json::json!({
        "id": connection_id,
        "source": source,
        "target": target,
        "strength": strength,
    }))
}

/// Remove a connection between two nodes
#[tauri::command]
async fn remove_connection_cmd(
    source: String,
    target: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    info!("Removing connection: {} -> {}", source, target);
    
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::delete_connection(&conn, &source, &target)
            .map_err(|e| format!("Database error: {}", e))
    })?;
    
    Ok(())
}

/// Get all connections (for restoring graph on startup)
#[tauri::command]
async fn get_all_connections_cmd(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let connections = tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::get_all_connections(&conn)
            .map_err(|e| format!("Database error: {}", e))
    })?;
    
    let result: Vec<serde_json::Value> = connections.into_iter().map(|(source, target, strength)| {
        serde_json::json!({
            "source": source,
            "target": target,
            "strength": strength,
        })
    }).collect();
    
    Ok(result)
}

// -------------------------------------------------------------------------
// Market Commands
// -------------------------------------------------------------------------

/// Add a new market connection
#[tauri::command]
async fn add_market_cmd(
    market_type: String,
    api_credentials: serde_json::Value,
    market_config: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<models::node::Node, String> {
    info!("Adding market connection: {:?}", market_type);
    
    // Parse market type
    let market_type_enum = match market_type.as_str() {
        "Polymarket" => models::node::MarketType::Polymarket,
        "Kalshi" => models::node::MarketType::Kalshi,
        _ => return Err(format!("Unknown market type: {}", market_type)),
    };
    
    // Extract market_id from config if present
    let market_id = market_config.get("market_id")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    
    // Extract market question/title for display
    let question = market_config.get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    
    // Extract token_ids for Polymarket CLOB orderbook subscription
    let token_ids: Vec<String> = market_config.get("token_ids")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    
    // Create node in database
    let node = tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        let node = models::node::Node {
            id: uuid::Uuid::new_v4().to_string(),
            node_type: models::node::NodeType::Market(market_type_enum.clone()),
            position: (200.0, 200.0), // Default position
            size: None,
            connections: vec![],
            metadata: serde_json::json!({
                "api_credentials": api_credentials,
                "market_config": market_config,
                "market_id": market_id,
                "question": question,
                "token_ids": token_ids,
                "status": "connected",
                "connected_at": chrono::Utc::now().to_rfc3339(),
            }),
        };
        
        if let Err(e) = sqlite::insert_node(&conn, &node) {
            return Err(format!("Database error: {}", e));
        }
        Ok(node)
    })?;
    
    info!("Market node created: {}", node.id);
    
    // TODO: 
    // 1. Validate API credentials with market
    // 2. Establish WebSocket connection
    // 3. Start market listener task
    
    Ok(node)
}

/// Remove market connection
#[tauri::command]
async fn remove_market_cmd(
    node_id: String,
    state: State<'_, AppState>,
) -> Result<sqlite::DeleteNodeStats, String> {
    info!("Removing market connection: {}", node_id);
    
    // Delete node and all associated data (cascade delete)
    let stats = tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::delete_node_cascade(&conn, &node_id)
            .map_err(|e| format!("Database error: {}", e))
    })?;
    
    // TODO: Close WebSocket connection if active
    
    info!("Market node removed: {} (deleted {} timeseries, {} websocket messages, {} connections, {} positions)", 
        node_id, stats.timeseries_deleted, stats.websocket_messages_deleted, stats.connections_deleted, stats.positions_deleted);
    
    Ok(stats)
}

/// Get all connected markets
#[tauri::command]
async fn get_markets_cmd(
    state: State<'_, AppState>,
    window: tauri::Window,
) -> Result<Vec<models::node::Node>, String> {
    // Filter nodes by Market type
    let all_nodes = get_data_sources_cmd(state, window).await?;
    Ok(all_nodes.into_iter()
        .filter(|n| matches!(n.node_type, models::node::NodeType::Market(_)))
        .collect())
}

/// Get current orderbook for a market
#[tauri::command]
async fn get_orderbook_cmd(
    market_id: String,
    state: State<'_, AppState>,
) -> Result<models::market::Orderbook, String> {
    // TODO: Fetch from cache or API
    // Dummy data for testing:
    Ok(models::market::Orderbook {
        market_id,
        bids: vec![[0.52, 1000.0], [0.51, 500.0]],
        asks: vec![[0.53, 800.0], [0.54, 1200.0]],
        timestamp: chrono::Utc::now().timestamp(),
        liquidity: 25000.0,
        spread: 0.01,
        last_price: Some(0.52),
        last_size: Some(100.0),
        last_trade_at: Some(chrono::Utc::now().timestamp()),
        sequence: 1,
    })
}

/// Refresh market WebSocket connection
#[tauri::command]
async fn refresh_market_connection_cmd(
    node_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    info!("Refreshing market connection: {}", node_id);
    
    // TODO: Reconnect WebSocket
    
    Ok(())
}

/// Search for markets on Polymarket or Kalshi
#[tauri::command]
async fn search_markets_cmd(
    platform: String,
    query: String,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<commands::MarketSearchResponse, String> {
    info!("Searching {} markets for: {} (limit={:?}, cursor={:?})", platform, query, limit, cursor);
    markets::search_markets(platform, query, limit, cursor).await
}

// -------------------------------------------------------------------------
// Trading Commands
// -------------------------------------------------------------------------

/// Place a trade order
#[tauri::command]
async fn place_order_cmd(
    market_id: String,
    side: String, // "buy" or "sell"
    size: f64,
    price: Option<f64>,
    order_type: String, // "limit" or "market"
    state: State<'_, AppState>,
) -> Result<models::market::TradeResult, String> {
    // TODO:
    // 1. Validate inputs
    // 2. Check balance
    // 3. Send to market API
    // 4. Record position
    // 5. Return result
    
    // Dummy implementation
    Ok(models::market::TradeResult {
        trade_id: uuid::Uuid::new_v4().to_string(),
        market_id,
        side: if side == "buy" { models::market::TradeSide::Buy } else { models::market::TradeSide::Sell },
        order_type: if order_type == "limit" { 
            models::market::OrderType::Limit(price.unwrap_or(0.5)) 
        } else { 
            models::market::OrderType::Market 
        },
        requested_size: size,
        filled_size: size,
        avg_price: price.unwrap_or(0.5),
        fees_paid: size * price.unwrap_or(0.5) * 0.02, // 2% fee
        status: "filled".to_string(),
        timestamp: chrono::Utc::now().timestamp(),
        metadata: serde_json::json!({}),
    })
}

/// Get all trading positions
#[tauri::command]
async fn get_positions_cmd(
    market_id: Option<String>,
    status: Option<String>, // "open", "closed", "all"
    state: State<'_, AppState>,
) -> Result<Vec<models::position::Position>, String> {
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::get_positions(&conn, market_id.as_deref(), status.as_deref())
            .map_err(|e| format!("Database error: {}", e))
    })
}

/// Close an existing position
#[tauri::command]
async fn close_position_cmd(
    position_id: String,
    exit_price: Option<f64>,
    state: State<'_, AppState>,
) -> Result<models::market::TradeResult, String> {
    // TODO: Place closing order, update position
    Err("Not implemented".to_string())
}

/// Get trade history
#[tauri::command]
async fn get_trade_history_cmd(
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    // TODO: Query trade history
    Ok(vec![])
}

// -------------------------------------------------------------------------
// Multi-Leg Trading Commands
// -------------------------------------------------------------------------
//
// These commands support multi-outcome (categorical) markets and coordinated
// multi-leg order execution (OCO, bracket, spread). See the architecture
// documentation in src-tauri/src/commands/trading.rs for details.
// -------------------------------------------------------------------------

/// Place a multi-leg order (OCO, bracket, spread, or single)
///
/// Frontend: await invoke('place_multi_leg_order_cmd', {
///   legs: [{ market_id, side, size, ... }],
///   orderType: 'spread',
///   timeInForce: 'GTC',
///   strategyLabel: 'My spread'
/// })
#[tauri::command]
async fn place_multi_leg_order_cmd(
    legs: Vec<trading::OrderLegInput>,
    order_type: String,
    time_in_force: Option<String>,
    strategy_label: Option<String>,
    state: State<'_, trading::TradingState>,
) -> Result<crate::models::market::MultiLegTradeResult, String> {
    trading::place_multi_leg_order(legs, order_type, time_in_force, strategy_label, state).await
}

/// Get multi-leg positions with optional filtering
///
/// Frontend: await invoke('get_multi_leg_positions_cmd', {
///   statusFilter: 'open',
///   strategyFilter: 'arbitrage'
/// })
#[tauri::command]
async fn get_multi_leg_positions_cmd(
    status_filter: Option<String>,
    strategy_filter: Option<String>,
    state: State<'_, trading::TradingState>,
) -> Result<Vec<crate::models::position::MultiLegPosition>, String> {
    trading::get_multi_leg_positions(status_filter, strategy_filter, state).await
}

/// Close all legs of a multi-leg position
///
/// Frontend: await invoke('close_multi_leg_position_cmd', {
///   positionId: 'uuid',
///   exitPrices: { 'leg-id': 0.55 }
/// })
#[tauri::command]
async fn close_multi_leg_position_cmd(
    position_id: String,
    exit_prices: Option<std::collections::HashMap<String, f64>>,
    state: State<'_, trading::TradingState>,
) -> Result<crate::models::position::MultiLegPosition, String> {
    trading::close_multi_leg_position(position_id, exit_prices, state).await
}

/// Close a single leg within a multi-leg position
///
/// Frontend: await invoke('close_position_leg_cmd', {
///   positionId: 'uuid',
///   legId: 'leg-uuid',
///   exitPrice: 0.55
/// })
#[tauri::command]
async fn close_position_leg_cmd(
    position_id: String,
    leg_id: String,
    exit_price: Option<f64>,
    state: State<'_, trading::TradingState>,
) -> Result<crate::models::position::MultiLegPosition, String> {
    trading::close_position_leg(position_id, leg_id, exit_price, state).await
}

/// Get a specific multi-leg position by ID
///
/// Frontend: await invoke('get_multi_leg_position_cmd', { positionId: 'uuid' })
#[tauri::command]
async fn get_multi_leg_position_cmd(
    position_id: String,
    state: State<'_, trading::TradingState>,
) -> Result<crate::models::position::MultiLegPosition, String> {
    trading::get_multi_leg_position(position_id, state).await
}

// -------------------------------------------------------------------------
// Storage Commands
// -------------------------------------------------------------------------

/// Store time-series data point
#[tauri::command]
async fn store_timeseries_cmd(
    source_id: String,
    metric_type: String,
    value: f64,
    metadata: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::insert_timeseries(&conn, &source_id, &metric_type, value, metadata)
            .map_err(|e| format!("Database error: {}", e))
    })
}

/// Query time-series data
#[tauri::command]
async fn query_timeseries_cmd(
    source_id: Option<String>,
    metric_type: Option<String>,
    start_time: Option<i64>,
    end_time: Option<i64>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<sqlite::TimeseriesPoint>, String> {
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::query_timeseries(&conn, source_id.as_deref(), metric_type.as_deref(), 
                                start_time, end_time, limit)
            .map_err(|e| format!("Database error: {}", e))
    })
}

/// Get correlation between two data sources
#[tauri::command]
async fn get_correlation_data_cmd(
    source_a: String,
    source_b: String,
    hours: Option<i64>,
    state: State<'_, AppState>,
) -> Result<f64, String> {
    // TODO: Calculate Pearson correlation from time-series data
    // Dummy: return random correlation
    Ok(0.75)
}

/// Get storage statistics
#[tauri::command]
async fn get_storage_stats_cmd(
    state: State<'_, AppState>,
) -> Result<sqlite::DatabaseStats, String> {
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::get_database_stats(&conn)
            .map_err(|e| format!("Database error: {}", e))
    })
}

/// Get node stored data
#[tauri::command]
async fn get_node_stored_data_cmd(
    node_id: String,
    limit: Option<i32>,
    state: State<'_, AppState>,
) -> Result<crate::commands::storage::NodeStoredData, String> {
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        
        // Get timeseries data
        let mut stmt = conn.prepare(
            "SELECT timestamp, source_id, metric_type, value, metadata 
             FROM timeseries 
             WHERE source_id = ? 
             ORDER BY timestamp DESC 
             LIMIT ?"
        ).map_err(|e| e.to_string())?;
        
        let timeseries: Vec<crate::commands::storage::DataPoint> = stmt.query_map(
            params![node_id, limit.unwrap_or(100)],
            |row| {
                let metadata_str: Option<String> = row.get(4)?;
                let metadata = metadata_str.as_ref().and_then(|s| serde_json::from_str(s).ok());
                
                Ok(crate::commands::storage::DataPoint {
                    timestamp: row.get(0)?,
                    source_id: row.get(1)?,
                    metric: row.get(2)?,
                    value: row.get(3)?,
                    metadata,
                })
            }
        ).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        
        // Get websocket messages
        let mut stmt = conn.prepare(
            "SELECT id, timestamp, node_id, message_type, payload, processed 
             FROM websocket_messages 
             WHERE node_id = ? 
             ORDER BY timestamp DESC 
             LIMIT ?"
        ).map_err(|e| e.to_string())?;
        
        let websocket_messages: Vec<crate::commands::storage::WebsocketMessage> = stmt.query_map(
            params![node_id, limit.unwrap_or(100)],
            |row| {
                let payload_str: String = row.get(4)?;
                let payload = serde_json::from_str(&payload_str).unwrap_or(serde_json::json!(null));
                
                Ok(crate::commands::storage::WebsocketMessage {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    node_id: row.get(2)?,
                    message_type: row.get(3)?,
                    payload,
                    processed: row.get::<_, i32>(5)? != 0,
                })
            }
        ).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        
        // Get available metrics
        let mut stmt = conn.prepare(
            "SELECT DISTINCT metric_type FROM timeseries WHERE source_id = ?"
        ).map_err(|e| e.to_string())?;
        
        let available_metrics: Vec<String> = stmt.query_map(
            params![node_id],
            |row| row.get(0)
        ).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
        
        // Get statistics
        let (total_points, oldest_timestamp, newest_timestamp) = conn.query_row(
            "SELECT COUNT(*), MIN(timestamp), MAX(timestamp) FROM timeseries WHERE source_id = ?",
            params![node_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                ))
            }
        ).map_err(|e| e.to_string())?;
        
        Ok(crate::commands::storage::NodeStoredData {
            timeseries,
            websocket_messages,
            available_metrics,
            total_points,
            oldest_timestamp,
            newest_timestamp,
        })
    })
}

/// Delete stored data for a node
#[tauri::command]
async fn delete_node_stored_data_cmd(
    node_id: String,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        
        // Delete timeseries data
        let ts_count = conn.execute(
            "DELETE FROM timeseries WHERE source_id = ?",
            params![node_id]
        ).map_err(|e| e.to_string())?;
        
        // Delete websocket messages
        let ws_count = conn.execute(
            "DELETE FROM websocket_messages WHERE node_id = ?",
            params![node_id]
        ).map_err(|e| e.to_string())?;
        
        Ok(ts_count + ws_count)
    })
}

// -------------------------------------------------------------------------
// System Commands
// -------------------------------------------------------------------------

/// Get system information
#[tauri::command]
async fn get_system_info_cmd() -> Result<serde_json::Value, String> {
    use sysinfo::CpuExt;
    
    let mut guard = get_system_monitor();
    if let Some(ref mut sys) = *guard {
        // First refresh initializes CPU tracking baseline
        sys.refresh_all();
        // Second refresh provides actual CPU usage reading
        sys.refresh_all();
        
        return Ok(serde_json::json!({
            "hostname": sys.host_name().unwrap_or_else(|| "unknown".to_string()),
            "os": sys.name().unwrap_or_else(|| "unknown".to_string()),
            "cpu_usage": sys.global_cpu_info().cpu_usage(),
            "memory_used": sys.used_memory(),
            "memory_total": sys.total_memory(),
        }));
    }
    
    Err("System monitor not initialized".to_string())
}

/// Get network bandwidth metrics
#[tauri::command]
async fn get_network_metrics_cmd(state: State<'_, OrderbookState>) -> Result<NetworkMetricsSnapshot, String> {
    let metrics = state.ws_manager.get_network_metrics();
    Ok(metrics)
}

/// Get database statistics
#[tauri::command]
async fn get_database_stats_cmd(
    state: State<'_, AppState>,
) -> Result<sqlite::DatabaseStats, String> {
    get_storage_stats_cmd(state).await
}

/// Vacuum database (maintenance)
#[tauri::command]
async fn vacuum_database_cmd(
    state: State<'_, AppState>,
) -> Result<(), String> {
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::vacuum_database(&conn)
            .map_err(|e| format!("Database error: {}", e))
    })
}

// -------------------------------------------------------------------------
// Utility Commands (for frontend error handling)
// -------------------------------------------------------------------------

/// Log frontend error to backend
#[tauri::command]
async fn log_frontend_error(
    message: String,
    stack: Option<String>,
) -> Result<(), String> {
    log::error!("Frontend error: {}", message);
    if let Some(stack) = stack {
        log::error!("Stack trace: {}", stack);
    }
    Ok(())
}

/// Report error from error boundary
#[tauri::command]
async fn report_error(
    error: String,
    stack: Option<String>,
    component_stack: Option<String>,
) -> Result<(), String> {
    log::error!("React error boundary: {}", error);
    if let Some(stack) = stack {
        log::error!("Stack: {}", stack);
    }
    if let Some(component_stack) = component_stack {
        log::error!("Component stack: {}", component_stack);
    }
    Ok(())
}

/// Restart the application
#[tauri::command]
async fn restart_app(
    app: tauri::AppHandle,
) -> Result<(), String> {
    log::info!("Restart requested");
    app.restart();
}

/// Frontend ready notification
#[tauri::command]
async fn frontend_ready() -> Result<(), String> {
    log::info!("Frontend ready notification received");
    Ok(())
}

// -------------------------------------------------------------------------
// Orderbook Commands
// -------------------------------------------------------------------------

/// Subscribe to orderbook updates for a market (legacy)
#[tauri::command]
async fn subscribe_orderbook_cmd(
    platform: String,
    market_id: String,
    app_handle: tauri::AppHandle,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    info!("Subscribing to {} orderbook for market: {}", platform, market_id);
    orderbook::subscribe_orderbook_cmd(platform, market_id, app_handle, state).await
}

/// Subscribe to Polymarket market updates using the ws/market endpoint
/// This uses a different subscription format (assets_ids + type: "market")
#[tauri::command]
async fn subscribe_polymarket_market_cmd(
    asset_ids: Vec<String>,
    app_handle: tauri::AppHandle,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    info!("Subscribing to Polymarket market for {} assets", asset_ids.len());
    orderbook::subscribe_polymarket_market_cmd(asset_ids, app_handle, state).await
}

/// Unsubscribe from orderbook updates (legacy)
#[tauri::command]
async fn unsubscribe_orderbook_cmd(
    market_id: String,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    info!("Unsubscribing from orderbook for market: {}", market_id);
    orderbook::unsubscribe_orderbook_cmd(market_id, state).await
}

/// Get active orderbook subscriptions (legacy)
#[tauri::command]
async fn get_orderbook_subscriptions_cmd(
    state: State<'_, OrderbookState>,
) -> Result<Vec<orderbook::SubscriptionInfo>, String> {
    orderbook::get_orderbook_subscriptions_cmd(state).await
}

/// Unsubscribe from all orderbooks (legacy)
#[tauri::command]
async fn unsubscribe_all_orderbooks_cmd(
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    info!("Unsubscribing from all orderbooks");
    orderbook::unsubscribe_all_orderbooks_cmd(state).await
}

/// Reconnect a stale orderbook connection (legacy)
#[tauri::command]
async fn reconnect_orderbook_cmd(
    market_id: String,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    info!("Reconnecting orderbook for market: {}", market_id);
    orderbook::reconnect_orderbook_cmd(market_id, state).await
}

/// Subscribe to Kalshi orderbook with authentication (legacy)
#[tauri::command]
async fn subscribe_kalshi_orderbook_auth_cmd(
    market_id: String,
    api_key: String,
    private_key_pem: String,
    demo: bool,
    app_handle: tauri::AppHandle,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    info!("Subscribing to Kalshi orderbook with auth for market: {}", market_id);
    orderbook::subscribe_kalshi_orderbook_with_auth_cmd(market_id, api_key, private_key_pem, demo, app_handle, state).await
}

// -------------------------------------------------------------------------
// Consolidated WebSocket Commands (NEW)
// -------------------------------------------------------------------------

/// Subscribe to orderbook using consolidated stream manager
#[tauri::command]
async fn subscribe_consolidated_cmd(
    platform: String,
    market_id: String,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    info!("[Consolidated] Subscribing to {} for market: {}", platform, market_id);
    orderbook::subscribe_consolidated_cmd(platform, market_id, state).await
}

/// Unsubscribe from consolidated stream
#[tauri::command]
async fn unsubscribe_consolidated_cmd(
    platform: String,
    market_id: String,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    info!("[Consolidated] Unsubscribing from {} for market: {}", platform, market_id);
    orderbook::unsubscribe_consolidated_cmd(platform, market_id, state).await
}

/// Get consolidated subscriptions grouped by platform
#[tauri::command]
async fn get_consolidated_subscriptions_cmd(
    state: State<'_, OrderbookState>,
) -> Result<Vec<orderbook::ConsolidatedSubscriptionInfo>, String> {
    orderbook::get_consolidated_subscriptions_cmd(state).await
}

/// Unsubscribe from all markets on a platform
#[tauri::command]
async fn unsubscribe_platform_cmd(
    platform: String,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    info!("[Consolidated] Unsubscribing from all {} markets", platform);
    orderbook::unsubscribe_platform_cmd(platform, state).await
}

/// Set Kalshi credentials for authenticated WebSocket
#[tauri::command]
async fn set_kalshi_credentials_cmd(
    api_key: String,
    private_key_pem: String,
    demo: bool,
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    info!("Setting Kalshi credentials");
    orderbook::set_kalshi_credentials_cmd(api_key, private_key_pem, demo, state).await
}

/// Clear Kalshi credentials
#[tauri::command]
async fn clear_kalshi_credentials_cmd(
    state: State<'_, OrderbookState>,
) -> Result<String, String> {
    info!("Clearing Kalshi credentials");
    orderbook::clear_kalshi_credentials_cmd(state).await
}

// -------------------------------------------------------------------------
// Persistent Orderbook Monitoring Commands (ALWAYS-ON)
// -------------------------------------------------------------------------
//
// These commands manage the persistent orderbook monitoring service that
// maintains subscriptions to ALL active market nodes at all times.
// Orderbook data is centrally cached and available to all UI components
// without requiring per-component subscriptions.
// -------------------------------------------------------------------------

/// Start persistent orderbook monitoring for a market node
///
/// Called automatically when a market node is added to the graph.
/// Subscribes via the consolidated WebSocket manager.
///
/// Frontend: await invoke('monitor_market_orderbook_cmd', {
///   nodeId: 'node-uuid',
///   marketId: 'token-id-or-ticker',
///   platform: 'polymarket'
/// })
#[tauri::command]
async fn monitor_market_orderbook_cmd(
    node_id: String,
    market_id: String,
    platform: String,
    state: State<'_, PersistentOrderbookState>,
) -> Result<String, String> {
    info!(
        "[PersistentOrderbook] Starting monitoring for node {} (market: {}, platform: {})",
        node_id, market_id, platform
    );
    state
        .subscribe_market(&node_id, &market_id, &platform)
        .await?;
    Ok(format!(
        "OrderBook monitoring started for {} on {}",
        market_id, platform
    ))
}

/// Stop persistent orderbook monitoring for a market node
///
/// Called when a market node is removed from the graph.
///
/// Frontend: await invoke('unmonitor_market_orderbook_cmd', { nodeId: 'node-uuid' })
#[tauri::command]
async fn unmonitor_market_orderbook_cmd(
    node_id: String,
    state: State<'_, PersistentOrderbookState>,
) -> Result<String, String> {
    info!(
        "[PersistentOrderbook] Stopping monitoring for node {}",
        node_id
    );
    state.unsubscribe_market(&node_id).await?;
    Ok(format!("OrderBook monitoring stopped for node {}", node_id))
}

/// Get cached orderbook for a specific market
///
/// Returns the current cached orderbook data without creating a subscription.
///
/// Frontend: await invoke('get_cached_orderbook_cmd', { marketId: 'token-id' })
#[tauri::command]
async fn get_cached_orderbook_cmd(
    market_id: String,
    state: State<'_, PersistentOrderbookState>,
) -> Result<Option<crate::services::persistent_orderbook::CachedOrderbook>, String> {
    Ok(state.get_orderbook(&market_id).await)
}

/// Get monitoring summary (all markets status)
///
/// Frontend: await invoke('get_orderbook_monitoring_summary_cmd')
#[tauri::command]
async fn get_orderbook_monitoring_summary_cmd(
    state: State<'_, PersistentOrderbookState>,
) -> Result<crate::services::persistent_orderbook::MonitoringSummary, String> {
    Ok(state.get_summary().await)
}

// -------------------------------------------------------------------------
// WebSocket Commands (Stub implementations for frontend compatibility)
// -------------------------------------------------------------------------

/// Reconnect a WebSocket channel (stub implementation)
#[tauri::command]
async fn reconnect_websocket_cmd(channel: String) -> Result<(), String> {
    info!("WebSocket reconnect requested for channel: {}", channel);
    // TODO: Implement actual WebSocket reconnection logic
    Ok(())
}

/// Disconnect a WebSocket channel (stub implementation)
#[tauri::command]
async fn disconnect_websocket_cmd(channel: String) -> Result<(), String> {
    info!("WebSocket disconnect requested for channel: {}", channel);
    // TODO: Implement actual WebSocket disconnection logic
    Ok(())
}

// -------------------------------------------------------------------------
// Order Management Commands (Stub implementations for frontend compatibility)
// -------------------------------------------------------------------------

/// Modify an existing order (stub implementation)
#[tauri::command]
async fn modify_order_cmd(
    position_id: String,
    updates: serde_json::Value,
) -> Result<(), String> {
    info!("Modify order requested for position: {} with updates: {:?}", position_id, updates);
    // TODO: Implement actual order modification logic
    Ok(())
}

/// Cancel an order (stub implementation)
#[tauri::command]
async fn cancel_order_cmd(order_id: String) -> Result<(), String> {
    info!("Cancel order requested for order: {}", order_id);
    // TODO: Implement actual order cancellation logic
    Ok(())
}

/// Get balance for a market (stub implementation)
#[tauri::command]
async fn get_balance_cmd(market: String) -> Result<f64, String> {
    info!("Get balance requested for market: {}", market);
    // TODO: Implement actual balance retrieval logic
    Ok(0.0)
}

// -------------------------------------------------------------------------
// API Key Commands
// -------------------------------------------------------------------------

/// Save API key for a platform
#[tauri::command]
async fn save_api_key_cmd(
    request: api_keys::SaveApiKeyRequest,
) -> Result<(), String> {
    api_keys::save_api_key_command(request).await
}

/// Get API key for a platform
#[tauri::command]
async fn get_api_key_cmd(
    platform: String,
) -> Result<api_keys::ApiKeyResponse, String> {
    api_keys::get_api_key_command(platform).await
}

/// Get all API keys (summary only)
#[tauri::command]
async fn get_all_api_keys_cmd() -> Result<Vec<api_keys::ApiKeySummary>, String> {
    api_keys::get_all_api_keys_command().await
}

/// Delete API key for a platform
#[tauri::command]
async fn delete_api_key_cmd(
    platform: String,
) -> Result<bool, String> {
    api_keys::delete_api_key_command(platform).await
}

/// Check if API key exists for a platform
#[tauri::command]
async fn has_api_key_cmd(
    platform: String,
) -> Result<bool, String> {
    api_keys::has_api_key_command(platform).await
}

/// Get list of platforms with configured API keys
#[tauri::command]
async fn get_configured_platforms_cmd() -> Result<Vec<String>, String> {
    api_keys::get_configured_platforms_command().await
}

// -------------------------------------------------------------------------
// Analyzer Commands
// -------------------------------------------------------------------------

/// Create an analyzer attached to a node
#[tauri::command]
async fn create_analyzer_cmd(
    request: analyzers::CreateAnalyzerRequest,
    state: State<'_, AppState>,
) -> Result<models::analyzer_node::AnalyzerNode, String> {
    info!("Creating analyzer: {} for node {}", request.name, request.node_id);
    analyzers::create_analyzer(state.db.clone(), request).await
}

/// Update an analyzer's configuration
#[tauri::command]
async fn update_analyzer_cmd(
    request: analyzers::UpdateAnalyzerRequest,
    state: State<'_, AppState>,
) -> Result<(), String> {
    info!("Updating analyzer: {}", request.analyzer_id);
    analyzers::update_analyzer(state.db.clone(), request).await
}

/// Delete an analyzer
#[tauri::command]
async fn delete_analyzer_cmd(
    analyzer_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    info!("Deleting analyzer: {}", analyzer_id);
    analyzers::delete_analyzer(state.db.clone(), analyzer_id).await
}

/// Get all analyzers for a node
#[tauri::command]
async fn get_node_analyzers_cmd(
    node_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<models::analyzer_node::AnalyzerNode>, String> {
    analyzers::get_node_analyzers(state.db.clone(), node_id).await
}

/// Get analyzer results
#[tauri::command]
async fn get_analyzer_results_cmd(
    analyzer_id: String,
    start_time: Option<i64>,
    end_time: Option<i64>,
    limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<Vec<models::analyzer_node::AnalyzerResult>, String> {
    analyzers::get_analyzer_results(state.db.clone(), analyzer_id, start_time, end_time, limit).await
}

/// Get a single analyzer by ID
#[tauri::command]
async fn get_analyzer_cmd(
    analyzer_id: String,
    state: State<'_, AppState>,
) -> Result<Option<models::analyzer_node::AnalyzerNode>, String> {
    analyzers::get_analyzer(state.db.clone(), analyzer_id).await
}

/// Toggle analyzer enabled/disabled
#[tauri::command]
async fn toggle_analyzer_cmd(
    analyzer_id: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    info!("Toggling analyzer {} to {}", analyzer_id, enabled);
    analyzers::toggle_analyzer(state.db.clone(), analyzer_id, enabled).await
}

/// Create an analyzer chain
#[tauri::command]
async fn create_chain_cmd(
    request: analyzers::CreateChainRequest,
    state: State<'_, AppState>,
) -> Result<models::analyzer_node::AnalyzerChain, String> {
    info!("Creating chain: {} -> {}", request.source_analyzer_id, request.target_analyzer_id);
    analyzers::create_chain(state.db.clone(), request).await
}

/// Delete an analyzer chain
#[tauri::command]
async fn delete_chain_cmd(
    chain_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    info!("Deleting chain: {}", chain_id);
    analyzers::delete_chain(state.db.clone(), chain_id).await
}

/// Get all chains for a node
#[tauri::command]
async fn get_node_chains_cmd(
    node_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<models::analyzer_node::AnalyzerChain>, String> {
    analyzers::get_node_chains(state.db.clone(), node_id).await
}

/// Get available analyzer types with defaults
#[tauri::command]
async fn get_analyzer_types_cmd() -> Result<Vec<serde_json::Value>, String> {
    Ok(analyzers::get_analyzer_types())
}

// -------------------------------------------------------------------------
// Remote Access Commands
// -------------------------------------------------------------------------
// These commands manage the remote desktop gateway feature, allowing
// the trading terminal to be accessed from remote devices via a WebSocket
// relay server.
//
// Architecture:
//   [Remote Device] <--WS Relay--> [Home Desktop (this app)] <---> [Market APIs]
//
// Features added:
//   - enable_remote_access_cmd: Connect to relay, begin accepting remotes
//   - disable_remote_access_cmd: Disconnect relay and all remote sessions
//   - get_remote_status_cmd: Current gateway status snapshot
//   - generate_pairing_code_cmd: Create 6-digit code for device enrollment
//   - revoke_remote_device_cmd: Revoke paired device access
//   - get_paired_devices_cmd: List paired devices (sans auth tokens)
//   - update_relay_config_cmd: Change relay server URL/settings
// -------------------------------------------------------------------------

/// Enable remote access and connect to the relay server.
///
/// Frontend: await invoke('enable_remote_access_cmd', { request: { relayUrl: 'wss://...', ... } })
#[tauri::command]
async fn enable_remote_access_cmd(
    request: commands::remote::EnableRemoteRequest,
    state: State<'_, AppState>,
) -> Result<models::remote::RemoteStatus, String> {
    remote::enable_remote_access(request, state.remote_manager.clone()).await
}

/// Disable remote access and disconnect all remote devices.
///
/// Frontend: await invoke('disable_remote_access_cmd')
#[tauri::command]
async fn disable_remote_access_cmd(
    state: State<'_, AppState>,
) -> Result<(), String> {
    remote::disable_remote_access(state.remote_manager.clone()).await
}

/// Get the current status of the remote gateway.
///
/// Frontend: await invoke('get_remote_status_cmd')
#[tauri::command]
async fn get_remote_status_cmd(
    state: State<'_, AppState>,
) -> Result<models::remote::RemoteStatus, String> {
    remote::get_remote_status(state.remote_manager.clone()).await
}

/// Generate a new pairing code for device enrollment.
///
/// Frontend: await invoke('generate_pairing_code_cmd')
#[tauri::command]
async fn generate_pairing_code_cmd(
    state: State<'_, AppState>,
) -> Result<(), String> {
    remote::generate_pairing_code(state.remote_manager.clone()).await
}

/// Revoke a paired device's access and disconnect it.
///
/// Frontend: await invoke('revoke_remote_device_cmd', { deviceId: '...' })
#[tauri::command]
async fn revoke_remote_device_cmd(
    device_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    remote::revoke_remote_device(device_id, state.remote_manager.clone()).await
}

/// Get all paired devices (without sensitive auth tokens).
///
/// Frontend: await invoke('get_paired_devices_cmd')
#[tauri::command]
async fn get_paired_devices_cmd(
    state: State<'_, AppState>,
) -> Result<Vec<commands::remote::PairedDeviceSummary>, String> {
    remote::get_paired_devices(state.remote_manager.clone()).await
}

/// Update the relay server configuration.
///
/// Frontend: await invoke('update_relay_config_cmd', { request: { relayUrl: 'wss://...', ... } })
#[tauri::command]
async fn update_relay_config_cmd(
    request: commands::remote::EnableRemoteRequest,
    state: State<'_, AppState>,
) -> Result<models::remote::RemoteStatus, String> {
    remote::update_relay_config(request, state.remote_manager.clone()).await
}