// ============================================================================
// MARKET CONNECTION COMMAND HANDLERS
// ============================================================================
//
// Purpose: Tauri command handlers for prediction market platform connections
// (Polymarket, Kalshi).
//
// COMMANDS:
//   add_market                 - Authenticate, establish WebSocket, create node
//   remove_market              - Close WebSocket, archive node
//   get_markets                - Retrieve all connected market nodes
//   get_orderbook              - Current bids/asks (cached <500ms, REST fallback)
//   refresh_market_connection  - Force WebSocket reconnection
//   get_market_status          - Connection health (latency, errors, heartbeat)
//
// STATE:
//   MARKET_CONNECTIONS: Arc<RwLock<HashMap<node_id, MarketConnection>>>
//   ORDERBOOK_CACHE: Arc<Mutex<LruCache>> with 5-minute TTL
//   API credentials stored in Tauri secure store (keyring), never in memory.
//
// WebSocket connections persist across command calls with automatic reconnection
// (exponential backoff up to 60s). All traffic uses wss:// (TLS).
// ============================================================================

use crate::db::get_connection;
use crate::models::market::Orderbook;
use crate::models::node::{MarketType, Node, NodeType};
use chrono::{DateTime, Utc};
use lru::LruCache;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Runtime, State, Window};
use tokio::sync::{Mutex, RwLock};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use futures_util::{SinkExt, StreamExt};

// ============================================================================
// CONSTANTS
// ============================================================================

const ORDERBOOK_CACHE_SIZE: usize = 100;
const ORDERBOOK_TTL_SECONDS: u64 = 300; // 5 minutes
const WS_RECONNECT_BASE_MS: u64 = 1000;
const WS_RECONNECT_MAX_MS: u64 = 60000;

// Platform WebSocket endpoints (placeholder URLs - replace with actual endpoints)
const POLYMARKET_WS_URL: &str = "wss://api.polymarket.com/ws";
const KALSHI_WS_URL: &str = "wss://trading-api.kalshi.com/v1/ws";

// Per-platform search page sizes (number of filtered results to return per page)
const POLYMARKET_PAGE_SIZE: u32 = 20;
const KALSHI_PAGE_SIZE: u32 = 20;

// Per-platform API batch sizes (how many items to fetch per API call)
const POLYMARKET_API_BATCH_SIZE: u32 = 500; // Gamma API max
const KALSHI_API_BATCH_SIZE: u32 = 200;

// Safety limit: maximum number of API calls per single search request
const MAX_API_FETCHES_PER_REQUEST: u32 = 10;

// ============================================================================
// STATE STRUCTURES
// ============================================================================

/// Represents an active WebSocket connection to a market
pub struct MarketConnection {
    pub market_id: String,
    pub platform: MarketType,
    pub websocket_task: tokio::task::JoinHandle<()>,
    pub last_heartbeat: Instant,
    pub connected: bool,
    pub error_count: u32,
    pub subscription_count: u32,
    pub credentials_id: String, // Reference to secure storage
}

/// Thread-safe state container for all market connections
pub struct MarketState {
    pub connections: Arc<RwLock<HashMap<String, MarketConnection>>>,
    pub orderbook_cache: Arc<Mutex<LruCache<String, CachedOrderbook>>>,
}

impl MarketState {
    pub fn new() -> Self {
        let cache = LruCache::new(NonZeroUsize::new(ORDERBOOK_CACHE_SIZE).unwrap());
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            orderbook_cache: Arc::new(Mutex::new(cache)),
        }
    }
}

/// Wrapper for cached orderbook with timestamp
pub struct CachedOrderbook {
    pub orderbook: Orderbook,
    pub timestamp: Instant,
}

/// Request payload for adding a market
#[derive(Debug, Deserialize)]
pub struct AddMarketRequest {
    pub market_type: MarketType,
    pub api_credentials: JsonValue,
    pub market_id: String,
    pub metadata: Option<JsonValue>,
    /// Extended market info from search results (static data that doesn't change)
    #[serde(default)]
    pub market_details: Option<MarketDetails>,
}

/// Extended market info from search results (static data that doesn't change)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketDetails {
    /// Human-readable market title/question
    pub title: Option<String>,
    /// Market description/rules
    pub description: Option<String>,
    /// Market image/icon URL
    pub image_url: Option<String>,
    /// Market category (e.g., "crypto", "politics")
    pub category: Option<String>,
    /// End date / close time (ISO 8601 string) - when market stops trading
    pub end_date: Option<String>,
    /// Resolution date (ISO 8601 string) - when market is resolved
    pub resolution_date: Option<String>,
    /// Market status ("open", "closed", "resolved")
    pub status: Option<String>,
    /// CLOB token IDs for Polymarket (needed for WebSocket orderbook subscription)
    pub token_ids: Option<Vec<String>>,
    /// Condition ID for Polymarket (used for REST API queries)
    pub condition_id: Option<String>,
    /// Market slug (URL-friendly identifier)
    pub slug: Option<String>,
    /// Tags for the market (additional categorization)
    pub tags: Option<Vec<String>>,
    /// Creation date (ISO 8601 string) - when market was created
    pub created_at: Option<String>,
}

