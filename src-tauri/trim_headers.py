"""Trim verbose header comments in Rust backend files."""
import os

def replace_header(filepath, new_header):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    lines = content.split('\n')

    # Find first non-comment, non-blank line (the first 'use' or code statement)
    code_start = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped and not stripped.startswith('//'):
            code_start = i
            break

    # Build new content: new header + blank line + code
    new_lines = new_header.rstrip('\n').split('\n')
    result = '\n'.join(new_lines) + '\n\n' + '\n'.join(lines[code_start:])

    with open(filepath, 'w', encoding='utf-8', newline='\n') as f:
        f.write(result)

    old_count = code_start
    new_count = len(new_lines)
    print(f"  {os.path.basename(filepath)}: {old_count} -> {new_count} header lines")


base = os.path.join(r"C:\Users\Dylan nonadmin\Desktop\TradingTerminal\src-tauri\src")

# 1. db/sqlite.rs
replace_header(os.path.join(base, "db", "sqlite.rs"), """\
// ============================================================================
// SQLITE DATABASE LAYER
// ============================================================================
//
// Purpose: Complete SQLite persistence layer for the prediction market terminal.
//
// Uses SQLite with WAL mode for concurrent access. Chosen for zero-config
// embedded operation with sub-millisecond query times and 10k+ writes/second.
//
// TABLES:
//   nodes           - Info sources and market connections (graph vertices)
//   connections     - Graph edges between nodes (unique source+target)
//   timeseries      - Scraped data points (indexed by source_id + timestamp)
//   positions       - Trading positions and P&L
//   scraper_status  - Health tracking for each data source scraper
//   event_log       - Audit trail of system events
//   api_keys        - Encrypted API credentials per platform (unique per platform)
//
// PERFORMANCE PRAGMAS:
//   WAL mode, synchronous=NORMAL, 64MB cache, memory temp store, 30GB mmap.
//   Strategic indexes on all query hot paths.
//
// KEY FUNCTIONS:
//   Connection: create_connection, setup_schema, apply_optimizations
//   Nodes:      insert/update/delete/get_node_by_id/get_all_active_nodes
//   Series:     insert_timeseries, batch_insert_timeseries, query_timeseries
//   Positions:  insert_position, get_positions
//   Scraper:    update_scraper_status, get_scraper_status
//   Events:     log_event, get_recent_events
//   Maintenance: vacuum_database, get_database_stats
//
// Serialization helpers: serialize_node_type() and deserialize_node() convert
// between NodeType enums and string pairs for database storage.
// ============================================================================""")

# 2. models/node.rs
replace_header(os.path.join(base, "models", "node.rs"), """\
// ============================================================================
// NODE MODEL
// ============================================================================
//
// Purpose: Core graph data structures for the visual node-based interface.
//
// Each Node is a graph vertex representing either an information source (data
// input) or a prediction market (trading venue). Nodes have spatial positions
// for canvas rendering and an adjacency list of connections.
//
// NODE TYPES:
//   InfoSource variants: CryptoPrices, FinancialPrices, CommodityPrices,
//                        NewsSource, SocialMedia, Weather, Livestream
//   Market variants:     Polymarket, Kalshi
//
// GRAPH ARCHITECTURE:
//   - Directed graph with (x, y) positioned vertices
//   - Connections represent data flow or trading relationships
//   - Metadata (serde_json::Value) stores per-type configuration
//
// DATABASE MAPPING:
//   NodeType is stored as (type_str, subtype_str) string pairs in SQLite.
//   Conversion handled by serialize_node_type() / deserialize_node() in db/sqlite.rs.
//
// All types derive Clone + Serialize + Deserialize for async tasks, database
// storage, and Tauri IPC with the TypeScript frontend.
// ============================================================================""")

# 3. models/market.rs
replace_header(os.path.join(base, "models", "market.rs"), """\
// ============================================================================
// MARKET DATA MODELS
// ============================================================================
//
// Purpose: Data structures for prediction market orderbooks, trades, and
// time-series data. Abstracts platform-specific formats (Polymarket, Kalshi)
// into unified internal representations.
//
// CORE TYPES:
//   Orderbook      - Bid/ask price levels with liquidity metrics and sequence
//                    numbers. Bids sorted descending, asks ascending.
//   OrderSide      - Buy (YES) or Sell (NO) direction
//   OrderType      - Limit(price) or Market execution
//   TimeInForce    - GTC, GTT, IOC, FOK order duration policies
//   TradeResult    - Execution confirmation with fill details, fees, and status
//   TimeseriesPoint - Single time-series observation (timestamp, source, metric, value)
//   DataPoint      - Alias for TimeseriesPoint used in batch operations
//
// PREDICTION MARKET PRICING:
//   Binary outcomes priced as probabilities 0.0-1.0. YES + NO ~ 1.0.
//   Payout is $1.00 if correct, $0.00 if incorrect.
//
// PLATFORM NORMALIZATION:
//   Polymarket CLOB orders are aggregated by price level.
//   Kalshi NO prices are converted to YES equivalents (1 - price).
// ============================================================================""")

