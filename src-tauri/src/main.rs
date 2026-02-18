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
};
use crate::db::sqlite::{self, Connection, create_connection, setup_schema, apply_optimizations};
use crate::services::{scraper};
use sysinfo::SystemExt;

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
        .invoke_handler(tauri::generate_handler![
            // Data source commands
            add_data_source_cmd,
            remove_data_source_cmd,
            get_data_sources_cmd,
            update_data_source_cmd,
            get_data_source_status_cmd,
            update_node_position_cmd,
            add_node_cmd,
            
            // Market commands
            add_market_cmd,
            remove_market_cmd,
            get_markets_cmd,
            get_orderbook_cmd,
            refresh_market_connection_cmd,
            
            // Trading commands
            place_order_cmd,
            get_positions_cmd,
            close_position_cmd,
            get_trade_history_cmd,
            
            // Storage commands
            store_timeseries_cmd,
            query_timeseries_cmd,
            get_correlation_data_cmd,
            get_storage_stats_cmd,
            
            // System commands
            get_system_info_cmd,
            get_database_stats_cmd,
            vacuum_database_cmd,
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
    let state = AppState {
        db: Arc::new(Mutex::new(conn)),
        http_client,
        active_scrapers: Arc::new(Mutex::new(std::collections::HashMap::new())),
        analyzer_handle: Arc::new(Mutex::new(None)),
        executor_handle: Arc::new(Mutex::new(None)),
        config: Arc::new(Mutex::new(AppConfig::default())),
    };
    
    // 5. Manage state (accessible to all commands via State<'_, AppState>)
    app.manage(state);
    
    // 6. Start background services (scraper supervisor, analyzer, executor)
    // In a real implementation, these would be started here or on-demand
    tauri::async_runtime::spawn(start_background_services(app.handle().clone()));
    
    info!("Application initialization complete");
    Ok(())
}

/// Background services starter
/// 
/// Spawns analyzer and executor services. Scrapers are started on-demand
/// when users add data sources.
async fn start_background_services(app_handle: tauri::AppHandle) {
    info!("Starting background services...");
    
    let state: State<'_, AppState> = app_handle.state();
    
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
    
    // 4. Database cleanup (VACUUM if needed, close connections)
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
    let scraper_handle = scraper::spawn_scraper(
        node.id.clone(),
        source_type,
        config,
        db,
        window,
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
) -> Result<(), String> {
    info!("Removing data source: {}", node_id);
    
    // Stop scraper
    if let Some(handle) = state.active_scrapers.lock().await.remove(&node_id) {
        scraper::stop_scraper(&handle).await.map_err(|e| e.to_string())?;
    }
    
    // Archive in database (soft delete)
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::delete_node(&conn, &node_id)
            .map_err(|e| format!("Database error: {}", e))
    })?;
    
    Ok(())
}

/// Get all active data sources
#[tauri::command]
async fn get_data_sources_cmd(
    state: State<'_, AppState>,
) -> Result<Vec<models::node::Node>, String> {
    tokio::task::block_in_place(|| {
        let conn = state.db.blocking_lock();
        sqlite::get_all_active_nodes(&conn)
            .map_err(|e| format!("Database error: {}", e))
    })
}

/// Update data source configuration
#[tauri::command]
async fn update_data_source_cmd(
    node_id: String,
    config: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<models::node::Node, String> {
    // TODO: Implement
    // 1. Fetch node from DB
    // 2. Update metadata
    // 3. Restart scraper with new config
    // 4. Return updated node
    Err("Not implemented".to_string())
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
    // TODO: 
    // 1. Validate API credentials with market
    // 2. Establish WebSocket connection
    // 3. Create market node in DB
    // 4. Start market listener task
    Err("Not implemented".to_string())
}

/// Remove market connection
#[tauri::command]
async fn remove_market_cmd(
    node_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // TODO: Close WebSocket, archive node
    Ok(())
}

/// Get all connected markets
#[tauri::command]
async fn get_markets_cmd(
    state: State<'_, AppState>,
) -> Result<Vec<models::node::Node>, String> {
    // Filter nodes by Market type
    let all_nodes = get_data_sources_cmd(state).await?;
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
) -> Result<(), String> {
    // TODO: Reconnect WebSocket
    Ok(())
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