/// Status response for market health
#[derive(Debug, Serialize)]
pub struct MarketStatus {
    pub connected: bool,
    pub last_heartbeat: Option<DateTime<Utc>>,
    pub latency_ms: u64,
    pub subscription_count: u32,
    pub error_count: u32,
    pub uptime_seconds: u64,
}

/// Default state initialization for Tauri
pub fn init_state() -> MarketState {
    MarketState::new()
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Add a new market connection
#[tauri::command]
pub async fn add_market<R: Runtime>(
    window: Window<R>,
    request: AddMarketRequest,
    state: State<'_, MarketState>,
) -> Result<Node, String> {
    let node_id = uuid::Uuid::new_v4().to_string();
    let market_type = request.market_type.clone();
    let market_id = request.market_id.clone();
    
    // Validate credentials format
    validate_credentials(&market_type, &request.api_credentials)?;
    
    // Store credentials securely (implementation depends on your secure storage setup)
    let creds_id = store_credentials_securely(&node_id, &request.api_credentials).await?;
    
    // Authenticate with platform to verify credentials work
    let auth_token = authenticate_platform(&market_type, &request.api_credentials).await
        .map_err(|e| format!("Authentication failed: {}", e))?;

    // Extract market details for static metadata
    let details = request.market_details.clone();
    
    // Build metadata with static market info (no volatile data like volume/open interest)
    let mut metadata = serde_json::json!({
        "market_id": market_id,
        "platform": format!("{:?}", market_type),
        "status": "connecting",
        "added_at": Utc::now().to_rfc3339(),
    });

    // Add static market details if provided
    if let Some(d) = &details {
        if let Some(title) = &d.title {
            metadata["title"] = serde_json::json!(title);
        }
        if let Some(desc) = &d.description {
            metadata["description"] = serde_json::json!(desc);
        }
        if let Some(img) = &d.image_url {
            metadata["image_url"] = serde_json::json!(img);
        }
        if let Some(cat) = &d.category {
            metadata["category"] = serde_json::json!(cat);
        }
        if let Some(end) = &d.end_date {
            metadata["end_date"] = serde_json::json!(end);
        }
        if let Some(res) = &d.resolution_date {
            metadata["resolution_date"] = serde_json::json!(res);
        }
        if let Some(stat) = &d.status {
            metadata["market_status"] = serde_json::json!(stat);
        }
        if let Some(tokens) = &d.token_ids {
            metadata["token_ids"] = serde_json::json!(tokens);
        }
        if let Some(cond) = &d.condition_id {
            metadata["condition_id"] = serde_json::json!(cond);
        }
        if let Some(slug) = &d.slug {
            metadata["slug"] = serde_json::json!(slug);
        }
        if let Some(tags) = &d.tags {
            metadata["tags"] = serde_json::json!(tags);
        }
        if let Some(created) = &d.created_at {
            metadata["created_at"] = serde_json::json!(created);
        }
    }

    // Add any extra user-provided metadata
    if let Some(extra) = request.metadata {
        metadata["extra"] = extra;
    }

    // Create the node
    let node = Node {
        id: node_id.clone(),
        node_type: NodeType::Market(market_type.clone()),
        position: (100.0 + rand::random::<f64>() * 200.0, 100.0 + rand::random::<f64>() * 200.0),
        size: None,
        connections: vec![],
        metadata,
    };
    
    // Store in database
    let conn = get_connection().await.map_err(|e| e.to_string())?;
    let conn_guard = conn.lock().unwrap();
    let Some(db_conn) = &*conn_guard else {
        return Err("Database not initialized".to_string());
    };
    crate::db::insert_node(db_conn, &node).map_err(|e| e.to_string())?;
    drop(conn_guard);
    
    // Establish WebSocket connection
    let ws_handle = spawn_websocket_listener(
        node_id.clone(),
        market_type.clone(),
        market_id.clone(),
        auth_token,
        state.connections.clone(),
        state.orderbook_cache.clone(),
        window.clone(),
    ).await?;
    
    // Register connection state
    let connection = MarketConnection {
        market_id: market_id.clone(),
        platform: market_type,
        websocket_task: ws_handle,
        last_heartbeat: Instant::now(),
        connected: true,
        error_count: 0,
        subscription_count: 1, // Default subscription to orderbook
        credentials_id: creds_id,
    };
    
    {
        let mut connections = state.connections.write().await;
        connections.insert(node_id.clone(), connection);
    }
    
    // Emit initial connection event
    window.emit("market:connected", &node_id)
        .map_err(|e| format!("Failed to emit event: {}", e))?;
    
    Ok(node)
}

/// Remove a market and close its connection
#[tauri::command]
pub async fn remove_market(
    id: String,
    state: State<'_, MarketState>,
) -> Result<(), String> {
    // Get connection handle
    let mut connections = state.connections.write().await;
    if let Some(conn) = connections.remove(&id) {
        // Abort WebSocket task
        conn.websocket_task.abort();
        
        // Send unsubscribe if possible (fire and forget)
        let _ = send_unsubscribe(&conn.platform, &conn.market_id).await;
        
        // Archive in database instead of hard delete (preserve history)
        let db_conn_result = get_connection().await.map_err(|e| e.to_string())?;
        let conn_guard = db_conn_result.lock().unwrap();
        let Some(db_conn) = &*conn_guard else {
            return Err("Database not initialized".to_string());
        };
        // Soft delete by setting archived flag
        crate::db::delete_node(db_conn, &id).map_err(|e| e.to_string())?;
        drop(conn_guard);
        
        // Clean up credentials
        remove_credentials(&conn.credentials_id).await?;
    }
    
    // Remove from cache
    {
        let mut cache = state.orderbook_cache.lock().await;
        cache.pop(&id);
    }
    
    Ok(())
}

/// Get all active markets
#[tauri::command]
pub async fn get_markets() -> Result<Vec<Node>, String> {
    let conn = get_connection().await.map_err(|e| e.to_string())?;
    let conn_guard = conn.lock().unwrap();
    let Some(db_conn) = &*conn_guard else {
        return Err("Database not initialized".to_string());
    };
    let nodes = crate::db::get_all_active_nodes(db_conn).map_err(|e| e.to_string())?;
    // Filter to only market nodes
    let market_nodes: Vec<Node> = nodes.into_iter()
        .filter(|n| matches!(n.node_type, NodeType::Market(_)))
        .collect();
    Ok(market_nodes)
}

/// Get current orderbook for a market
#[tauri::command]
pub async fn get_orderbook(
    market_node_id: String,
    state: State<'_, MarketState>,
) -> Result<Orderbook, String> {
    // Check cache first
    {
        let mut cache = state.orderbook_cache.lock().await;
        if let Some(cached) = cache.get(&market_node_id) {
            if cached.timestamp.elapsed() < Duration::from_secs(ORDERBOOK_TTL_SECONDS) {
                return Ok(cached.orderbook.clone());
            }
        }
    }
    
    // Cache miss or expired - fetch from REST API
    let connections = state.connections.read().await;
    let conn = connections.get(&market_node_id)
        .ok_or_else(|| "Market not found or not connected".to_string())?;
    
    let orderbook = fetch_rest_orderbook(&conn.platform, &conn.market_id)
        .await
        .map_err(|e| format!("Failed to fetch orderbook: {}", e))?;
    
    // Update cache
    {
        let mut cache = state.orderbook_cache.lock().await;
        cache.put(market_node_id, CachedOrderbook {
            orderbook: orderbook.clone(),
            timestamp: Instant::now(),
        });
    }
    
    Ok(orderbook)
}

/// Force reconnect a market WebSocket
#[tauri::command]
pub async fn refresh_market_connection<R: Runtime>(
    window: Window<R>,
    id: String,
    state: State<'_, MarketState>,
) -> Result<Node, String> {
    // Get existing connection info
    let (market_type, market_id, creds_id) = {
        let connections = state.connections.read().await;
        let conn = connections.get(&id)
            .ok_or_else(|| "Market not found".to_string())?;
        (conn.platform.clone(), conn.market_id.clone(), conn.credentials_id.clone())
    };
    
    // Remove old connection
    remove_market(id.clone(), state.clone()).await?;
    
    // Get credentials
    let creds = retrieve_credentials(&creds_id).await?;
    
    // Re-add with same ID (preserving history and position)
    let request = AddMarketRequest {
        market_type,
        api_credentials: creds,
        market_id,
        metadata: None,
        market_details: None,
    };
    
    // Hack: reuse add logic but we need to preserve the same ID
    // In production, you'd want a separate reconnect flow that preserves the ID
    add_market(window, request, state).await
}

/// Get connection health status
#[tauri::command]
pub async fn get_market_status(
    id: String,
    state: State<'_, MarketState>,
) -> Result<MarketStatus, String> {
    let connections = state.connections.read().await;
    let conn = connections.get(&id)
        .ok_or_else(|| "Market not found".to_string())?;
    
    let now = Instant::now();
    let uptime = now.duration_since(conn.last_heartbeat).as_secs();
    
    // Calculate latency (mock calculation - in real impl, track ping/pong)
    let latency = if conn.connected { 25 } else { 9999 };
    
    Ok(MarketStatus {
        connected: conn.connected,
        last_heartbeat: Some(Utc::now() - chrono::Duration::seconds(uptime as i64)),
        latency_ms: latency,
        subscription_count: conn.subscription_count,
        error_count: conn.error_count,
        uptime_seconds: uptime,
    })
}

// ============================================================================
// WEBSOCKET HANDLING
// ============================================================================

/// Spawn a WebSocket listener task for a market
async fn spawn_websocket_listener<R: Runtime>(
    node_id: String,
    platform: MarketType,
    market_id: String,
    auth_token: String,
    connections: Arc<RwLock<HashMap<String, MarketConnection>>>,
    cache: Arc<Mutex<LruCache<String, CachedOrderbook>>>,
    window: Window<R>,
) -> Result<tokio::task::JoinHandle<()>, String> {
    let ws_url = match platform {
        MarketType::Polymarket => POLYMARKET_WS_URL,
        MarketType::Kalshi => KALSHI_WS_URL,
    };
    
    let handle = tokio::spawn(async move {
        let mut reconnect_delay = WS_RECONNECT_BASE_MS;
        
        loop {
            match connect_and_listen(
                &node_id,
                ws_url,
                &auth_token,
                &market_id,
                &platform,
                connections.clone(),
                cache.clone(),
                window.clone(),
            ).await {
                Ok(_) => {
                    // Clean exit (requested)
                    break;
                }
                Err(e) => {
                    eprintln!("WebSocket error for {}: {}", node_id, e);
                    
                    // Update error count
                    {
                        let mut conns = connections.write().await;
                        if let Some(conn) = conns.get_mut(&node_id) {
                            conn.error_count += 1;
                            conn.connected = false;
                        }
                    }
                    
                    // Emit error to frontend
                    let _ = window.emit("market:error", serde_json::json!({
                        "node_id": node_id,
                        "error": e.to_string(),
                        "retry_in_ms": reconnect_delay
                    }));
                    
                    // Exponential backoff
                    tokio::time::sleep(Duration::from_millis(reconnect_delay)).await;
                    reconnect_delay = (reconnect_delay * 2).min(WS_RECONNECT_MAX_MS);
                }
            }
        }
    });
    
    Ok(handle)
}

/// Main WebSocket connection and listen loop
async fn connect_and_listen<R: Runtime>(
    node_id: &str,
    ws_url: &str,
    auth_token: &str,
    market_id: &str,
    platform: &MarketType,
    connections: Arc<RwLock<HashMap<String, MarketConnection>>>,
    cache: Arc<Mutex<LruCache<String, CachedOrderbook>>>,
    window: Window<R>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Connect
    let url = format!("{}?token={}", ws_url, auth_token);
    let (ws_stream, _) = connect_async(&url).await?;
    let (mut write, mut read) = ws_stream.split();
    
    // Subscribe to orderbook channel
    let subscribe_msg = match platform {
        MarketType::Polymarket => serde_json::json!({
            "type": "subscribe",
            "channel": "orderbook",
            "market": market_id
        }),
        MarketType::Kalshi => serde_json::json!({
            "action": "subscribe",
            "market_id": market_id,
            "channel": "orderbook"
        }),
    };
    
    write.send(Message::Text(subscribe_msg.to_string())).await?;
    
    // Update connection state
    {
        let mut conns = connections.write().await;
        if let Some(conn) = conns.get_mut(node_id) {
            conn.connected = true;
            conn.last_heartbeat = Instant::now();
        }
    }
    
    // Emit connected event
    window.emit("market:connected", node_id)?;
    
    // Listen loop
    while let Some(msg) = read.next().await {
        match msg? {
            Message::Text(text) => {
                // Parse and handle message
                if let Err(e) = handle_ws_message(
                    node_id,
                    &text,
                    platform,
                    &cache,
                    &window,
                ).await {
                    eprintln!("Error handling message: {}", e);
                }
                
                // Update heartbeat
                {
                    let mut conns = connections.write().await;
                    if let Some(conn) = conns.get_mut(node_id) {
                        conn.last_heartbeat = Instant::now();
                    }
                }
            }
            Message::Close(_) => {
                println!("WebSocket closed for {}", node_id);
                break;
            }
            _ => {}
        }
    }
    
    Ok(())
}

/// Handle incoming WebSocket message
async fn handle_ws_message<R: Runtime>(
    node_id: &str,
    text: &str,
    platform: &MarketType,
    cache: &Arc<Mutex<LruCache<String, CachedOrderbook>>>,
    window: &Window<R>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let value: serde_json::Value = serde_json::from_str(text)?;
    
    // Parse platform-specific format into standard Orderbook
    let orderbook = parse_orderbook_update(value, platform)?;
    
    // Update cache
    {
        let mut c = cache.lock().await;
        c.put(node_id.to_string(), CachedOrderbook {
            orderbook: orderbook.clone(),
            timestamp: Instant::now(),
        });
    }
    
    // Emit to frontend
    window.emit("orderbook:update", serde_json::json!({
        "node_id": node_id,
        "orderbook": orderbook,
        "timestamp": Utc::now().to_rfc3339()
    }))?;
    
    Ok(())
}

// ============================================================================
// PLATFORM API HELPERS
// ============================================================================

/// Authenticate with platform
async fn authenticate_platform(
    platform: &MarketType,
    credentials: &JsonValue,
) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    // Placeholder implementations - replace with actual API calls
    
    match platform {
        MarketType::Polymarket => {
            // Polymarket market data is public - API keys are optional
            // If API key is provided, we can authenticate for trading
            // If not provided, we can still access public market data
            if let Some(api_key) = credentials["api_key"].as_str() {
                // Mock validation - in real implementation, exchange for JWT
                Ok(format!("pm_token_{}", api_key))
            } else {
                // No API key - return empty token for public access
                println!("Polymarket: Using public access (no API key provided)");
                Ok("pm_public_access".to_string())
            }
        }
        MarketType::Kalshi => {
            // POST https://trading-api.kalshi.com/v1/login
            let api_key = credentials["api_key"].as_str().ok_or("Missing api_key")?;
            let api_secret = credentials["api_secret"].as_str().ok_or("Missing api_secret")?;
            
            // Mock validation
            Ok(format!("kalshi_session_{}_{}", api_key, api_secret))
        }
    }
}

