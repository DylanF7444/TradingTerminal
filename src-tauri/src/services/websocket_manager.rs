// ============================================================================
// CONSOLIDATED WEBSOCKET STREAM MANAGER
// ============================================================================
//
// Module: services/websocket_manager.rs
// Purpose: Manage consolidated WebSocket connections per platform
//
// OVERVIEW:
// This module implements a connection pooling system for WebSocket streams.
// Instead of creating a new WebSocket connection for each market/channel,
// it maintains a single connection per platform and multiplexes subscriptions.
//
// BENEFITS:
// - Reduced connection overhead (1 connection per platform vs 1 per market)
// - Efficient subscription management (add/remove channels without reconnecting)
// - Better resource utilization (shared event loop, single heartbeat)
// - Simplified error handling and reconnection logic
//
// ARCHITECTURE:
// ┌─────────────────────────────────────────────────────────────────┐
// │                    WebSocketManager                              │
// ├─────────────────────────────────────────────────────────────────┤
// │  polymarket_connection: Option<PlatformConnection>              │
// │  kalshi_connection: Option<PlatformConnection>                  │
// │  binance_connection: Option<PlatformConnection>                 │
// └─────────────────────────────────────────────────────────────────┘
//                           │
//                           ▼
// ┌─────────────────────────────────────────────────────────────────┐
// │                    PlatformConnection                            │
// ├─────────────────────────────────────────────────────────────────┤
// │  task_handle: JoinHandle                                        │
// │  command_tx: mpsc::Sender<ConnectionCommand>                    │
// │  subscribed_channels: HashSet<String>                           │
// │  platform: Platform                                             │
// └─────────────────────────────────────────────────────────────────┘
//
// FLOW:
// 1. subscribe_market(platform, market_id) called
// 2. Check if platform connection exists
//    - If not, create new connection with initial subscription
//    - If yes, send AddSubscription command to update subscriptions
// 3. Connection task receives command, sends subscribe message to WebSocket
// 4. Messages received are parsed and emitted to frontend with market_id
//
// ============================================================================

use anyhow::{Result, anyhow};
use serde::{Serialize, Deserialize};
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::{RwLock, mpsc};
use tokio::time::Duration;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use futures_util::{SinkExt, StreamExt};
use tauri::{Emitter, AppHandle};
use chrono::Utc;

use super::orderbook::{
    OrderbookUpdate, OrderbookLevel, RawWebSocketMessage,
    Platform, KalshiCredentials,
    parse_polymarket_market_all, parse_kalshi_message,
    sign_pss_text, load_private_key, create_kalshi_auth_headers,
};

// ============================================================================
// TYPES
// ============================================================================

/// Supported platforms for consolidated connections
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlatformType {
    Polymarket,
    Kalshi,
    Binance,
    Coinbase,
}

impl PlatformType {
    pub fn as_str(&self) -> &'static str {
        match self {
            PlatformType::Polymarket => "polymarket",
            PlatformType::Kalshi => "kalshi",
            PlatformType::Binance => "binance",
            PlatformType::Coinbase => "coinbase",
        }
    }
}

/// Command sent to connection task to manage subscriptions
#[derive(Debug, Clone)]
pub enum ConnectionCommand {
    /// Add a new subscription (market_id/channel)
    AddSubscription { market_id: String },
    /// Remove a subscription
    RemoveSubscription { market_id: String },
    /// Shutdown the connection
    Shutdown,
    /// Force reconnect
    Reconnect,
}

/// Active connection to a platform
pub struct PlatformConnection {
    /// Task handle for the WebSocket connection
    pub task_handle: tokio::task::JoinHandle<()>,
    /// Channel to send commands to the connection task
    pub command_tx: mpsc::Sender<ConnectionCommand>,
    /// Currently subscribed market IDs
    pub subscribed_markets: Arc<RwLock<HashSet<String>>>,
}

/// Global WebSocket manager state
pub struct WebSocketManager {
    /// Active platform connections
    connections: RwLock<HashMap<PlatformType, PlatformConnection>>,
    /// Tauri app handle for emitting events
    app_handle: AppHandle,
    /// Kalshi credentials (if available)
    kalshi_credentials: RwLock<Option<KalshiCredentials>>,
    /// Network bandwidth metrics (shared across all connections)
    network_metrics: Arc<NetworkMetrics>,
}

/// Network bandwidth metrics for tracking data transfer
#[derive(Debug, Default)]
pub struct NetworkMetrics {
    /// Total bytes received via WebSocket
    bytes_received: AtomicU64,
    /// Total bytes sent via WebSocket
    bytes_sent: AtomicU64,
    /// Total messages received
    messages_received: AtomicU64,
    /// Total messages sent
    messages_sent: AtomicU64,
}

impl Clone for NetworkMetrics {
    fn clone(&self) -> Self {
        Self {
            bytes_received: AtomicU64::new(self.bytes_received.load(Ordering::Relaxed)),
            bytes_sent: AtomicU64::new(self.bytes_sent.load(Ordering::Relaxed)),
            messages_received: AtomicU64::new(self.messages_received.load(Ordering::Relaxed)),
            messages_sent: AtomicU64::new(self.messages_sent.load(Ordering::Relaxed)),
        }
    }
}

impl NetworkMetrics {
    pub fn new() -> Self {
        Self::default()
    }
    
    /// Record bytes received
    pub fn record_received(&self, bytes: u64) {
        self.bytes_received.fetch_add(bytes, Ordering::Relaxed);
        self.messages_received.fetch_add(1, Ordering::Relaxed);
    }
    
    /// Record bytes sent
    pub fn record_sent(&self, bytes: u64) {
        self.bytes_sent.fetch_add(bytes, Ordering::Relaxed);
        self.messages_sent.fetch_add(1, Ordering::Relaxed);
    }
    
    /// Get current metrics snapshot
    pub fn get_snapshot(&self) -> NetworkMetricsSnapshot {
        NetworkMetricsSnapshot {
            bytes_received: self.bytes_received.load(Ordering::Relaxed),
            bytes_sent: self.bytes_sent.load(Ordering::Relaxed),
            messages_received: self.messages_received.load(Ordering::Relaxed),
            messages_sent: self.messages_sent.load(Ordering::Relaxed),
        }
    }
    
    /// Reset all counters
    pub fn reset(&self) {
        self.bytes_received.store(0, Ordering::Relaxed);
        self.bytes_sent.store(0, Ordering::Relaxed);
        self.messages_received.store(0, Ordering::Relaxed);
        self.messages_sent.store(0, Ordering::Relaxed);
    }
}