# 4. models/position.rs
replace_header(os.path.join(base, "models", "position.rs"), """\
// ============================================================================
// POSITION MODEL
// ============================================================================
//
// Purpose: Data model and business logic for trading positions in prediction markets.
//
// POSITION LIFECYCLE:
//   1. Created via new() -> status "open", entry price/time recorded
//   2. Monitored via calculate_unrealized_pnl(current_price)
//   3. Closed via close(exit_price, time, fees) -> status "closed", realized P&L computed
//   4. Or failed via mark_failed(reason) -> status "failed"
//
// POSITION TYPES:
//   Long  - Buying YES contracts, profit when price increases
//   Short - Buying NO contracts, profit when price decreases
//
// P&L CALCULATION:
//   Unrealized: (current_price - entry_price) * quantity - fees (long)
//   Short positions invert the price direction.
//   Realized P&L includes both entry and exit fees.
//
// FEE STRUCTURES:
//   Polymarket ~2% per side, Kalshi ~1% per side.
//   Fees are accumulated on the Position struct across entry and exit.
// ============================================================================""")

# 5. models/trading_signal.rs
replace_header(os.path.join(base, "models", "trading_signal.rs"), """\
// ============================================================================
// TRADING SIGNAL MODEL
// ============================================================================
//
// Purpose: Data structures for trading signals emitted by the analyzer service.
//
// A TradingSignal represents a trading opportunity with a confidence score,
// target market, suggested size, and time-to-live. Signals flow from the
// analyzer to the executor via async channels.
//
// SIGNAL STRATEGIES:
//   arbitrage  - Price discrepancy between markets
//   momentum   - Significant price movement detected
//   sentiment  - News/social media analysis trigger
//
// Confidence score (0.0-1.0) feeds into Kelly criterion position sizing.
// Signals expire after ttl_ms if not executed.
// ============================================================================""")

# 6. commands/storage.rs
replace_header(os.path.join(base, "commands", "storage.rs"), """\
// ============================================================================
// TIME-SERIES STORAGE COMMAND HANDLERS
// ============================================================================
//
// Purpose: Tauri command handlers for persisting and querying time-series data
// (prices, sentiment, volumes) for backtesting and correlation analysis.
//
// DATA FLOW:
//   Scraper -> memory buffer (batched) -> SQLite flush every 5s or 1000 rows
//   -> indexed for fast retrieval -> queryable for analysis and charting
//
// COMMANDS:
//   store_timeseries      - Batch insert from scrapers (10k+ points/sec)
//   query_timeseries      - Time-range retrieval with granularity downsampling
//   get_correlation_data  - Pearson correlation between two time-series
//   get_available_metrics - List metric types for a source
//   delete_timeseries     - Archival cleanup by timestamp
//   get_storage_stats     - Database size and row count statistics
//
// STATE:
//   DB_POOL (r2d2 connection pool), WRITE_BUFFER (Arc<Mutex<Vec<DataPoint>>>),
//   QUERY_CACHE (LRU with TTL). Buffer flushed on shutdown to prevent data loss.
//
// All commands return Result<T, String> for Tauri IPC compatibility.
// ============================================================================""")

# 7. commands/data_sources.rs
replace_header(os.path.join(base, "commands", "data_sources.rs"), """\
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
// ============================================================================""")

# 8. commands/markets.rs
replace_header(os.path.join(base, "commands", "markets.rs"), """\
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
// ============================================================================""")

# 9. commands/orderbook.rs
replace_header(os.path.join(base, "commands", "orderbook.rs"), """\
// ============================================================================
// ORDERBOOK COMMANDS
// ============================================================================
//
// Purpose: Tauri IPC commands for orderbook WebSocket subscription management.
//
// COMMANDS:
//   subscribe_orderbook        - Start WebSocket subscription for a market
//   unsubscribe_orderbook      - Stop specific subscription
//   get_orderbook_subscriptions - List active subscriptions
//   unsubscribe_all_orderbooks - Stop all subscriptions
//   reconnect_orderbook        - Force reconnection
//
// Uses a consolidated stream manager that pools WebSocket connections by
// platform (one connection per platform, multiplexed subscriptions).
//
// OrderbookState holds the WebSocketManager, injected into commands via
// Tauri managed state.
// ============================================================================""")

