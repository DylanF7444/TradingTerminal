// ============================================================================
// DATA SOURCES COMMAND HANDLERS
// ============================================================================
//
// Purpose: Tauri command handlers for managing information source nodes.
//
// Bridges the frontend UI and backend scraping services, handling the full
// lifecycle of data sources (crypto, financial, commodity prices, news,
// social media, weather, livestreams).
//
// COMMANDS:
//   add_data_source        - Create node, store in DB, spawn scraper task
//   remove_data_source     - Stop scraper, archive node (soft delete)
//   get_data_sources       - Retrieve all active (non-archived) sources
//   update_data_source     - Update config, restart scraper
//   get_data_source_status - Health metrics (active, last_update, errors, uptime)
//
// STATE:
//   ACTIVE_SCRAPERS: HashMap<node_id, JoinHandle> protected by Arc<Mutex>
//   for tracking and graceful shutdown of background scraper tasks.
//
// Scraper tasks run on the Tokio async runtime. Database operations use
// SQLite with WAL mode. All commands return Result<T, String> for Tauri IPC.
// ============================================================================

use crate::models::node::{Node, NodeType, InfoSourceType};
use crate::AppState;
use tauri::State;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::LazyLock;
use tokio::sync::Mutex;

// Dummy storage for active scrapers (in real implementation, this would be more sophisticated)
static ACTIVE_SCRAPERS: LazyLock<Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>> = 
    LazyLock::new(|| Arc::new(Mutex::new(HashMap::new())));

/// Add a new data source and start scraping
#[tauri::command]
pub async fn add_data_source(
    source_type: InfoSourceType,
    config: serde_json::Value,
) -> Result<Node, String> {
    // Generate unique ID for the node
    let node_id = uuid::Uuid::new_v4().to_string();
    
    // Create the node structure
    let node = Node {
        id: node_id.clone(),
        node_type: NodeType::InfoSource(source_type.clone()),
        position: (0.0, 0.0),
        size: None,
        connections: vec![],
        metadata: config.clone(),
    };
    
    // Store node in database
    store_node_in_db(&node).await
        .map_err(|e| format!("Failed to store node: {}", e))?;
    
    // Start the scraping service based on source type
    let scraper_handle = start_scraper_service(
        node_id.clone(),
        source_type,
        config
    ).await.map_err(|e| format!("Failed to start scraper: {}", e))?;
    
    // Store the scraper handle for later cleanup
    let mut scrapers = ACTIVE_SCRAPERS.lock().await;
    scrapers.insert(node_id.clone(), scraper_handle);
    
    // Log the addition
    log_data_source_event(&node_id, "added").await;
    
    Ok(node)
}

/// Remove a data source and stop its scraping service
#[tauri::command]
pub async fn remove_data_source(id: String) -> Result<(), String> {
    // Stop the scraping service
    stop_scraper_service(&id).await
        .map_err(|e| format!("Failed to stop scraper: {}", e))?;
    
    // Archive the node data (keep historical data but mark as inactive)
    archive_node_in_db(&id).await
        .map_err(|e| format!("Failed to archive node: {}", e))?;
    
    // Remove from active scrapers
    let mut scrapers = ACTIVE_SCRAPERS.lock().await;
    if let Some(handle) = scrapers.remove(&id) {
        handle.abort();
    }
    
    // Log the removal
    log_data_source_event(&id, "removed").await;
    
    Ok(())
}

/// Get all active data sources and start their scrapers
#[tauri::command]
pub async fn get_data_sources() -> Result<Vec<Node>, String> {
    let nodes = fetch_active_nodes_from_db().await
        .map_err(|e| format!("Failed to fetch data sources: {}", e))?;
    
    // Start scrapers for each InfoSource node
    for node in &nodes {
        if let NodeType::InfoSource(source_type) = &node.node_type {
            let node_id = node.id.clone();
            let source_type = source_type.clone();
            let config = node.metadata.clone();
            
            match start_scraper_service(node_id.clone(), source_type.clone(), config).await {
                Ok(handle) => {
                    let mut scrapers = ACTIVE_SCRAPERS.lock().await;
                    scrapers.insert(node_id.clone(), handle);
                    println!("Started scraper for node {}", node_id);
                }
                Err(e) => {
                    eprintln!("Failed to start scraper for node {}: {}", node_id, e);
                }
            }
        }
    }
    
    Ok(nodes)
}

/// Update data source configuration
#[tauri::command]
pub async fn update_data_source(
    id: String,
    config: serde_json::Value,
) -> Result<Node, String> {
    // Fetch existing node
    let mut node = fetch_node_from_db(&id).await
        .map_err(|e| format!("Failed to fetch node: {}", e))?;
    
    // Update metadata
    node.metadata = config.clone();
    
    // Update in database
    update_node_in_db(&node).await
        .map_err(|e| format!("Failed to update node: {}", e))?;
    
    // Restart scraper with new config
    stop_scraper_service(&id).await.ok();
    
    if let NodeType::InfoSource(source_type) = &node.node_type {
        let scraper_handle = start_scraper_service(
            id.clone(),
            source_type.clone(),
            config
        ).await.map_err(|e| format!("Failed to restart scraper: {}", e))?;
        
        let mut scrapers = ACTIVE_SCRAPERS.lock().await;
        scrapers.insert(id.clone(), scraper_handle);
    }
    
    log_data_source_event(&id, "updated").await;
    
    Ok(node)
}

