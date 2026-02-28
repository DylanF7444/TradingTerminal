// ============================================================================
// WEBSOCKET SCRAPER SERVICE FOR INFOSOURCE NODES
// ============================================================================
//
// Module: services/websocket_scraper.rs
// Purpose: WebSocket-based data collection for InfoSource nodes
//
// OVERVIEW:
// This module implements WebSocket-based data ingestion for InfoSource nodes
// that support real-time streaming (e.g., Coinbase for crypto prices).
// Unlike HTTP polling scrapers, WebSocket scrapers maintain persistent connections
// and receive data as it becomes available.
//
// KEY FEATURES:
// - Real-time data streaming via WebSocket
// - Timeframe-based metric storage (aggregate over interval)
// - Automatic reconnection with exponential backoff
// - Graceful shutdown handling
// - Per-node subscription management
//
// ARCHITECTURE:
// ┌─────────────────────────────────────────────────────────────────┐
// │                    WebSocketScraperManager                       │
// ├─────────────────────────────────────────────────────────────────┤
// │  connections: HashMap<NodeId, WebSocketConnection>              │
// │  storage_intervals: HashMap<NodeId, StorageConfig>              │
// │  pending_data: HashMap<NodeId, Vec<DataPoint>>                 │
// └─────────────────────────────────────────────────────────────────┘
//
// FLOW:
// 1. spawn_websocket_scraper() called with node config
// 2. Connect to WebSocket endpoint (e.g., Coinbase)
// 3. Subscribe to channels (ticker, level2) for configured symbols
// 4. On message: Update in-memory state, emit to frontend
// 5. On storage interval: Batch write accumulated data to SQLite
// 6. On shutdown: Close connection, flush pending data
//
// STORAGE INTERVAL:
// To prevent excessive database writes, data is accumulated in memory
// and only written to SQLite at the configured storage interval.
// For example, with storageIntervalMs=60000 (1 minute):
// - Real-time price updates are received every ~100ms
// - Frontend receives all updates via events
// - Database only stores aggregated data once per minute
//
// ============================================================================

use anyhow::{Result, anyhow};
use serde::{Serialize, Deserialize};
use serde_json::Value as JsonValue;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{RwLock, mpsc, Mutex};
use tokio::time::interval;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use futures_util::{SinkExt, StreamExt};
use tauri::{Window, Emitter, AppHandle};
use chrono::Utc;

use crate::models::node::InfoSourceType;
use crate::db::sqlite::{insert_timeseries, Connection};
use crate::services::websocket_manager::NetworkMetrics;

// ============================================================================
// TYPES
// ============================================================================

/// Configuration for WebSocket-based scraper
#[derive(Debug, Clone)]
pub struct WebSocketScraperConfig {
    /// Node ID for tracking
    pub node_id: String,
    /// InfoSource type (must support WebSocket)
    pub source_type: InfoSourceType,
    /// Provider (e.g., "coinbase")
    pub provider: String,
    /// Symbols to subscribe to (e.g., ["BTC-USD", "ETH-USD"])
    pub symbols: Vec<String>,
    /// Storage interval in milliseconds (how often to write to DB)
    pub storage_interval_ms: u64,
    /// Include orderbook data
    pub include_orderbook: bool,
    /// Orderbook depth
    pub orderbook_depth: usize,
    /// Network metrics for bandwidth tracking
    pub network_metrics: Arc<NetworkMetrics>,
}

/// Handle to a running WebSocket scraper
pub struct WebSocketScraperHandle {
    /// Task handle for the WebSocket connection
    pub join_handle: tokio::task::JoinHandle<()>,
    /// Channel to send commands to the scraper
    pub command_tx: mpsc::Sender<ScraperCommand>,
}

/// Commands for controlling the WebSocket scraper
#[derive(Debug, Clone)]
pub enum ScraperCommand {
    /// Add symbols to subscription
    AddSymbols(Vec<String>),
    /// Remove symbols from subscription
    RemoveSymbols(Vec<String>),
    /// Update storage interval
    SetStorageInterval(u64),
    /// Graceful shutdown
    Shutdown,
}

/// Data point accumulated for storage
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccumulatedDataPoint {
    pub metric_type: String,
    pub value: f64,
    pub timestamp: i64,
    pub metadata: Option<JsonValue>,
}

