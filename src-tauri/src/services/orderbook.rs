// ============================================================================
// ORDERBOOK WEBSOCKET SERVICE
// ============================================================================
//
// Purpose: Real-time orderbook streaming from Polymarket and Kalshi.
//
// Manages WebSocket connections to prediction market orderbook feeds.
// Messages are parsed, normalized to a common format, and emitted
// to the frontend via Tauri events.
//
// SUPPORTED PLATFORMS:
//   Polymarket: wss://ws-subscriptions-clob.polymarket.com/ws
//   Kalshi:     wss://api.elections.kalshi.com/trade-api/v2/ws
//
// DATA FLOW:
//   WebSocket Message -> Parse -> Normalize -> Emit Tauri Event -> Frontend
//
// Each subscription spawns a dedicated connection task with auto-reconnect
// (exponential backoff). Parse errors are logged without crashing the connection.
// Stale data (no updates for 30s) triggers reconnection.
// ============================================================================

use anyhow::{Result, Context, anyhow};
use serde::{Serialize, Deserialize};
use serde_json::Value as JsonValue;
use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::{RwLock, mpsc};
use tokio::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use futures_util::{SinkExt, StreamExt};
use tauri::{Emitter, AppHandle};
use chrono::Utc;
use rsa::{RsaPrivateKey, traits::PublicKeyParts};
use rsa::pkcs1::DecodeRsaPrivateKey;
use rsa::pkcs8::DecodePrivateKey;
use sha2::Sha256;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};

// ============================================================================
// TYPES
// ============================================================================

/// Normalized orderbook update sent to frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderbookUpdate {
    /// Market identifier (platform-specific)
    pub market_id: String,
    /// Platform (polymarket or kalshi)
    pub platform: String,
    /// Bid levels: (price, size)
    pub bids: Vec<OrderbookLevel>,
    /// Ask levels: (price, size)
    pub asks: Vec<OrderbookLevel>,
    /// Unix timestamp in milliseconds
    pub timestamp: i64,
    /// Sequence number for ordering
    pub sequence: u64,
    /// Last trade price (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_price: Option<f64>,
    /// Last trade size (if available)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_size: Option<f64>,
}

/// Raw WebSocket message sent to frontend for debugging/display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawWebSocketMessage {
    /// Market identifier (platform-specific)
    pub market_id: String,
    /// Platform (polymarket or kalshi)
    pub platform: String,
    /// Raw JSON message as string
    pub raw_message: String,
    /// Unix timestamp in milliseconds when received
    pub timestamp: i64,
    /// Message type (if determinable)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub msg_type: Option<String>,
}

/// Single orderbook level
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderbookLevel {
    pub price: f64,
    pub size: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order_count: Option<u32>,
}

/// Handle to an active orderbook subscription
pub struct OrderbookSubscription {
    /// Task handle for the WebSocket connection
    pub task_handle: tokio::task::JoinHandle<()>,
    /// Channel to send control messages (unsubscribe)
    pub control_tx: mpsc::Sender<SubscriptionControl>,
    /// Market ID
    pub market_id: String,
    /// Platform
    pub platform: Platform,
}

/// Control messages for subscription management
pub enum SubscriptionControl {
    Unsubscribe,
    Reconnect,
}

/// Supported prediction market platforms
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Platform {
    Polymarket,
    Kalshi,
}

impl Platform {
    pub fn as_str(&self) -> &'static str {
        match self {
            Platform::Polymarket => "polymarket",
            Platform::Kalshi => "kalshi",
        }
    }
}

/// Global state for active orderbook subscriptions
pub type ActiveSubscriptions = Arc<RwLock<HashMap<String, OrderbookSubscription>>>;

// ============================================================================
// POLYMARKET WEBSOCKET
// ============================================================================

// ============================================================================
// POLYMARKET WEBSOCKET ENDPOINTS (FIXED)
// ============================================================================
//
// Polymarket CLOB API WebSocket endpoints (2024/2025):
//   - /ws/market  : Market-level data (trades, orderbook updates)
//   - /ws/user    : User-specific data (fills, positions)
//
// Subscription format for /ws/market:
//   { "assets_ids": ["<token_id>"], "type": "market" }
//
// The assets_ids are CLOB token IDs (long numeric strings), NOT condition IDs.
// Each binary market has two token IDs: one for YES, one for NO.
//
// Response types:
//   - event_type: "book"         → full orderbook snapshot
//   - event_type: "book_update"  → incremental orderbook delta
//   - event_type: "trade"        → trade execution
//   - event_type: "price_change" → last price change
//   - type: "subscribed"         → subscription confirmation
//
// Keepalive: Send text "PING", expect text "PONG" response.
// ============================================================================

/// Polymarket CLOB WebSocket endpoint
/// Used for orderbook/trade/market data subscriptions.
/// Subscription uses assets_ids (token IDs) with type "market".
const POLYMARKET_WS_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/// Alias for clarity - same endpoint handles both orderbook and market data
const POLYMARKET_MARKET_WS_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/// Polymarket subscription message format (DEPRECATED - use PolymarketMarketSubscribe)
/// The old format with "channel" and "markets" fields is no longer used.
/// Kept for reference only.
#[derive(Debug, Serialize)]
#[allow(dead_code)]
struct PolymarketSubscribe {
    #[serde(rename = "type")]
    msg_type: String,
    channel: String,
    markets: Vec<String>,
}

/// Polymarket market subscription message format (market channel)
/// Uses assets_ids instead of markets, and type: "market"
#[derive(Debug, Serialize)]
struct PolymarketMarketSubscribe {
    #[serde(rename = "assets_ids")]
    assets_ids: Vec<String>,
    #[serde(rename = "type")]
    msg_type: String,
}

/// Polymarket orderbook message
#[derive(Debug, Deserialize)]
struct PolymarketOrderbookMsg {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    event: Option<String>,
    #[serde(rename = "asset_id")]
    asset_id: Option<String>,
    market: Option<String>,
    #[serde(rename = "hash")]
    hash: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "price")]
    price_string: Option<String>,
    #[serde(rename = "size")]
    size_string: Option<String>,
    side: Option<String>,
    // For book updates
    bids: Option<Vec<PolymarketLevel>>,
    asks: Option<Vec<PolymarketLevel>>,
}

/// Polymarket market channel message (from ws/market endpoint)
/// This is the format received from the market WebSocket endpoint
#[derive(Debug, Deserialize)]
struct PolymarketMarketMsg {
    /// Asset ID (token ID for the outcome)
    #[serde(rename = "asset_id")]
    asset_id: Option<String>,
    /// Market ID
    market: Option<String>,
    /// Event type from market channel (e.g., "book", "price_change", "last_trade_price")
    event_type: Option<String>,
    /// Price as string (needs parsing to f64)
    price: Option<String>,
    /// Size/amount as string
    size: Option<String>,
    /// Side: "BUY" or "SELL"
    side: Option<String>,
    /// Timestamp
    timestamp: Option<String>,
    /// Transaction hash
    #[serde(rename = "hash")]
    hash: Option<String>,
    /// Event type (e.g., "trade") - legacy field
    event: Option<String>,
    /// Tick size for the market
    tick_size: Option<String>,
    /// Last trade price
    last_trade_price: Option<String>,
    /// Book data (for orderbook snapshots)
    bids: Option<Vec<PolymarketLevel>>,
    asks: Option<Vec<PolymarketLevel>>,
    /// Price changes array (for price_change event_type)
    price_changes: Option<Vec<PolymarketPriceChange>>,
}

/// Polymarket price change entry (from price_change event)
#[derive(Debug, Deserialize)]
struct PolymarketPriceChange {
    asset_id: Option<String>,
    price: Option<String>,
    size: Option<String>,
    side: Option<String>,
    hash: Option<String>,
    best_bid: Option<String>,
    best_ask: Option<String>,
}

/// Polymarket price level
#[derive(Debug, Deserialize)]
struct PolymarketLevel {
    price: String,
    size: String,
}