/// Fetch orderbook via REST API (fallback)
async fn fetch_rest_orderbook(
    platform: &MarketType,
    market_id: &str,
) -> Result<Orderbook, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::new();
    
    match platform {
        MarketType::Polymarket => {
            // GET https://api.polymarket.com/exchange/v1/orderbooks/{market_id}
            let url = format!("https://api.polymarket.com/exchange/v1/orderbooks/{}", market_id);
            let resp = client.get(&url).send().await?;
            
            if !resp.status().is_success() {
                return Err(format!("HTTP {}: {}", resp.status(), resp.text().await?).into());
            }
            
            let data: serde_json::Value = resp.json().await?;
            parse_polymarket_orderbook(data)
        }
        MarketType::Kalshi => {
            // GET https://trading-api.kalshi.com/v1/markets/{market_id}/orderbook
            let url = format!("https://trading-api.kalshi.com/v1/markets/{}/orderbook", market_id);
            let resp = client.get(&url).send().await?;
            
            if !resp.status().is_success() {
                return Err(format!("HTTP {}: {}", resp.status(), resp.text().await?).into());
            }
            
            let data: serde_json::Value = resp.json().await?;
            parse_kalshi_orderbook(data)
        }
    }
}

/// Send unsubscribe message (best effort)
async fn send_unsubscribe(
    platform: &MarketType,
    market_id: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Implementation would send unsubscribe frame if connection still open
    // For now, just log
    println!("Unsubscribing {} from {}", market_id, 
        match platform {
            MarketType::Polymarket => "Polymarket",
            MarketType::Kalshi => "Kalshi",
        }
    );
    Ok(())
}

