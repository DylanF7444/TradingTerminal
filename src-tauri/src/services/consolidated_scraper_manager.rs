// ============================================================================
// CONSOLIDATED WEBSOCKET SCRAPER MANAGER
// ============================================================================
//
// Purpose: Connection pooling for InfoSource WebSocket scrapers -- one
// connection per provider instead of one per node, with multiplexed
// symbol subscriptions across multiple nodes.
//
// Benefits: reduced connection overhead, shared symbols don't duplicate
// traffic, shared heartbeat, simplified reconnection logic.
//
// ARCHITECTURE:
//   ConsolidatedScraperManager holds one ProviderConnection per provider
//   (coinbase, finnhub, binance). Each ProviderConnection has a Tokio
//   task handle, mpsc command channel, and subscription tracking.
//
// FLOW:
//   subscribe_node(provider, node_id, symbols) -> create or reuse connection
//   -> send Subscribe command -> WebSocket subscribe message
//   -> messages parsed and emitted to frontend with node_id
//   -> data accumulated per-node and stored in node's timeseries
//
// SUBSCRIPTION MODEL:
//   symbol -> HashSet<node_id> mapping ensures:
//   - First node for a symbol: subscribe to provider
//   - Additional nodes: just track, no new subscription needed
//   - Last node unsubscribes: unsubscribe from provider
//   - Events emitted per-node (each subscribed node gets the event)
// ============================================================================

use anyhow::{Result, anyhow};
use serde::Serialize;
use serde_json::Value as JsonValue;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{RwLock, mpsc, Mutex};
use tokio::time::interval;
use tokio_tungstenite::{connect_async, tungstenite::Message as WsMessage};
use futures_util::{SinkExt, StreamExt};
use tauri::{Emitter, AppHandle};
use chrono::Utc;

use crate::db::sqlite::{insert_timeseries, Connection};
use crate::services::websocket_manager::NetworkMetrics;

// ============================================================================
// TYPES
// ============================================================================

/// Supported providers for consolidated scraper connections
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ScraperProviderType {
    /// Coinbase for CryptoPrices
    Coinbase,
    /// Finnhub for FinancialPrices and CommodityPrices (forex pairs)
    Finnhub,
    /// Binance for CommodityPrices (PAXG gold, etc.)
    Binance,
}

impl ScraperProviderType {
    pub fn as_str(&self) -> &'static str {
        match self {
            ScraperProviderType::Coinbase => "coinbase",
            ScraperProviderType::Finnhub => "finnhub",
            ScraperProviderType::Binance => "binance",
        }
    }
}

/// Command sent to provider connection task to manage subscriptions
#[derive(Debug, Clone)]
pub enum ScraperConnectionCommand {
    /// Subscribe a node to symbols
    Subscribe { node_id: String, symbols: Vec<String>, storage_interval_ms: u64 },
    /// Unsubscribe a node from specific symbols
    Unsubscribe { node_id: String, symbols: Vec<String> },
    /// Remove a node entirely (unsubscribe all its symbols)
    RemoveNode { node_id: String },
    /// Update storage interval for a node
    SetStorageInterval { node_id: String, interval_ms: u64 },
    /// Shutdown the connection
    Shutdown,
}

/// Subscription info for a node
#[derive(Debug, Clone)]
pub struct NodeSubscription {
    /// Provider type
    pub provider: ScraperProviderType,
    /// Symbols this node is subscribed to
    pub symbols: HashSet<String>,
    /// Storage interval in milliseconds
    pub storage_interval_ms: u64,
}

/// Active connection to a provider
pub struct ProviderConnection {
    /// Task handle for the WebSocket connection
    pub task_handle: tokio::task::JoinHandle<()>,
    /// Channel to send commands to the connection task
    pub command_tx: mpsc::Sender<ScraperConnectionCommand>,
    /// Symbol -> set of subscribed node IDs
    pub subscriptions: Arc<RwLock<HashMap<String, HashSet<String>>>>,
}

/// Global consolidated scraper manager state
pub struct ConsolidatedScraperManager {
    /// Active provider connections
    connections: RwLock<HashMap<ScraperProviderType, ProviderConnection>>,
    /// Node subscriptions: node_id -> subscription info
    node_subscriptions: RwLock<HashMap<String, NodeSubscription>>,
    /// Tauri app handle for emitting events
    app_handle: AppHandle,
    /// Database for storage
    db: Arc<Mutex<Connection>>,
    /// Finnhub API key (required for Finnhub connections)
    finnhub_api_key: RwLock<Option<String>>,
    /// Network bandwidth metrics (shared across all connections)
    network_metrics: Arc<NetworkMetrics>,
}

impl ConsolidatedScraperManager {
    /// Create a new consolidated scraper manager
    pub fn new(app_handle: AppHandle, db: Arc<Mutex<Connection>>, network_metrics: Arc<NetworkMetrics>) -> Arc<Self> {
        Arc::new(Self {
            connections: RwLock::new(HashMap::new()),
            node_subscriptions: RwLock::new(HashMap::new()),
            app_handle,
            db,
            finnhub_api_key: RwLock::new(None),
            network_metrics,
        })
    }

    /// Set the Finnhub API key (required before subscribing to Finnhub)
    pub async fn set_finnhub_api_key(&self, api_key: String) {
        let mut key = self.finnhub_api_key.write().await;
        *key = Some(api_key);
    }

    /// Get the Finnhub API key
    pub async fn get_finnhub_api_key(&self) -> Option<String> {
        self.finnhub_api_key.read().await.clone()
    }