/// Start Polymarket orderbook subscription
pub async fn subscribe_polymarket_orderbook(
    market_id: String,
    app_handle: AppHandle,
    subscriptions: ActiveSubscriptions,
) -> Result<()> {
    // Check if already subscribed
    {
        let subs = subscriptions.read().await;
        if subs.contains_key(&market_id) {
            return Ok(());
        }
    }
    
    // Create control channel
    let (control_tx, mut control_rx) = mpsc::channel::<SubscriptionControl>(1);
    
    // Spawn the WebSocket task
    let market_id_clone = market_id.clone();
    let subs_clone = subscriptions.clone();
    let task_handle = tokio::spawn(async move {
        let mut retry_count = 0u32;
        let max_retries = 10u32;
        
        loop {
            // Check for unsubscribe signal
            tokio::select! {
                control = control_rx.recv() => {
                    match control {
                        Some(SubscriptionControl::Unsubscribe) | None => {
                            println!("Polymarket orderbook unsubscribed for {}", market_id_clone);
                            break;
                        }
                        Some(SubscriptionControl::Reconnect) => {
                            println!("Reconnecting Polymarket orderbook for {}", market_id_clone);
                            retry_count = 0;
                            continue;
                        }
                    }
                }
                
                result = run_polymarket_connection(&market_id_clone, &app_handle) => {
                    match result {
                        Ok(_) => {
                            println!("Polymarket connection closed normally for {}", market_id_clone);
                            break;
                        }
                        Err(e) => {
                            eprintln!("Polymarket connection error for {}: {}", market_id_clone, e);
                            retry_count += 1;
                            
                            if retry_count >= max_retries {
                                eprintln!("Max retries reached for Polymarket {}", market_id_clone);
                                break;
                            }
                            
                            // Exponential backoff
                            let delay = Duration::from_secs(2u64.pow(retry_count.min(6)));
                            tokio::time::sleep(delay).await;
                        }
                    }
                }
            }
        }
        
        // Remove from active subscriptions
        let mut subs = subs_clone.write().await;
        subs.remove(&market_id_clone);
    });
    
    // Store subscription
    let subscription = OrderbookSubscription {
        task_handle,
        control_tx,
        market_id: market_id.clone(),
        platform: Platform::Polymarket,
    };
    
    {
        let mut subs = subscriptions.write().await;
        subs.insert(market_id, subscription);
    }
    
    Ok(())
}

/// Run a single Polymarket WebSocket connection
async fn run_polymarket_connection(market_id: &str, app_handle: &AppHandle) -> Result<()> {
    println!("Connecting to Polymarket WebSocket for market {}", market_id);
    println!("WebSocket URL: {}", POLYMARKET_WS_URL);
    
    // Connect to WebSocket with detailed error handling
    let ws_result = connect_async(POLYMARKET_WS_URL).await;
    
    let (ws_stream, _) = match ws_result {
        Ok(stream) => {
            println!("[Polymarket] WebSocket connected successfully");
            stream
        }
        Err(e) => {
            // ================================================================
            // POLYMARKET CONNECTION ERROR DIAGNOSTICS (IMPROVED)
            // ================================================================
            let err_str = format!("{:?}", e);
            let diagnostic = if err_str.contains("403") {
                "HTTP 403 Forbidden - possible IP block or rate limit"
            } else if err_str.contains("404") {
                "HTTP 404 Not Found - endpoint may have changed"
            } else if err_str.contains("429") {
                "HTTP 429 Too Many Requests - rate limited, back off"
            } else if err_str.contains("dns") || err_str.contains("resolve") {
                "DNS resolution failed - check internet connection"
            } else if err_str.contains("tls") || err_str.contains("certificate") {
                "TLS/SSL error - certificate verification failed"
            } else if err_str.contains("timeout") || err_str.contains("timed out") {
                "Connection timed out - server may be down or blocked"
            } else {
                "Network error - check firewall and internet connection"
            };
            eprintln!("[Polymarket] WebSocket connection failed: {:?}", e);
            eprintln!("[Polymarket] Diagnostic: {}", diagnostic);
            return Err(anyhow!(
                "Polymarket WebSocket connection failed: {}. Diagnostic: {}. URL: {}",
                e, diagnostic, POLYMARKET_WS_URL
            ));
        }
    };
    
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    
    // ========================================================================
    // POLYMARKET SUBSCRIPTION FORMAT (FIXED)
    // ========================================================================
    // Correct format: { "assets_ids": ["<token_id>"], "type": "market" }
    // The assets_ids field expects CLOB token IDs (long numeric strings).
    // type must be "market" (not "subscribe", not "orderbook").
    // ========================================================================
    let subscribe_msg = PolymarketMarketSubscribe {
        assets_ids: vec![market_id.to_string()],
        msg_type: "market".to_string(),
    };
    
    let subscribe_json = serde_json::to_string(&subscribe_msg)?;
    println!("[Polymarket] Sending subscription: {}", subscribe_json);
    ws_sender.send(WsMessage::Text(subscribe_json)).await?;
    
    println!("[Polymarket] Subscribed to market {}", market_id);
    
    // Track last update time for staleness detection
    let mut last_update = std::time::Instant::now();
    let staleness_timeout = Duration::from_secs(30);
    
    // Receive messages
    while let Some(msg) = ws_receiver.next().await {
        // Check for staleness
        if last_update.elapsed() > staleness_timeout {
            return Err(anyhow!("Connection stale - no updates for 30 seconds"));
        }
        
        match msg {
            Ok(WsMessage::Text(text)) => {
                // Emit raw message for debugging/display
                let raw_msg = RawWebSocketMessage {
                    market_id: market_id.to_string(),
                    platform: "polymarket".to_string(),
                    raw_message: text.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    msg_type: serde_json::from_str::<JsonValue>(&text)
                        .ok()
                        .and_then(|v| v.get("event_type").or_else(|| v.get("type")).and_then(|t| t.as_str().map(|s| s.to_string()))),
                };
                if let Err(e) = app_handle.emit("orderbook:raw", &raw_msg) {
                    eprintln!("Failed to emit raw orderbook message: {}", e);
                }
                
                match parse_polymarket_message(&text, market_id) {
                    Ok(Some(update)) => {
                        last_update = std::time::Instant::now();
                        
                        // Emit to frontend
                        if let Err(e) = app_handle.emit("orderbook:update", &update) {
                            eprintln!("Failed to emit orderbook update: {}", e);
                        }
                    }
                    Ok(None) => {
                        // Message parsed but not an orderbook update (e.g., heartbeat)
                    }
                    Err(e) => {
                        eprintln!("Failed to parse Polymarket message: {}", e);
                    }
                }
            }
            Ok(WsMessage::Ping(data)) => {
                // Respond to ping
                let _ = ws_sender.send(WsMessage::Pong(data)).await;
            }
            Ok(WsMessage::Close(_)) => {
                println!("Polymarket WebSocket closed by server");
                break;
            }
            Ok(WsMessage::Pong(_)) => {
                // Ignore pong
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("Polymarket WebSocket error: {}", e);
                return Err(anyhow!("WebSocket error: {}", e));
            }
        }
    }
    
    Ok(())
}

/// Parse a Polymarket WebSocket message
pub fn parse_polymarket_message(text: &str, market_id: &str) -> Result<Option<OrderbookUpdate>> {
    let value: JsonValue = serde_json::from_str(text)?;
    
    // Check message type
    let msg_type = value.get("event_type").and_then(|v| v.as_str()).unwrap_or("");
    
    match msg_type {
        "book" | "book_update" => {
            // Full book or delta update
            let bids = parse_polymarket_levels(value.get("bids"))?;
            let asks = parse_polymarket_levels(value.get("asks"))?;
            
            let timestamp = value.get("timestamp")
                .and_then(|v| v.as_str())
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.timestamp_millis())
                .unwrap_or_else(|| Utc::now().timestamp_millis());
            
            let sequence = value.get("hash")
                .and_then(|v| v.as_str())
                .map(|s| {
                    // Use hash as sequence (convert to u64 via hash)
                    let mut hash: u64 = 0;
                    for c in s.chars().take(16) {
                        hash = hash.wrapping_mul(16).wrapping_add(c as u64);
                    }
                    hash
                })
                .unwrap_or(0);
            
            Ok(Some(OrderbookUpdate {
                market_id: market_id.to_string(),
                platform: "polymarket".to_string(),
                bids,
                asks,
                timestamp,
                sequence,
                last_price: None,
                last_size: None,
            }))
        }
        "trade" => {
            // Trade message - extract last price
            let price = value.get("price")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok());
            
            let size = value.get("size")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok());
            
            // Emit trade update
            if let (Some(price), Some(size)) = (price, size) {
                Ok(Some(OrderbookUpdate {
                    market_id: market_id.to_string(),
                    platform: "polymarket".to_string(),
                    bids: vec![],
                    asks: vec![],
                    timestamp: Utc::now().timestamp_millis(),
                    sequence: 0,
                    last_price: Some(price),
                    last_size: Some(size),
                }))
            } else {
                Ok(None)
            }
        }
        "subscribed" => {
            println!("Polymarket subscription confirmed for {}", market_id);
            Ok(None)
        }
        "heartbeat" | "ping" => {
            Ok(None)
        }
        _ => {
            // Try to parse as orderbook anyway
            if value.get("bids").is_some() || value.get("asks").is_some() {
                let bids = parse_polymarket_levels(value.get("bids"))?;
                let asks = parse_polymarket_levels(value.get("asks"))?;
                
                Ok(Some(OrderbookUpdate {
                    market_id: market_id.to_string(),
                    platform: "polymarket".to_string(),
                    bids,
                    asks,
                    timestamp: Utc::now().timestamp_millis(),
                    sequence: 0,
                    last_price: None,
                    last_size: None,
                }))
            } else {
                Ok(None)
            }
        }
    }
}

