# Module Overview

Quick reference for every module in the codebase. Use this to find where specific functionality lives.

---

## Frontend Modules (`src/`)

### Entry Points

| File | Purpose |
|------|---------|
| `main.tsx` | App bootstrap: platform detection, Tauri init, error boundary, React root |
| `App.tsx` | Root layout: 3-panel responsive shell, keyboard shortcuts, node loading |

### Components

| Module | Files | Purpose |
|--------|-------|---------|
| `Canvas/` | `Canvas.tsx`, `Node.tsx` | Interactive node graph with zoom/pan, drag-drop, connection drawing |
| `Markets/` | `MarketPanel.tsx` | Add/configure Polymarket and Kalshi market nodes |
| | `OrderbookView.tsx` | Real-time orderbook display with depth visualization |
| | `GlobalOrderbookOverlay.tsx` | Overlay for viewing orderbooks across all markets |
| | `NodeOrderbookPopup.tsx` | Compact orderbook popup on canvas nodes |
| | `MultiLegOrderEntry.tsx` | Spread/OCO/bracket order entry form |
| | `MultiLegPositionView.tsx` | Multi-leg position display with aggregate P&L |
| | `MarketBrowser.tsx` | Search and browse available markets |
| `InfoSources/` | `SourcePanel.tsx` | Add/configure/remove data source nodes |
| | `SourceTypes.tsx` | Type-specific config components for each source type |
| `Nodes/` | `NodeDetailsPanel.extracted.tsx` | Selected node details, monitoring config, connections |
| | `RawStreamTab.tsx` | Live data stream viewer with simulation support |
| | `NodeDataPanel.tsx` | Stored time-series data viewer |
| `Analyzers/` | `AnalyzerPanel.tsx` | Create/configure/delete analyzers, view results |
| `Metrics/` | `PerformanceMetrics.tsx` | System health and trading performance dashboard |
| `Settings/` | `ApiKeySettings.tsx` | API key management for trading platforms |
| `Remote/` | `RemoteAccessPanel.tsx` | Remote access gateway settings and device management |
| `UI/` | `Modal.tsx` | Reusable modal dialog |
| | `Button.tsx` | Multi-variant button component |
| | `Clock.tsx` | Real-time clock display |
| | `ErrorBoundary.tsx` | Panel-level error boundary (isolates crashes per panel) |

### Hooks

| Hook | Purpose |
|------|---------|
| `useInfoSourceEvents` | Listens for `infosource:update` Tauri events; also exports `useNodeQualityMetrics`, `useMarketOrderbookEvents`, `useAutoMarketSubscriptions` |
| `useOrderbook` | Subscribes to orderbook updates for specific markets |
| `usePersistentOrderbooks` | Manages always-on orderbook subscriptions for all active market nodes |
| `useConsolidatedWebSocket` | Interface to backend's per-platform consolidated WebSocket |
| `useWebSocket` | General-purpose WebSocket connection lifecycle management |
| `useApiKeys` | API key save/get/delete via Tauri commands |
| `useRemoteAccess` | Remote gateway enable/disable, status, pairing, device management |
| `useTauriCommand` | Generic command invocation hook with loading/error state |
| `useNodeGraph` | Node graph state: layout, drag/drop, connections |

### Store Slices

| Slice | State | Key Actions |
|-------|-------|-------------|
| `nodesSlice` | `nodes` (Record), `connections` (array), `selectedIds` (Set), `viewport` | `addNode`, `removeNode`, `updateNodePosition`, `selectNode`, `addConnection` |
| `marketsSlice` | `markets` (array), `orderbooks` (Record), `marketStatus` | `addMarket`, `removeMarket`, `updateOrderbook`, `setMarketStatus` |
| `positionsSlice` | `openPositions`, `closedPositions`, `multiLegPositions`, `dailyStats` | `openPosition`, `closePosition`, `updatePositionPrice` |
| `uiSlice` (inline) | `sidebarOpen`, `activePanel`, `theme`, `modalOpen` | `toggleSidebar`, `setActivePanel`, `setTheme` |

### Types

| File | Defines |
|------|---------|
| `nodes.ts` | `Node`, `NodeType`, `NodeId`, `InfoSourceType` (9 variants), `MarketType`, `AnalyzerType`, `AlertType`, `Connection`, `ViewportState`, validation functions |
| `markets.ts` | `Orderbook`, `OrderSide`, `OrderType`, `TradeResult`, `Position`, `MultiLegOrder`, `NetworkMetrics` |
| `sources.ts` | Per-source-type configuration interfaces (`CryptoConfig`, `NewsConfig`, etc.) |
| `analyzers.ts` | `AnalyzerNode`, `AnalyzerType`, `AnalyzerResult`, `AnalyzerChain` |
| `remote.ts` | `RemoteStatus`, `DeviceCredentials`, `PairedDevice`, `RelayConfig` |

### Utilities

| File | Purpose |
|------|---------|
| `api.ts` | Typed Tauri command wrappers with `Result<T, ApiError>` pattern, error factories, retry logic |
| `nodeTransform.ts` | Converts backend Node structs to frontend format |
| `nodeHelpers.ts` | Type guards (`isInfoSourceNode`), display names (`TYPE_DISPLAY_NAMES`), color schemes |
| `graphLayout.ts` | Force-directed and hierarchical layout algorithms for auto-arranging nodes |
| `demoData.ts` | Creates demo nodes and connections for first-time users |