    /// Subscribe a node to symbols on a provider
    /// 
    /// This is the main entry point. If no connection exists for the provider,
    /// one will be created. The node's symbols are added to the shared subscription.
    pub async fn subscribe(
        self: &Arc<Self>,
        provider: ScraperProviderType,
        node_id: String,
        symbols: Vec<String>,
        storage_interval_ms: u64,
    ) -> Result<()> {
        // Validate Finnhub API key if needed
        if provider == ScraperProviderType::Finnhub {
            let key = self.finnhub_api_key.read().await;
            if key.is_none() {
                return Err(anyhow!("Finnhub API key required. Set it in Settings before using Finnhub data sources."));
            }
        }

        // Update node subscription tracking
        {
            let mut node_subs = self.node_subscriptions.write().await;
            let entry = node_subs.entry(node_id.clone()).or_insert_with(|| NodeSubscription {
                provider,
                symbols: HashSet::new(),
                storage_interval_ms,
            });
            for symbol in &symbols {
                entry.symbols.insert(symbol.clone());
            }
        }

        // Ensure connection exists for this provider
        let needs_connection = {
            let connections = self.connections.read().await;
            !connections.contains_key(&provider)
        };

        if needs_connection {
            self.create_provider_connection(provider).await?;
        }

        // Send subscribe command to the connection
        let connections = self.connections.read().await;
        if let Some(conn) = connections.get(&provider) {
            conn.command_tx.send(ScraperConnectionCommand::Subscribe {
                node_id,
                symbols,
                storage_interval_ms,
            }).await.map_err(|e| anyhow!("Failed to send subscribe command: {}", e))?;
        }

        Ok(())
    }

    /// Unsubscribe a node from specific symbols
    pub async fn unsubscribe(
        &self,
        node_id: &str,
        symbols: Vec<String>,
    ) -> Result<()> {
        // Get the provider for this node
        let provider = {
            let node_subs = self.node_subscriptions.read().await;
            node_subs.get(node_id).map(|s| s.provider)
        };

        let provider = match provider {
            Some(p) => p,
            None => return Ok(()), // Node not subscribed
        };

        // Update node subscription tracking
        {
            let mut node_subs = self.node_subscriptions.write().await;
            if let Some(sub) = node_subs.get_mut(node_id) {
                for symbol in &symbols {
                    sub.symbols.remove(symbol);
                }
                // If no symbols left, remove the node entry
                if sub.symbols.is_empty() {
                    node_subs.remove(node_id);
                }
            }
        }

        // Send unsubscribe command to the connection
        let connections = self.connections.read().await;
        if let Some(conn) = connections.get(&provider) {
            conn.command_tx.send(ScraperConnectionCommand::Unsubscribe {
                node_id: node_id.to_string(),
                symbols,
            }).await.map_err(|e| anyhow!("Failed to send unsubscribe command: {}", e))?;
        }

        Ok(())
    }

    /// Remove a node entirely (unsubscribe from all symbols)
    pub async fn remove_node(&self, node_id: &str) -> Result<()> {
        // Get the provider for this node
        let provider = {
            let mut node_subs = self.node_subscriptions.write().await;
            node_subs.remove(node_id).map(|s| s.provider)
        };

        let provider = match provider {
            Some(p) => p,
            None => return Ok(()), // Node not subscribed
        };

        // Send remove command to the connection
        let connections = self.connections.read().await;
        if let Some(conn) = connections.get(&provider) {
            conn.command_tx.send(ScraperConnectionCommand::RemoveNode {
                node_id: node_id.to_string(),
            }).await.map_err(|e| anyhow!("Failed to send remove node command: {}", e))?;
        }

        Ok(())
    }

    /// Update storage interval for a node
    pub async fn set_storage_interval(&self, node_id: &str, interval_ms: u64) -> Result<()> {
        // Get the provider for this node
        let provider = {
            let mut node_subs = self.node_subscriptions.write().await;
            if let Some(sub) = node_subs.get_mut(node_id) {
                sub.storage_interval_ms = interval_ms;
                Some(sub.provider)
            } else {
                None
            }
        };

        let provider = match provider {
            Some(p) => p,
            None => return Ok(()), // Node not subscribed
        };

        // Send command to the connection
        let connections = self.connections.read().await;
        if let Some(conn) = connections.get(&provider) {
            conn.command_tx.send(ScraperConnectionCommand::SetStorageInterval {
                node_id: node_id.to_string(),
                interval_ms,
            }).await.map_err(|e| anyhow!("Failed to send storage interval command: {}", e))?;
        }

        Ok(())
    }

    /// Get subscription info for a node
    pub async fn get_node_subscription(&self, node_id: &str) -> Option<NodeSubscription> {
        let node_subs = self.node_subscriptions.read().await;
        node_subs.get(node_id).cloned()
    }

    /// Get all subscribed nodes
    pub async fn get_all_subscriptions(&self) -> HashMap<String, NodeSubscription> {
        let node_subs = self.node_subscriptions.read().await;
        node_subs.clone()
    }

    /// Get connection status for all providers
    pub async fn get_connection_status(&self) -> HashMap<String, ConnectionStatus> {
        let connections = self.connections.read().await;
        let mut status = HashMap::new();

        for (provider, conn) in connections.iter() {
            let subs = conn.subscriptions.read().await;
            let total_symbols = subs.len();
            let total_nodes: usize = subs.values().map(|nodes| nodes.len()).sum();
            
            status.insert(provider.as_str().to_string(), ConnectionStatus {
                connected: !conn.task_handle.is_finished(),
                total_symbols,
                total_nodes,
            });
        }

        status
    }

    /// Shutdown all connections
    pub async fn shutdown_all(&self) {
        let mut connections = self.connections.write().await;
        
        for (provider, conn) in connections.drain() {
            println!("[ConsolidatedScraperManager] Shutting down {} connection", provider.as_str());
            let _ = conn.command_tx.send(ScraperConnectionCommand::Shutdown).await;
            conn.task_handle.abort();
        }

        // Clear node subscriptions
        let mut node_subs = self.node_subscriptions.write().await;
        node_subs.clear();
    }

    /// Create a new provider connection
    async fn create_provider_connection(self: &Arc<Self>, provider: ScraperProviderType) -> Result<()> {
        let (command_tx, command_rx) = mpsc::channel(100);
        let subscriptions = Arc::new(RwLock::new(HashMap::<String, HashSet<String>>::new()));

        let task_handle = match provider {
            ScraperProviderType::Coinbase => {
                let manager = Arc::clone(self);
                let subs = Arc::clone(&subscriptions);
                tokio::spawn(run_coinbase_consolidated(
                    manager,
                    command_rx,
                    subs,
                ))
            }
            ScraperProviderType::Finnhub => {
                let api_key = self.finnhub_api_key.read().await.clone()
                    .ok_or_else(|| anyhow!("Finnhub API key not set"))?;
                let manager = Arc::clone(self);
                let subs = Arc::clone(&subscriptions);
                tokio::spawn(run_finnhub_consolidated(
                    manager,
                    api_key,
                    command_rx,
                    subs,
                ))
            }
            ScraperProviderType::Binance => {
                let manager = Arc::clone(self);
                let subs = Arc::clone(&subscriptions);
                tokio::spawn(run_binance_consolidated(
                    manager,
                    command_rx,
                    subs,
                ))
            }
        };

        let connection = ProviderConnection {
            task_handle,
            command_tx,
            subscriptions,
        };

        let mut connections = self.connections.write().await;
        connections.insert(provider, connection);

        println!("[ConsolidatedScraperManager] Created {} connection", provider.as_str());
        Ok(())
    }