/// Aggregated data for storage interval
#[derive(Debug, Clone, Default)]
pub struct AggregatedData {
    /// Price data: symbol -> (prices, volumes)
    pub prices: HashMap<String, Vec<(f64, f64, i64)>>, // (price, volume, timestamp)
    /// Orderbook snapshots: symbol -> (bids, asks, timestamp)
    pub orderbooks: HashMap<String, (Vec<(f64, f64)>, Vec<(f64, f64)>, i64)>, // (price, size)
}

// ============================================================================
// COINBASE WEBSOCKET IMPLEMENTATION
// ============================================================================

const COINBASE_WS_URL: &str = "wss://ws-feed.exchange.coinbase.com";

/// Coinbase subscription message
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
    volume_24h: String,
    #[serde(default)]
    best_bid: String,
    #[serde(default)]
    best_ask: String,
    time: String,
}

/// Run a Coinbase WebSocket scraper for an InfoSource node
pub async fn run_coinbase_scraper(
    config: WebSocketScraperConfig,
    db: Arc<Mutex<Connection>>,
    window: Window,
    mut command_rx: mpsc::Receiver<ScraperCommand>,
) {
    let mut retry_count = 0u32;
    let max_retries = 10u32;
    
    println!("[Coinbase Scraper {}] Starting", config.node_id);
    
    // Current WebSocket state
    let mut ws_sender: Option<futures_util::stream::SplitSink<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>, WsMessage>> = None;
    let mut ws_receiver: Option<futures_util::stream::SplitStream<tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>>> = None;
    
    // Current subscriptions
    let mut subscribed_symbols: Vec<String> = config.symbols.clone();
    
    // Aggregated data for storage
    let mut aggregated = AggregatedData::default();
    let mut last_storage_time = std::time::Instant::now();
    let storage_interval = Duration::from_millis(config.storage_interval_ms);
    let mut storage_timer = interval(storage_interval);
    
    // Connection maintenance interval (every 5 seconds)
    let mut connection_timer = interval(Duration::from_secs(5));
    
    loop {
        // DEBUG: Log loop iteration
        println!("[Coinbase Scraper {}] Loop iteration", config.node_id);
        
        tokio::select! {
            // Handle commands
            cmd = command_rx.recv() => {
                match cmd {
                    Some(ScraperCommand::AddSymbols(symbols)) => {
                        // DEBUG: Print add symbols command
                        println!("[Coinbase Scraper {}] AddSymbols command: {:?}", config.node_id, symbols);
                        
                        for symbol in &symbols {
                            if !subscribed_symbols.contains(symbol) {
                                subscribed_symbols.push(symbol.clone());
                            }
                        }
                        
                        if let Some(ref mut sender) = ws_sender {
                            let subscribe_msg = CoinbaseSubscribe {
                                msg_type: "subscribe".to_string(),
                                product_ids: symbols.clone(),
                                channels: vec!["ticker".to_string()],
                            };
                            if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                println!("[Coinbase Scraper {}] Dynamic subscribe: {}", config.node_id, json);
                                let _ = sender.send(WsMessage::Text(json.clone())).await;
                                config.network_metrics.record_sent(json.len() as u64);
                            }
                        }
                    }
                    Some(ScraperCommand::RemoveSymbols(symbols)) => {
                        // DEBUG: Print remove symbols command
                        println!("[Coinbase Scraper {}] RemoveSymbols command: {:?}", config.node_id, symbols);
                        
                        subscribed_symbols.retain(|s| !symbols.contains(s));
                        
                        if let Some(ref mut sender) = ws_sender {
                            let unsubscribe_msg = CoinbaseSubscribe {
                                msg_type: "unsubscribe".to_string(),
                                product_ids: symbols,
                                channels: vec!["ticker".to_string()],
                            };
                            if let Ok(json) = serde_json::to_string(&unsubscribe_msg) {
                                println!("[Coinbase Scraper {}] Dynamic unsubscribe: {}", config.node_id, json);
                                let _ = sender.send(WsMessage::Text(json.clone())).await;
                                config.network_metrics.record_sent(json.len() as u64);
                            }
                        }
                    }
                    Some(ScraperCommand::SetStorageInterval(ms)) => {
                        storage_timer = interval(Duration::from_millis(ms));
                        println!("[Coinbase Scraper {}] Storage interval updated to {}ms", config.node_id, ms);
                    }
                    Some(ScraperCommand::Shutdown) | None => {
                        println!("[Coinbase Scraper {}] Shutdown command received", config.node_id);
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        
                        // Flush remaining data
                        flush_aggregated_data(&db, &config.node_id, &aggregated).await;
                        break;
                    }
                }
            }
            
            // Handle incoming WebSocket messages (only when connected)
            msg = async {
                if let Some(ref mut receiver) = ws_receiver {
                    receiver.next().await
                } else {
                    futures_util::future::pending::<Option<Result<WsMessage, tokio_tungstenite::tungstenite::Error>>>().await
                }
            } => {
                // DEBUG: We received something from the WebSocket
                println!("[Coinbase Scraper {}] Received WebSocket message", config.node_id);
                
                // When using pending(), the msg is never Some, so this branch runs when pending() doesn't fire
                // But we still need to handle the case - let's check ws_receiver directly
                if let Some(ref mut receiver) = ws_receiver {
                    match receiver.next().await {
                        Some(Ok(WsMessage::Text(text))) => {
                            // Record network bandwidth (received)
                            config.network_metrics.record_received(text.len() as u64);
                            
                            // DEBUG: Print raw WebSocket message
                            println!("[Coinbase Scraper {}] Raw message: {}", config.node_id, text);
                            
                            // Parse message
                            if let Ok(value) = serde_json::from_str::<JsonValue>(&text) {
                                let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                
                                match msg_type {
                                    "ticker" => {
                                        if let Ok(ticker) = serde_json::from_str::<CoinbaseTickerMessage>(&text) {
                                            let price = ticker.price.parse::<f64>().unwrap_or(0.0);
                                            let timestamp = Utc::now().timestamp_millis();
                                            
                                            // DEBUG: Print parsed ticker data
                                            println!("[Coinbase Scraper {}] TICKER: symbol={} price={} bid={} ask={}", 
                                                config.node_id, ticker.product_id, price, ticker.best_bid, ticker.best_ask);
                                            
                                            // Emit to frontend immediately
                                            let price_update = serde_json::json!({
                                                "nodeId": config.node_id,
                                                "symbol": ticker.product_id,
                                                "price": price,
                                                "bid": ticker.best_bid.parse::<f64>().ok(),
                                                "ask": ticker.best_ask.parse::<f64>().ok(),
                                                "volume_24h": ticker.volume_24h,
                                                "timestamp": timestamp,
                                                "source": "coinbase",
                                            });
                                            let _ = window.emit("infosource:update", &price_update);
                                            
                                            // Accumulate for storage
                                            let entry = aggregated.prices.entry(ticker.product_id).or_insert_with(Vec::new);
                                            entry.push((price, 0.0, timestamp)); // volume not in ticker
                                        }
                                    }
                                    "subscriptions" => {
                                        println!("[Coinbase Scraper {}] Subscription confirmed: {}", config.node_id, text);
                                    }
                                    "error" => {
                                        eprintln!("[Coinbase Scraper {}] Error from server: {}", config.node_id, text);
                                    }
                                    _ => {
                                        // DEBUG: Print unknown message type
                                        println!("[Coinbase Scraper {}] Unknown message type: {}", config.node_id, msg_type);
                                    }
                                }
                            }
                        }
                        Some(Ok(WsMessage::Ping(data))) => {
                            if let Some(ref mut sender) = ws_sender {
                                let _ = sender.send(WsMessage::Pong(data.clone())).await;
                                config.network_metrics.record_sent(data.len() as u64);
                            }
                        }
                        Some(Ok(WsMessage::Close(_))) => {
                            println!("[Coinbase Scraper {}] Connection closed by server", config.node_id);
                            ws_sender = None;
                            ws_receiver = None;
                        }
                        Some(Err(e)) => {
                            eprintln!("[Coinbase Scraper {}] WebSocket error: {}", config.node_id, e);
                            ws_sender = None;
                            ws_receiver = None;
                        }
                        None => {
                            // Stream ended
                            println!("[Coinbase Scraper {}] WebSocket stream ended", config.node_id);
                            ws_sender = None;
                            ws_receiver = None;
                        }
                        _ => {}
                    }
                }
            }
            
            // Storage interval tick - write accumulated data to DB
            _ = storage_timer.tick() => {
                if !aggregated.prices.is_empty() {
                    flush_aggregated_data(&db, &config.node_id, &aggregated).await;
                    aggregated = AggregatedData::default();
                }
            }
            
            // Connection maintenance
            _ = connection_timer.tick() => {
                // DEBUG: Log the connection maintenance check
                println!("[Coinbase Scraper {}] Connection maintenance check: ws_sender={:?} ws_receiver={:?} symbols={:?}", 
                    config.node_id, ws_sender.is_some(), ws_receiver.is_some(), subscribed_symbols);
                
                if ws_sender.is_none() && ws_receiver.is_none() && !subscribed_symbols.is_empty() {
                    println!("[Coinbase Scraper {}] Attempting connection (retry {})", config.node_id, retry_count);
                    
                    match connect_async(COINBASE_WS_URL).await {
                        Ok((ws_stream, _)) => {
                            println!("[Coinbase Scraper {}] Connected successfully", config.node_id);
                            let (sender, receiver) = ws_stream.split();
                            ws_sender = Some(sender);
                            ws_receiver = Some(receiver);
                            
                            // Subscribe to symbols
                            if let Some(ref mut sender) = ws_sender {
                                let channels = if config.include_orderbook {
                                    vec!["ticker".to_string(), "level2_batch".to_string()]
                                } else {
                                    vec!["ticker".to_string()]
                                };
                                
                                let subscribe_msg = CoinbaseSubscribe {
                                    msg_type: "subscribe".to_string(),
                                    product_ids: subscribed_symbols.clone(),
                                    channels,
                                };
                                if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                    // DEBUG: Print subscription message being sent
                                    println!("[Coinbase Scraper {}] Sending subscribe: {}", config.node_id, json);
                                    let _ = sender.send(WsMessage::Text(json.clone())).await;
                                    config.network_metrics.record_sent(json.len() as u64);
                                }
                            }
                            
                            retry_count = 0;
                        }
                        Err(e) => {
                            eprintln!("[Coinbase Scraper {}] Connection failed: {}", config.node_id, e);
                            retry_count += 1;
                            if retry_count >= max_retries {
                                eprintln!("[Coinbase Scraper {}] Max retries reached", config.node_id);
                            }
                        }
                    }
                }
            }
        }
    }
    
    println!("[Coinbase Scraper {}] Exiting", config.node_id);
}