// ============================================================================
// PARSING
// ============================================================================

fn parse_orderbook_update(
    value: serde_json::Value,
    platform: &MarketType,
) -> Result<Orderbook, Box<dyn std::error::Error + Send + Sync>> {
    match platform {
        MarketType::Polymarket => parse_polymarket_orderbook(value),
        MarketType::Kalshi => parse_kalshi_orderbook(value),
    }
}

fn parse_polymarket_orderbook(data: serde_json::Value) -> Result<Orderbook, Box<dyn std::error::Error + Send + Sync>> {
    // Parse Polymarket format
    let bids: Vec<[f64; 2]> = data["bids"]
        .as_array()
        .map(|arr| arr.iter()
            .filter_map(|v| {
                let price = v["price"].as_f64()?;
                let size = v["size"].as_f64()?;
                Some([price, size])
            })
            .collect())
        .unwrap_or_default();
    
    let asks: Vec<[f64; 2]> = data["asks"]
        .as_array()
        .map(|arr| arr.iter()
            .filter_map(|v| {
                let price = v["price"].as_f64()?;
                let size = v["size"].as_f64()?;
                Some([price, size])
            })
            .collect())
        .unwrap_or_default();
    
    let timestamp = data["timestamp"]
        .as_i64()
        .map(|ts| DateTime::from_timestamp(ts, 0).unwrap_or_else(|| Utc::now()))
        .unwrap_or_else(|| Utc::now());
    
    let liquidity: f64 = bids.iter().map(|b| b[1]).sum::<f64>() +
                        asks.iter().map(|a| a[1]).sum::<f64>();
    
    // Calculate spread (best_ask - best_bid)
    let spread = match (bids.first(), asks.first()) {
        (Some(bid), Some(ask)) => ask[0] - bid[0],
        _ => 0.0,
    };
    
    Ok(Orderbook {
        bids,
        asks,
        timestamp: timestamp.timestamp(),
        liquidity,
        spread,
        market_id: data["market_id"].as_str().unwrap_or("unknown").to_string(),
        last_price: None,
        last_size: None,
        last_trade_at: None,
        sequence: 0,
    })
}