    /// Check if a provider connection should be closed (no more subscriptions)
    async fn maybe_close_provider(&self, provider: ScraperProviderType) {
        let should_close = {
            let connections = self.connections.read().await;
            if let Some(conn) = connections.get(&provider) {
                let subs = conn.subscriptions.read().await;
                subs.is_empty()
            } else {
                false
            }
        };

        if should_close {
            let mut connections = self.connections.write().await;
            if let Some(conn) = connections.remove(&provider) {
                println!("[ConsolidatedScraperManager] Closing {} connection (no subscriptions)", provider.as_str());
                let _ = conn.command_tx.send(ScraperConnectionCommand::Shutdown).await;
            }
        }
    }
}

/// Connection status for a provider
#[derive(Debug, Clone, Serialize)]
pub struct ConnectionStatus {
    pub connected: bool,
    pub total_symbols: usize,
    pub total_nodes: usize,
}

// ============================================================================
// COINBASE CONSOLIDATED CONNECTION
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

/// Aggregated data for storage (per-node)
#[derive(Debug, Clone)]
struct NodeAggregatedData {
    /// Price data: symbol -> Vec<(price, volume, timestamp)>
    prices: HashMap<String, Vec<(f64, f64, i64)>>,
    /// Storage interval in milliseconds
    storage_interval_ms: u64,
    /// Last storage time
    last_storage: std::time::Instant,
    /// Last stored prices for change detection
    last_stored_prices: HashMap<String, f64>,
}

impl Default for NodeAggregatedData {
    fn default() -> Self {
        Self {
            prices: HashMap::new(),
            storage_interval_ms: 0,
            last_storage: std::time::Instant::now(),
            last_stored_prices: HashMap::new(),
        }
    }
}