# 10. commands/remote.rs
replace_header(os.path.join(base, "commands", "remote.rs"), """\
// ============================================================================
// REMOTE ACCESS COMMANDS
// ============================================================================
//
// Purpose: Tauri IPC commands for remote desktop gateway management.
//
// Exposes the remote gateway service to the React frontend via Tauri invoke.
// Commands: enable/disable remote access, device pairing, connection status,
// relay configuration.
//
// ARCHITECTURE:
//   Frontend (React) --invoke()--> Commands (this) --channel--> Gateway Service
//
// All commands use the _cmd suffix convention and receive the
// RemoteConnectionManager from Tauri managed state.
//
// SECURITY:
//   Pairing codes require physical access. Auth tokens are never exposed to
//   the frontend. Device revocation immediately disconnects the remote device.
// ============================================================================""")

# 11. services/websocket_scraper.rs
replace_header(os.path.join(base, "services", "websocket_scraper.rs"), """\
// ============================================================================
// WEBSOCKET SCRAPER SERVICE FOR INFOSOURCE NODES
// ============================================================================
//
// Purpose: WebSocket-based real-time data collection for InfoSource nodes
// (e.g., Coinbase crypto price feeds).
//
// Unlike HTTP polling scrapers, WebSocket scrapers maintain persistent
// connections and receive data as it becomes available.
//
// FLOW:
//   1. spawn_websocket_scraper() connects to WebSocket endpoint
//   2. Subscribe to channels (ticker, level2) for configured symbols
//   3. On message: update in-memory state, emit to frontend
//   4. On storage interval: batch write accumulated data to SQLite
//   5. On shutdown: close connection, flush pending data
//
// Storage interval prevents excessive DB writes by accumulating data
// in memory and writing aggregated values at the configured interval.
// ============================================================================""")

# 12. services/remote_gateway.rs
replace_header(os.path.join(base, "services", "remote_gateway.rs"), """\
// ============================================================================
// REMOTE GATEWAY SERVICE
// ============================================================================
//
// Purpose: WebSocket relay-based remote access gateway for the trading terminal.
//
// Enables remote access to the desktop terminal via an outbound WebSocket
// connection to a relay server. Market data and Tauri commands are proxied
// bidirectionally between remote devices and the home desktop.
//
// ARCHITECTURE:
//   [Remote Device] <--WS--> [Relay Server] <--WS--> [Home Desktop (this)]
//
// Uses a relay model (vs direct P2P) to avoid NAT traversal and port
// forwarding -- outbound connections only, works through firewalls.
//
// FLOW:
//   1. Gateway connects to relay, registers with device_id
//   2. Remote device connects to relay, enters pairing code
//   3. Relay bridges connections; remote authenticates with auth_token
//   4. Commands executed locally, results + market data forwarded
//
// SECURITY: TLS (wss://), 256-bit auth tokens, session timeouts, device
// revocation. Pairing requires physical access to see the pairing code.
//
// Runs as a Tokio task with mpsc command channel. WebSocket read/write
// halves run in separate tasks. Session state protected by Arc<RwLock<>>.
// ============================================================================""")

# 13. services/persistent_orderbook.rs
replace_header(os.path.join(base, "services", "persistent_orderbook.rs"), """\
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
// ============================================================================""")

# 14. services/orderbook.rs
replace_header(os.path.join(base, "services", "orderbook.rs"), """\
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
// ============================================================================""")

# 15. services/websocket_manager.rs
replace_header(os.path.join(base, "services", "websocket_manager.rs"), """\
// ============================================================================
// CONSOLIDATED WEBSOCKET STREAM MANAGER
// ============================================================================
//
// Purpose: Connection pooling for WebSocket streams -- one connection per
// platform instead of one per market, with multiplexed subscriptions.
//
// Benefits: reduced connection overhead, add/remove channels without
// reconnecting, shared heartbeat, simplified reconnection logic.
//
// ARCHITECTURE:
//   WebSocketManager holds one PlatformConnection per platform
//   (polymarket, kalshi, binance). Each PlatformConnection has a Tokio
//   task handle, mpsc command channel, and subscribed channel set.
//
// FLOW:
//   subscribe_market(platform, id) -> create or reuse connection
//   -> send AddSubscription command -> WebSocket subscribe message
//   -> messages parsed and emitted to frontend with market_id
// ============================================================================""")

print("\nAll 15 headers trimmed successfully.")