/// Parse Polymarket price levels
fn parse_polymarket_levels(value: Option<&JsonValue>) -> Result<Vec<OrderbookLevel>> {
    let mut levels = Vec::new();
    
    if let Some(arr) = value.and_then(|v| v.as_array()) {
        for item in arr {
            let price = item.get("price")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0);
            
            let size = item.get("size")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0);
            
            if price > 0.0 && size > 0.0 {
                levels.push(OrderbookLevel {
                    price,
                    size,
                    order_count: None,
                });
            }
        }
    }
    
    // Sort bids descending, asks ascending
    levels.sort_by(|a, b| {
        b.price.partial_cmp(&a.price).unwrap_or(std::cmp::Ordering::Equal)
    });
    
    Ok(levels)
}

// ============================================================================
// POLYMARKET MARKET WEBSOCKET (ws/market endpoint)
// ============================================================================

/// Start Polymarket market subscription using the ws/market endpoint
/// This endpoint uses a different subscription format and provides real-time market data
/// 
/// # Arguments
/// * `asset_ids` - List of Polymarket asset/token IDs to subscribe to
/// * `app_handle` - Tauri app handle for emitting events
/// * `subscriptions` - Shared subscriptions state
pub async fn subscribe_polymarket_market(
    asset_ids: Vec<String>,
    app_handle: AppHandle,
    subscriptions: ActiveSubscriptions,
) -> Result<()> {
    // Create a composite key from all asset IDs
    let subscription_key = asset_ids.join(",");
    
    // Check if already subscribed
    {
        let subs = subscriptions.read().await;
        if subs.contains_key(&subscription_key) {
            return Ok(());
        }
    }
    
    // Create control channel
    let (control_tx, mut control_rx) = mpsc::channel::<SubscriptionControl>(1);
    
    // Clone the key for use inside the async block
    let subscription_key_clone = subscription_key.clone();
    let subscription_key_for_struct = subscription_key.clone();
    
    // Spawn the WebSocket task
    let asset_ids_clone = asset_ids.clone();
    let subs_clone = subscriptions.clone();
    let task_handle = tokio::spawn(async move {
        let mut retry_count = 0u32;
        let max_retries = 10u32;
        
        loop {
            // Check for unsubscribe signal
            tokio::select! {
                control = control_rx.recv() => {
                    match control {
                        Some(SubscriptionControl::Unsubscribe) | None => {
                            println!("Polymarket market unsubscribed for {:?}", asset_ids_clone);
                            break;
                        }
                        Some(SubscriptionControl::Reconnect) => {
                            println!("Reconnecting Polymarket market for {:?}", asset_ids_clone);
                            retry_count = 0;
                            continue;
                        }
                    }
                }
                
                result = run_polymarket_market_connection(&asset_ids_clone, &app_handle) => {
                    match result {
                        Ok(_) => {
                            println!("Polymarket market connection closed normally for {:?}", asset_ids_clone);
                            break;
                        }
                        Err(e) => {
                            eprintln!("Polymarket market connection error for {:?}: {}", asset_ids_clone, e);
                            retry_count += 1;
                            
                            if retry_count >= max_retries {
                                eprintln!("Max retries reached for Polymarket market {:?}", asset_ids_clone);
                                break;
                            }
                            
                            // Exponential backoff
                            let delay = Duration::from_secs(2u64.pow(retry_count.min(6)));
                            tokio::time::sleep(delay).await;
                        }
                    }
                }
            }
        }
        
        // Remove from active subscriptions
        let mut subs = subs_clone.write().await;
        subs.remove(&subscription_key_clone);
    });
    
    // Store subscription
    let subscription = OrderbookSubscription {
        task_handle,
        control_tx,
        market_id: subscription_key_for_struct,
        platform: Platform::Polymarket,
    };
    
    {
        let mut subs = subscriptions.write().await;
        subs.insert(subscription_key, subscription);
    }
    
    Ok(())
}

/// Run a single Polymarket market WebSocket connection (improved diagnostics)
async fn run_polymarket_market_connection(asset_ids: &[String], app_handle: &AppHandle) -> Result<()> {
    println!("[Polymarket] Connecting for assets {:?}", asset_ids);
    println!("[Polymarket] WebSocket URL: {}", POLYMARKET_MARKET_WS_URL);
    
    // Connect to WebSocket with improved error diagnostics
    let ws_result = connect_async(POLYMARKET_MARKET_WS_URL).await;
    
    let (ws_stream, _) = match ws_result {
        Ok(stream) => {
            println!("[Polymarket] WebSocket connected for market subscription");
            stream
        }
        Err(e) => {
            let err_str = format!("{:?}", e);
            let diagnostic = if err_str.contains("403") {
                "HTTP 403 Forbidden - possible IP block or rate limit"
            } else if err_str.contains("429") {
                "HTTP 429 Too Many Requests - rate limited"
            } else if err_str.contains("dns") || err_str.contains("resolve") {
                "DNS resolution failed - check internet connection"
            } else if err_str.contains("timeout") {
                "Connection timed out - server may be unreachable"
            } else {
                "Network error - check firewall and internet"
            };
            eprintln!("[Polymarket] Market WebSocket failed: {:?}", e);
            eprintln!("[Polymarket] Diagnostic: {}", diagnostic);
            return Err(anyhow!(
                "Polymarket market WebSocket failed: {}. Diagnostic: {}",
                e, diagnostic
            ));
        }
    };
    
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    
    // ========================================================================
    // POLYMARKET MARKET SUBSCRIPTION (CORRECT FORMAT)
    // ========================================================================
    // Format: { "assets_ids": ["<token_id_1>", "<token_id_2>"], "type": "market" }
    // ========================================================================
    let subscribe_msg = PolymarketMarketSubscribe {
        assets_ids: asset_ids.to_vec(),
        msg_type: "market".to_string(),
    };
    
    let subscribe_json = serde_json::to_string(&subscribe_msg)?;
    println!("[Polymarket] Sending market subscription: {}", subscribe_json);
    ws_sender.send(WsMessage::Text(subscribe_json)).await?;
    
    println!("[Polymarket] Subscribed to {} assets", asset_ids.len());
    
    // Track last update time for staleness detection and PING/PONG
    let mut last_update = std::time::Instant::now();
    let mut last_pong = std::time::Instant::now();
    let staleness_timeout = Duration::from_secs(30);
    let ping_interval = Duration::from_secs(10);
    
    // Receive messages
    while let Some(msg) = ws_receiver.next().await {
        // Check for staleness
        if last_update.elapsed() > staleness_timeout {
            return Err(anyhow!("Connection stale - no updates for 30 seconds"));
        }
        
        // Send PING if no PONG received in 10 seconds
        if last_pong.elapsed() > ping_interval {
            ws_sender.send(WsMessage::Text("PING".to_string())).await?;
            println!("Sent PING to Polymarket market WebSocket");
        }
        
        match msg {
            Ok(WsMessage::Text(text)) => {
                // Handle PONG response
                if text == "PONG" {
                    last_pong = std::time::Instant::now();
                    last_update = std::time::Instant::now();
                    println!("Received PONG from Polymarket market WebSocket");
                    continue;
                }
                
                // Emit raw message for debugging/display
                let raw_msg = RawWebSocketMessage {
                    market_id: asset_ids.join(","),
                    platform: "polymarket".to_string(),
                    raw_message: text.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    msg_type: serde_json::from_str::<JsonValue>(&text)
                        .ok()
                        .and_then(|v| {
                            // Handle arrays (book snapshots come as arrays)
                            if let Some(arr) = v.as_array() {
                                arr.first()
                                    .and_then(|item| item.get("event_type").or_else(|| item.get("type")))
                                    .and_then(|t| t.as_str().map(|s| s.to_string()))
                            } else {
                                v.get("event_type").or_else(|| v.get("type"))
                                    .and_then(|t| t.as_str().map(|s| s.to_string()))
                            }
                        }),
                };
                if let Err(e) = app_handle.emit("orderbook:raw", &raw_msg) {
                    eprintln!("Failed to emit raw orderbook message: {}", e);
                }
                
                // Parse market message
                match parse_polymarket_market_message(&text, asset_ids) {
                    Ok(Some(update)) => {
                        last_update = std::time::Instant::now();
                        last_pong = std::time::Instant::now();
                        
                        println!("[DEBUG] Emitting Polymarket orderbook:update for market: {} (price: {:?})", update.market_id, update.last_price);
                        
                        // Emit to frontend
                        if let Err(e) = app_handle.emit("orderbook:update", &update) {
                            eprintln!("Failed to emit Polymarket market update: {}", e);
                        }
                    }
                    Ok(None) => {
                        // Message parsed but not an update (e.g., subscription confirm)
                    }
                    Err(e) => {
                        eprintln!("Failed to parse Polymarket market message: {}", e);
                    }
                }
            }
            Ok(WsMessage::Ping(data)) => {
                // Respond to ping
                let _ = ws_sender.send(WsMessage::Pong(data)).await;
            }
            Ok(WsMessage::Pong(_)) => {
                last_pong = std::time::Instant::now();
            }
            Ok(WsMessage::Close(_)) => {
                println!("Polymarket market WebSocket closed by server");
                break;
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("Polymarket market WebSocket error: {}", e);
                return Err(anyhow!("WebSocket error: {}", e));
            }
        }
    }
    
    Ok(())
}