/// Flush aggregated data to database
async fn flush_aggregated_data(
    db: &Arc<Mutex<Connection>>,
    node_id: &str,
    aggregated: &AggregatedData,
) {
    let conn = db.lock().await;
    let timestamp = Utc::now().timestamp_millis();
    
    for (symbol, prices) in &aggregated.prices {
        if prices.is_empty() {
            continue;
        }
        
        // Calculate aggregate values - extract prices as f64 values
        let price_values: Vec<f64> = prices.iter().map(|(p, _, _)| *p).collect();
        
        let avg_price = price_values.iter().sum::<f64>() / price_values.len() as f64;
        let min_price = price_values.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_price = price_values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let count = prices.len();
        
        // Store aggregated price data
        let metric_type = format!("price:{}", symbol.to_lowercase());
        let metadata = serde_json::json!({
            "symbol": symbol,
            "avg_price": avg_price,
            "min_price": min_price,
            "max_price": max_price,
            "sample_count": count,
            "source": "coinbase",
            "interval_start": prices.first().map(|(_, _, t)| *t).unwrap_or(timestamp),
            "interval_end": prices.last().map(|(_, _, t)| *t).unwrap_or(timestamp),
        });
        
        if let Err(e) = insert_timeseries(&conn, node_id, &metric_type, avg_price, Some(metadata)) {
            eprintln!("[Coinbase Scraper {}] Failed to insert timeseries: {}", node_id, e);
        }
    }
    
    println!("[Coinbase Scraper {}] Flushed {} symbols to database", node_id, aggregated.prices.len());
}

