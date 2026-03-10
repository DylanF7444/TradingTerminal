// ============================================================================
// PERSISTENT ORDERBOOK MONITORING SERVICE
// ============================================================================
//
// Purpose: Always-on orderbook monitoring for ALL active market nodes.
//
// Maintains persistent WebSocket subscriptions regardless of which UI
// component is currently viewing them. Uses the consolidated WebSocketManager
// (one connection per platform) and stores updates in a central in-memory cache.
//
// LIFECYCLE:
//   Market Added   -> subscribe via WebSocketManager, cache updates
//   Market Removed -> unsubscribe, remove cache entry
//   Continuous     -> emit 'orderbook:update' events to frontend
//
// MEMORY BOUNDS:
//   Max 50 price levels per side, 20 recent trades per market.
//   Stale entries cleaned after 5 minutes of no updates.
// ============================================================================

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{RwLock, Mutex};
use tauri::{AppHandle, Emitter};
use chrono::Utc;
use serde::{Serialize, Deserialize};

use crate::db::sqlite::Connection;
use crate::services::orderbook::{OrderbookUpdate, OrderbookLevel};
use crate::services::websocket_manager::{WebSocketManager, PlatformType};

// ============================================================================
// TYPES
// ============================================================================

/// Maximum number of price levels to keep per side (memory bound)
const MAX_LEVELS_PER_SIDE: usize = 50;

/// Maximum number of recent trades to keep per market
const MAX_RECENT_TRADES: usize = 20;

/// Stale threshold in seconds - markets with no updates are flagged
const STALE_THRESHOLD_SECS: i64 = 300; // 5 minutes

/// Default storage interval (60 seconds)
const DEFAULT_STORAGE_INTERVAL_MS: u64 = 60_000;

/// What to store to the database
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MarketStorageMode {
    /// Don't persist any orderbook data
    Off,
    /// Store only best bid and best ask (top of book)
    BestBidAsk,
    /// Store the full orderbook snapshot (all levels)
    FullOrderbook,
}

impl Default for MarketStorageMode {
    fn default() -> Self {
        MarketStorageMode::Off
    }
}

/// Per-node storage configuration
#[derive(Debug, Clone)]
pub struct MarketStorageConfig {
    /// What level of detail to store
    pub mode: MarketStorageMode,
    /// How often to flush to DB (milliseconds)
    pub interval_ms: u64,
    /// Last time this node's data was flushed
    pub last_flush_ms: i64,
}

impl Default for MarketStorageConfig {
    fn default() -> Self {
        Self {
            mode: MarketStorageMode::Off,
            interval_ms: DEFAULT_STORAGE_INTERVAL_MS,
            last_flush_ms: 0,
        }
    }
}

/// Cached orderbook data for a single market
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedOrderbook {
    /// Market identifier (token_id or market_ticker)
    pub market_id: String,
    /// Platform name
    pub platform: String,
    /// Current bid levels (sorted descending by price)
    pub bids: Vec<OrderbookLevel>,
    /// Current ask levels (sorted ascending by price)
    pub asks: Vec<OrderbookLevel>,
    /// Last update timestamp (millis)
    pub last_updated: i64,
    /// Sequence number for ordering
    pub sequence: u64,
    /// Last trade price
    pub last_price: Option<f64>,
    /// Last trade size
    pub last_size: Option<f64>,
    /// Recent trades (newest first)
    pub recent_trades: Vec<TradeRecord>,
    /// Total number of updates received
    pub update_count: u64,
    /// Whether this market is considered stale
    pub is_stale: bool,
}

/// Record of a single trade
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeRecord {
    pub price: f64,
    pub size: f64,
    pub timestamp: i64,
}

/// Information about a monitored market
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitoredMarket {
    /// Node ID in the graph
    pub node_id: String,
    /// Market identifier (token_id for Polymarket, ticker for Kalshi)
    pub market_id: String,
    /// Platform type
    pub platform: String,
    /// Whether currently subscribed
    pub subscribed: bool,
    /// Last update timestamp
    pub last_updated: Option<i64>,
    /// Update count
    pub update_count: u64,
}

