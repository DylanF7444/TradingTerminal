// ============================================================================
// STARTUP SERVICE
// ============================================================================
//
// Module: services/startup.rs
// Purpose: Initialize all nodes, websockets, and scrapers on application startup
//
// OVERVIEW:
// This module handles the automatic initialization of all saved nodes when
// the application starts. It loads nodes from the database and starts their
// associated services (websockets for markets, scrapers for info sources).
//
// FLOW:
// 1. Load all active nodes from database
// 2. For each Market node: Start websocket connection
// 3. For each InfoSource node: Start scraper task
// 4. All data is persisted to the database as it arrives
//
// ============================================================================

use anyhow::Result;
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter};
use chrono::Utc;

use crate::db::sqlite::{Connection, get_all_active_nodes};
use crate::models::node::{Node, NodeType, InfoSourceType, MarketType};
use crate::services::scraper::{spawn_scraper, ScraperHandle};
use crate::services::websocket_manager::{WebSocketManager, PlatformType};
use crate::services::orderbook::KalshiCredentials;

/// Holds all running service handles
pub struct ActiveServices {
    /// Active scraper handles keyed by node ID
    pub scrapers: std::collections::HashMap<String, ScraperHandle>,
    /// WebSocket manager reference
    pub ws_manager: Arc<WebSocketManager>,
}

/// Initialize all services for saved nodes on startup
/// 
/// This is the main entry point called from main.rs setup
pub async fn initialize_saved_nodes(
    db: Arc<Mutex<Connection>>,
    ws_manager: Arc<WebSocketManager>,
    app_handle: AppHandle,
) -> Result<ActiveServices> {
    println!("[Startup] Initializing saved nodes from database...");
    
    // Load all active nodes from database
    let nodes = {
        let conn = db.lock().await;
        get_all_active_nodes(&conn)?
    };
    
    println!("[Startup] Found {} active nodes", nodes.len());
    
    let mut scrapers = std::collections::HashMap::new();
    let mut market_count = 0;
    let mut source_count = 0;
    
    // Process each node
    for node in nodes {
        match &node.node_type {
            NodeType::Market(market_type) => {
                // Start websocket connection for market nodes
                match start_market_websocket(&node, market_type, &ws_manager, &app_handle).await {
                    Ok(_) => {
                        market_count += 1;
                        println!("[Startup] Started websocket for market node: {} ({:?})", node.id, market_type);
                    }
                    Err(e) => {
                        eprintln!("[Startup] Failed to start websocket for {}: {}", node.id, e);
                    }
                }
            }
            NodeType::InfoSource(source_type) => {
                // Start scraper for info source nodes
                match start_info_source_scraper(&node, source_type, &db, &app_handle, &ws_manager).await {
                    Ok(handle) => {
                        source_count += 1;
                        scrapers.insert(node.id.clone(), handle);
                        println!("[Startup] Started scraper for info source node: {} ({:?})", node.id, source_type);
                    }
                    Err(e) => {
                        eprintln!("[Startup] Failed to start scraper for {}: {}", node.id, e);
                    }
                }
            }
        }
    }
    
    println!("[Startup] Initialization complete: {} markets, {} info sources", market_count, source_count);
    
    // Emit startup complete event to frontend
    let _ = app_handle.emit("startup:complete", serde_json::json!({
        "markets_initialized": market_count,
        "sources_initialized": source_count,
        "timestamp": Utc::now().timestamp_millis(),
    }));
    
    Ok(ActiveServices {
        scrapers,
        ws_manager,
    })
}