/// Parse a Polymarket market WebSocket message
/// Handles both single JSON objects and arrays of objects (multi-asset book snapshots)
fn parse_polymarket_market_message(text: &str, asset_ids: &[String]) -> Result<Option<OrderbookUpdate>> {
    let updates = parse_polymarket_market_all(text, asset_ids)?;
    Ok(updates.into_iter().next())
}

/// Parse a Polymarket market WebSocket message and return ALL updates
/// (one per asset_id in the message). This is needed for array messages
/// where Polymarket sends book snapshots for multiple outcomes (Yes/No).
pub fn parse_polymarket_market_all(text: &str, asset_ids: &[String]) -> Result<Vec<OrderbookUpdate>> {
    // Try to parse as JSON
    let value: JsonValue = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            // Not JSON, could be a control message
            println!("Non-JSON message from Polymarket market: {}", text);
            return Ok(vec![]);
        }
    };

    // Handle JSON arrays: Polymarket sends book snapshots as an array of objects,
    // one per asset_id in the market (e.g., Yes/No outcomes).
    // Return ALL valid updates so both sides of a market get populated.
    if let Some(arr) = value.as_array() {
        let mut updates = Vec::new();
        for item in arr {
            if let Ok(Some(update)) = parse_polymarket_market_single(item, asset_ids) {
                updates.push(update);
            }
        }
        return Ok(updates);
    }

    // Handle price_change events specially: they contain updates for multiple
    // assets in one message, so we need to return an update per asset.
    let event_type = value.get("event_type").or_else(|| value.get("type")).and_then(|v| v.as_str());
    if event_type == Some("price_change") {
        let mut updates = Vec::new();
        if let Some(changes) = value.get("changes").or_else(|| value.get("price_changes")).and_then(|v| v.as_array()) {
            // Parse timestamp from message
            let timestamp = value.get("timestamp")
                .and_then(|v| v.as_str())
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or_else(|| Utc::now().timestamp_millis());

            for change in changes {
                let change_asset = change.get("asset_id").and_then(|v| v.as_str()).unwrap_or("");
                if change_asset.is_empty() {
                    continue;
                }
                if !asset_ids.is_empty() && !asset_ids.iter().any(|id| id == change_asset) {
                    continue;
                }

                // price_change events only carry best bid/ask -- emit as last_price
                // update only, NOT as book replacement data (empty bids/asks).
                // This prevents wiping out the full orderbook with zero-size levels.
                let best_bid = change.get("price").or_else(|| change.get("best_bid"))
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<f64>().ok());
                let best_ask = change.get("best_ask")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse::<f64>().ok());

                // Use the mid price as last_price if both sides available,
                // otherwise use whichever is available
                let last_price = match (best_bid, best_ask) {
                    (Some(bid), _) => Some(bid),
                    (None, Some(ask)) => Some(ask),
                    _ => None,
                };

                if last_price.is_some() {
                    updates.push(OrderbookUpdate {
                        market_id: change_asset.to_string(),
                        platform: "polymarket".to_string(),
                        bids: vec![],  // Empty: don't overwrite full book data
                        asks: vec![],  // Empty: don't overwrite full book data
                        timestamp,
                        sequence: 0,
                        last_price,
                        last_size: None,
                    });
                }
            }
        }
        // Also try parsing via the struct-based approach as fallback
        if updates.is_empty() {
            if let Ok(msg) = serde_json::from_value::<PolymarketMarketMsg>(value.clone()) {
                if let Some(changes) = msg.price_changes {
                    let timestamp = msg.timestamp.as_deref()
                        .and_then(|s| s.parse::<i64>().ok())
                        .unwrap_or_else(|| Utc::now().timestamp_millis());

                    for change in &changes {
                        let change_asset = change.asset_id.as_deref().unwrap_or("");
                        if change_asset.is_empty() {
                            continue;
                        }
                        if !asset_ids.is_empty() && !asset_ids.iter().any(|id| id == change_asset) {
                            continue;
                        }

                        let best_bid = change.best_bid.as_deref()
                            .and_then(|s| s.parse::<f64>().ok());

                        if best_bid.is_some() {
                            updates.push(OrderbookUpdate {
                                market_id: change_asset.to_string(),
                                platform: "polymarket".to_string(),
                                bids: vec![],
                                asks: vec![],
                                timestamp,
                                sequence: 0,
                                last_price: best_bid,
                                last_size: None,
                            });
                        }
                    }
                }
            }
        }
        return Ok(updates);
    }

    // Single JSON object (non-price_change)
    match parse_polymarket_market_single(&value, asset_ids)? {
        Some(update) => Ok(vec![update]),
        None => Ok(vec![]),
    }
}

/// Parse a single Polymarket market message object (not an array)
fn parse_polymarket_market_single(value: &JsonValue, asset_ids: &[String]) -> Result<Option<OrderbookUpdate>> {
    // Check for subscription confirmation
    let event_type = value.get("event_type").or_else(|| value.get("type")).and_then(|v| v.as_str());
    if event_type == Some("subscribed") {
        println!("Polymarket market subscription confirmed");
        return Ok(None);
    }

    // Parse as market message struct
    let msg: PolymarketMarketMsg = match serde_json::from_value(value.clone()) {
        Ok(m) => m,
        Err(e) => {
            println!("Failed to parse Polymarket market message: {}", e);
            return Ok(None);
        }
    };

    // Determine which asset_id this message is for
    let asset_id = msg.asset_id.as_deref()
        .or(msg.market.as_deref())
        .unwrap_or("");

    // Use the asset_id if available, otherwise fall back to first subscribed id
    let market_id = if !asset_id.is_empty() {
        asset_id.to_string()
    } else if !asset_ids.is_empty() {
        asset_ids[0].clone()
    } else {
        String::new()
    };

    // Parse timestamp from message (millisecond unix timestamp string)
    let timestamp = msg.timestamp.as_deref()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or_else(|| Utc::now().timestamp_millis());

    // Parse last_trade_price from book messages
    let last_trade_price = msg.last_trade_price.as_deref()
        .and_then(|s| if s.is_empty() { None } else { s.parse::<f64>().ok() });

    // Route by event_type
    match msg.event_type.as_deref().or(event_type) {
        Some("book") | Some("book_update") => {
            // Full orderbook snapshot
            println!("[DEBUG] Polymarket received BOOK SNAPSHOT for market_id: {}", market_id);
            let bids = parse_market_levels(msg.bids);
            let asks = parse_market_levels(msg.asks);

            Ok(Some(OrderbookUpdate {
                market_id,
                platform: "polymarket".to_string(),
                bids,
                asks,
                timestamp,
                sequence: 0,
                last_price: last_trade_price,
                last_size: None,
            }))
        }
        Some("price_change") => {
            // price_change events contain updates for multiple assets (YES/NO).
            // Handled by parse_polymarket_market_all to return all updates.
            // Return None here so the caller can handle it.
            Ok(None)
        }
        Some("last_trade_price") => {
            // Trade event — extract price and size
            let price = msg.price.as_deref()
                .and_then(|s| s.parse::<f64>().ok());
            let size = msg.size.as_deref()
                .and_then(|s| s.parse::<f64>().ok());

            if let Some(price) = price {
                Ok(Some(OrderbookUpdate {
                    market_id,
                    platform: "polymarket".to_string(),
                    bids: vec![],
                    asks: vec![],
                    timestamp,
                    sequence: 0,
                    last_price: Some(price),
                    last_size: size,
                }))
            } else {
                Ok(None)
            }
        }
        Some("tick_size_change") | Some("heartbeat") | Some("ping") => {
            // Informational only, no orderbook update needed
            Ok(None)
        }
        _ => {
            // Legacy/unknown event_type — try to extract orderbook or trade data
            if msg.event.as_deref() == Some("trade") || msg.price.is_some() {
                let price = msg.price.as_deref().and_then(|p| p.parse::<f64>().ok());
                let size = msg.size.as_deref().and_then(|s| s.parse::<f64>().ok());
                if let (Some(price), Some(size)) = (price, size) {
                    return Ok(Some(OrderbookUpdate {
                        market_id,
                        platform: "polymarket".to_string(),
                        bids: vec![],
                        asks: vec![],
                        timestamp,
                        sequence: 0,
                        last_price: Some(price),
                        last_size: Some(size),
                    }));
                }
            }

            if msg.bids.is_some() || msg.asks.is_some() {
                let bids = parse_market_levels(msg.bids);
                let asks = parse_market_levels(msg.asks);
                return Ok(Some(OrderbookUpdate {
                    market_id,
                    platform: "polymarket".to_string(),
                    bids,
                    asks,
                    timestamp,
                    sequence: 0,
                    last_price: last_trade_price,
                    last_size: None,
                }));
            }

            // Truly unknown
            println!("Unknown Polymarket market event_type: {:?}, message keys: {:?}",
                msg.event_type,
                value.as_object().map(|o| o.keys().collect::<Vec<_>>())
            );
            Ok(None)
        }
    }
}