/// Snapshot of network metrics for frontend display
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkMetricsSnapshot {
    pub bytes_received: u64,
    pub bytes_sent: u64,
    pub messages_received: u64,
    pub messages_sent: u64,
}

// ============================================================================
// POLYMARKET CONSOLIDATED CONNECTION (FIXED)
// ============================================================================
//
// Uses the correct Polymarket CLOB WebSocket endpoint and subscription format.
// Subscription: { "assets_ids": ["<token_id>"], "type": "market" }
// Keepalive: Send "PING", expect "PONG" text response.
// ============================================================================

/// Polymarket CLOB WebSocket endpoint (market/orderbook/trade data)
const POLYMARKET_WS_URL: &str = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

/// Polymarket subscription message format
#[derive(Debug, Serialize)]
struct PolymarketSubscribe {
    #[serde(rename = "assets_ids")]
    assets_ids: Vec<String>,
    #[serde(rename = "type")]
    msg_type: String,
}

/// Run a consolidated Polymarket WebSocket connection
async fn run_polymarket_consolidated(
    app_handle: AppHandle,
    mut command_rx: mpsc::Receiver<ConnectionCommand>,
    subscribed_markets: Arc<RwLock<HashSet<String>>>,
    network_metrics: Arc<NetworkMetrics>,
) {
    let mut retry_count = 0u32;
    let max_retries = 10u32;
    
    println!("[Polymarket Consolidated] Starting connection manager");
    
    // Current WebSocket state
    let mut ws_sender: Option<futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, WsMessage>> = None;
    let mut ws_receiver: Option<futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>> = None;
    
    loop {
        tokio::select! {
            // Handle commands from manager
            cmd = command_rx.recv() => {
                match cmd {
                    Some(ConnectionCommand::AddSubscription { market_id }) => {
                        // Add to subscribed set
                        {
                            let mut subs = subscribed_markets.write().await;
                            subs.insert(market_id.clone());
                        }
                        
                        // If connected, send subscription update
                        if let Some(ref mut sender) = ws_sender {
                            let subs = subscribed_markets.read().await;
                            let all_markets: Vec<String> = subs.iter().cloned().collect();
                            
                            let subscribe_msg = PolymarketSubscribe {
                                assets_ids: all_markets,
                                msg_type: "market".to_string(),
                            };
                            
                            if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                println!("[Polymarket Consolidated] Sending subscription update: {}", json);
                                let _ = sender.send(WsMessage::Text(json)).await;
                            }
                        } else {
                            // Trigger reconnection
                            println!("[Polymarket Consolidated] No connection, triggering connect");
                            retry_count = 0;
                        }
                    }
                    Some(ConnectionCommand::RemoveSubscription { market_id }) => {
                        // Remove from subscribed set
                        {
                            let mut subs = subscribed_markets.write().await;
                            subs.remove(&market_id);
                        }
                        
                        // If connected and still have subscriptions, update
                        if let Some(ref mut sender) = ws_sender {
                            let subs = subscribed_markets.read().await;
                            
                            if subs.is_empty() {
                                // No more subscriptions, close connection
                                println!("[Polymarket Consolidated] No more subscriptions, closing connection");
                                let _ = sender.close().await;
                                ws_sender = None;
                                ws_receiver = None;
                            } else {
                                // Update subscription with remaining markets
                                let all_markets: Vec<String> = subs.iter().cloned().collect();
                                let subscribe_msg = PolymarketSubscribe {
                                    assets_ids: all_markets,
                                    msg_type: "market".to_string(),
                                };
                                
                                if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                    println!("[Polymarket Consolidated] Sending updated subscription: {}", json);
                                    let _ = sender.send(WsMessage::Text(json)).await;
                                }
                            }
                        }
                    }
                    Some(ConnectionCommand::Shutdown) | None => {
                        println!("[Polymarket Consolidated] Shutdown command received");
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        break;
                    }
                    Some(ConnectionCommand::Reconnect) => {
                        println!("[Polymarket Consolidated] Reconnect command received");
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        ws_sender = None;
                        ws_receiver = None;
                        retry_count = 0;
                    }
                }
            }
            
            // Handle incoming WebSocket messages
            msg = async {
                if let Some(ref mut receiver) = ws_receiver {
                    receiver.next().await
                } else {
                    // No connection, wait a bit
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    None
                }
            } => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        // Record network bandwidth (received)
                        network_metrics.record_received(text.len() as u64);

                        // Parse and emit message
                        if text == "PONG" {
                            continue;
                        }

                        // Get all subscribed asset IDs for the market endpoint parser
                        let all_asset_ids: Vec<String> = {
                            let subs = subscribed_markets.read().await;
                            subs.iter().cloned().collect()
                        };

                        // Try to determine which market this message is for (for raw msg emission)
                        if let Ok(value) = serde_json::from_str::<JsonValue>(&text) {
                            // Emit raw message for single-object messages
                            let asset_id = value.get("asset_id")
                                .and_then(|v| v.as_str())
                                .or_else(|| value.get("market").and_then(|v| v.as_str()))
                                .map(|s| s.to_string());

                            if let Some(ref aid) = asset_id {
                                 let raw_msg = RawWebSocketMessage {
                                     market_id: aid.clone(),
                                     platform: "polymarket".to_string(),
                                     raw_message: text.clone(),
                                     timestamp: Utc::now().timestamp_millis(),
                                     msg_type: value.get("event_type").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                 };
                                 let _ = app_handle.emit("orderbook:raw", &raw_msg);
                            }

                            // For array messages (initial book snapshots), emit raw for each element
                            if let Some(arr) = value.as_array() {
                                for item in arr {
                                    if let Some(aid) = item.get("asset_id").and_then(|v| v.as_str()) {
                                        let raw_msg = RawWebSocketMessage {
                                            market_id: aid.to_string(),
                                            platform: "polymarket".to_string(),
                                            raw_message: item.to_string(),
                                            timestamp: Utc::now().timestamp_millis(),
                                            msg_type: item.get("event_type").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                        };
                                        let _ = app_handle.emit("orderbook:raw", &raw_msg);
                                    }
                                }
                            }
                        }

                        // Parse as orderbook update using the market endpoint parser
                        // This handles both arrays (initial snapshots for all tokens)
                        // and single objects (incremental updates)
                        match parse_polymarket_market_all(&text, &all_asset_ids) {
                            Ok(updates) => {
                                println!("[Polymarket Market] Received {} update(s): {:?}", updates.len(), updates);
                                for update in updates {
                                    if let Err(e) = app_handle.emit("orderbook:update", &update) {
                                        eprintln!("[Polymarket Consolidated] Failed to emit update: {}", e);
                                    }
                                }
                            }
                            Err(e) => {
                                eprintln!("[Polymarket Consolidated] Parse error: {}", e);
                            }
                        }
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.send(WsMessage::Pong(data)).await;
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) => {
                        println!("[Polymarket Consolidated] Connection closed by server");
                        ws_sender = None;
                        ws_receiver = None;
                    }
                    Some(Err(e)) => {
                        eprintln!("[Polymarket Consolidated] WebSocket error: {}", e);
                        ws_sender = None;
                        ws_receiver = None;
                    }
                    _ => {}
                }
            }
            
            // Connection maintenance - reconnect if needed
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                // Check if we need to connect/reconnect
                if ws_sender.is_none() && ws_receiver.is_none() {
                    let subs = subscribed_markets.read().await;
                    if !subs.is_empty() {
                        println!("[Polymarket Consolidated] Attempting connection (retry {})", retry_count);
                        
                        let all_markets: Vec<String> = subs.iter().cloned().collect();
                        drop(subs);
                        
                        match connect_async(POLYMARKET_WS_URL).await {
                            Ok((ws_stream, _)) => {
                                println!("[Polymarket Consolidated] Connected successfully");
                                let (sender, receiver) = ws_stream.split();
                                ws_sender = Some(sender);
                                ws_receiver = Some(receiver);
                                
                                // Send initial subscription
                                if let Some(ref mut sender) = ws_sender {
                                    let subscribe_msg = PolymarketSubscribe {
                                        assets_ids: all_markets,
                                        msg_type: "market".to_string(),
                                    };
                                    if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                        println!("[Polymarket Consolidated] Sending initial subscription: {}", json);
                                        let _ = sender.send(WsMessage::Text(json)).await;
                                    }
                                }
                                
                                retry_count = 0;
                            }
                            Err(e) => {
                                eprintln!("[Polymarket Consolidated] Connection failed: {}", e);
                                retry_count += 1;
                                if retry_count >= max_retries {
                                    eprintln!("[Polymarket Consolidated] Max retries reached");
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    println!("[Polymarket Consolidated] Connection manager exiting");
}

// ============================================================================
// KALSHI CONSOLIDATED CONNECTION
// ============================================================================

const KALSHI_WS_URL: &str = "wss://api.elections.kalshi.com/trade-api/ws/v2";
const KALSHI_DEMO_WS_URL: &str = "wss://demo-api.kalshi.com/trade-api/ws/v2";

/// Kalshi subscription message
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

/// Run a consolidated Kalshi WebSocket connection
async fn run_kalshi_consolidated(
    app_handle: AppHandle,
    mut command_rx: mpsc::Receiver<ConnectionCommand>,
    subscribed_markets: Arc<RwLock<HashSet<String>>>,
    credentials: Option<KalshiCredentials>,
    network_metrics: Arc<NetworkMetrics>,
) {
    let mut retry_count = 0u32;
    let max_retries = 10u32;
    
    println!("[Kalshi Consolidated] Starting connection manager");
    
    // Current WebSocket state
    let mut ws_sender: Option<futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, WsMessage>> = None;
    let mut ws_receiver: Option<futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>> = None;
    
    // Orderbook state per market (Kalshi sends deltas)
    let mut orderbook_state: HashMap<String, (Vec<OrderbookLevel>, Vec<OrderbookLevel>)> = HashMap::new();
    let mut sequence: u64 = 0;
    let mut subscription_id: u64 = 1;
    
    loop {
        tokio::select! {
            // Handle commands from manager
            cmd = command_rx.recv() => {
                match cmd {
                    Some(ConnectionCommand::AddSubscription { market_id }) => {
                        // Add to subscribed set
                        {
                            let mut subs = subscribed_markets.write().await;
                            subs.insert(market_id.clone());
                        }
                        
                        // Initialize orderbook state for this market
                        orderbook_state.entry(market_id.clone()).or_insert_with(|| (Vec::new(), Vec::new()));
                        
                        // If connected, send subscription message for this market
                        if let Some(ref mut sender) = ws_sender {
                            // Subscribe to orderbook_delta and trade channels
                            let channels = if credentials.is_some() {
                                vec!["orderbook_delta".to_string(), "trade".to_string()]
                            } else {
                                vec!["ticker".to_string(), "trade".to_string()]
                            };
                            
                            let subscribe_msg = KalshiSubscribe {
                                id: subscription_id,
                                cmd: "subscribe".to_string(),
                                params: KalshiSubscribeParams {
                                    channels,
                                    market_ticker: market_id.clone(),
                                },
                            };
                            subscription_id += 1;
                            
                            if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                println!("[Kalshi Consolidated] Sending subscription: {}", json);
                                let _ = sender.send(WsMessage::Text(json)).await;
                            }
                        } else {
                            // Trigger connection
                            println!("[Kalshi Consolidated] No connection, will connect");
                            retry_count = 0;
                        }
                    }
                    Some(ConnectionCommand::RemoveSubscription { market_id }) => {
                        // Remove from subscribed set
                        {
                            let mut subs = subscribed_markets.write().await;
                            subs.remove(&market_id);
                        }
                        
                        // Remove orderbook state
                        orderbook_state.remove(&market_id);
                        
                        // If connected, send unsubscribe
                        if let Some(ref mut sender) = ws_sender {
                            let subscribe_msg = KalshiSubscribe {
                                id: subscription_id,
                                cmd: "unsubscribe".to_string(),
                                params: KalshiSubscribeParams {
                                    channels: vec!["orderbook_delta".to_string(), "trade".to_string(), "ticker".to_string()],
                                    market_ticker: market_id.clone(),
                                },
                            };
                            subscription_id += 1;
                            
                            if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                println!("[Kalshi Consolidated] Sending unsubscribe: {}", json);
                                let _ = sender.send(WsMessage::Text(json)).await;
                            }
                        }
                        
                        // Check if we should close connection
                        let subs = subscribed_markets.read().await;
                        if subs.is_empty() {
                            println!("[Kalshi Consolidated] No more subscriptions, closing connection");
                            if let Some(ref mut sender) = ws_sender {
                                let _ = sender.close().await;
                            }
                            ws_sender = None;
                            ws_receiver = None;
                        }
                    }
                    Some(ConnectionCommand::Shutdown) | None => {
                        println!("[Kalshi Consolidated] Shutdown command received");
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        break;
                    }
                    Some(ConnectionCommand::Reconnect) => {
                        println!("[Kalshi Consolidated] Reconnect command received");
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        ws_sender = None;
                        ws_receiver = None;
                        retry_count = 0;
                    }
                }
            }
            
            // Handle incoming WebSocket messages
            msg = async {
                if let Some(ref mut receiver) = ws_receiver {
                    receiver.next().await
                } else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    None
                }
            } => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        // Record network bandwidth (received)
                        network_metrics.record_received(text.len() as u64);
                        
                        // Parse message to determine market
                        if let Ok(value) = serde_json::from_str::<JsonValue>(&text) {
                            let market_ticker = value.get("market_ticker")
                                .and_then(|v| v.as_str())
                                .or_else(|| value.get("msg").and_then(|m| m.get("market_ticker")).and_then(|v| v.as_str()))
                                .map(|s| s.to_string());
                            
                            if let Some(ticker) = market_ticker {
                                // Emit raw message
                                let raw_msg = RawWebSocketMessage {
                                    market_id: ticker.clone(),
                                    platform: "kalshi".to_string(),
                                    raw_message: text.clone(),
                                    timestamp: Utc::now().timestamp_millis(),
                                    msg_type: value.get("type").and_then(|v| v.as_str()).map(|s| s.to_string()),
                                };
                                let _ = app_handle.emit("orderbook:raw", &raw_msg);
                                
                                // Parse message
                                let (bids, asks) = orderbook_state.entry(ticker.clone()).or_insert_with(|| (Vec::new(), Vec::new()));
                                
                                match parse_kalshi_message(&text, &ticker, bids, asks, &mut sequence) {
                                    Ok(Some(update)) => {
                                        if let Err(e) = app_handle.emit("orderbook:update", &update) {
                                            eprintln!("[Kalshi Consolidated] Failed to emit update: {}", e);
                                        }
                                    }
                                    Ok(None) => {}
                                    Err(e) => {
                                        eprintln!("[Kalshi Consolidated] Parse error: {}", e);
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.send(WsMessage::Pong(data)).await;
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) => {
                        println!("[Kalshi Consolidated] Connection closed by server");
                        ws_sender = None;
                        ws_receiver = None;
                    }
                    Some(Err(e)) => {
                        eprintln!("[Kalshi Consolidated] WebSocket error: {}", e);
                        ws_sender = None;
                        ws_receiver = None;
                    }
                    _ => {}
                }
            }
            
            // Connection maintenance
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                if ws_sender.is_none() && ws_receiver.is_none() {
                    let subs = subscribed_markets.read().await;
                    if !subs.is_empty() {
                        println!("[Kalshi Consolidated] Attempting connection (retry {})", retry_count);
                        
                        let markets_to_subscribe: Vec<String> = subs.iter().cloned().collect();
                        drop(subs);
                        
                        // Determine URL and connect
                        let ws_url = if let Some(ref creds) = credentials {
                            if creds.demo { KALSHI_DEMO_WS_URL } else { KALSHI_WS_URL }
                        } else {
                            KALSHI_WS_URL
                        };
                        
                        let connect_result: Result<_, anyhow::Error> = if let Some(ref creds) = credentials {
                            // Connect with auth headers
                            match load_private_key(&creds.private_key_pem) {
                                Ok(private_key) => {
                                    match create_kalshi_auth_headers(&private_key, &creds.api_key, "GET", "/trade-api/ws/v2") {
                                        Ok(auth_headers) => {
                                            use tokio_tungstenite::tungstenite::client::IntoClientRequest;
                                            use tokio_tungstenite::tungstenite::http::header::HeaderName;
                                            
                                            match ws_url.into_client_request() {
                                                Ok(mut request) => {
                                                    if let Ok(key_header) = "KALSHI-ACCESS-KEY".parse::<HeaderName>() {
                                                        let _ = request.headers_mut().insert(key_header, auth_headers.access_key.parse().unwrap());
                                                    }
                                                    if let Ok(sig_header) = "KALSHI-ACCESS-SIGNATURE".parse::<HeaderName>() {
                                                        let _ = request.headers_mut().insert(sig_header, auth_headers.signature.parse().unwrap());
                                                    }
                                                    if let Ok(ts_header) = "KALSHI-ACCESS-TIMESTAMP".parse::<HeaderName>() {
                                                        let _ = request.headers_mut().insert(ts_header, auth_headers.timestamp.parse().unwrap());
                                                    }
                                                    
                                                    connect_async(request).await.map_err(|e| anyhow!("WebSocket error: {}", e))
                                                }
                                                Err(e) => Err(anyhow!("Failed to create request: {}", e)),
                                            }
                                        }
                                        Err(e) => Err(anyhow!("Auth header error: {}", e)),
                                    }
                                }
                                Err(e) => Err(anyhow!("Key load error: {}", e)),
                            }
                        } else {
                            connect_async(ws_url).await.map_err(|e| anyhow!("WebSocket error: {}", e))
                        };
                        
                        match connect_result {
                            Ok((ws_stream, _)) => {
                                println!("[Kalshi Consolidated] Connected successfully");
                                let (sender, receiver) = ws_stream.split();
                                ws_sender = Some(sender);
                                ws_receiver = Some(receiver);
                                
                                // Subscribe to all markets
                                if let Some(ref mut sender) = ws_sender {
                                    for market_id in &markets_to_subscribe {
                                        let channels = if credentials.is_some() {
                                            vec!["orderbook_delta".to_string(), "trade".to_string()]
                                        } else {
                                            vec!["ticker".to_string(), "trade".to_string()]
                                        };
                                        
                                        let subscribe_msg = KalshiSubscribe {
                                            id: subscription_id,
                                            cmd: "subscribe".to_string(),
                                            params: KalshiSubscribeParams {
                                                channels: channels.clone(),
                                                market_ticker: market_id.clone(),
                                            },
                                        };
                                        subscription_id += 1;
                                        
                                        if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                            println!("[Kalshi Consolidated] Sending subscription for {}: {}", market_id, json);
                                            let _ = sender.send(WsMessage::Text(json)).await;
                                        }
                                    }
                                }
                                
                                retry_count = 0;
                            }
                            Err(e) => {
                                eprintln!("[Kalshi Consolidated] Connection failed: {:?}", e);
                                retry_count += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    
    println!("[Kalshi Consolidated] Connection manager exiting");
}

// ============================================================================
// BINANCE CONSOLIDATED CONNECTION
// ============================================================================

const BINANCE_WS_URL: &str = "wss://stream.binance.com:9443/ws";

/// Binance subscription message
#[derive(Debug, Serialize)]
struct BinanceSubscribe {
    method: String,
    params: Vec<String>,
    id: u64,
}

/// Run a consolidated Binance WebSocket connection
async fn run_binance_consolidated(
    app_handle: AppHandle,
    mut command_rx: mpsc::Receiver<ConnectionCommand>,
    subscribed_markets: Arc<RwLock<HashSet<String>>>,
    network_metrics: Arc<NetworkMetrics>,
) {
    let mut retry_count = 0u32;
    let max_retries = 10u32;
    
    println!("[Binance Consolidated] Starting connection manager");
    
    let mut ws_sender: Option<futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, WsMessage>> = None;
    let mut ws_receiver: Option<futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>> = None;
    let mut request_id: u64 = 1;
    
    loop {
        tokio::select! {
            cmd = command_rx.recv() => {
                match cmd {
                    Some(ConnectionCommand::AddSubscription { market_id }) => {
                        {
                            let mut subs = subscribed_markets.write().await;
                            subs.insert(market_id.clone());
                        }
                        
                        if let Some(ref mut sender) = ws_sender {
                            // Binance uses stream names like "btcusdt@depth"
                            let stream_name = format!("{}@depth", market_id.to_lowercase());
                            let subscribe_msg = BinanceSubscribe {
                                method: "SUBSCRIBE".to_string(),
                                params: vec![stream_name],
                                id: request_id,
                            };
                            request_id += 1;
                            
                            if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                println!("[Binance Consolidated] Sending subscription: {}", json);
                                let _ = sender.send(WsMessage::Text(json)).await;
                            }
                        }
                    }
                    Some(ConnectionCommand::RemoveSubscription { market_id }) => {
                        {
                            let mut subs = subscribed_markets.write().await;
                            subs.remove(&market_id);
                        }
                        
                        if let Some(ref mut sender) = ws_sender {
                            let stream_name = format!("{}@depth", market_id.to_lowercase());
                            let subscribe_msg = BinanceSubscribe {
                                method: "UNSUBSCRIBE".to_string(),
                                params: vec![stream_name],
                                id: request_id,
                            };
                            request_id += 1;
                            
                            if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                println!("[Binance Consolidated] Sending unsubscribe: {}", json);
                                let _ = sender.send(WsMessage::Text(json)).await;
                            }
                        }
                        
                        let subs = subscribed_markets.read().await;
                        if subs.is_empty() {
                            if let Some(ref mut sender) = ws_sender {
                                let _ = sender.close().await;
                            }
                            ws_sender = None;
                            ws_receiver = None;
                        }
                    }
                    Some(ConnectionCommand::Shutdown) | None => {
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        break;
                    }
                    Some(ConnectionCommand::Reconnect) => {
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        ws_sender = None;
                        ws_receiver = None;
                        retry_count = 0;
                    }
                }
            }
            
            msg = async {
                if let Some(ref mut receiver) = ws_receiver {
                    receiver.next().await
                } else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    None
                }
            } => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        // Record network bandwidth (received)
                        network_metrics.record_received(text.len() as u64);
                        
                        // Parse Binance message
                        if let Ok(value) = serde_json::from_str::<JsonValue>(&text) {
                            // Binance includes the stream name which has the symbol
                            let stream = value.get("stream").and_then(|v| v.as_str()).unwrap_or("");
                            let symbol = stream.split('@').next().unwrap_or("").to_uppercase();
                            
                            if !symbol.is_empty() {
                                // Parse depth data
                                let bids = value.get("bids")
                                    .and_then(|b| b.as_array())
                                    .map(|arr| {
                                        arr.iter().filter_map(|level| {
                                            let price = level.get(0)?.as_str()?.parse::<f64>().ok()?;
                                            let size = level.get(1)?.as_str()?.parse::<f64>().ok()?;
                                            Some(OrderbookLevel { price, size, order_count: None })
                                        }).collect()
                                    }).unwrap_or_default();
                                
                                let asks = value.get("asks")
                                    .and_then(|a| a.as_array())
                                    .map(|arr| {
                                        arr.iter().filter_map(|level| {
                                            let price = level.get(0)?.as_str()?.parse::<f64>().ok()?;
                                            let size = level.get(1)?.as_str()?.parse::<f64>().ok()?;
                                            Some(OrderbookLevel { price, size, order_count: None })
                                        }).collect()
                                    }).unwrap_or_default();
                                
                                let update = OrderbookUpdate {
                                    market_id: symbol.clone(),
                                    platform: "binance".to_string(),
                                    bids,
                                    asks,
                                    timestamp: Utc::now().timestamp_millis(),
                                    sequence: value.get("lastUpdateId").and_then(|v| v.as_u64()).unwrap_or(0),
                                    last_price: None,
                                    last_size: None,
                                };
                                
                                let _ = app_handle.emit("orderbook:update", &update);
                            }
                        }
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.send(WsMessage::Pong(data)).await;
                        }
                    }
                    Some(Ok(WsMessage::Close(_))) => {
                        ws_sender = None;
                        ws_receiver = None;
                    }
                    Some(Err(_)) => {
                        ws_sender = None;
                        ws_receiver = None;
                    }
                    _ => {}
                }
            }
            
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                if ws_sender.is_none() && ws_receiver.is_none() {
                    let subs = subscribed_markets.read().await;
                    if !subs.is_empty() {
                        // Build combined stream URL
                        let streams: Vec<String> = subs.iter()
                            .map(|s| format!("{}@depth", s.to_lowercase()))
                            .collect();
                        drop(subs);
                        
                        let url = format!("{}/{}", BINANCE_WS_URL, streams.join("/"));
                        
                        match connect_async(&url).await {
                            Ok((ws_stream, _)) => {
                                println!("[Binance Consolidated] Connected successfully");
                                let (sender, receiver) = ws_stream.split();
                                ws_sender = Some(sender);
                                ws_receiver = Some(receiver);
                                retry_count = 0;
                            }
                            Err(e) => {
                                eprintln!("[Binance Consolidated] Connection failed: {}", e);
                                retry_count += 1;
                            }
                        }
                    }
                }
            }
        }
    }
    
    println!("[Binance Consolidated] Connection manager exiting");
}