/// Summary of all monitored markets (for frontend status display)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitoringSummary {
    pub total_markets: usize,
    pub active_subscriptions: usize,
    pub stale_markets: usize,
    pub total_updates: u64,
    pub markets: Vec<MonitoredMarket>,
}

// ============================================================================
// PERSISTENT ORDERBOOK MONITOR
// ============================================================================

/// Central orderbook cache and monitoring service
pub struct PersistentOrderbookMonitor {
    /// Cached orderbook data per market_id
    cache: Arc<RwLock<HashMap<String, CachedOrderbook>>>,
    /// Mapping from node_id to market_id (for add/remove by node)
    node_to_market: Arc<RwLock<HashMap<String, MarketMapping>>>,
    /// Per-node storage configuration (node_id -> config)
    storage_configs: Arc<RwLock<HashMap<String, MarketStorageConfig>>>,
    /// Reference to the WebSocket manager
    ws_manager: Arc<WebSocketManager>,
    /// Database connection for persisting orderbook snapshots
    db: Arc<Mutex<Connection>>,
    /// Tauri app handle for emitting events
    app_handle: AppHandle,
}

/// Maps a node to its market subscription details
#[derive(Debug, Clone)]
struct MarketMapping {
    market_id: String,
    platform: PlatformType,
}

impl PersistentOrderbookMonitor {
    /// Create a new persistent orderbook monitor
    pub fn new(ws_manager: Arc<WebSocketManager>, app_handle: AppHandle, db: Arc<Mutex<Connection>>) -> Self {
        Self {
            cache: Arc::new(RwLock::new(HashMap::new())),
            node_to_market: Arc::new(RwLock::new(HashMap::new())),
            storage_configs: Arc::new(RwLock::new(HashMap::new())),
            ws_manager,
            db,
            app_handle,
        }
    }

    // ========================================================================
    // MARKET SUBSCRIPTION MANAGEMENT
    // ========================================================================

    /// Subscribe to a market's orderbook (called when market node is added)
    ///
    /// This starts a persistent subscription that stays alive until the market
    /// is explicitly removed. Multiple calls with the same node_id are idempotent.
    pub async fn subscribe_market(
        &self,
        node_id: &str,
        market_id: &str,
        platform: &str,
    ) -> Result<(), String> {
        // Parse platform
        let platform_type = match platform.to_lowercase().as_str() {
            "polymarket" => PlatformType::Polymarket,
            "kalshi" => PlatformType::Kalshi,
            _ => return Err(format!("Unsupported platform: {}", platform)),
        };

        // Check if already subscribed for this node
        {
            let mappings = self.node_to_market.read().await;
            if mappings.contains_key(node_id) {
                println!(
                    "[PersistentOrderbook] Already monitoring node {} (market: {})",
                    node_id, market_id
                );
                return Ok(());
            }
        }

        println!(
            "[PersistentOrderbook] Subscribing node {} to {} market: {}",
            node_id, platform, market_id
        );

        // Subscribe via WebSocket manager (consolidated connection)
        self.ws_manager
            .subscribe(platform_type, market_id.to_string())
            .await
            .map_err(|e| format!("WebSocket subscribe failed: {}", e))?;

        // Store the mapping
        {
            let mut mappings = self.node_to_market.write().await;
            mappings.insert(
                node_id.to_string(),
                MarketMapping {
                    market_id: market_id.to_string(),
                    platform: platform_type,
                },
            );
        }

        // Initialize cache entry
        {
            let mut cache = self.cache.write().await;
            cache.entry(market_id.to_string()).or_insert_with(|| CachedOrderbook {
                market_id: market_id.to_string(),
                platform: platform.to_string(),
                bids: vec![],
                asks: vec![],
                last_updated: Utc::now().timestamp_millis(),
                sequence: 0,
                last_price: None,
                last_size: None,
                recent_trades: vec![],
                update_count: 0,
                is_stale: false,
            });
        }

        // Emit monitoring status update
        self.emit_monitoring_status().await;

        Ok(())
    }