/// Parse Polymarket levels from Option<Vec<PolymarketLevel>>
fn parse_market_levels(levels: Option<Vec<PolymarketLevel>>) -> Vec<OrderbookLevel> {
    levels.map(|lvls| {
        lvls.into_iter()
            .filter_map(|l| {
                let price = l.price.parse::<f64>().ok()?;
                let size = l.size.parse::<f64>().ok()?;
                if price > 0.0 && size > 0.0 {
                    Some(OrderbookLevel { price, size, order_count: None })
                } else {
                    None
                }
            })
            .collect()
    }).unwrap_or_default()
}

// ============================================================================
// KALSHI WEBSOCKET
// ============================================================================

/// Kalshi WebSocket endpoint
/// Per Kalshi docs: https://docs.kalshi.com/websockets
/// Production: wss://api.elections.kalshi.com/trade-api/ws/v2
/// Demo: wss://demo-api.kalshi.com/trade-api/ws/v2
const KALSHI_WS_URL: &str = "wss://api.elections.kalshi.com/trade-api/ws/v2";
const KALSHI_DEMO_WS_URL: &str = "wss://demo-api.kalshi.com/trade-api/ws/v2";

// ============================================================================
// KALSHI AUTHENTICATION
// ============================================================================

/// Kalshi API credentials for WebSocket authentication
#[derive(Debug, Clone)]
pub struct KalshiCredentials {
    pub api_key: String,
    pub private_key_pem: String,
    pub demo: bool,
}

/// Kalshi authentication headers
#[derive(Debug, Clone)]
pub struct KalshiAuthHeaders {
    pub access_key: String,
    pub signature: String,
    pub timestamp: String,
}

/// Sign a message using RSA-PSS (Kalshi's required signing method)
pub fn sign_pss_text(private_key: &RsaPrivateKey, text: &str) -> Result<String> {
    use rsa::pss::Pss;
    use rand::thread_rng;
    use sha2::Digest;
    
    let message = text.as_bytes();
    
    println!("DEBUG: Signing message: {}", text);
    println!("DEBUG: Message bytes length: {}", message.len());
    println!("DEBUG: Private key size: {} bits", private_key.size() * 8);
    
    // Hash the message first with SHA256
    // Python's cryptography library does this internally
    let mut hasher = Sha256::new();
    Digest::update(&mut hasher, message);
    let hashed = hasher.finalize();
    
    println!("DEBUG: Hashed message, hash length: {} bytes", hashed.len());
    
    // Use PSS with SHA256
    let padding = Pss::new::<Sha256>();
    
    println!("DEBUG: Attempting to sign with PSS-SHA256...");
    
    // PSS requires a random number generator for the salt
    let mut rng = thread_rng();
    
    // Sign the hashed message
    let signature_bytes = match private_key.sign_with_rng(&mut rng, padding, &hashed) {
        Ok(sig) => {
            println!("DEBUG: Signing successful, signature length: {} bytes", sig.len());
            sig
        }
        Err(e) => {
            println!("DEBUG: Signing FAILED with error: {:?}", e);
            println!("DEBUG: Error type: {}", std::any::type_name_of_val(&e));
            return Err(anyhow!("Failed to sign message: {}", e));
        }
    };
    
    // Base64 encode the signature
    let signature_b64 = BASE64.encode(&signature_bytes);
    println!("DEBUG: Signature (base64): {}", signature_b64);
    
    Ok(signature_b64)
}

/// Load RSA private key from PEM format
pub fn load_private_key(pem_str: &str) -> Result<RsaPrivateKey> {
    println!("DEBUG: Loading private key...");
    println!("DEBUG: Key starts with: {}...", &pem_str.chars().take(50).collect::<String>());
    println!("DEBUG: Key length: {} chars", pem_str.len());
    
    // Debug: show all lines
    println!("DEBUG: Lines in key:");
    for (i, line) in pem_str.lines().take(5).enumerate() {
        println!("DEBUG:   Line {}: '{}' (len: {})", i, &line.chars().take(60).collect::<String>(), line.len());
    }
    
    // Normalize the PEM string - ensure proper line endings
    let mut pem_normalized = pem_str
        .replace("\\n", "\n")  // Handle escaped newlines from JSON
        .replace("\r\n", "\n") // Normalize CRLF to LF
        .trim()
        .to_string();
    
    // Fix: Add newlines after headers if they're on the same line as content
    // This handles the case where the key is stored as a single line
    if pem_normalized.contains("-----BEGIN RSA PRIVATE KEY-----") && !pem_normalized.contains("\n-----BEGIN") {
        // Insert newlines around headers
        pem_normalized = pem_normalized
            .replace("-----BEGIN RSA PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----\n")
            .replace("-----END RSA PRIVATE KEY-----", "\n-----END RSA PRIVATE KEY-----");
    }
    if pem_normalized.contains("-----BEGIN PRIVATE KEY-----") && !pem_normalized.contains("\n-----BEGIN") {
        pem_normalized = pem_normalized
            .replace("-----BEGIN PRIVATE KEY-----", "-----BEGIN PRIVATE KEY-----\n")
            .replace("-----END PRIVATE KEY-----", "\n-----END PRIVATE KEY-----");
    }
    
    // Remove leading/trailing spaces from each line
    let lines: Vec<&str> = pem_normalized.lines().collect();
    let cleaned_lines: Vec<String> = lines.iter().map(|l| l.trim().to_string()).collect();
    let pem_cleaned = cleaned_lines.join("\n");
    
    println!("DEBUG: Cleaned key starts with: {}...", &pem_cleaned.chars().take(80).collect::<String>());
    println!("DEBUG: Cleaned key contains newlines: {}", pem_cleaned.contains('\n'));
    
    // Try PKCS#1 format first (RSA PRIVATE KEY) - most common for Kalshi
    match RsaPrivateKey::from_pkcs1_pem(&pem_cleaned) {
        Ok(key) => {
            println!("DEBUG: Successfully loaded PKCS#1 key");
            return Ok(key);
        }
        Err(e) => {
            println!("DEBUG: PKCS#1 load failed: {:?}", e);
        }
    }
    
    // Try PKCS#8 format (PRIVATE KEY)
    match RsaPrivateKey::from_pkcs8_pem(&pem_cleaned) {
        Ok(key) => {
            println!("DEBUG: Successfully loaded PKCS#8 key");
            return Ok(key);
        }
        Err(e) => {
            println!("DEBUG: PKCS#8 load failed: {:?}", e);
        }
    }
    
    // Try extracting base64 content and decoding as DER
    // Filter out header/footer lines and collect base64 content
    let base64_content: String = pem_cleaned
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !trimmed.starts_with("-----") && !trimmed.is_empty()
        })
        .flat_map(|line| line.chars().filter(|c| !c.is_whitespace()))
        .collect();
    
    println!("DEBUG: Attempting DER decode, base64 content length: {} chars", base64_content.len());
    if !base64_content.is_empty() {
        println!("DEBUG: Base64 content starts with: {}...", &base64_content.chars().take(40).collect::<String>());
    }
    
    // Decode base64 and try DER format
    match BASE64.decode(&base64_content) {
        Ok(der_bytes) => {
            println!("DEBUG: Base64 decoded, {} bytes", der_bytes.len());
            
            // Try PKCS#1 DER
            match RsaPrivateKey::from_pkcs1_der(&der_bytes) {
                Ok(key) => {
                    println!("DEBUG: Successfully loaded PKCS#1 DER key");
                    return Ok(key);
                }
                Err(e) => {
                    println!("DEBUG: PKCS#1 DER load failed: {:?}", e);
                }
            }
            
            // Try PKCS#8 DER
            match RsaPrivateKey::from_pkcs8_der(&der_bytes) {
                Ok(key) => {
                    println!("DEBUG: Successfully loaded PKCS#8 DER key");
                    return Ok(key);
                }
                Err(e) => {
                    println!("DEBUG: PKCS#8 DER load failed: {:?}", e);
                }
            }
        }
        Err(e) => {
            println!("DEBUG: Base64 decode failed: {:?}", e);
        }
    }
    
    Err(anyhow!("Failed to parse private key. Make sure the key is in valid PEM format with proper BEGIN/END headers."))
}