// ============================================================================
// WEBSOCKET SCRAPER MANAGER
// ============================================================================

/// Manages multiple WebSocket scraper instances
pub struct WebSocketScraperManager {
    /// Active scraper handles by node ID
    scrapers: RwLock<HashMap<String, WebSocketScraperHandle>>,
    /// Database connection
    db: Arc<Mutex<Connection>>,
    /// Tauri window for emitting events
    window: Window,
}

impl WebSocketScraperManager {
    /// Create a new WebSocket scraper manager
    pub fn new(db: Arc<Mutex<Connection>>, window: Window) -> Self {
        Self {
            scrapers: RwLock::new(HashMap::new()),
            db,
            window,
        }
    }
    
    /// Spawn a new WebSocket scraper for a node
    pub async fn spawn(&self, config: WebSocketScraperConfig) -> Result<()> {
        let node_id = config.node_id.clone();
        
        // Check if already running
        let scrapers = self.scrapers.read().await;
        if scrapers.contains_key(&node_id) {
            return Err(anyhow!("Scraper already running for node: {}", node_id));
        }
        drop(scrapers);
        
        // Create command channel
        let (command_tx, command_rx) = mpsc::channel(100);
        
        // Spawn the appropriate scraper based on provider
        let db = self.db.clone();
        let window = self.window.clone();
        
        let join_handle = match config.provider.as_str() {
            "coinbase" => {
                tokio::spawn(run_coinbase_scraper(config, db, window, command_rx))
            }
            _ => {
                return Err(anyhow!("Unsupported WebSocket provider: {}", config.provider));
            }
        };
        
        let handle = WebSocketScraperHandle {
            join_handle,
            command_tx,
        };
        
        // Store handle
        let mut scrapers = self.scrapers.write().await;
        scrapers.insert(node_id.clone(), handle);
        
        println!("[WebSocketScraperManager] Spawned scraper for node: {}", node_id);
        Ok(())
    }
    