    /// Unsubscribe from a market's orderbook (called when market node is removed)
    pub async fn unsubscribe_market(&self, node_id: &str) -> Result<(), String> {
        // Get the mapping
        let mapping = {
            let mut mappings = self.node_to_market.write().await;
            mappings.remove(node_id)
        };

        let Some(mapping) = mapping else {
            println!(
                "[PersistentOrderbook] No mapping found for node {}, nothing to unsubscribe",
                node_id
            );
            return Ok(());
        };

        println!(
            "[PersistentOrderbook] Unsubscribing node {} from {} market: {}",
            node_id,
            mapping.platform.as_str(),
            mapping.market_id
        );

        // Check if any other node is using the same market_id
        let still_used = {
            let mappings = self.node_to_market.read().await;
            mappings.values().any(|m| m.market_id == mapping.market_id)
        };

        if !still_used {
            // No other node uses this market, unsubscribe and remove cache
            self.ws_manager
                .unsubscribe(mapping.platform, &mapping.market_id)
                .await
                .map_err(|e| format!("WebSocket unsubscribe failed: {}", e))?;

            let mut cache = self.cache.write().await;
            cache.remove(&mapping.market_id);
        } else {
            println!(
                "[PersistentOrderbook] Market {} still used by other nodes, keeping subscription",
                mapping.market_id
            );
        }

        // Emit monitoring status update
        self.emit_monitoring_status().await;

        Ok(())
    }

    // ========================================================================
    // CACHE UPDATE HANDLING
    // ========================================================================

    /// Process an incoming orderbook update and cache it
    ///
    /// Called when the backend receives an orderbook:update event.
    /// Applies memory bounds and staleness detection.
    pub async fn handle_update(&self, update: &OrderbookUpdate) {
        let mut cache = self.cache.write().await;

        let entry = cache
            .entry(update.market_id.clone())
            .or_insert_with(|| CachedOrderbook {
                market_id: update.market_id.clone(),
                platform: update.platform.clone(),
                bids: vec![],
                asks: vec![],
                last_updated: update.timestamp,
                sequence: update.sequence,
                last_price: None,
                last_size: None,
                recent_trades: vec![],
                update_count: 0,
                is_stale: false,
            });

        // Update bid/ask levels (only if non-empty, preserving existing on trade-only updates)
        if !update.bids.is_empty() {
            entry.bids = update.bids.clone();
            // Enforce memory bound
            entry.bids.truncate(MAX_LEVELS_PER_SIDE);
        }
        if !update.asks.is_empty() {
            entry.asks = update.asks.clone();
            entry.asks.truncate(MAX_LEVELS_PER_SIDE);
        }

        // Update trade data
        if let (Some(price), Some(size)) = (update.last_price, update.last_size) {
            entry.last_price = Some(price);
            entry.last_size = Some(size);

            // Add to recent trades
            entry.recent_trades.insert(
                0,
                TradeRecord {
                    price,
                    size,
                    timestamp: update.timestamp,
                },
            );
            // Enforce memory bound on trades
            entry.recent_trades.truncate(MAX_RECENT_TRADES);
        }

        // Update metadata
        entry.last_updated = update.timestamp;
        entry.sequence = update.sequence;
        entry.update_count += 1;
        entry.is_stale = false;
    }

    // ========================================================================
    // CACHE QUERIES
    // ========================================================================

    /// Get cached orderbook for a specific market
    pub async fn get_orderbook(&self, market_id: &str) -> Option<CachedOrderbook> {
        let cache = self.cache.read().await;
        cache.get(market_id).cloned()
    }

    /// Get all cached orderbooks
    pub async fn get_all_orderbooks(&self) -> HashMap<String, CachedOrderbook> {
        let cache = self.cache.read().await;
        cache.clone()
    }