/// Get the status of a data source (active, error, last update time, etc.)
#[tauri::command]
pub async fn get_data_source_status(id: String) -> Result<serde_json::Value, String> {
    let status = fetch_scraper_status(&id).await
        .map_err(|e| format!("Failed to fetch status: {}", e))?;
    
    Ok(json!({
        "id": id,
        "active": status.active,
        "last_update": status.last_update,
        "error": status.error,
        "data_points_collected": status.data_points_collected,
        "uptime_seconds": status.uptime_seconds,
    }))
}

/// Update the position of a node on the canvas
/// This is called during drag operations to persist position changes
#[tauri::command]
pub async fn update_node_position_cmd(
    id: String,
    position: [f64; 2],
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Get database connection from app state
    let conn = state.db.lock().await;

    // Fetch existing node
    let mut node = crate::db::get_node_by_id(&conn, &id)
        .map_err(|e| format!("Failed to get node: {}", e))?;

    // Update position
    node.position = (position[0], position[1]);

    // Save to database
    crate::db::update_node(&conn, &node)
        .map_err(|e| format!("Failed to update node position: {}", e))?;

    Ok(())
}

/// Update the size of a node on the canvas
/// This is called during resize operations to persist size changes
#[tauri::command]
pub async fn update_node_size_cmd(
    id: String,
    size: (f64, Option<f64>),
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Get database connection from app state
    let conn = state.db.lock().await;

    // Fetch existing node
    let mut node = crate::db::get_node_by_id(&conn, &id)
        .map_err(|e| format!("Failed to get node: {}", e))?;

    // Update size
    node.size = Some(size);

    // Save to database
    crate::db::update_node(&conn, &node)
        .map_err(|e| format!("Failed to update node size: {}", e))?;

    Ok(())
}

// ============================================================================
// DUMMY DATABASE METHODS
// These would be implemented in db/sqlite.rs in a real application
// ============================================================================

async fn store_node_in_db(node: &Node) -> Result<(), anyhow::Error> {
    // Dummy implementation
    // In real code: INSERT INTO nodes (id, type, position_x, position_y, metadata) VALUES (?, ?, ?, ?, ?)
    println!("DB: Storing node {} with type {:?}", node.id, node.node_type);
    Ok(())
}

async fn archive_node_in_db(id: &str) -> Result<(), anyhow::Error> {
    // Dummy implementation
    // In real code: UPDATE nodes SET archived = true, archived_at = ? WHERE id = ?
    println!("DB: Archiving node {}", id);
    Ok(())
}

async fn fetch_active_nodes_from_db() -> Result<Vec<Node>, anyhow::Error> {
    // Dummy implementation
    // In real code: SELECT * FROM nodes WHERE archived = false
    println!("DB: Fetching all active nodes");
    Ok(vec![
        Node {
            id: "dummy-node-1".to_string(),
            node_type: NodeType::InfoSource(InfoSourceType::CryptoPrices),
            position: (100.0, 100.0),
            size: None,
            connections: vec![],
            metadata: json!({
                "symbols": ["BTC", "ETH"],
                "update_interval_seconds": 5
            }),
        },
        Node {
            id: "dummy-node-2".to_string(),
            node_type: NodeType::InfoSource(InfoSourceType::NewsSource),
            position: (300.0, 100.0),
            size: None,
            connections: vec![],
            metadata: json!({
                "sources": ["reuters", "ap"],
                "keywords": ["election", "politics"]
            }),
        }
    ])
}

async fn fetch_node_from_db(id: &str) -> Result<Node, anyhow::Error> {
    // Dummy implementation
    // In real code: SELECT * FROM nodes WHERE id = ?
    println!("DB: Fetching node {}", id);
    Ok(Node {
        id: id.to_string(),
        node_type: NodeType::InfoSource(InfoSourceType::CryptoPrices),
        position: (100.0, 100.0),
        size: None,
        connections: vec![],
        metadata: json!({
            "symbols": ["BTC"],
            "update_interval_seconds": 5
        }),
    })
}

async fn update_node_in_db(node: &Node) -> Result<(), anyhow::Error> {
    // Dummy implementation
    // In real code: UPDATE nodes SET metadata = ?, position_x = ?, position_y = ? WHERE id = ?
    println!("DB: Updating node {}", node.id);
    Ok(())
}

// ============================================================================
// DUMMY SCRAPER SERVICE METHODS
// These would be implemented in services/scraper.rs in a real application
// ============================================================================