/// Run consolidated Coinbase WebSocket connection
async fn run_coinbase_consolidated(
    manager: Arc<ConsolidatedScraperManager>,
    mut command_rx: mpsc::Receiver<ScraperConnectionCommand>,
    subscriptions: Arc<RwLock<HashMap<String, HashSet<String>>>>,
) {
    let mut retry_count = 0u32;
    let max_retries = 10u32;

    type WsSender = futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        WsMessage,
    >;
    type WsReceiver = futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    >;

    let mut ws_sender: Option<WsSender> = None;
    let mut ws_receiver: Option<WsReceiver> = None;

    // Per-node aggregated data for storage
    let mut node_data: HashMap<String, NodeAggregatedData> = HashMap::new();

    // Connection maintenance interval
    let mut connection_timer = interval(Duration::from_secs(5));
    // Storage check interval (check all nodes)
    let mut storage_timer = interval(Duration::from_millis(100));

    loop {
        tokio::select! {
            // Handle commands
            cmd = command_rx.recv() => {
                match cmd {
                    Some(ScraperConnectionCommand::Subscribe { node_id, symbols, storage_interval_ms }) => {
                        println!("[Coinbase Consolidated] Node {} subscribing to {:?}", node_id, symbols);

                        // Initialize node data if needed
                        node_data.entry(node_id.clone()).or_insert_with(|| NodeAggregatedData {
                            storage_interval_ms,
                            last_storage: std::time::Instant::now(),
                            ..Default::default()
                        });

                        // Track new symbols
                        let mut new_symbols = Vec::new();
                        {
                            let mut subs = subscriptions.write().await;
                            for symbol in &symbols {
                                let nodes = subs.entry(symbol.clone()).or_insert_with(HashSet::new);
                                if nodes.is_empty() {
                                    new_symbols.push(symbol.clone());
                                }
                                nodes.insert(node_id.clone());
                            }
                        }

                        // Subscribe to new symbols on WebSocket
                        if !new_symbols.is_empty() {
                            if let Some(ref mut sender) = ws_sender {
                                let subscribe_msg = CoinbaseSubscribe {
                                    msg_type: "subscribe".to_string(),
                                    product_ids: new_symbols.clone(),
                                    channels: vec!["ticker".to_string()],
                                };
                                if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                    let _ = sender.send(WsMessage::Text(json.clone())).await;
                                    manager.network_metrics.record_sent(json.len() as u64);
                                }
                            }
                        }
                    }

                    Some(ScraperConnectionCommand::Unsubscribe { node_id, symbols }) => {
                        println!("[Coinbase Consolidated] Node {} unsubscribing from {:?}", node_id, symbols);

                        let mut symbols_to_unsub = Vec::new();
                        {
                            let mut subs = subscriptions.write().await;
                            for symbol in &symbols {
                                if let Some(nodes) = subs.get_mut(symbol) {
                                    nodes.remove(&node_id);
                                    if nodes.is_empty() {
                                        symbols_to_unsub.push(symbol.clone());
                                        subs.remove(symbol);
                                    }
                                }
                            }
                        }

                        // Remove symbols from node data
                        if let Some(data) = node_data.get_mut(&node_id) {
                            for symbol in &symbols {
                                data.prices.remove(symbol);
                                data.last_stored_prices.remove(symbol);
                            }
                        }

                        // Unsubscribe from provider if no nodes need these symbols
                        if !symbols_to_unsub.is_empty() {
                            if let Some(ref mut sender) = ws_sender {
                                let unsubscribe_msg = CoinbaseSubscribe {
                                    msg_type: "unsubscribe".to_string(),
                                    product_ids: symbols_to_unsub,
                                    channels: vec!["ticker".to_string()],
                                };
                                if let Ok(json) = serde_json::to_string(&unsubscribe_msg) {
                                    let _ = sender.send(WsMessage::Text(json.clone())).await;
                                    manager.network_metrics.record_sent(json.len() as u64);
                                }
                            }
                        }
                    }

                    Some(ScraperConnectionCommand::RemoveNode { node_id }) => {
                        println!("[Coinbase Consolidated] Removing node {}", node_id);

                        // Flush remaining data for this node
                        if let Some(data) = node_data.remove(&node_id) {
                            flush_node_data(&manager.db, &node_id, &data).await;
                        }

                        // Remove node from all symbol subscriptions
                        let mut symbols_to_unsub = Vec::new();
                        {
                            let mut subs = subscriptions.write().await;
                            let symbols: Vec<_> = subs.keys().cloned().collect();
                            for symbol in symbols {
                                if let Some(nodes) = subs.get_mut(&symbol) {
                                    nodes.remove(&node_id);
                                    if nodes.is_empty() {
                                        symbols_to_unsub.push(symbol.clone());
                                        subs.remove(&symbol);
                                    }
                                }
                            }
                        }

                        // Unsubscribe from provider
                        if !symbols_to_unsub.is_empty() {
                            if let Some(ref mut sender) = ws_sender {
                                let unsubscribe_msg = CoinbaseSubscribe {
                                    msg_type: "unsubscribe".to_string(),
                                    product_ids: symbols_to_unsub,
                                    channels: vec!["ticker".to_string()],
                                };
                                if let Ok(json) = serde_json::to_string(&unsubscribe_msg) {
                                    let _ = sender.send(WsMessage::Text(json.clone())).await;
                                    manager.network_metrics.record_sent(json.len() as u64);
                                }
                            }
                        }

                        // Check if we should close the connection
                        manager.maybe_close_provider(ScraperProviderType::Coinbase).await;
                    }

                    Some(ScraperConnectionCommand::SetStorageInterval { node_id, interval_ms }) => {
                        if let Some(data) = node_data.get_mut(&node_id) {
                            data.storage_interval_ms = interval_ms;
                        }
                    }

                    Some(ScraperConnectionCommand::Shutdown) | None => {
                        println!("[Coinbase Consolidated] Shutting down");
                        // Flush all node data
                        for (node_id, data) in &node_data {
                            flush_node_data(&manager.db, node_id, data).await;
                        }
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        break;
                    }
                }
            }

            // Handle incoming WebSocket messages
            _ = async {
                if let Some(ref mut receiver) = ws_receiver {
                    if let Some(msg) = receiver.next().await {
                        match msg {
                            Ok(WsMessage::Text(text)) => {
                                manager.network_metrics.record_received(text.len() as u64);

                                if let Ok(value) = serde_json::from_str::<JsonValue>(&text) {
                                    let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

                                    if msg_type == "ticker" {
                                        let symbol = value.get("product_id").and_then(|v| v.as_str()).unwrap_or("");
                                        let price = value.get("price").and_then(|v| v.as_str())
                                            .and_then(|p| p.parse::<f64>().ok()).unwrap_or(0.0);
                                        let best_bid = value.get("best_bid").and_then(|v| v.as_str())
                                            .and_then(|p| p.parse::<f64>().ok());
                                        let best_ask = value.get("best_ask").and_then(|v| v.as_str())
                                            .and_then(|p| p.parse::<f64>().ok());
                                        let timestamp = Utc::now().timestamp_millis();

                                        if !symbol.is_empty() && price > 0.0 {
                                            // Get all nodes subscribed to this symbol
                                            let subscribed_nodes: Vec<String> = {
                                                let subs = subscriptions.read().await;
                                                subs.get(symbol).map(|nodes| nodes.iter().cloned().collect()).unwrap_or_default()
                                            };

                                            // Emit to each subscribed node and accumulate data
                                            for node_id in subscribed_nodes {
                                                // Emit to frontend
                                                let price_update = serde_json::json!({
                                                    "nodeId": node_id,
                                                    "symbol": symbol,
                                                    "price": price,
                                                    "bid": best_bid,
                                                    "ask": best_ask,
                                                    "timestamp": timestamp,
                                                    "source": "coinbase",
                                                });
                                                let _ = manager.app_handle.emit("infosource:update", &price_update);

                                                // Accumulate for storage
                                                if let Some(data) = node_data.get_mut(&node_id) {
                                                    let entry = data.prices.entry(symbol.to_string()).or_insert_with(Vec::new);
                                                    entry.push((price, 0.0, timestamp));
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            Ok(WsMessage::Ping(data)) => {
                                if let Some(ref mut sender) = ws_sender {
                                    let _ = sender.send(WsMessage::Pong(data.clone())).await;
                                    manager.network_metrics.record_sent(data.len() as u64);
                                }
                            }
                            Ok(WsMessage::Close(_)) | Err(_) => {
                                println!("[Coinbase Consolidated] Connection lost, will reconnect");
                                ws_sender = None;
                                ws_receiver = None;
                            }
                            _ => {}
                        }
                    }
                } else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            } => {}

            // Storage timer - flush accumulated data for nodes that need it
            _ = storage_timer.tick() => {
                let now = std::time::Instant::now();
                for (node_id, data) in &mut node_data {
                    if data.storage_interval_ms > 0 {
                        let elapsed = now.duration_since(data.last_storage).as_millis() as u64;
                        if elapsed >= data.storage_interval_ms && !data.prices.is_empty() {
                            flush_node_data(&manager.db, node_id, data).await;
                            data.prices.clear();
                            data.last_storage = now;
                        }
                    }
                }
            }

            // Connection maintenance
            _ = connection_timer.tick() => {
                let has_subscriptions = {
                    let subs = subscriptions.read().await;
                    !subs.is_empty()
                };

                if ws_sender.is_none() && ws_receiver.is_none() && has_subscriptions {
                    match connect_async(COINBASE_WS_URL).await {
                        Ok((ws_stream, _)) => {
                            println!("[Coinbase Consolidated] Connected to WebSocket");
                            let (sender, receiver) = ws_stream.split();
                            ws_sender = Some(sender);
                            ws_receiver = Some(receiver);

                            // Resubscribe to all symbols
                            let symbols: Vec<String> = {
                                let subs = subscriptions.read().await;
                                subs.keys().cloned().collect()
                            };

                            if !symbols.is_empty() {
                                if let Some(ref mut sender) = ws_sender {
                                    let subscribe_msg = CoinbaseSubscribe {
                                        msg_type: "subscribe".to_string(),
                                        product_ids: symbols,
                                        channels: vec!["ticker".to_string()],
                                    };
                                    if let Ok(json) = serde_json::to_string(&subscribe_msg) {
                                        let _ = sender.send(WsMessage::Text(json.clone())).await;
                                        manager.network_metrics.record_sent(json.len() as u64);
                                    }
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

    println!("[Coinbase Consolidated] Exiting");
}

// ============================================================================
// FINNHUB CONSOLIDATED CONNECTION
// ============================================================================

const FINNHUB_WS_URL: &str = "wss://ws.finnhub.io/";

/// Finnhub subscribe/unsubscribe message
#[derive(Debug, Serialize)]
struct FinnhubSubscribe {
    #[serde(rename = "type")]
    msg_type: String,
    symbol: String,
}

/// Run consolidated Finnhub WebSocket connection
async fn run_finnhub_consolidated(
    manager: Arc<ConsolidatedScraperManager>,
    api_key: String,
    mut command_rx: mpsc::Receiver<ScraperConnectionCommand>,
    subscriptions: Arc<RwLock<HashMap<String, HashSet<String>>>>,
) {
    let mut retry_count = 0u32;
    let max_retries = 10u32;

    type WsSender = futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        WsMessage,
    >;
    type WsReceiver = futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    >;

    let mut ws_sender: Option<WsSender> = None;
    let mut ws_receiver: Option<WsReceiver> = None;

    let mut node_data: HashMap<String, NodeAggregatedData> = HashMap::new();
    let mut connection_timer = interval(Duration::from_secs(5));
    let mut storage_timer = interval(Duration::from_millis(100));

    loop {
        tokio::select! {
            cmd = command_rx.recv() => {
                match cmd {
                    Some(ScraperConnectionCommand::Subscribe { node_id, symbols, storage_interval_ms }) => {
                        println!("[Finnhub Consolidated] Node {} subscribing to {:?}", node_id, symbols);

                        node_data.entry(node_id.clone()).or_insert_with(|| NodeAggregatedData {
                            storage_interval_ms,
                            last_storage: std::time::Instant::now(),
                            ..Default::default()
                        });

                        let mut new_symbols = Vec::new();
                        {
                            let mut subs = subscriptions.write().await;
                            for symbol in &symbols {
                                let nodes = subs.entry(symbol.clone()).or_insert_with(HashSet::new);
                                if nodes.is_empty() {
                                    new_symbols.push(symbol.clone());
                                }
                                nodes.insert(node_id.clone());
                            }
                        }

                        // Subscribe to new symbols (Finnhub requires one message per symbol)
                        if !new_symbols.is_empty() {
                            if let Some(ref mut sender) = ws_sender {
                                for symbol in &new_symbols {
                                    let sub_msg = FinnhubSubscribe {
                                        msg_type: "subscribe".to_string(),
                                        symbol: symbol.clone(),
                                    };
                                    if let Ok(json) = serde_json::to_string(&sub_msg) {
                                        let _ = sender.send(WsMessage::Text(json.clone())).await;
                                        manager.network_metrics.record_sent(json.len() as u64);
                                    }
                                }
                            }
                        }
                    }

                    Some(ScraperConnectionCommand::Unsubscribe { node_id, symbols }) => {
                        println!("[Finnhub Consolidated] Node {} unsubscribing from {:?}", node_id, symbols);

                        let mut symbols_to_unsub = Vec::new();
                        {
                            let mut subs = subscriptions.write().await;
                            for symbol in &symbols {
                                if let Some(nodes) = subs.get_mut(symbol) {
                                    nodes.remove(&node_id);
                                    if nodes.is_empty() {
                                        symbols_to_unsub.push(symbol.clone());
                                        subs.remove(symbol);
                                    }
                                }
                            }
                        }

                        if let Some(data) = node_data.get_mut(&node_id) {
                            for symbol in &symbols {
                                data.prices.remove(symbol);
                                data.last_stored_prices.remove(symbol);
                            }
                        }

                        if !symbols_to_unsub.is_empty() {
                            if let Some(ref mut sender) = ws_sender {
                                for symbol in &symbols_to_unsub {
                                    let unsub_msg = FinnhubSubscribe {
                                        msg_type: "unsubscribe".to_string(),
                                        symbol: symbol.clone(),
                                    };
                                    if let Ok(json) = serde_json::to_string(&unsub_msg) {
                                        let _ = sender.send(WsMessage::Text(json.clone())).await;
                                        manager.network_metrics.record_sent(json.len() as u64);
                                    }
                                }
                            }
                        }
                    }

                    Some(ScraperConnectionCommand::RemoveNode { node_id }) => {
                        println!("[Finnhub Consolidated] Removing node {}", node_id);

                        if let Some(data) = node_data.remove(&node_id) {
                            flush_node_data(&manager.db, &node_id, &data).await;
                        }

                        let mut symbols_to_unsub = Vec::new();
                        {
                            let mut subs = subscriptions.write().await;
                            let symbols: Vec<_> = subs.keys().cloned().collect();
                            for symbol in symbols {
                                if let Some(nodes) = subs.get_mut(&symbol) {
                                    nodes.remove(&node_id);
                                    if nodes.is_empty() {
                                        symbols_to_unsub.push(symbol.clone());
                                        subs.remove(&symbol);
                                    }
                                }
                            }
                        }

                        if !symbols_to_unsub.is_empty() {
                            if let Some(ref mut sender) = ws_sender {
                                for symbol in &symbols_to_unsub {
                                    let unsub_msg = FinnhubSubscribe {
                                        msg_type: "unsubscribe".to_string(),
                                        symbol: symbol.clone(),
                                    };
                                    if let Ok(json) = serde_json::to_string(&unsub_msg) {
                                        let _ = sender.send(WsMessage::Text(json.clone())).await;
                                        manager.network_metrics.record_sent(json.len() as u64);
                                    }
                                }
                            }
                        }

                        manager.maybe_close_provider(ScraperProviderType::Finnhub).await;
                    }

                    Some(ScraperConnectionCommand::SetStorageInterval { node_id, interval_ms }) => {
                        if let Some(data) = node_data.get_mut(&node_id) {
                            data.storage_interval_ms = interval_ms;
                        }
                    }

                    Some(ScraperConnectionCommand::Shutdown) | None => {
                        println!("[Finnhub Consolidated] Shutting down");
                        for (node_id, data) in &node_data {
                            flush_node_data(&manager.db, node_id, data).await;
                        }
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        break;
                    }
                }
            }

            _ = async {
                if let Some(ref mut receiver) = ws_receiver {
                    if let Some(msg) = receiver.next().await {
                        match msg {
                            Ok(WsMessage::Text(text)) => {
                                manager.network_metrics.record_received(text.len() as u64);

                                if let Ok(value) = serde_json::from_str::<JsonValue>(&text) {
                                    let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

                                    if msg_type == "trade" {
                                        // Finnhub trade: {"data":[{"p":price,"s":"SYMBOL","t":timestamp_ms,"v":volume}],"type":"trade"}
                                        if let Some(trades) = value.get("data").and_then(|d| d.as_array()) {
                                            for trade in trades {
                                                let price = trade.get("p").and_then(|p| p.as_f64()).unwrap_or(0.0);
                                                let symbol = trade.get("s").and_then(|s| s.as_str()).unwrap_or("");
                                                let ts = trade.get("t").and_then(|t| t.as_i64()).unwrap_or_else(|| Utc::now().timestamp_millis());
                                                let volume = trade.get("v").and_then(|v| v.as_f64()).unwrap_or(0.0);

                                                if symbol.is_empty() || price == 0.0 {
                                                    continue;
                                                }

                                                let subscribed_nodes: Vec<String> = {
                                                    let subs = subscriptions.read().await;
                                                    subs.get(symbol).map(|nodes| nodes.iter().cloned().collect()).unwrap_or_default()
                                                };

                                                for node_id in subscribed_nodes {
                                                    let price_update = serde_json::json!({
                                                        "nodeId": node_id,
                                                        "symbol": symbol,
                                                        "price": price,
                                                        "volume": volume,
                                                        "timestamp": ts,
                                                        "source": "finnhub",
                                                    });
                                                    let _ = manager.app_handle.emit("infosource:update", &price_update);

                                                    if let Some(data) = node_data.get_mut(&node_id) {
                                                        let entry = data.prices.entry(symbol.to_string()).or_insert_with(Vec::new);
                                                        entry.push((price, volume, ts));
                                                    }
                                                }
                                            }
                                        }
                                    } else if msg_type == "ping" {
                                        // Respond to Finnhub ping
                                        if let Some(ref mut sender) = ws_sender {
                                            let pong = serde_json::json!({"type": "pong"});
                                            if let Ok(json) = serde_json::to_string(&pong) {
                                                let _ = sender.send(WsMessage::Text(json.clone())).await;
                                                manager.network_metrics.record_sent(json.len() as u64);
                                            }
                                        }
                                    }
                                }
                            }
                            Ok(WsMessage::Ping(data)) => {
                                if let Some(ref mut sender) = ws_sender {
                                    let _ = sender.send(WsMessage::Pong(data.clone())).await;
                                    manager.network_metrics.record_sent(data.len() as u64);
                                }
                            }
                            Ok(WsMessage::Close(_)) | Err(_) => {
                                println!("[Finnhub Consolidated] Connection lost, will reconnect");
                                ws_sender = None;
                                ws_receiver = None;
                            }
                            _ => {}
                        }
                    }
                } else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            } => {}

            _ = storage_timer.tick() => {
                let now = std::time::Instant::now();
                for (node_id, data) in &mut node_data {
                    if data.storage_interval_ms > 0 {
                        let elapsed = now.duration_since(data.last_storage).as_millis() as u64;
                        if elapsed >= data.storage_interval_ms && !data.prices.is_empty() {
                            flush_node_data(&manager.db, node_id, data).await;
                            data.prices.clear();
                            data.last_storage = now;
                        }
                    }
                }
            }

            _ = connection_timer.tick() => {
                let has_subscriptions = {
                    let subs = subscriptions.read().await;
                    !subs.is_empty()
                };

                if ws_sender.is_none() && ws_receiver.is_none() && has_subscriptions {
                    let url = format!("{}?token={}", FINNHUB_WS_URL, api_key);
                    match connect_async(&url).await {
                        Ok((ws_stream, _)) => {
                            println!("[Finnhub Consolidated] Connected to WebSocket");
                            let (sender, receiver) = ws_stream.split();
                            ws_sender = Some(sender);
                            ws_receiver = Some(receiver);

                            // Resubscribe to all symbols
                            let symbols: Vec<String> = {
                                let subs = subscriptions.read().await;
                                subs.keys().cloned().collect()
                            };

                            if let Some(ref mut sender) = ws_sender {
                                for symbol in &symbols {
                                    let sub_msg = FinnhubSubscribe {
                                        msg_type: "subscribe".to_string(),
                                        symbol: symbol.clone(),
                                    };
                                    if let Ok(json) = serde_json::to_string(&sub_msg) {
                                        let _ = sender.send(WsMessage::Text(json.clone())).await;
                                        manager.network_metrics.record_sent(json.len() as u64);
                                    }
                                }
                            }

                            retry_count = 0;
                        }
                        Err(e) => {
                            eprintln!("[Finnhub Consolidated] Connection failed: {}", e);
                            retry_count += 1;
                            if retry_count >= max_retries {
                                eprintln!("[Finnhub Consolidated] Max retries reached");
                            }
                        }
                    }
                }
            }
        }
    }

    println!("[Finnhub Consolidated] Exiting");
}

// ============================================================================
// BINANCE CONSOLIDATED CONNECTION
// ============================================================================

const BINANCE_WS_URL: &str = "wss://stream.binance.us:9443/ws";

/// Run consolidated Binance WebSocket connection
async fn run_binance_consolidated(
    manager: Arc<ConsolidatedScraperManager>,
    mut command_rx: mpsc::Receiver<ScraperConnectionCommand>,
    subscriptions: Arc<RwLock<HashMap<String, HashSet<String>>>>,
) {
    let mut retry_count = 0u32;
    let max_retries = 10u32;
    let mut sub_id_counter = 1u64;

    type WsSender = futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
        WsMessage,
    >;
    type WsReceiver = futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    >;

    let mut ws_sender: Option<WsSender> = None;
    let mut ws_receiver: Option<WsReceiver> = None;

    let mut node_data: HashMap<String, NodeAggregatedData> = HashMap::new();
    let mut connection_timer = interval(Duration::from_secs(5));
    let mut storage_timer = interval(Duration::from_millis(100));

    // Map display symbol (e.g., "PAXG/USDT") to Binance stream name (e.g., "paxgusdt")
    let to_stream_name = |symbol: &str| -> String {
        symbol.to_lowercase().replace('/', "").replace('-', "")
    };

    loop {
        tokio::select! {
            cmd = command_rx.recv() => {
                match cmd {
                    Some(ScraperConnectionCommand::Subscribe { node_id, symbols, storage_interval_ms }) => {
                        println!("[Binance Consolidated] Node {} subscribing to {:?}", node_id, symbols);

                        node_data.entry(node_id.clone()).or_insert_with(|| NodeAggregatedData {
                            storage_interval_ms,
                            last_storage: std::time::Instant::now(),
                            ..Default::default()
                        });

                        let mut new_symbols = Vec::new();
                        {
                            let mut subs = subscriptions.write().await;
                            for symbol in &symbols {
                                let nodes = subs.entry(symbol.clone()).or_insert_with(HashSet::new);
                                if nodes.is_empty() {
                                    new_symbols.push(symbol.clone());
                                }
                                nodes.insert(node_id.clone());
                            }
                        }

                        if !new_symbols.is_empty() {
                            if let Some(ref mut sender) = ws_sender {
                                let params: Vec<String> = new_symbols.iter()
                                    .map(|s| format!("{}@trade", to_stream_name(s)))
                                    .collect();
                                sub_id_counter += 1;
                                let sub_msg = serde_json::json!({
                                    "method": "SUBSCRIBE",
                                    "params": params,
                                    "id": sub_id_counter
                                });
                                if let Ok(json) = serde_json::to_string(&sub_msg) {
                                    let _ = sender.send(WsMessage::Text(json.clone())).await;
                                    manager.network_metrics.record_sent(json.len() as u64);
                                }
                            }
                        }
                    }

                    Some(ScraperConnectionCommand::Unsubscribe { node_id, symbols }) => {
                        println!("[Binance Consolidated] Node {} unsubscribing from {:?}", node_id, symbols);

                        let mut symbols_to_unsub = Vec::new();
                        {
                            let mut subs = subscriptions.write().await;
                            for symbol in &symbols {
                                if let Some(nodes) = subs.get_mut(symbol) {
                                    nodes.remove(&node_id);
                                    if nodes.is_empty() {
                                        symbols_to_unsub.push(symbol.clone());
                                        subs.remove(symbol);
                                    }
                                }
                            }
                        }

                        if let Some(data) = node_data.get_mut(&node_id) {
                            for symbol in &symbols {
                                data.prices.remove(symbol);
                                data.last_stored_prices.remove(symbol);
                            }
                        }

                        if !symbols_to_unsub.is_empty() {
                            if let Some(ref mut sender) = ws_sender {
                                let params: Vec<String> = symbols_to_unsub.iter()
                                    .map(|s| format!("{}@trade", to_stream_name(s)))
                                    .collect();
                                sub_id_counter += 1;
                                let unsub_msg = serde_json::json!({
                                    "method": "UNSUBSCRIBE",
                                    "params": params,
                                    "id": sub_id_counter
                                });
                                if let Ok(json) = serde_json::to_string(&unsub_msg) {
                                    let _ = sender.send(WsMessage::Text(json.clone())).await;
                                    manager.network_metrics.record_sent(json.len() as u64);
                                }
                            }
                        }
                    }

                    Some(ScraperConnectionCommand::RemoveNode { node_id }) => {
                        println!("[Binance Consolidated] Removing node {}", node_id);

                        if let Some(data) = node_data.remove(&node_id) {
                            flush_node_data(&manager.db, &node_id, &data).await;
                        }

                        let mut symbols_to_unsub = Vec::new();
                        {
                            let mut subs = subscriptions.write().await;
                            let symbols: Vec<_> = subs.keys().cloned().collect();
                            for symbol in symbols {
                                if let Some(nodes) = subs.get_mut(&symbol) {
                                    nodes.remove(&node_id);
                                    if nodes.is_empty() {
                                        symbols_to_unsub.push(symbol.clone());
                                        subs.remove(&symbol);
                                    }
                                }
                            }
                        }

                        if !symbols_to_unsub.is_empty() {
                            if let Some(ref mut sender) = ws_sender {
                                let params: Vec<String> = symbols_to_unsub.iter()
                                    .map(|s| format!("{}@trade", to_stream_name(s)))
                                    .collect();
                                sub_id_counter += 1;
                                let unsub_msg = serde_json::json!({
                                    "method": "UNSUBSCRIBE",
                                    "params": params,
                                    "id": sub_id_counter
                                });
                                if let Ok(json) = serde_json::to_string(&unsub_msg) {
                                    let _ = sender.send(WsMessage::Text(json.clone())).await;
                                    manager.network_metrics.record_sent(json.len() as u64);
                                }
                            }
                        }

                        manager.maybe_close_provider(ScraperProviderType::Binance).await;
                    }

                    Some(ScraperConnectionCommand::SetStorageInterval { node_id, interval_ms }) => {
                        if let Some(data) = node_data.get_mut(&node_id) {
                            data.storage_interval_ms = interval_ms;
                        }
                    }

                    Some(ScraperConnectionCommand::Shutdown) | None => {
                        println!("[Binance Consolidated] Shutting down");
                        for (node_id, data) in &node_data {
                            flush_node_data(&manager.db, node_id, data).await;
                        }
                        if let Some(ref mut sender) = ws_sender {
                            let _ = sender.close().await;
                        }
                        break;
                    }
                }
            }

            _ = async {
                if let Some(ref mut receiver) = ws_receiver {
                    if let Some(msg) = receiver.next().await {
                        match msg {
                            Ok(WsMessage::Text(text)) => {
                                manager.network_metrics.record_received(text.len() as u64);

                                if let Ok(value) = serde_json::from_str::<JsonValue>(&text) {
                                    let event_type = value.get("e").and_then(|e| e.as_str()).unwrap_or("");

                                    if event_type == "trade" {
                                        // Binance trade: {"e":"trade","s":"PAXGUSDT","p":"2350.50","q":"0.1","T":...}
                                        let symbol_raw = value.get("s").and_then(|s| s.as_str()).unwrap_or("");
                                        let price = value.get("p").and_then(|p| p.as_str())
                                            .and_then(|p| p.parse::<f64>().ok())
                                            .unwrap_or(0.0);
                                        let quantity = value.get("q").and_then(|q| q.as_str())
                                            .and_then(|q| q.parse::<f64>().ok())
                                            .unwrap_or(0.0);
                                        let ts = value.get("T").and_then(|t| t.as_i64())
                                            .unwrap_or_else(|| Utc::now().timestamp_millis());

                                        if !symbol_raw.is_empty() && price > 0.0 {
                                            // Find all nodes subscribed to any symbol that matches this stream
                                            let subscribed_nodes: Vec<(String, String)> = {
                                                let subs = subscriptions.read().await;
                                                let symbol_lower = symbol_raw.to_lowercase();
                                                subs.iter()
                                                    .filter(|(sym, _)| to_stream_name(sym) == symbol_lower)
                                                    .flat_map(|(sym, nodes)| {
                                                        nodes.iter().map(|n| (n.clone(), sym.clone())).collect::<Vec<_>>()
                                                    })
                                                    .collect()
                                            };

                                            for (node_id, symbol) in subscribed_nodes {
                                                let price_update = serde_json::json!({
                                                    "nodeId": node_id,
                                                    "symbol": symbol,
                                                    "price": price,
                                                    "volume": quantity,
                                                    "timestamp": ts,
                                                    "source": "binance",
                                                });
                                                let _ = manager.app_handle.emit("infosource:update", &price_update);

                                                if let Some(data) = node_data.get_mut(&node_id) {
                                                    let entry = data.prices.entry(symbol).or_insert_with(Vec::new);
                                                    entry.push((price, quantity, ts));
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            Ok(WsMessage::Ping(data)) => {
                                if let Some(ref mut sender) = ws_sender {
                                    let _ = sender.send(WsMessage::Pong(data.clone())).await;
                                    manager.network_metrics.record_sent(data.len() as u64);
                                }
                            }
                            Ok(WsMessage::Close(_)) | Err(_) => {
                                println!("[Binance Consolidated] Connection lost, will reconnect");
                                ws_sender = None;
                                ws_receiver = None;
                            }
                            _ => {}
                        }
                    }
                } else {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            } => {}

            _ = storage_timer.tick() => {
                let now = std::time::Instant::now();
                for (node_id, data) in &mut node_data {
                    if data.storage_interval_ms > 0 {
                        let elapsed = now.duration_since(data.last_storage).as_millis() as u64;
                        if elapsed >= data.storage_interval_ms && !data.prices.is_empty() {
                            flush_node_data(&manager.db, node_id, data).await;
                            data.prices.clear();
                            data.last_storage = now;
                        }
                    }
                }
            }

            _ = connection_timer.tick() => {
                let has_subscriptions = {
                    let subs = subscriptions.read().await;
                    !subs.is_empty()
                };

                if ws_sender.is_none() && ws_receiver.is_none() && has_subscriptions {
                    match connect_async(BINANCE_WS_URL).await {
                        Ok((ws_stream, _)) => {
                            println!("[Binance Consolidated] Connected to WebSocket");
                            let (sender, receiver) = ws_stream.split();
                            ws_sender = Some(sender);
                            ws_receiver = Some(receiver);

                            // Resubscribe to all symbols
                            let symbols: Vec<String> = {
                                let subs = subscriptions.read().await;
                                subs.keys().cloned().collect()
                            };

                            if !symbols.is_empty() {
                                if let Some(ref mut sender) = ws_sender {
                                    let params: Vec<String> = symbols.iter()
                                        .map(|s| format!("{}@trade", to_stream_name(s)))
                                        .collect();
                                    sub_id_counter += 1;
                                    let sub_msg = serde_json::json!({
                                        "method": "SUBSCRIBE",
                                        "params": params,
                                        "id": sub_id_counter
                                    });
                                    if let Ok(json) = serde_json::to_string(&sub_msg) {
                                        let _ = sender.send(WsMessage::Text(json.clone())).await;
                                        manager.network_metrics.record_sent(json.len() as u64);
                                    }
                                }
                            }

                            retry_count = 0;
                        }
                        Err(e) => {
                            eprintln!("[Binance Consolidated] Connection failed: {}", e);
                            retry_count += 1;
                            if retry_count >= max_retries {
                                eprintln!("[Binance Consolidated] Max retries reached");
                            }
                        }
                    }
                }
            }
        }
    }

    println!("[Binance Consolidated] Exiting");
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Flush accumulated node data to database
async fn flush_node_data(db: &Arc<Mutex<Connection>>, node_id: &str, data: &NodeAggregatedData) {
    let conn = db.lock().await;
    let timestamp = Utc::now().timestamp_millis();
    let mut stored_count = 0;

    for (symbol, prices) in &data.prices {
        if prices.is_empty() {
            continue;
        }

        // Calculate aggregate values
        let price_values: Vec<f64> = prices.iter().map(|(p, _, _)| *p).collect();
        let avg_price = price_values.iter().sum::<f64>() / price_values.len() as f64;
        let min_price = price_values.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_price = price_values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let count = prices.len();

        // Skip if average hasn't changed
        if let Some(prev_avg) = data.last_stored_prices.get(symbol) {
            if (avg_price - prev_avg).abs() < f64::EPSILON {
                continue;
            }
        }

        let metric_type = format!("price:{}", symbol.to_lowercase());
        let metadata = serde_json::json!({
            "symbol": symbol,
            "avg_price": avg_price,
            "min_price": min_price,
            "max_price": max_price,
            "sample_count": count,
            "interval_start": prices.first().map(|(_, _, t)| *t).unwrap_or(timestamp),
            "interval_end": prices.last().map(|(_, _, t)| *t).unwrap_or(timestamp),
        });

        if let Err(e) = insert_timeseries(&conn, node_id, &metric_type, avg_price, Some(metadata)) {
            eprintln!("[ConsolidatedScraper] Failed to insert timeseries for node {}: {}", node_id, e);
        } else {
            stored_count += 1;
        }
    }

    if stored_count > 0 {
        println!("[ConsolidatedScraper] Flushed {} symbols to database for node {}", stored_count, node_id);
    }
}

/// Create a new consolidated scraper manager (convenience function)
pub fn create_consolidated_scraper_manager(
    app_handle: AppHandle,
    db: Arc<Mutex<Connection>>,
    network_metrics: Arc<NetworkMetrics>,
) -> Arc<ConsolidatedScraperManager> {
    ConsolidatedScraperManager::new(app_handle, db, network_metrics)
}