    /// Get monitoring summary
    pub async fn get_summary(&self) -> MonitoringSummary {
        let cache = self.cache.read().await;
        let mappings = self.node_to_market.read().await;
        let now = Utc::now().timestamp_millis();

        let mut markets = Vec::new();
        let mut total_updates = 0u64;
        let mut stale_count = 0usize;

        for (node_id, mapping) in mappings.iter() {
            let cached = cache.get(&mapping.market_id);
            let is_stale = cached
                .map(|c| (now - c.last_updated) > STALE_THRESHOLD_SECS * 1000)
                .unwrap_or(true);

            if is_stale {
                stale_count += 1;
            }

            let update_count = cached.map(|c| c.update_count).unwrap_or(0);
            total_updates += update_count;

            markets.push(MonitoredMarket {
                node_id: node_id.clone(),
                market_id: mapping.market_id.clone(),
                platform: mapping.platform.as_str().to_string(),
                subscribed: true,
                last_updated: cached.map(|c| c.last_updated),
                update_count,
            });
        }

        MonitoringSummary {
            total_markets: markets.len(),
            active_subscriptions: markets.len(),
            stale_markets: stale_count,
            total_updates,
            markets,
        }
    }

    // ========================================================================
    // STORAGE CONFIGURATION
    // ========================================================================

    /// Set storage configuration for a specific node
    pub async fn set_storage_config(&self, node_id: &str, mode: MarketStorageMode, interval_ms: u64) {
        let mut configs = self.storage_configs.write().await;
        let config = configs.entry(node_id.to_string()).or_insert_with(MarketStorageConfig::default);
        config.mode = mode.clone();
        config.interval_ms = interval_ms;
        println!(
            "[PersistentOrderbook] Storage config for node {}: mode={:?}, interval={}ms",
            node_id, mode, interval_ms
        );
    }

    /// Get storage configuration for a specific node
    pub async fn get_storage_config(&self, node_id: &str) -> MarketStorageConfig {
        let configs = self.storage_configs.read().await;
        configs.get(node_id).cloned().unwrap_or_default()
    }

    // ========================================================================
    // DATABASE PERSISTENCE
    // ========================================================================