/// Create Kalshi authentication headers
pub fn create_kalshi_auth_headers(
    private_key: &RsaPrivateKey,
    api_key: &str,
    method: &str,
    path: &str,
) -> Result<KalshiAuthHeaders> {
    // Timestamp in milliseconds
    let timestamp = format!("{}", Utc::now().timestamp_millis());
    
    // Message string: timestamp + method + path (without query params)
    let path_without_query = path.split('?').next().unwrap_or(path);
    let msg_string = format!("{}{}{}", timestamp, method, path_without_query);
    
    println!("DEBUG: Creating auth headers");
    println!("DEBUG: Timestamp: {}", timestamp);
    println!("DEBUG: Method: {}", method);
    println!("DEBUG: Path: {}", path_without_query);
    println!("DEBUG: Message string: {}", msg_string);
    
    // Sign the message
    let signature = sign_pss_text(private_key, &msg_string)?;
    
    println!("DEBUG: API Key: {}", api_key);
    
    Ok(KalshiAuthHeaders {
        access_key: api_key.to_string(),
        signature,
        timestamp,
    })
}

/// Kalshi subscription message
/// Per Kalshi docs: https://docs.kalshi.com/websockets
/// Format: { "id": 1, "cmd": "subscribe", "params": { "channels": ["orderbook_delta"], "market_ticker": "XXX" } }
#[derive(Debug, Serialize)]
struct KalshiSubscribe {
    id: u64,
    cmd: String,
    params: KalshiSubscribeParams,
}

#[derive(Debug, Serialize)]
struct KalshiSubscribeParams {
    channels: Vec<String>,
    market_ticker: String,
}

/// Kalshi orderbook message
#[derive(Debug, Deserialize)]
struct KalshiOrderbookMsg {
    #[serde(rename = "type")]
    msg_type: Option<String>,
    channel: Option<String>,
    market_ticker: Option<String>,
    side: Option<String>,
    yes: Option<Vec<KalshiLevel>>,
    no: Option<Vec<KalshiLevel>>,
    price: Option<i32>,
    count: Option<i32>,
    delta: Option<i32>,
    sequence: Option<u64>,
    timestamp: Option<String>,
}

/// Kalshi price level
#[derive(Debug, Deserialize)]
struct KalshiLevel {
    price: i32,
    count: i32,
    delta: Option<i32>,
}

/// Start Kalshi orderbook subscription with authentication
pub async fn subscribe_kalshi_orderbook(
    market_ticker: String,
    app_handle: AppHandle,
    subscriptions: ActiveSubscriptions,
    credentials: Option<KalshiCredentials>,
) -> Result<()> {
    // Check if already subscribed
    {
        let subs = subscriptions.read().await;
        if subs.contains_key(&market_ticker) {
            return Ok(());
        }
    }
    
    // Create control channel
    let (control_tx, mut control_rx) = mpsc::channel::<SubscriptionControl>(1);
    
    // Spawn the WebSocket task
    let market_ticker_clone = market_ticker.clone();
    let subs_clone = subscriptions.clone();
    let task_handle = tokio::spawn(async move {
        let mut retry_count = 0u32;
        let max_retries = 10u32;
        
        loop {
            tokio::select! {
                control = control_rx.recv() => {
                    match control {
                        Some(SubscriptionControl::Unsubscribe) | None => {
                            println!("Kalshi orderbook unsubscribed for {}", market_ticker_clone);
                            break;
                        }
                        Some(SubscriptionControl::Reconnect) => {
                            println!("Reconnecting Kalshi orderbook for {}", market_ticker_clone);
                            retry_count = 0;
                            continue;
                        }
                    }
                }
                
                result = run_kalshi_connection(&market_ticker_clone, &app_handle, credentials.as_ref()) => {
                    match result {
                        Ok(_) => {
                            println!("Kalshi connection closed normally for {}", market_ticker_clone);
                            break;
                        }
                        Err(e) => {
                            eprintln!("Kalshi connection error for {}: {}", market_ticker_clone, e);
                            retry_count += 1;
                            
                            if retry_count >= max_retries {
                                eprintln!("Max retries reached for Kalshi {}", market_ticker_clone);
                                break;
                            }
                            
                            let delay = Duration::from_secs(2u64.pow(retry_count.min(6)));
                            tokio::time::sleep(delay).await;
                        }
                    }
                }
            }
        }
        
        // Remove from active subscriptions
        let mut subs = subs_clone.write().await;
        subs.remove(&market_ticker_clone);
    });
    
    // Store subscription
    let subscription = OrderbookSubscription {
        task_handle,
        control_tx,
        market_id: market_ticker.clone(),
        platform: Platform::Kalshi,
    };
    
    {
        let mut subs = subscriptions.write().await;
        subs.insert(market_ticker, subscription);
    }
    
    Ok(())
}