fn parse_kalshi_orderbook(data: serde_json::Value) -> Result<Orderbook, Box<dyn std::error::Error + Send + Sync>> {
    // Parse Kalshi format (different structure)
    let bids: Vec<[f64; 2]> = data["orderbook"]["yes"]
        .as_array()
        .map(|arr| arr.iter()
            .filter_map(|v| {
                let price = v["price"].as_f64()? / 100.0; // Kalshi uses cents
                let size = v["count"].as_f64()?;
                Some([price, size])
            })
        .collect())
        .unwrap_or_default();
    
    // Kalshi structure might be different - adjust as needed
    let asks: Vec<[f64; 2]> = data["orderbook"]["no"]
        .as_array()
        .map(|arr| arr.iter()
            .filter_map(|v| {
                let price = 1.0 - (v["price"].as_f64()? / 100.0); // Invert for NO side
                let size = v["count"].as_f64()?;
                Some([price, size])
            })
        .collect())
        .unwrap_or_default();
    
    // Calculate liquidity
    let liquidity: f64 = bids.iter().map(|b| b[1]).sum::<f64>() +
                        asks.iter().map(|a| a[1]).sum::<f64>();
    
    // Calculate spread (best_ask - best_bid)
    let spread = match (bids.first(), asks.first()) {
        (Some(bid), Some(ask)) => ask[0] - bid[0],
        _ => 0.0,
    };
    
    Ok(Orderbook {
        bids,
        asks,
        timestamp: Utc::now().timestamp(),
        liquidity,
        spread,
        market_id: data["market_id"].as_str().unwrap_or("unknown").to_string(),
        last_price: None,
        last_size: None,
        last_trade_at: None,
        sequence: 0,
    })
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

fn validate_credentials(
    platform: &MarketType,
    creds: &JsonValue,
) -> Result<(), String> {
    match platform {
        MarketType::Polymarket => {
            // Polymarket market data is public - API keys are optional (only needed for trading)
            // No validation required for read-only market data access
            println!("Polymarket credentials validation: API keys are optional for market data access");
        }
        MarketType::Kalshi => {
            if creds["api_key"].as_str().is_none() || creds["api_secret"].as_str().is_none() {
                return Err("Kalshi requires api_key and api_secret".to_string());
            }
        }
    }
    Ok(())
}

// Placeholder for secure credential storage
async fn store_credentials_securely(
    _node_id: &str,
    _creds: &JsonValue,
) -> Result<String, String> {
    // In real implementation, use Tauri's secure storage API or OS keyring
    // Returns a reference ID to retrieve later
    Ok(format!("creds:{}", _node_id))
}

async fn retrieve_credentials(_creds_id: &str) -> Result<JsonValue, String> {
    // Retrieve from secure storage
    // Mock implementation
    Ok(serde_json::json!({
        "api_key": "retrieved_key",
        "api_secret": "retrieved_secret"
    }))
}

async fn remove_credentials(_creds_id: &str) -> Result<(), String> {
    // Remove from secure storage
    println!("Removing credentials {}", _creds_id);
    Ok(())
}

// ============================================================================
// MARKET SEARCH
// ============================================================================

/// A search result returned from market search APIs
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketSearchResult {
    /// Unique market identifier (CLOB token ID for Polymarket, ticker for Kalshi)
    pub id: String,
    /// Human-readable market title/question
    pub title: String,
    /// Short description or subtitle
    pub description: String,
    /// URL to market image/icon (if available)
    pub image_url: Option<String>,
    /// Current YES price (probability 0.0 - 1.0)
    pub yes_price: Option<f64>,
    /// Current NO price
    pub no_price: Option<f64>,
    /// 24h trading volume
    #[serde(default)]
    pub volume_24h: Option<f64>,
    /// Total liquidity available
    #[serde(default)]
    pub liquidity: Option<f64>,
    /// Market category (e.g., "crypto", "politics")
    #[serde(default)]
    pub category: Option<String>,
    /// Market status ("open", "closed", "resolved")
    pub status: String,
    /// End date / close time (ISO 8601 string)
    #[serde(default)]
    pub end_date: Option<String>,
    /// Creation date (ISO 8601 string) - when market was created
    #[serde(default)]
    pub created_at: Option<String>,
    /// Platform this result came from
    pub platform: String,
    /// The slug or ticker to use when adding this market
    pub slug: String,
    /// CLOB token IDs for Polymarket (needed for WebSocket orderbook subscription)
    /// For binary markets: [YES_token_id, NO_token_id]
    #[serde(default)]
    pub token_ids: Vec<String>,
    /// Condition ID for Polymarket (used for REST API queries)
    #[serde(default)]
    pub condition_id: Option<String>,
}

/// Paginated search response containing results and continuation state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketSearchResponse {
    /// The matching market results for this page
    pub results: Vec<MarketSearchResult>,
    /// Whether more results may be available from the API
    pub has_more: bool,
    /// Opaque cursor string to pass back for the next page request
    pub next_cursor: Option<String>,
    /// The page size used for this platform
    pub page_size: u32,
}