async fn start_scraper_service(
    node_id: String,
    source_type: InfoSourceType,
    config: serde_json::Value,
) -> Result<tokio::task::JoinHandle<()>, anyhow::Error> {
    println!("Scraper: Starting service for node {} ({:?})", node_id, source_type);
    
    // Spawn a background task that would do the actual scraping
    let handle = tokio::spawn(async move {
        // In real implementation, this would be a loop that:
        // 1. Fetches data from external API
        // 2. Stores in database
        // 3. Emits WebSocket event to frontend
        // 4. Sleeps for configured interval
        
        match source_type {
            InfoSourceType::CryptoPrices => {
                println!("Scraper Task: Would poll CoinGecko API for {:?}", config);
                // scraper::crypto::poll_prices(node_id, config).await;
            },
            InfoSourceType::NewsSource => {
                println!("Scraper Task: Would poll RSS feeds for {:?}", config);
                // scraper::news::poll_feeds(node_id, config).await;
            },
            InfoSourceType::Weather => {
                println!("Scraper Task: Would poll weather API for {:?}", config);
                // scraper::weather::poll_weather(node_id, config).await;
            },
            InfoSourceType::SocialMedia => {
                println!("Scraper Task: Would poll Twitter/Reddit API for {:?}", config);
                // scraper::social::poll_social_media(node_id, config).await;
            },
            InfoSourceType::Livestream => {
                println!("Scraper Task: Would monitor livestream for {:?}", config);
                // scraper::livestream::monitor_stream(node_id, config).await;
            },
            InfoSourceType::FinancialPrices => {
                println!("Scraper Task: Would poll stock/forex API for {:?}", config);
                // scraper::finance::poll_prices(node_id, config).await;
            },
            InfoSourceType::CommodityPrices => {
                println!("Scraper Task: Would poll commodity API for {:?}", config);
                // scraper::commodities::poll_prices(node_id, config).await;
            },
            InfoSourceType::EconomicIndicators => {
                println!("Scraper Task: Would poll economic indicators for {:?}", config);
            },
            InfoSourceType::OnChainData => {
                println!("Scraper Task: Would poll on-chain data for {:?}", config);
            },
            InfoSourceType::PolymarketUserTrades => {
                println!("Scraper Task: Would poll Polymarket user trades for {:?}", config);
            },
        }
        
        // Simulate continuous scraping
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            println!("Scraper Task [{}]: Scraping tick...", node_id);
        }
    });
    
    Ok(handle)
}

async fn stop_scraper_service(node_id: &str) -> Result<(), anyhow::Error> {
    println!("Scraper: Stopping service for node {}", node_id);
    
    // In real implementation:
    // 1. Send shutdown signal to scraper task
    // 2. Wait for graceful shutdown
    // 3. Clean up resources (close HTTP connections, etc.)
    
    Ok(())
}

#[derive(Debug)]
struct ScraperStatus {
    active: bool,
    last_update: Option<String>,
    error: Option<String>,
    data_points_collected: u64,
    uptime_seconds: u64,
}

async fn fetch_scraper_status(node_id: &str) -> Result<ScraperStatus, anyhow::Error> {
    println!("Scraper: Fetching status for node {}", node_id);
    
    // In real implementation:
    // 1. Check if scraper task is still running
    // 2. Query database for last update timestamp
    // 3. Get error logs if any
    // 4. Count data points in timeseries table
    
    Ok(ScraperStatus {
        active: true,
        last_update: Some("2026-01-26T10:30:00Z".to_string()),
        error: None,
        data_points_collected: 1234,
        uptime_seconds: 3600,
    })
}

// ============================================================================
// DUMMY LOGGING METHODS
// ============================================================================

async fn log_data_source_event(node_id: &str, event_type: &str) {
    // In real implementation: INSERT INTO event_log (node_id, event_type, timestamp) VALUES (?, ?, ?)
    println!("Logger: Node {} {}", node_id, event_type);
}

/// Get curated social media sources organized by prediction market category
#[tauri::command]
pub async fn get_curated_social_sources() -> Result<serde_json::Value, String> {
    Ok(crate::services::scraper::get_curated_social_sources())
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_add_crypto_data_source() {
        let config = json!({
            "symbols": ["BTC", "ETH"],
            "update_interval_seconds": 5
        });
        
        let result = add_data_source(InfoSourceType::CryptoPrices, config).await;
        assert!(result.is_ok());
        
        let node = result.unwrap();
        assert_eq!(node.connections.len(), 0);
        assert!(matches!(node.node_type, NodeType::InfoSource(InfoSourceType::CryptoPrices)));
    }

    #[tokio::test]
    async fn test_remove_data_source() {
        let result = remove_data_source("test-node-id".to_string()).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_data_sources() {
        let result = get_data_sources().await;
        assert!(result.is_ok());
        
        let sources = result.unwrap();
        assert_eq!(sources.len(), 2); // From dummy implementation
    }

    #[tokio::test]
    async fn test_update_data_source() {
        let new_config = json!({
            "symbols": ["BTC", "ETH", "SOL"],
            "update_interval_seconds": 10
        });
        
        let result = update_data_source("test-node-id".to_string(), new_config).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_get_data_source_status() {
        let result = get_data_source_status("test-node-id".to_string()).await;
        assert!(result.is_ok());
        
        let status = result.unwrap();
        assert_eq!(status["active"], true);
        assert_eq!(status["data_points_collected"], 1234);
    }
}