/// Run a single Kalshi WebSocket connection with optional authentication
async fn run_kalshi_connection(
    market_ticker: &str, 
    app_handle: &AppHandle,
    credentials: Option<&KalshiCredentials>,
) -> Result<()> {
    println!("Connecting to Kalshi WebSocket for market {}", market_ticker);
    
    // Determine WebSocket URL based on environment
    let ws_url = if let Some(creds) = credentials {
        if creds.demo {
            println!("Using Kalshi demo environment");
            KALSHI_DEMO_WS_URL
        } else {
            println!("Using Kalshi production environment");
            KALSHI_WS_URL
        }
    } else {
        println!("No credentials provided, using production environment (public channels only)");
        KALSHI_WS_URL
    };
    
    println!("WebSocket URL: {}", ws_url);
    
    // Build WebSocket connection with optional auth headers
    let ws_result = if let Some(creds) = credentials {
        // Load private key and create auth headers
        let private_key = load_private_key(&creds.private_key_pem)
            .context("Failed to load Kalshi private key")?;
        
        let auth_headers = create_kalshi_auth_headers(
            &private_key,
            &creds.api_key,
            "GET",
            "/trade-api/ws/v2",
        ).context("Failed to create Kalshi auth headers")?;
        
        println!("Created auth headers for Kalshi WebSocket");
        
        // Use IntoClientRequest to create a request from the URL, then add custom headers
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::http::header::HeaderName;
        
        let mut request = ws_url.into_client_request()
            .map_err(|e| anyhow!("Failed to create WebSocket request: {}", e))?;
        
        // Add Kalshi authentication headers with exact case matching Python code
        // Python uses: "KALSHI-ACCESS-KEY", "KALSHI-ACCESS-SIGNATURE", "KALSHI-ACCESS-TIMESTAMP"
        let key_header: HeaderName = "KALSHI-ACCESS-KEY".parse()
            .map_err(|e| anyhow!("Invalid header name: {}", e))?;
        let sig_header: HeaderName = "KALSHI-ACCESS-SIGNATURE".parse()
            .map_err(|e| anyhow!("Invalid header name: {}", e))?;
        let ts_header: HeaderName = "KALSHI-ACCESS-TIMESTAMP".parse()
            .map_err(|e| anyhow!("Invalid header name: {}", e))?;
        
        request.headers_mut().insert(key_header, 
            auth_headers.access_key.parse()
                .map_err(|e| anyhow!("Invalid access key header: {}", e))?);
        request.headers_mut().insert(sig_header, 
            auth_headers.signature.parse()
                .map_err(|e| anyhow!("Invalid signature header: {}", e))?);
        request.headers_mut().insert(ts_header, 
            auth_headers.timestamp.parse()
                .map_err(|e| anyhow!("Invalid timestamp header: {}", e))?);
        
        println!("DEBUG: Request headers: {:?}", request.headers());
        
        // Use connect_async with the modified request
        connect_async(request).await
    } else {
        // No auth - connect without headers
        connect_async(ws_url).await
    };
    
    let (ws_stream, _) = match ws_result {
        Ok(stream) => stream,
        Err(e) => {
            eprintln!("Kalshi WebSocket connection failed: {:?}", e);
            return Err(anyhow!("Failed to connect to Kalshi WebSocket at {}: {:?}", ws_url, e));
        }
    };
    
    println!("Connected to Kalshi WebSocket successfully");
    
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    
    // Subscribe to channels based on authentication
    // Per Kalshi docs: https://docs.kalshi.com/websockets
    // Public channels: ticker, trade, market_lifecycle_v2
    // Private channels (auth required): orderbook_delta, fill, market_positions
    
    if credentials.is_some() {
        // Authenticated - subscribe to orderbook_delta for full orderbook data
        let orderbook_subscribe = KalshiSubscribe {
            id: 1,
            cmd: "subscribe".to_string(),
            params: KalshiSubscribeParams {
                channels: vec!["orderbook_delta".to_string()],
                market_ticker: market_ticker.to_string(),
            },
        };
        let orderbook_json = serde_json::to_string(&orderbook_subscribe)?;
        println!("Sending orderbook_delta subscription: {}", orderbook_json);
        ws_sender.send(WsMessage::Text(orderbook_json)).await?;
        
        // Also subscribe to trades for last price
        let trade_subscribe = KalshiSubscribe {
            id: 2,
            cmd: "subscribe".to_string(),
            params: KalshiSubscribeParams {
                channels: vec!["trade".to_string()],
                market_ticker: market_ticker.to_string(),
            },
        };
        let trade_json = serde_json::to_string(&trade_subscribe)?;
        println!("Sending trade subscription: {}", trade_json);
        ws_sender.send(WsMessage::Text(trade_json)).await?;
    } else {
        // No auth - subscribe to public channels only
        let ticker_subscribe = KalshiSubscribe {
            id: 1,
            cmd: "subscribe".to_string(),
            params: KalshiSubscribeParams {
                channels: vec!["ticker".to_string()],
                market_ticker: market_ticker.to_string(),
            },
        };
        let ticker_json = serde_json::to_string(&ticker_subscribe)?;
        println!("Sending ticker subscription: {}", ticker_json);
        ws_sender.send(WsMessage::Text(ticker_json)).await?;
        
        let trade_subscribe = KalshiSubscribe {
            id: 2,
            cmd: "subscribe".to_string(),
            params: KalshiSubscribeParams {
                channels: vec!["trade".to_string()],
                market_ticker: market_ticker.to_string(),
            },
        };
        let trade_json = serde_json::to_string(&trade_subscribe)?;
        println!("Sending trade subscription: {}", trade_json);
        ws_sender.send(WsMessage::Text(trade_json)).await?;
    }
    
    println!("Sent subscriptions for Kalshi market {}", market_ticker);
    
    // Track orderbook state for YES and NO sides separately
    // YES side is keyed by market_ticker, NO side by market_ticker:no
    let mut yes_bids: Vec<OrderbookLevel> = Vec::new();
    let mut yes_asks: Vec<OrderbookLevel> = Vec::new();
    let mut no_bids: Vec<OrderbookLevel> = Vec::new();
    let mut no_asks: Vec<OrderbookLevel> = Vec::new();
    let mut sequence: u64 = 0;

    // Receive messages - persist subscription without staleness timeout
    while let Some(msg) = ws_receiver.next().await {
        match msg {
            Ok(WsMessage::Text(text)) => {
                // Debug: Print incoming websocket message
                println!("[Kalshi WS IN] {}: {}", market_ticker, text);

                // Emit raw message for debugging/display
                let raw_msg = RawWebSocketMessage {
                    market_id: market_ticker.to_string(),
                    platform: "kalshi".to_string(),
                    raw_message: text.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    msg_type: serde_json::from_str::<JsonValue>(&text)
                        .ok()
                        .and_then(|v| v.get("type").and_then(|t| t.as_str().map(|s| s.to_string()))),
                };
                if let Err(e) = app_handle.emit("orderbook:raw", &raw_msg) {
                    eprintln!("Failed to emit raw Kalshi message: {}", e);
                }

                match parse_kalshi_message(&text, market_ticker, &mut yes_bids, &mut yes_asks, &mut no_bids, &mut no_asks, &mut sequence) {
                    Ok(updates) => {
                        for update in updates {
                            if let Err(e) = app_handle.emit("orderbook:update", &update) {
                                eprintln!("Failed to emit Kalshi orderbook update: {}", e);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to parse Kalshi message: {}", e);
                    }
                }
            }
            Ok(WsMessage::Ping(data)) => {
                let _ = ws_sender.send(WsMessage::Pong(data)).await;
            }
            Ok(WsMessage::Close(_)) => {
                println!("Kalshi WebSocket closed by server");
                break;
            }
            Ok(_) => {}
            Err(e) => {
                eprintln!("Kalshi WebSocket error: {}", e);
                return Err(anyhow!("WebSocket error: {}", e));
            }
        }
    }
    
    Ok(())
}

/// Parse a Kalshi WebSocket message
/// Per Kalshi docs: https://docs.kalshi.com/websockets
/// Returns Vec of updates: one for YES (market_ticker) and one for NO (market_ticker:no)
///
/// Kalshi binary markets have YES and NO sides. A YES bid at price X implies a NO ask at (100-X),
/// and vice versa. We maintain separate orderbooks for each side so the frontend can display
/// them side-by-side, matching the Polymarket two-token architecture.
pub fn parse_kalshi_message(
    text: &str,
    market_ticker: &str,
    yes_bids: &mut Vec<OrderbookLevel>,
    yes_asks: &mut Vec<OrderbookLevel>,
    no_bids: &mut Vec<OrderbookLevel>,
    no_asks: &mut Vec<OrderbookLevel>,
    sequence: &mut u64,
) -> Result<Vec<OrderbookUpdate>> {
    let value: JsonValue = serde_json::from_str(text)?;

    let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let no_market_id = format!("{}:no", market_ticker);

    match msg_type {
        "subscribed" => {
            println!("Kalshi subscription confirmed: {}", text);
            Ok(vec![])
        }
        "ticker" => {
            // Ticker message format: { "type": "ticker", "msg": { "market_ticker": "XXX", "yes_bid": 45, "yes_ask": 55 } }
            let msg = value.get("msg").ok_or_else(|| anyhow!("Missing msg field in ticker"))?;
            let yes_bid_price = msg.get("yes_bid").and_then(|v| v.as_i64()).unwrap_or(0) as f64 / 100.0;
            let yes_ask_price = msg.get("yes_ask").and_then(|v| v.as_i64()).unwrap_or(0) as f64 / 100.0;

            // YES orderbook: yes_bid is the best bid, yes_ask is the best ask
            *yes_bids = vec![OrderbookLevel { price: yes_bid_price, size: 1.0, order_count: None }];
            *yes_asks = vec![OrderbookLevel { price: yes_ask_price, size: 1.0, order_count: None }];

            // NO orderbook: derived by inverting YES prices
            // NO bid = 1 - YES ask, NO ask = 1 - YES bid
            let no_bid_price = 1.0 - yes_ask_price;
            let no_ask_price = 1.0 - yes_bid_price;
            *no_bids = vec![OrderbookLevel { price: no_bid_price, size: 1.0, order_count: None }];
            *no_asks = vec![OrderbookLevel { price: no_ask_price, size: 1.0, order_count: None }];

            *sequence += 1;

            Ok(vec![
                OrderbookUpdate {
                    market_id: market_ticker.to_string(),
                    platform: "kalshi".to_string(),
                    bids: yes_bids.clone(),
                    asks: yes_asks.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    sequence: *sequence,
                    last_price: None,
                    last_size: None,
                },
                OrderbookUpdate {
                    market_id: no_market_id,
                    platform: "kalshi".to_string(),
                    bids: no_bids.clone(),
                    asks: no_asks.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    sequence: *sequence,
                    last_price: None,
                    last_size: None,
                },
            ])
        }
        "trade" => {
            // Trade message: { "type": "trade", "msg": { "market_ticker": "XXX", "price": 50, "count": 100, ... } }
            let msg = value.get("msg").ok_or_else(|| anyhow!("Missing msg field in trade"))?;
            let price = msg.get("price").and_then(|v| v.as_i64()).unwrap_or(0) as f64 / 100.0;
            let size = msg.get("count").and_then(|v| v.as_i64()).unwrap_or(0) as f64;

            *sequence += 1;

            Ok(vec![
                OrderbookUpdate {
                    market_id: market_ticker.to_string(),
                    platform: "kalshi".to_string(),
                    bids: yes_bids.clone(),
                    asks: yes_asks.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    sequence: *sequence,
                    last_price: Some(price),
                    last_size: Some(size),
                },
                OrderbookUpdate {
                    market_id: no_market_id,
                    platform: "kalshi".to_string(),
                    bids: no_bids.clone(),
                    asks: no_asks.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    sequence: *sequence,
                    last_price: Some(1.0 - price),
                    last_size: Some(size),
                },
            ])
        }
        "orderbook_snapshot" => {
            // Full snapshot: { "type": "orderbook_snapshot", "msg": { "yes": [[price,qty],...], "no": [[price,qty],...] } }
            let msg = value.get("msg").ok_or_else(|| anyhow!("Missing msg field in orderbook_snapshot"))?;
            let raw_yes_levels = parse_kalshi_levels(msg.get("yes"));
            let raw_no_levels = parse_kalshi_levels(msg.get("no"));

            // YES orderbook: YES bids from yes array, YES asks derived from NO (price = 1 - no_price)
            *yes_bids = raw_yes_levels.clone();
            *yes_asks = invert_kalshi_levels(&raw_no_levels);
            yes_asks.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal));

            // NO orderbook: NO bids from no array, NO asks derived from YES (price = 1 - yes_price)
            *no_bids = raw_no_levels.clone();
            *no_asks = invert_kalshi_levels(&raw_yes_levels);
            no_asks.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal));

            *sequence += 1;

            Ok(vec![
                OrderbookUpdate {
                    market_id: market_ticker.to_string(),
                    platform: "kalshi".to_string(),
                    bids: yes_bids.clone(),
                    asks: yes_asks.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    sequence: *sequence,
                    last_price: None,
                    last_size: None,
                },
                OrderbookUpdate {
                    market_id: no_market_id,
                    platform: "kalshi".to_string(),
                    bids: no_bids.clone(),
                    asks: no_asks.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    sequence: *sequence,
                    last_price: None,
                    last_size: None,
                },
            ])
        }
        "orderbook_delta" => {
            // Delta update: { "type": "orderbook_delta", "msg": { "side": "yes"|"no", "price": N, "delta": N } }
            let msg = value.get("msg").ok_or_else(|| anyhow!("Missing msg field in orderbook_delta"))?;
            let side = msg.get("side").and_then(|v| v.as_str()).unwrap_or("");
            let price = msg.get("price").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let delta = msg.get("delta").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let inverted_price = 100 - price;

            if side == "yes" {
                // Update YES bids
                apply_kalshi_delta(yes_bids, price, delta);
                // Update NO asks (inverted YES)
                apply_kalshi_delta(no_asks, inverted_price, delta);
            } else {
                // Update NO bids
                apply_kalshi_delta(no_bids, price, delta);
                // Update YES asks (inverted NO)
                apply_kalshi_delta(yes_asks, inverted_price, delta);
            }

            // Sort: bids descending, asks ascending
            yes_bids.sort_by(|a, b| b.price.partial_cmp(&a.price).unwrap_or(std::cmp::Ordering::Equal));
            yes_asks.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal));
            no_bids.sort_by(|a, b| b.price.partial_cmp(&a.price).unwrap_or(std::cmp::Ordering::Equal));
            no_asks.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal));

            *sequence += 1;

            Ok(vec![
                OrderbookUpdate {
                    market_id: market_ticker.to_string(),
                    platform: "kalshi".to_string(),
                    bids: yes_bids.clone(),
                    asks: yes_asks.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    sequence: *sequence,
                    last_price: None,
                    last_size: None,
                },
                OrderbookUpdate {
                    market_id: no_market_id,
                    platform: "kalshi".to_string(),
                    bids: no_bids.clone(),
                    asks: no_asks.clone(),
                    timestamp: Utc::now().timestamp_millis(),
                    sequence: *sequence,
                    last_price: None,
                    last_size: None,
                },
            ])
        }
        "error" => {
            let msg = value.get("msg").and_then(|v| v.as_str()).unwrap_or("unknown error");
            eprintln!("Kalshi WebSocket error: {}", msg);
            Ok(vec![])
        }
        "heartbeat" | "ping" => {
            Ok(vec![])
        }
        _ => {
            // Log unknown messages for debugging
            println!("Unknown Kalshi message type '{}': {}", msg_type, text);
            Ok(vec![])
        }
    }
}