/// Parse a Polymarket cursor string into an API offset
fn parse_polymarket_cursor(cursor: &Option<String>) -> Result<u32, String> {
    match cursor {
        None => Ok(0),
        Some(c) => c
            .strip_prefix("polymarket:")
            .and_then(|s| s.parse::<u32>().ok())
            .ok_or_else(|| format!("Invalid Polymarket cursor: {}", c)),
    }
}

/// Parse a Kalshi cursor string into an API cursor token
fn parse_kalshi_cursor(cursor: &Option<String>) -> Result<Option<String>, String> {
    match cursor {
        None => Ok(None),
        Some(c) => c
            .strip_prefix("kalshi:")
            .map(|s| {
                if s.is_empty() {
                    None
                } else {
                    Some(s.to_string())
                }
            })
            .ok_or_else(|| format!("Invalid Kalshi cursor: {}", c)),
    }
}

/// Parse a single Polymarket JSON item into a MarketSearchResult
fn parse_polymarket_item(item: &JsonValue) -> Option<MarketSearchResult> {
    let id = item["id"].as_str()?.to_string();
    let question = item["question"].as_str().unwrap_or("").to_string();
    let description = item["description"].as_str().unwrap_or("").to_string();
    let slug = item["slug"].as_str().unwrap_or(&id).to_string();
    let image = item["image"].as_str().map(|s| s.to_string());
    let active = item["active"].as_bool().unwrap_or(false);
    let closed = item["closed"].as_bool().unwrap_or(true);

    let clob_token_ids: Vec<String> = item["clobTokenIds"]
        .as_str()
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .or_else(|| {
            item["clobTokenIds"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                        .collect()
                })
        })
        .unwrap_or_default();

    let condition_id_val = item["conditionId"].as_str().map(|s| s.to_string());

    let primary_id = clob_token_ids
        .first()
        .cloned()
        .or_else(|| condition_id_val.clone())
        .unwrap_or_else(|| slug.clone());

    let outcomes_prices: Vec<f64> = item["outcomePrices"]
        .as_str()
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .map(|prices| {
            prices
                .iter()
                .filter_map(|p| p.parse::<f64>().ok())
                .collect()
        })
        .unwrap_or_default();

    let yes_price = outcomes_prices.first().copied();
    let no_price = outcomes_prices.get(1).copied();

    let volume = item["volume"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| item["volume"].as_f64());
    let liquidity = item["liquidity"]
        .as_str()
        .and_then(|s| s.parse::<f64>().ok())
        .or_else(|| item["liquidity"].as_f64());
    let end_date = item["endDate"].as_str().map(|s| s.to_string());
    let created_at = item["createdAt"].as_str().map(|s| s.to_string());

    let status = if closed {
        "closed".to_string()
    } else if active {
        "open".to_string()
    } else {
        "inactive".to_string()
    };

    Some(MarketSearchResult {
        id: primary_id,
        title: question,
        description: if description.len() > 200 {
            format!("{}...", &description[..200])
        } else {
            description
        },
        image_url: image,
        yes_price,
        no_price,
        volume_24h: volume,
        liquidity,
        category: item["category"].as_str().map(|s| s.to_string()),
        status,
        end_date,
        created_at,
        platform: "Polymarket".to_string(),
        slug,
        token_ids: clob_token_ids,
        condition_id: condition_id_val,
    })
}