/// Start websocket connection for a market node
async fn start_market_websocket(
    node: &Node,
    market_type: &MarketType,
    ws_manager: &Arc<WebSocketManager>,
    _app_handle: &AppHandle,
) -> Result<()> {
    // Extract market ID from metadata
    let market_id = node.metadata.get("market_id")
        .or_else(|| node.metadata.get("condition_id"))
        .or_else(|| node.metadata.get("slug"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("No market_id found in metadata for node {}", node.id))?;
    
    // Map market type to platform
    let platform = match market_type {
        MarketType::Polymarket => PlatformType::Polymarket,
        MarketType::Kalshi => PlatformType::Kalshi,
    };
    
    // Subscribe via the websocket manager
    ws_manager.subscribe(platform, market_id.to_string()).await?;
    
    Ok(())
}

/// Start scraper for an info source node
async fn start_info_source_scraper(
    node: &Node,
    source_type: &InfoSourceType,
    db: &Arc<Mutex<Connection>>,
    app_handle: &AppHandle,
    ws_manager: &Arc<WebSocketManager>,
) -> Result<ScraperHandle> {
    use tauri::Manager;
    use tauri::WebviewWindow;
    
    // Get the main window for emitting events
    let window: WebviewWindow = app_handle.get_webview_window("main")
        .ok_or_else(|| anyhow::anyhow!("Main window not found"))?;
    
    // Convert WebviewWindow to Window for the scraper
    let window = window.as_ref().window().clone();
    
    // Spawn the scraper with network metrics
    let network_metrics = ws_manager.network_metrics();
    let handle = spawn_scraper(
        node.id.clone(),
        source_type.clone(),
        node.metadata.clone(),
        db.clone(),
        window,
        network_metrics,
    ).await?;
    
    Ok(handle)
}

/// Stop all services for a specific node
pub async fn stop_node_services(
    node_id: &str,
    node_type: &NodeType,
    services: &mut ActiveServices,
) -> Result<()> {
    match node_type {
        NodeType::Market(market_type) => {
            let platform = match market_type {
                MarketType::Polymarket => PlatformType::Polymarket,
                MarketType::Kalshi => PlatformType::Kalshi,
            };
            services.ws_manager.unsubscribe(platform, node_id).await?;
        }
        NodeType::InfoSource(_) => {
            if let Some(handle) = services.scrapers.remove(node_id) {
                crate::services::scraper::stop_scraper(&handle).await?;
            }
        }
    }
    Ok(())
}

/// Gracefully shutdown all services
pub async fn shutdown_all_services(services: &mut ActiveServices) -> Result<()> {
    println!("[Startup] Shutting down all services...");
    
    // Stop all scrapers
    for (node_id, handle) in services.scrapers.drain() {
        match crate::services::scraper::stop_scraper(&handle).await {
            Ok(_) => println!("[Startup] Stopped scraper for {}", node_id),
            Err(e) => eprintln!("[Startup] Error stopping scraper {}: {}", node_id, e),
        }
    }
    
    // Shutdown all websockets
    services.ws_manager.shutdown().await;
    
    println!("[Startup] All services shut down");
    Ok(())
}

// ============================================================================
// DATA PERSISTENCE FUNCTIONS
// ============================================================================

/// Store a websocket message in the database
pub async fn store_websocket_message(
    db: &Arc<Mutex<Connection>>,
    node_id: &str,
    message_type: &str,
    payload: &serde_json::Value,
) -> Result<()> {
    let conn = db.lock().await;
    
    let timestamp = Utc::now().timestamp_millis();
    let payload_str = serde_json::to_string(payload)?;
    
    conn.execute(
        "INSERT INTO websocket_messages (timestamp, node_id, message_type, payload)
         VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![timestamp, node_id, message_type, payload_str],
    )?;
    
    Ok(())
}

/// Store a scraper data point in the database
pub async fn store_scraper_data(
    db: &Arc<Mutex<Connection>>,
    node_id: &str,
    metric_type: &str,
    value: f64,
    metadata: Option<&serde_json::Value>,
) -> Result<()> {
    let conn = db.lock().await;
    
    let timestamp = Utc::now().timestamp_millis();
    let metadata_str = metadata
        .map(|m| serde_json::to_string(m))
        .transpose()?
        .unwrap_or_else(|| "null".to_string());
    
    conn.execute(
        "INSERT INTO timeseries (timestamp, source_id, metric_type, value, metadata)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![timestamp, node_id, metric_type, value, metadata_str],
    )?;
    
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite::{create_connection, setup_schema, apply_optimizations};
    use tempfile::NamedTempFile;
    
    fn setup_test_db() -> (NamedTempFile, Arc<Mutex<Connection>>) {
        let temp_file = NamedTempFile::new().unwrap();
        let conn = create_connection(temp_file.path()).unwrap();
        setup_schema(&conn).unwrap();
        apply_optimizations(&conn).unwrap();
        (temp_file, Arc::new(Mutex::new(conn)))
    }
    
    #[tokio::test]
    async fn test_store_scraper_data() {
        let (_temp, db) = setup_test_db();
        
        let result = store_scraper_data(
            &db,
            "test-node-1",
            "price",
            50000.0,
            Some(&serde_json::json!({"symbol": "BTC"})),
        ).await;
        
        assert!(result.is_ok());
    }
}