/// Invert Kalshi price levels: price -> (1.0 - price)
/// Used to derive asks from the opposite side's bids.
/// E.g., a YES bid at 7c becomes a NO ask at 93c.
fn invert_kalshi_levels(levels: &[OrderbookLevel]) -> Vec<OrderbookLevel> {
    levels.iter()
        .filter_map(|l| {
            let inverted_price = 1.0 - l.price;
            if inverted_price > 0.0 {
                Some(OrderbookLevel {
                    price: inverted_price,
                    size: l.size,
                    order_count: l.order_count,
                })
            } else {
                None
            }
        })
        .collect()
}

/// Apply a Kalshi delta to a levels vec (handles add/update/remove)
fn apply_kalshi_delta(levels: &mut Vec<OrderbookLevel>, price_cents: i32, delta: i32) {
    if delta == 0 {
        levels.retain(|l| (l.price * 100.0).round() as i32 != price_cents);
    } else {
        let price_f64 = price_cents as f64 / 100.0;
        let size_f64 = delta.abs() as f64;

        if let Some(level) = levels.iter_mut().find(|l| (l.price * 100.0).round() as i32 == price_cents) {
            level.size = size_f64;
        } else {
            levels.push(OrderbookLevel {
                price: price_f64,
                size: size_f64,
                order_count: None,
            });
        }
    }
}

/// Parse Kalshi price levels
/// Kalshi sends levels as arrays of [price_cents, quantity], e.g. [[1,63108],[2,12145],...]
fn parse_kalshi_levels(value: Option<&JsonValue>) -> Vec<OrderbookLevel> {
    let mut levels = Vec::new();

    if let Some(arr) = value.and_then(|v| v.as_array()) {
        for item in arr {
            // Kalshi snapshot levels are [price_in_cents, quantity] arrays
            if let Some(pair) = item.as_array() {
                if pair.len() >= 2 {
                    let price = pair[0].as_i64().unwrap_or(0) as f64 / 100.0;
                    let count = pair[1].as_i64().unwrap_or(0) as f64;

                    if price > 0.0 && count > 0.0 {
                        levels.push(OrderbookLevel {
                            price,
                            size: count,
                            order_count: None,
                        });
                    }
                }
            } else {
                // Fallback: try object format {"price": N, "count": N}
                let price = item.get("price")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0) as f64 / 100.0;

                let count = item.get("count")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0) as f64;

                if price > 0.0 && count > 0.0 {
                    levels.push(OrderbookLevel {
                        price,
                        size: count,
                        order_count: None,
                    });
                }
            }
        }
    }

    // Sort by price descending (for bids)
    levels.sort_by(|a, b| {
        b.price.partial_cmp(&a.price).unwrap_or(std::cmp::Ordering::Equal)
    });

    levels
}

// ============================================================================
// SUBSCRIPTION MANAGEMENT
// ============================================================================

/// Unsubscribe from an orderbook
pub async fn unsubscribe_orderbook(
    market_id: &str,
    subscriptions: ActiveSubscriptions,
) -> Result<()> {
    let mut subs = subscriptions.write().await;
    
    if let Some(subscription) = subs.remove(market_id) {
        // Send unsubscribe signal
        let _ = subscription.control_tx.send(SubscriptionControl::Unsubscribe).await;
        
        // Abort the task if it doesn't stop gracefully
        subscription.task_handle.abort();
        
        println!("Unsubscribed from orderbook for {}", market_id);
    }
    
    Ok(())
}

/// Unsubscribe from all orderbooks
pub async fn unsubscribe_all(subscriptions: ActiveSubscriptions) -> Result<()> {
    let mut subs = subscriptions.write().await;
    
    for (market_id, subscription) in subs.drain() {
        let _ = subscription.control_tx.send(SubscriptionControl::Unsubscribe).await;
        subscription.task_handle.abort();
        println!("Unsubscribed from orderbook for {}", market_id);
    }
    
    Ok(())
}

/// Get list of active subscriptions
pub async fn get_active_subscriptions(subscriptions: ActiveSubscriptions) -> Vec<(String, String)> {
    let subs = subscriptions.read().await;
    subs.values()
        .map(|s| (s.market_id.clone(), s.platform.as_str().to_string()))
        .collect()
}

// ============================================================================
// INITIALIZATION
// ============================================================================

/// Create the shared subscriptions state
pub fn create_subscriptions_state() -> ActiveSubscriptions {
    Arc::new(RwLock::new(HashMap::new()))
}