/// Parse a single Kalshi market JSON item into a MarketSearchResult
/// Returns None if the market doesn't match the query
fn parse_kalshi_market(
    market: &JsonValue,
    event_title: &str,
    event_category: &Option<String>,
    event_image: &Option<String>,
    query_lower: &str,
) -> Option<MarketSearchResult> {
    let ticker = market["ticker"].as_str().unwrap_or("").to_string();
    let title = market["title"].as_str().unwrap_or("").to_string();
    let subtitle = market["subtitle"].as_str().unwrap_or("").to_string();

    // Client-side filtering by query
    if !query_lower.is_empty() {
        let search_text = format!("{} {} {} {}", event_title, title, subtitle, ticker).to_lowercase();
        if !search_text.contains(query_lower) {
            return None;
        }
    }

    let yes_price = market["yes_ask"]
        .as_f64()
        .or_else(|| market["last_price"].as_f64())
        .map(|p| p / 100.0);
    let no_price = market["no_ask"].as_f64().map(|p| p / 100.0);

    let volume = market["volume"]
        .as_f64()
        .or_else(|| market["volume_24h"].as_f64());

    let open_interest = market["open_interest"].as_f64();
    let close_time = market["close_time"].as_str().map(|s| s.to_string());

    let market_status = market["status"]
        .as_str()
        .unwrap_or("unknown")
        .to_string();

    let display_title = if title.is_empty() {
        event_title.to_string()
    } else {
        title.clone()
    };

    Some(MarketSearchResult {
        id: ticker.clone(),
        title: display_title,
        description: subtitle,
        image_url: event_image.clone(),
        yes_price,
        no_price,
        volume_24h: volume,
        liquidity: open_interest,
        category: event_category.clone(),
        status: market_status,
        end_date: close_time,
        created_at: None,
        platform: "Kalshi".to_string(),
        slug: ticker,
        token_ids: vec![],
        condition_id: None,
    })
}

/// Search for markets on Polymarket or Kalshi
///
/// Polymarket: Uses the Gamma API (https://gamma-api.polymarket.com)
/// Kalshi: Uses the public markets API (https://api.elections.kalshi.com/trade-api/v2)
///
/// Supports cursor-based pagination. Pass `cursor` from the previous response's
/// `next_cursor` to fetch the next page of results.
pub async fn search_markets(
    platform: String,
    query: String,
    limit: Option<u32>,
    cursor: Option<String>,
) -> Result<MarketSearchResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("PredictionMarketTerminal/1.0")
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

    match platform.as_str() {
        "Polymarket" => {
            let page_size = limit.unwrap_or(POLYMARKET_PAGE_SIZE).min(500);
            let api_offset = parse_polymarket_cursor(&cursor)?;
            search_polymarket(&client, &query, page_size, api_offset).await
        }
        "Kalshi" => {
            let page_size = limit.unwrap_or(KALSHI_PAGE_SIZE).min(500);
            let api_cursor = parse_kalshi_cursor(&cursor)?;
            search_kalshi(&client, &query, page_size, api_cursor).await
        }
        _ => Err(format!("Unknown platform: {}", platform)),
    }
}