    /// Stop a WebSocket scraper
    pub async fn stop(&self, node_id: &str) -> Result<()> {
        let mut scrapers = self.scrapers.write().await;
        
        if let Some(handle) = scrapers.remove(node_id) {
            handle.command_tx.send(ScraperCommand::Shutdown).await.ok();
            handle.join_handle.abort();
            println!("[WebSocketScraperManager] Stopped scraper for node: {}", node_id);
        }
        
        Ok(())
    }
    
    /// Add symbols to a running scraper
    pub async fn add_symbols(&self, node_id: &str, symbols: Vec<String>) -> Result<()> {
        let scrapers = self.scrapers.read().await;
        
        if let Some(handle) = scrapers.get(node_id) {
            handle.command_tx.send(ScraperCommand::AddSymbols(symbols)).await
                .map_err(|e| anyhow!("Failed to send command: {}", e))?;
        }
        
        Ok(())
    }
    
    /// Remove symbols from a running scraper
    pub async fn remove_symbols(&self, node_id: &str, symbols: Vec<String>) -> Result<()> {
        let scrapers = self.scrapers.read().await;
        
        if let Some(handle) = scrapers.get(node_id) {
            handle.command_tx.send(ScraperCommand::RemoveSymbols(symbols)).await
                .map_err(|e| anyhow!("Failed to send command: {}", e))?;
        }
        
        Ok(())
    }
    
    /// Update storage interval for a scraper
    pub async fn set_storage_interval(&self, node_id: &str, interval_ms: u64) -> Result<()> {
        let scrapers = self.scrapers.read().await;
        
        if let Some(handle) = scrapers.get(node_id) {
            handle.command_tx.send(ScraperCommand::SetStorageInterval(interval_ms)).await
                .map_err(|e| anyhow!("Failed to send command: {}", e))?;
        }
        
        Ok(())
    }
    
    /// Stop all scrapers
    pub async fn stop_all(&self) {
        let mut scrapers = self.scrapers.write().await;
        
        for (node_id, handle) in scrapers.drain() {
            handle.command_tx.send(ScraperCommand::Shutdown).await.ok();
            handle.join_handle.abort();
            println!("[WebSocketScraperManager] Stopped scraper for node: {}", node_id);
        }
    }
    
    /// Get list of active scrapers
    pub async fn get_active_scrapers(&self) -> Vec<String> {
        let scrapers = self.scrapers.read().await;
        scrapers.keys().cloned().collect()
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Parse WebSocket scraper config from node metadata
pub fn parse_websocket_config(
    node_id: &str,
    source_type: &InfoSourceType,
    config: &JsonValue,
) -> Result<WebSocketScraperConfig> {
    let provider = config.get("provider")
        .and_then(|v| v.as_str())
        .unwrap_or("coinbase")
        .to_string();
    
    let symbols: Vec<String> = config.get("symbols")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    
    let storage_interval_ms = config.get("storageIntervalMs")
        .and_then(|v| v.as_u64())
        .unwrap_or(60000); // Default: 1 minute
    
    let include_orderbook = config.get("includeOrderbook")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    
    let orderbook_depth = config.get("orderbookDepth")
        .and_then(|v| v.as_u64())
        .unwrap_or(10) as usize;
    
    Ok(WebSocketScraperConfig {
        node_id: node_id.to_string(),
        source_type: source_type.clone(),
        provider,
        symbols,
        storage_interval_ms,
        include_orderbook,
        orderbook_depth,
        network_metrics: Arc::new(NetworkMetrics::new()),
    })
}