---

## Backend Modules (`src-tauri/src/`)

### Entry Point

| File | Purpose |
|------|---------|
| `main.rs` | App bootstrap: SQLite init, scraper/WebSocket startup, all `#[tauri::command]` wrappers, command registration via `generate_handler![]` |

### Commands (IPC Handlers)

Each command module is a thin controller that validates input, acquires state, and delegates to services.

| Module | Commands | Purpose |
|--------|----------|---------|
| `data_sources.rs` | `add_data_source`, `remove_data_source`, `get_data_sources`, `update_node_position_cmd`, `update_node_size_cmd` | Info source node CRUD; starts scraper tasks on add |
| `markets.rs` | `add_market`, `remove_market`, `get_markets`, `get_orderbook`, `search_markets`, `get_market_status`, `refresh_market_connection` | Market node management; WebSocket lifecycle |
| `trading.rs` | `place_order`, `get_positions`, `close_position` | Trade execution and position queries |
| `orderbook.rs` | `subscribe_orderbook_cmd`, `subscribe_consolidated_cmd`, `unsubscribe_*`, `set_kalshi_credentials_cmd` | WebSocket subscription management (legacy + consolidated) |
| `storage.rs` | `store_timeseries`, `query_timeseries`, `get_correlation_data`, `get_node_stored_data`, `delete_node_stored_data` | Time-series persistence with downsampling |
| `analyzers.rs` | `create_analyzer`, `update_analyzer`, `delete_analyzer`, `get_node_analyzers`, `toggle_analyzer`, `create_chain` | Analyzer CRUD and chain management |
| `api_keys.rs` | `save_api_key_command`, `get_api_key_command`, `delete_api_key_command`, `has_api_key_command` | Secure credential storage |
| `remote.rs` | `enable_remote_access`, `disable_remote_access`, `generate_pairing_code`, `revoke_remote_device` | Remote gateway management |

### Services (Background Tasks)

| Module | Runs As | Purpose |
|--------|---------|---------|
| `scraper.rs` | One Tokio task per info source node | Polls external APIs, stores data in SQLite, emits events |
| `analyzer.rs` | Single task | Consumes scraper data, generates trading signals |
| `executor.rs` | Single task | Receives signals, applies risk management, places orders |
| `orderbook.rs` | One task per subscribed market | WebSocket connections for real-time orderbook data |
| `websocket_manager.rs` | One task per platform | Consolidated WebSocket (one connection per exchange, multiplexes subscriptions) |
| `websocket_scraper.rs` | One task per WS-based source | WebSocket data ingestion for info sources (e.g., Coinbase ticker) |
| `persistent_orderbook.rs` | Single task | Always-on orderbook subscriptions for all active market nodes |
| `startup.rs` | Runs once at boot | Reconnects saved nodes (scrapers, WebSockets) from database |
| `remote_gateway.rs` | Single task | Outbound WebSocket to relay server for remote access |
| `analyzer_pipeline.rs` | Embedded in analyzer | Routes data events to correct analyzer instances |
| `node_analyzer_manager.rs` | Embedded | Manages analyzer lifecycle (start/stop on node connect/disconnect) |

### Analyzer Implementations (`services/analyzers/`)

All implement the `AnalyzerInstance` trait.

| Module | Algorithm |
|--------|-----------|
| `correlation.rs` | Pearson correlation using Welford's online algorithm |
| `momentum.rs` | EMA crossover (configurable short/long periods) |
| `arbitrage.rs` | Cross-market price discrepancy detection |
| `sentiment.rs` | Keyword-weighted sentiment with temporal decay |
| `rsi.rs` | Relative Strength Index with configurable thresholds |
| `volatility.rs` | Rolling standard deviation of returns |

### Models (Data Structures)

All implement `Serialize`/`Deserialize` for Tauri IPC compatibility.

| Module | Key Types |
|--------|-----------|
| `node.rs` | `Node`, `NodeType`, `InfoSourceType` (9 variants), `MarketType` (Polymarket, Kalshi) |
| `market.rs` | `Orderbook`, `OrderbookLevel`, `TradeSide`, `OrderType`, `TradeResult`, `MultiLegOrder` |
| `position.rs` | `Position` (lifecycle: open -> closed), `MultiLegPosition`, P&L calculations |
| `trading_signal.rs` | `TradingSignal` (confidence, strategy type, TTL) |
| `analyzer_node.rs` | `AnalyzerNode`, `AnalyzerType` (7 variants), `AnalyzerResult`, `AnalyzerChain` |
| `remote.rs` | `RemoteSession`, `DeviceCredentials`, `RemoteCommand`, `RelayConfig` |

### Database (`db/`)

| Module | Purpose |
|--------|---------|
| `mod.rs` | Global SQLite connection management (init, get, close, health check) |
| `sqlite.rs` | Schema creation (`setup_schema`), all CRUD operations, WAL mode optimization, query helpers |