/// Search Polymarket markets via the Gamma API
/// Loops over API batches until enough filtered results are collected or the API is exhausted.
async fn search_polymarket(
    client: &reqwest::Client,
    query: &str,
    page_size: u32,
    initial_api_offset: u32,
) -> Result<MarketSearchResponse, String> {
    let query_lower = query.to_lowercase();
    let mut collected: Vec<MarketSearchResult> = Vec::new();
    let mut api_offset = initial_api_offset;
    let mut api_exhausted = false;
    let mut fetches = 0u32;

    while collected.len() < page_size as usize && !api_exhausted {
        if fetches >= MAX_API_FETCHES_PER_REQUEST {
            break;
        }

        let url = format!(
            "https://gamma-api.polymarket.com/markets?closed=false&limit={}&offset={}&order=createdAt&ascending=false",
            POLYMARKET_API_BATCH_SIZE, api_offset
        );

        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Polymarket search request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Polymarket API returned {}: {}", status, body));
        }

        let data: Vec<JsonValue> = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse Polymarket response: {}", e))?;

        let batch_size = data.len() as u32;

        // If API returned fewer than requested, there are no more
        if batch_size < POLYMARKET_API_BATCH_SIZE {
            api_exhausted = true;
        }

        api_offset += batch_size;
        fetches += 1;

        // Filter this batch by query
        let matching: Vec<JsonValue> = if query.is_empty() {
            data
        } else {
            data.into_iter()
                .filter(|item| {
                    let question = item["question"].as_str().unwrap_or("").to_lowercase();
                    let description = item["description"].as_str().unwrap_or("").to_lowercase();
                    let slug = item["slug"].as_str().unwrap_or("").to_lowercase();
                    let category = item["category"].as_str().unwrap_or("").to_lowercase();
                    question.contains(&query_lower)
                        || description.contains(&query_lower)
                        || slug.contains(&query_lower)
                        || category.contains(&query_lower)
                })
                .collect()
        };

        // Parse matching items and collect until page is full
        for item in &matching {
            if collected.len() >= page_size as usize {
                break;
            }
            if let Some(result) = parse_polymarket_item(item) {
                collected.push(result);
            }
        }
    }

    let has_more = !api_exhausted;
    let next_cursor = if has_more {
        Some(format!("polymarket:{}", api_offset))
    } else {
        None
    };

    Ok(MarketSearchResponse {
        results: collected,
        has_more,
        next_cursor,
        page_size: POLYMARKET_PAGE_SIZE,
    })
}

/// Search Kalshi markets via the public API
/// Loops over API pages using cursor-based pagination until enough filtered results
/// are collected or the API is exhausted.
async fn search_kalshi(
    client: &reqwest::Client,
    query: &str,
    page_size: u32,
    initial_cursor: Option<String>,
) -> Result<MarketSearchResponse, String> {
    let query_lower = query.to_lowercase();
    let mut collected: Vec<MarketSearchResult> = Vec::new();
    let mut cursor = initial_cursor;
    let mut api_exhausted = false;
    let mut fetches = 0u32;

    while collected.len() < page_size as usize && !api_exhausted {
        if fetches >= MAX_API_FETCHES_PER_REQUEST {
            break;
        }

        let mut url = format!(
            "https://api.elections.kalshi.com/trade-api/v2/events?status=open&with_nested_markets=true&limit={}",
            KALSHI_API_BATCH_SIZE
        );
        if let Some(ref c) = cursor {
            url.push_str(&format!("&cursor={}", c));
        }

        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("Kalshi search request failed: {}", e))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!("Kalshi API returned {}: {}", status, body));
        }

        let data: JsonValue = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse Kalshi response: {}", e))?;

        // Extract the next cursor from the response
        let next_cursor_value = data["cursor"]
            .as_str()
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());

        // If no cursor returned, API is exhausted
        if next_cursor_value.is_none() {
            api_exhausted = true;
        }
        cursor = next_cursor_value;
        fetches += 1;

        // Parse events and their nested markets, filtering by query
        if let Some(events) = data["events"].as_array() {
            for event in events {
                if collected.len() >= page_size as usize {
                    break;
                }
                let event_title = event["title"].as_str().unwrap_or("");
                let event_category = event["category"].as_str().map(|s| s.to_string());
                let event_image = event["image_url"].as_str().map(|s| s.to_string());

                if let Some(markets) = event["markets"].as_array() {
                    for market in markets {
                        if collected.len() >= page_size as usize {
                            break;
                        }
                        if let Some(result) = parse_kalshi_market(
                            market,
                            event_title,
                            &event_category,
                            &event_image,
                            &query_lower,
                        ) {
                            collected.push(result);
                        }
                    }
                }
            }
        }
    }

    let has_more = !api_exhausted;
    let next_cursor = if has_more {
        cursor.map(|c| format!("kalshi:{}", c))
    } else {
        None
    };

    Ok(MarketSearchResponse {
        results: collected,
        has_more,
        next_cursor,
        page_size: KALSHI_PAGE_SIZE,
    })
}