    /// Flush cached orderbook data to the database for all nodes that have
    /// storage enabled and whose interval has elapsed.
    ///
    /// Called periodically from main.rs (every 5 seconds). The actual per-node
    /// flush interval is controlled by each node's MarketStorageConfig.
    pub async fn flush_to_database(&self) {
        let now_ms = Utc::now().timestamp_millis();
        let mappings = self.node_to_market.read().await;
        let cache = self.cache.read().await;
        let mut configs = self.storage_configs.write().await;

        // Collect data to write outside the locks
        let mut to_write: Vec<(String, MarketStorageMode, CachedOrderbook)> = Vec::new();

        for (node_id, mapping) in mappings.iter() {
            let config = configs.entry(node_id.clone()).or_insert_with(MarketStorageConfig::default);

            // Skip if storage is off
            if config.mode == MarketStorageMode::Off {
                continue;
            }

            // Skip if interval hasn't elapsed
            let elapsed = now_ms - config.last_flush_ms;
            if elapsed < config.interval_ms as i64 {
                continue;
            }

            // Get cached orderbook
            if let Some(cached) = cache.get(&mapping.market_id) {
                // Only write if there's actual data and the cache has been updated since last flush
                if cached.update_count > 0 && cached.last_updated > config.last_flush_ms {
                    to_write.push((node_id.clone(), config.mode.clone(), cached.clone()));
                    config.last_flush_ms = now_ms;
                }
            }
        }

        // Drop locks before doing DB work
        drop(configs);
        drop(cache);
        drop(mappings);

        if to_write.is_empty() {
            return;
        }

        // Write to database
        let conn = self.db.lock().await;
        for (node_id, mode, cached) in &to_write {
            let timestamp = Utc::now().timestamp();

            match mode {
                MarketStorageMode::BestBidAsk => {
                    let best_bid = cached.bids.first().map(|l| l.price).unwrap_or(0.0);
                    let best_ask = cached.asks.first().map(|l| l.price).unwrap_or(0.0);
                    let best_bid_size = cached.bids.first().map(|l| l.size).unwrap_or(0.0);
                    let best_ask_size = cached.asks.first().map(|l| l.size).unwrap_or(0.0);
                    let mid = if best_bid > 0.0 && best_ask > 0.0 {
                        (best_bid + best_ask) / 2.0
                    } else {
                        best_bid.max(best_ask)
                    };

                    let metadata = serde_json::json!({
                        "market_id": cached.market_id,
                        "platform": cached.platform,
                        "best_bid": best_bid,
                        "best_bid_size": best_bid_size,
                        "best_ask": best_ask,
                        "best_ask_size": best_ask_size,
                        "spread": best_ask - best_bid,
                        "last_price": cached.last_price,
                        "last_size": cached.last_size,
                        "sequence": cached.sequence,
                        "storage_mode": "best_bid_ask",
                    });

                    let metadata_str = serde_json::to_string(&metadata).unwrap_or_default();
                    if let Err(e) = conn.execute(
                        "INSERT INTO timeseries (timestamp, source_id, metric_type, value, metadata) VALUES (?1, ?2, ?3, ?4, ?5)",
                        rusqlite::params![timestamp, node_id, "orderbook:bbo", mid, metadata_str],
                    ) {
                        eprintln!("[PersistentOrderbook] DB write error for {}: {}", node_id, e);
                    }
                }
                MarketStorageMode::FullOrderbook => {
                    let mid = if !cached.bids.is_empty() && !cached.asks.is_empty() {
                        (cached.bids[0].price + cached.asks[0].price) / 2.0
                    } else {
                        cached.last_price.unwrap_or(0.0)
                    };

                    let metadata = serde_json::json!({
                        "market_id": cached.market_id,
                        "platform": cached.platform,
                        "bids": cached.bids,
                        "asks": cached.asks,
                        "last_price": cached.last_price,
                        "last_size": cached.last_size,
                        "sequence": cached.sequence,
                        "storage_mode": "full_orderbook",
                    });

                    let metadata_str = serde_json::to_string(&metadata).unwrap_or_default();
                    if let Err(e) = conn.execute(
                        "INSERT INTO timeseries (timestamp, source_id, metric_type, value, metadata) VALUES (?1, ?2, ?3, ?4, ?5)",
                        rusqlite::params![timestamp, node_id, "orderbook:full", mid, metadata_str],
                    ) {
                        eprintln!("[PersistentOrderbook] DB write error for {}: {}", node_id, e);
                    }
                }
                MarketStorageMode::Off => {} // Already filtered above
            }
        }

        println!(
            "[PersistentOrderbook] Flushed {} market snapshots to database",
            to_write.len()
        );
    }

    // ========================================================================
    // MAINTENANCE
    // ========================================================================

    /// Mark stale entries (called periodically)
    pub async fn check_staleness(&self) {
        let now = Utc::now().timestamp_millis();
        let mut cache = self.cache.write().await;

        for entry in cache.values_mut() {
            let age_secs = (now - entry.last_updated) / 1000;
            entry.is_stale = age_secs > STALE_THRESHOLD_SECS;
        }
    }

    /// Emit monitoring status to frontend
    async fn emit_monitoring_status(&self) {
        let summary = self.get_summary().await;
        if let Err(e) = self.app_handle.emit("orderbook:monitoring_status", &summary) {
            eprintln!("[PersistentOrderbook] Failed to emit monitoring status: {}", e);
        }
    }
}

// ============================================================================
// TAURI STATE TYPE
// ============================================================================

/// Shared state for the persistent orderbook monitor (managed by Tauri)
pub type PersistentOrderbookState = Arc<PersistentOrderbookMonitor>;

/// Create the persistent orderbook monitor
pub fn create_persistent_monitor(
    ws_manager: Arc<WebSocketManager>,
    app_handle: AppHandle,
    db: Arc<Mutex<Connection>>,
) -> PersistentOrderbookState {
    Arc::new(PersistentOrderbookMonitor::new(ws_manager, app_handle, db))
}
