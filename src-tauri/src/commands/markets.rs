// ============================================================================
// MARKET CONNECTION COMMAND HANDLERS
// ============================================================================
//
// Module: commands/markets.rs
// Purpose: Tauri command handlers for prediction market platform connections
//
// OVERVIEW:
// This module manages connections to prediction market platforms (Polymarket, Kalshi)
// and handles real-time orderbook data. It serves as the abstraction layer between
// market-specific APIs and the internal node graph representation.
//
// Supported Platforms:
// - Polymarket (Polygon blockchain-based, WebSocket + REST)
// - Kalshi (regulated US exchange, WebSocket + REST)
//
// ARCHITECTURE:
// User clicks "Add Market" in UI
//   → Frontend calls add_market() with API credentials
//   → Backend validates credentials against platform
//   → Establishes WebSocket connection for real-time data
//   → Creates Market node in database
//   → Spawns WebSocket listener task (Tokio async)
//   → Returns Node to frontend for canvas display
//   → Continuously receives orderbook updates via WebSocket
//   → Updates in-memory cache and emits events to frontend
//
// COMMANDS (Tauri-callable functions):
//
// 1. add_market(market_type, api_credentials, market_id) -> Result<Node, String>
//    - Authenticates with prediction market platform
//    - Establishes WebSocket connection for real-time feeds
//    - Creates market node in graph
//    - Returns: Complete Node object with connection status
//    - Example: add_market(Polymarket, {"api_key": "xxx"}, "BTC-100K-2026")
//
// 2. remove_market(id) -> Result<(), String>
//    - Closes WebSocket connection gracefully
//    - Sends unsubscribe frames to platform
//    - Archives market node (preserves trade history)
//    - Cleans up API client resources
//
// 3. get_markets() -> Result<Vec<Node>, String>
//    - Retrieves all connected market nodes
//    - Includes connection health status
//    - Used by UI to populate canvas on startup
//    - Returns: Array of Node objects with metadata
//
// 4. get_orderbook(market_id) -> Result<Orderbook, String>
//    - Returns current orderbook (bids/asks) for a market
//    - Checks in-memory cache first (<500ms old)
//    - Falls back to REST API if WebSocket disconnected
//    - Returns: Structured orderbook with liquidity metrics
//    - Format: { bids: [[price, size], ...], asks: [[price, size], ...], timestamp }
//
// 5. refresh_market_connection(id) -> Result<Node, String>
//    - Forces reconnection to market WebSocket
//    - Useful when connection drops or API key changes
//    - Maintains node position and connections in graph
//    - Updates connection state
//
// 6. get_market_status(id) -> Result<JsonValue, String>
//    - Returns connection health metrics
//    - Fields: connected, last_heartbeat, latency_ms, 
//              subscription_count, error_count
//    - Used by UI to show connection indicators (green/red dot)
//
// STATE MANAGEMENT:
// - MARKET_CONNECTIONS: Arc<RwLock<HashMap<String, MarketConnection>>>
//   - Maps node_id → MarketConnection struct
//   - Contains: WebSocket stream, API client, last message timestamp
//   - RwLock allows concurrent reads of orderbook data
//
// - ORDERBOOK_CACHE: Arc<Mutex<LruCache<String, Orderbook>>>
//   - LRU cache with 5-minute TTL
//   - Prevents hammering REST APIs when frontend polls frequently
//   - Automatically evicts old entries
//
// - API_CREDENTIALS: Secure storage reference
//   - API keys stored in Tauri's secure store (keyring)
//   - Only handles/connection IDs stored in memory
//   - Retrieved by ID when making authenticated calls
//
// EXTERNAL METHODS CALLED:
//
// Platform API clients (implemented in services/market_api/):
// - authenticate_polymarket(api_key) -> Result<AuthToken, Error>
//   - POST /auth/api-key to Polymarket
//   - Returns JWT token for subsequent requests
//
// - authenticate_kalshi(api_key, api_secret) -> Result<Session, Error>
//   - POST /login to Kalshi
//   - Establishes session cookie/token
//
// - connect_websocket(url, auth_token) -> Result<WebSocketStream, Error>
//   - Opens WSS connection to platform
//   - Sends authentication frame
//   - Returns framed stream for orderbook updates
//
// - fetch_rest_orderbook(market_id, platform) -> Result<Orderbook, Error>
//   - GET /exchange/v1/orderbooks/{id} (Polymarket)
//   - GET /markets/{id}/orderbook (Kalshi)
//   - Normalizes different formats to internal Orderbook struct
//
// Database operations (db/sqlite.rs):
// - store_market_node(node) -> Result<(), Error>
// - fetch_market_node(id) -> Result<Node, Error>
// - update_market_status(id, status) -> Result<(), Error>
// - archive_market_node(id) -> Result<(), Error>
//
// WebSocket handlers (services/market_websocket.rs):
// - spawn_websocket_listener(connection_id, stream) -> JoinHandle
//   - Processes incoming orderbook deltas
//   - Updates ORDERBOOK_CACHE
//   - Emits "orderbook:update" events to frontend
//   - Handles reconnection logic
//
// DEPENDENCIES:
// - crate::models::node::{Node, NodeType, MarketType}
// - crate::models::market::Orderbook
// - tokio_tungstenite (WebSocket client)
// - reqwest (HTTP client for REST APIs)
// - tauri::api::notification (connection error alerts)
// - serde_json (credential serialization)
// - chrono (timestamp handling)
// - lru::LruCache (in-memory caching)
//
// ERROR HANDLING:
// All commands return Result<T, String> for Tauri compatibility
// Errors categorized as:
// - AuthenticationError: Invalid API credentials
// - ConnectionError: Network/WebSocket failures
// - RateLimitError: HTTP 429 from platform
// - NotFoundError: Market ID doesn't exist on platform
// Errors include context (platform name, market ID) for debugging
//
// PERFORMANCE NOTES:
// - WebSocket connections persisted across command calls (not per-request)
// - Orderbook cache serves 95% of get_orderbook calls without network hit
// - WebSocket listener tasks use zero-copy where possible
// - Supports 20+ concurrent market connections without degradation
// - Automatic reconnection with exponential backoff (1s, 2s, 4s... 60s max)
//
// SECURITY NOTES:
// - API keys never logged or returned to frontend
// - Credentials retrieved from secure storage by reference only
// - WebSocket connections use wss:// (TLS) exclusively
// - No plaintext credential storage in SQLite
//
// TESTING:
// - Unit tests use mock WebSocket servers (tokio-test)
// - Mock API responses for authentication
// - Tests verify cache invalidation logic
// - Connection failure scenarios tested
//
// USAGE EXAMPLE (from frontend):
// ```typescript
// import { invoke } from '@tauri-apps/api/tauri';
// 
// // Connect to Polymarket
// const marketNode = await invoke('add_market', {
//   marketType: 'Polymarket',
//   apiCredentials: { apiKey: 'pm_key_xxx' }, // Stored securely
//   marketId: 'BTC-100K-2026'
// });
// 
// // Fetch orderbook
// const orderbook = await invoke('get_orderbook', {
//   marketId: marketNode.id
// });
// console.log('Best bid:', orderbook.bids[0]);
// ```
//
// FUTURE ENHANCEMENTS:
// - Support for additional platforms (PredictIt, Betfair)
// - Orderbook aggregation across platforms
// - Connection pooling for multiple markets per platform
// - Automatic failover to REST when WebSocket fails
// - Market metadata caching (descriptions, resolution criteria)
// ============================================================================