// ============================================================================
// COINBASE CONSOLIDATED CONNECTION
// ============================================================================

const COINBASE_WS_URL: &str = "wss://ws-feed.exchange.coinbase.com";

/// Coinbase subscription message format
#[derive(Debug, Serialize)]
struct CoinbaseSubscribe {
    #[serde(rename = "type")]
    msg_type: String,
    product_ids: Vec<String>,
    channels: Vec<String>,
}

/// Coinbase ticker message
#[derive(Debug, Deserialize)]
struct CoinbaseTickerMessage {
    #[serde(rename = "type")]
    msg_type: String,
    product_id: String,
    price: String,
    #[serde(default)]
    best_bid: String,
    #[serde(default)]
    best_ask: String,
    #[serde(default)]
    volume_24h: String,
    time: String,
}

/// Coinbase level2 snapshot message
#[derive(Debug, Deserialize)]
struct CoinbaseLevel2Snapshot {
    #[serde(rename = "type")]
    msg_type: String,
    product_id: String,
    bids: Vec<Vec<String>>,
    asks: Vec<Vec<String>>,
}

/// Coinbase level2 update message
#[derive(Debug, Deserialize)]
struct CoinbaseLevel2Update {
    #[serde(rename = "type")]
    msg_type: String,
    product_id: String,
    changes: Vec<Vec<String>>,
}

/// Run a consolidated Coinbase WebSocket connection
async fn run_coinbase_consolidated(
    app_handle: AppHandle,
    mut command_rx: mpsc::Receiver<ConnectionCommand>,
    subscribed_markets: Arc<RwLock<HashSet<String>>>,
    network_metrics: Arc<NetworkMetrics>,
) {
    let mut retry_count = 0u32;
    let max_retries = 10u32;
    
    println!("[Coinbase Consolidated] Starting connection manager");
    
    // Current WebSocket state
    let mut ws_sender: Option<futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, WsMessage>> = None;
    let mut ws_receiver: Option<futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>> = None;
    
    // Orderbook state per market (Coinbase sends incremental updates)
    let mut orderbook_state: HashMap<String, (Vec<OrderbookLevel>, Vec<OrderbookLevel>)> = HashMap::new();
    
    loop {
        tokio::select! {
            // Handle commands from manager
            cmd = command_rx.recv() => {
                match cmd {
                    Some(ConnectionCommand::AddSubscription { market_id }) => {
                        // Add to subscribed set
                        {
                            let mut subs = subscribed_markets.write().await;
                            subs.insert(market_id.clone());
                        }
                        
                        // Initialize orderbook state
                        orderbook_state.entry(market_id.clone()).or_insert_with(|| (Vec::new(), Vec::new()));
                        
                        // If connected, send subscription update
                        if let Some(ref mut sender) = ws_sender {
                            let subs = subscribed_markets.read().await;
                            let all_markets: Vec<String> = subs.iter().cloned().collect();
                            drop(subs);
                            
                            // Subscribe to ticker and level2 channels
                            let subscribe_msg = CoinbaseSubscribe {
                                msg_type: "subscribe".to_string(),
                                product_ids: all_markets,
                                channels: vec![
                                    "ticker".to_string(),
                                    "level2_batch".to_string(),
                                ],
                            };
                            
                            if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                println!("[Coinbase Consolidated] Sending subscription update: {}", json);
                                let _ = sender.send(WsMessage::Text(json)).await;
                            }
                        } else {
                            // Trigger reconnection
                            println!("[Coinbase Consolidated] No connection, triggering connect");
                            retry_count = 0;
                        }
                    }
                    Some(ConnectionCommand::RemoveSubscription { market_id }) => {
                        // Remove from subscribed set
                        {
                            let mut subs = subscribed_markets.write().await;
                            subs.remove(&market_id);
                        }
                        
                        // Remove orderbook state
                        orderbook_state.remove(&market_id);
                        
                        // If connected and still have subscriptions, update
                        if let Some(ref mut sender) = ws_sender {
                            let subs = subscribed_markets.read().await;
                            
                            if subs.is_empty() {
                                // No more subscriptions, close connection
                                println!("[Coinbase Consolidated] No more subscriptions, closing connection");
                                let _ = sender.close().await;
                                ws_sender = None;
                                ws_receiver = None;
                            } else {
                                // Unsubscribe from this market
                                let unsubscribe_msg = CoinbaseSubscribe {
                                    msg_type: "unsubscribe".to_string(),
                                    product_ids: vec![market_id.clone()],
                                    channels: vec!["ticker".to_string(), "level2_batch".to_string()],
                                };
                                
                                if let Ok(json) = serde_json::to_string(&unsubscribe_msg) {
                                    println!("[Coinbase Consolidated] Sending unsubscribe: {}", json);
                                    let _ = sender.send(WsMessage::Text(json)).await;
                                }
                            }
                        }
                    }
                    Some(ConnectionCommand::Shutdown) | None => {
                        println!("[Coinbase Consolidated] Shutdown command received");
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        break;
                    }
                    Some(ConnectionCommand::Reconnect) => {
                        println!("[Coinbase Consolidated] Reconnect command received");
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        ws_sender = None;
                        ws_receiver = None;
                        retry_count = 0;
                    }
                }
            }
            
            // Handle incoming WebSocket messages
            msg = async {
                if let Some(ref mut receiver) = ws_receiver {
                    receiver.next().await
                } else {
                    // No connection, wait a bit
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    None
                }
            } => {
                match msg {
                    Some(Ok(WsMessage::Text(text))) => {
                        // Record network bandwidth (received)
                        network_metrics.record_received(text.len() as u64);
                        
                        // Parse message type
                        if let Ok(value) = serde_json::from_str::<JsonValue>(&text) {
                            let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            let product_id = value.get("product_id").and_then(|v| v.as_str()).map(|s| s.to_string());
                            
                            match msg_type {
                                "ticker" => {
                                    // Handle ticker message
                                    if let Ok(ticker) = serde_json::from_str::<CoinbaseTickerMessage>(&text) {
                                        let price = ticker.price.parse::<f64>().unwrap_or(0.0);
                                        let best_bid = ticker.best_bid.parse::<f64>().ok();
                                        let best_ask = ticker.best_ask.parse::<f64>().ok();
                                        
                                        // Emit price update
                                        let price_update = serde_json::json!({
                                            "symbol": ticker.product_id,
                                            "price": price,
                                            "bid": best_bid,
                                            "ask": best_ask,
                                            "volume_24h": ticker.volume_24h,
                                            "timestamp": ticker.time,
                                            "platform": "coinbase",
                                        });
                                        let _ = app_handle.emit("price:update", &price_update);
                                        
                                        // Also emit raw message for database storage
                                        let raw_msg = RawWebSocketMessage {
                                            market_id: ticker.product_id.clone(),
                                            platform: "coinbase".to_string(),
                                            raw_message: text.clone(),
                                            timestamp: Utc::now().timestamp_millis(),
                                            msg_type: Some("ticker".to_string()),
                                        };
                                        let _ = app_handle.emit("orderbook:raw", &raw_msg);
                                    }
                                }
                                "snapshot" => {
                                    // Handle level2 snapshot
                                    if let Ok(snapshot) = serde_json::from_str::<CoinbaseLevel2Snapshot>(&text) {
                                        let bids: Vec<OrderbookLevel> = snapshot.bids.iter()
                                            .filter_map(|level| {
                                                let price = level.get(0)?.parse::<f64>().ok()?;
                                                let size = level.get(1)?.parse::<f64>().ok()?;
                                                Some(OrderbookLevel { price, size, order_count: None })
                                            })
                                            .collect();
                                        
                                        let asks: Vec<OrderbookLevel> = snapshot.asks.iter()
                                            .filter_map(|level| {
                                                let price = level.get(0)?.parse::<f64>().ok()?;
                                                let size = level.get(1)?.parse::<f64>().ok()?;
                                                Some(OrderbookLevel { price, size, order_count: None })
                                            })
                                            .collect();
                                        
                                        // Update orderbook state
                                        if let Some(state) = orderbook_state.get_mut(&snapshot.product_id) {
                                            *state = (bids.clone(), asks.clone());
                                        }
                                        
                                        let update = OrderbookUpdate {
                                            market_id: snapshot.product_id.clone(),
                                            platform: "coinbase".to_string(),
                                            bids,
                                            asks,
                                            timestamp: Utc::now().timestamp_millis(),
                                            sequence: 0,
                                            last_price: None,
                                            last_size: None,
                                        };
                                        
                                        let _ = app_handle.emit("orderbook:update", &update);
                                    }
                                }
                                "l2update" => {
                                    // Handle level2 update
                                    if let Ok(update_msg) = serde_json::from_str::<CoinbaseLevel2Update>(&text) {
                                        if let Some(state) = orderbook_state.get_mut(&update_msg.product_id) {
                                            let (ref mut bids, ref mut asks) = state;
                                            
                                            for change in &update_msg.changes {
                                                let side = change.get(0).map(|s| s.as_str()).unwrap_or("");
                                                let price = change.get(1).and_then(|p| p.parse::<f64>().ok()).unwrap_or(0.0);
                                                let size = change.get(2).and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0);
                                                
                                                let level = OrderbookLevel { price, size, order_count: None };
                                                
                                                match side {
                                                    "buy" => {
                                                        if size == 0.0 {
                                                            bids.retain(|l| l.price != price);
                                                        } else {
                                                            if let Some(existing) = bids.iter_mut().find(|l| l.price == price) {
                                                                existing.size = size;
                                                            } else {
                                                                bids.push(level);
                                                                bids.sort_by(|a, b| b.price.partial_cmp(&a.price).unwrap_or(std::cmp::Ordering::Equal));
                                                            }
                                                        }
                                                    }
                                                    "sell" => {
                                                        if size == 0.0 {
                                                            asks.retain(|l| l.price != price);
                                                        } else {
                                                            if let Some(existing) = asks.iter_mut().find(|l| l.price == price) {
                                                                existing.size = size;
                                                            } else {
                                                                asks.push(level);
                                                                asks.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal));
                                                            }
                                                        }
                                                    }
                                                    _ => {}
                                                }
                                            }
                                            
                                            // Emit updated orderbook
                                            let update = OrderbookUpdate {
                                                market_id: update_msg.product_id.clone(),
                                                platform: "coinbase".to_string(),
                                                bids: bids.clone(),
                                                asks: asks.clone(),
                                                timestamp: Utc::now().timestamp_millis(),
                                                sequence: 0,
                                                last_price: None,
                                                last_size: None,
                                            };
                                            
                                            let _ = app_handle.emit("orderbook:update", &update);
                                        }
                                    }
                                }
                                "subscriptions" => {
                                    println!("[Coinbase Consolidated] Subscription confirmed: {}", text);
                                }
                                "error" => {
                                    eprintln!("[Coinbase Consolidated] Error from server: {}", text);
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.send(WsMessage::Pong(data)).await;
                        }
                    }
                    Some(Ok(WsMessage::Pong(_))) => {
                        // Pong received, connection is alive
                    }
                    Some(Ok(WsMessage::Close(_))) => {
                        println!("[Coinbase Consolidated] Connection closed by server");
                        ws_sender = None;
                        ws_receiver = None;
                    }
                    Some(Err(e)) => {
                        eprintln!("[Coinbase Consolidated] WebSocket error: {}", e);
                        ws_sender = None;
                        ws_receiver = None;
                    }
                    _ => {}
                }
            }
            
            // Connection maintenance - reconnect if needed
            _ = tokio::time::sleep(Duration::from_secs(5)) => {
                // Check if we need to connect/reconnect
                if ws_sender.is_none() && ws_receiver.is_none() {
                    let subs = subscribed_markets.read().await;
                    if !subs.is_empty() {
                        println!("[Coinbase Consolidated] Attempting connection (retry {})", retry_count);
                        
                        let all_markets: Vec<String> = subs.iter().cloned().collect();
                        drop(subs);
                        
                        match connect_async(COINBASE_WS_URL).await {
                            Ok((ws_stream, _)) => {
                                println!("[Coinbase Consolidated] Connected successfully");
                                let (sender, receiver) = ws_stream.split();
                                ws_sender = Some(sender);
                                ws_receiver = Some(receiver);
                                
                                // Send initial subscription
                                if let Some(ref mut sender) = ws_sender {
                                    let subscribe_msg = CoinbaseSubscribe {
                                        msg_type: "subscribe".to_string(),
                                        product_ids: all_markets,
                                        channels: vec![
                                            "ticker".to_string(),
                                            "level2_batch".to_string(),
                                        ],
                                    };
                                    if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                        println!("[Coinbase Consolidated] Sending initial subscription: {}", json);
                                        let _ = sender.send(WsMessage::Text(json)).await;
                                    }
                                }
                                
                                retry_count = 0;
                            }
                            Err(e) => {
                                eprintln!("[Coinbase Consolidated] Connection failed: {}", e);
                                retry_count += 1;
                                if retry_count >= max_retries {
                                    eprintln!("[Coinbase Consolidated] Max retries reached");
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    
    println!("[Coinbase Consolidated] Connection manager exiting");
}

// ============================================================================
// WEBSOCKET MANAGER IMPLEMENTATION
// ============================================================================

impl WebSocketManager {
    /// Create a new WebSocket manager
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            connections: RwLock::new(HashMap::new()),
            app_handle,
            kalshi_credentials: RwLock::new(None),
            network_metrics: Arc::new(NetworkMetrics::new()),
        }
    }
    
    /// Get network bandwidth metrics snapshot
    pub fn get_network_metrics(&self) -> NetworkMetricsSnapshot {
        self.network_metrics.get_snapshot()
    }
    
    /// Get reference to network metrics for recording
    pub fn network_metrics(&self) -> Arc<NetworkMetrics> {
        self.network_metrics.clone()
    }
    
    /// Set Kalshi credentials
    pub async fn set_kalshi_credentials(&self, credentials: Option<KalshiCredentials>) {
        let mut creds = self.kalshi_credentials.write().await;
        *creds = credentials;
    }
    
    /// Subscribe to a market on a platform
    pub async fn subscribe(&self, platform: PlatformType, market_id: String) -> Result<()> {
        let mut connections = self.connections.write().await;
        
        // Check if we already have a connection for this platform
        if let Some(conn) = connections.get(&platform) {
            // Check if already subscribed
            let subs = conn.subscribed_markets.read().await;
            if subs.contains(&market_id) {
                println!("[WebSocketManager] Already subscribed to {} on {:?}", market_id, platform);
                return Ok(());
            }
            drop(subs);
            
            // Send add subscription command
            conn.command_tx.send(ConnectionCommand::AddSubscription { market_id: market_id.clone() }).await
                .map_err(|e| anyhow!("Failed to send subscription command: {}", e))?;
            
            println!("[WebSocketManager] Added subscription to {} on {:?}", market_id, platform);
        } else {
            // Create new connection
            let (command_tx, command_rx) = mpsc::channel(100);
            let subscribed_markets = Arc::new(RwLock::new(HashSet::new()));
            
            // Add initial subscription
            subscribed_markets.write().await.insert(market_id.clone());
            
            // Spawn platform-specific connection
            let app_handle = self.app_handle.clone();
            let subscribed_markets_clone = subscribed_markets.clone();
            let network_metrics = self.network_metrics();
            
            let task_handle = match platform {
                PlatformType::Polymarket => {
                    tokio::spawn(run_polymarket_consolidated(
                        app_handle,
                        command_rx,
                        subscribed_markets_clone,
                        network_metrics.clone(),
                    ))
                }
                PlatformType::Kalshi => {
                    let creds = self.kalshi_credentials.read().await.clone();
                    tokio::spawn(run_kalshi_consolidated(
                        app_handle,
                        command_rx,
                        subscribed_markets_clone,
                        creds,
                        network_metrics.clone(),
                    ))
                }
                PlatformType::Binance => {
                    tokio::spawn(run_binance_consolidated(
                        app_handle,
                        command_rx,
                        subscribed_markets_clone,
                        network_metrics.clone(),
                    ))
                }
                PlatformType::Coinbase => {
                    tokio::spawn(run_coinbase_consolidated(
                        app_handle,
                        command_rx,
                        subscribed_markets_clone,
                        network_metrics.clone(),
                    ))
                }
            };
            
            let connection = PlatformConnection {
                task_handle,
                command_tx,
                subscribed_markets,
            };
            
            connections.insert(platform, connection);
            println!("[WebSocketManager] Created new {:?} connection for {}", platform, market_id);
        }
        
        Ok(())
    }
    
    /// Unsubscribe from a market
    pub async fn unsubscribe(&self, platform: PlatformType, market_id: &str) -> Result<()> {
        let connections = self.connections.read().await;
        
        if let Some(conn) = connections.get(&platform) {
            // Check if subscribed
            let subs = conn.subscribed_markets.read().await;
            if !subs.contains(market_id) {
                return Ok(());
            }
            drop(subs);
            
            // Send remove subscription command
            conn.command_tx.send(ConnectionCommand::RemoveSubscription { 
                market_id: market_id.to_string() 
            }).await
                .map_err(|e| anyhow!("Failed to send unsubscription command: {}", e))?;
            
            println!("[WebSocketManager] Removed subscription to {} on {:?}", market_id, platform);
        }
        
        Ok(())
    }
    
    /// Unsubscribe from all markets on a platform
    pub async fn unsubscribe_all(&self, platform: PlatformType) -> Result<()> {
        let mut connections = self.connections.write().await;
        
        if let Some(conn) = connections.remove(&platform) {
            conn.command_tx.send(ConnectionCommand::Shutdown).await.ok();
            conn.task_handle.abort();
            println!("[WebSocketManager] Shutdown {:?} connection", platform);
        }
        
        Ok(())
    }
    
    /// Shutdown all connections
    pub async fn shutdown(&self) {
        let mut connections = self.connections.write().await;
        
        for (platform, conn) in connections.drain() {
            conn.command_tx.send(ConnectionCommand::Shutdown).await.ok();
            conn.task_handle.abort();
            println!("[WebSocketManager] Shutdown {:?} connection", platform);
        }
    }
    
    /// Get active subscriptions
    pub async fn get_subscriptions(&self) -> Vec<(PlatformType, Vec<String>)> {
        let connections = self.connections.read().await;
        let mut result = Vec::new();
        
        for (platform, conn) in connections.iter() {
            let subs = conn.subscribed_markets.read().await;
            let markets: Vec<String> = subs.iter().cloned().collect();
            if !markets.is_empty() {
                result.push((*platform, markets));
            }
        }
        
        result
    }
}

/// Create a new WebSocket manager wrapped in Arc for sharing
pub fn create_websocket_manager(app_handle: AppHandle) -> Arc<WebSocketManager> {
    Arc::new(WebSocketManager::new(app_handle))
}