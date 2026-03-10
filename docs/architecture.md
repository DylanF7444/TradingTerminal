# Architecture

This document describes the system architecture of the Prediction Market Trading Terminal.

---

## System Overview

The application is a Tauri 2 desktop app with two distinct layers:

- **Frontend**: React 19 + TypeScript, running in a native webview
- **Backend**: Rust, running as a native process with Tokio async runtime

Communication between layers uses Tauri's IPC bridge (`invoke` from frontend, `#[tauri::command]` on backend). The frontend calls commands; the backend emits events.

```
 ┌────────────────────────────────────────────────────┐
 │              FRONTEND (Webview)                     │
 │                                                     │
 │  React Components ──> Zustand Store ──> Tauri IPC  │
 │       ▲                                    │        │
 │       │ events                     invoke  │        │
 │       │                                    ▼        │
 ├───────┼────────────────────────────────────┼────────┤
 │              BACKEND (Native)              │        │
 │                                                     │
 │  Commands ──> Services ──> SQLite                   │
 │               (Tokio tasks)                         │
 └────────────────────────────────────────────────────┘
```

---

## Backend Architecture

### Module Organization

```
src-tauri/src/
├── main.rs              # Entry point: DB init, service startup, command registration
├── commands/            # IPC handlers (thin controllers)
│   ├── data_sources.rs  # CRUD for info source nodes + scraper lifecycle
│   ├── markets.rs       # Market connections, search, status
│   ├── trading.rs       # Order placement, positions, multi-leg orders
│   ├── orderbook.rs     # WebSocket subscription management
│   ├── storage.rs       # Time-series data persistence + queries
│   ├── analyzers.rs     # Analyzer CRUD, results, chains
│   ├── api_keys.rs      # Credential storage (encrypted in SQLite)
│   └── remote.rs        # Remote access gateway management
├── services/            # Background async tasks
│   ├── scraper.rs       # Per-node data collection (one Tokio task each)
│   ├── analyzer.rs      # Signal generation (correlation, arbitrage, etc.)
│   ├── executor.rs      # Trade execution with risk management
│   ├── orderbook.rs     # Per-market WebSocket connections
│   ├── websocket_manager.rs      # Consolidated per-platform WS connections
│   ├── websocket_scraper.rs      # WS-based data ingestion for info sources
│   ├── persistent_orderbook.rs   # Always-on orderbook subscriptions
│   ├── startup.rs                # Reconnect saved nodes on app launch
│   ├── remote_gateway.rs         # Remote access relay connection
│   ├── analyzer_pipeline.rs      # Routes data events to analyzer instances
│   ├── node_analyzer_manager.rs  # Lifecycle management for node analyzers
│   └── analyzers/                # Concrete analyzer implementations
│       ├── correlation.rs        # Pearson correlation (Welford's algorithm)
│       ├── momentum.rs           # EMA crossover signals
│       ├── arbitrage.rs          # Cross-market price discrepancy detection
│       ├── sentiment.rs          # Keyword-weighted sentiment scoring
│       ├── rsi.rs                # Relative Strength Index
│       └── volatility.rs         # Rolling standard deviation
├── models/              # Shared data structures (Serde-serializable)
│   ├── node.rs          # Node, NodeType, InfoSourceType, MarketType
│   ├── market.rs        # Orderbook, OrderType, TradeResult
│   ├── position.rs      # Position lifecycle and P&L
│   ├── trading_signal.rs # Trading signals between analyzer and executor
│   ├── analyzer_node.rs # Analyzer configuration and results
│   └── remote.rs        # Remote session, credentials, protocol messages
└── db/
    ├── mod.rs           # Global connection management
    └── sqlite.rs        # Schema, CRUD operations, migrations
```

### Service Pipeline

The core data processing follows a pipeline pattern with independent failure domains:

```
[Scraper Service]  →  [Analyzer Service]  →  [Executor Service]
     │                       │                       │
     ▼                       ▼                       ▼
  Raw Data            Trading Signals           Orders Placed
  (prices,            (buy/sell/hold)           (positions opened)
  sentiment)
```

Each service runs as independent Tokio tasks. A failed scraper doesn't block analysis; a failed executor doesn't crash data ingestion.

### Database Schema

SQLite with WAL mode. Key tables:

| Table | Purpose |
|-------|---------|
| `nodes` | Graph nodes (info sources, markets, analyzers) |
| `connections` | Edges between nodes with strength metadata |
| `timeseries` | Time-series data points from scrapers |
| `websocket_messages` | Raw WebSocket message log |
| `positions` | Trading positions with entry/exit data |
| `api_keys` | Encrypted API credentials |
| `analyzers` | Analyzer configurations per node |
| `analyzer_chains` | Chained analyzer relationships |
| `scraper_status` | Scraper health monitoring |

### Threading Model

- **Main thread**: Tauri event loop (UI, window management)
- **Tokio runtime**: All async work (commands, services, WebSockets, HTTP)
- **Scraper tasks**: One per data source node, independently cancellable
- **WebSocket tasks**: Per-platform consolidated connections

---

## Frontend Architecture

### Component Hierarchy

```
main.tsx (bootstrap, error boundary, theme)
└── App.tsx (responsive 3-panel layout)
    ├── Left Sidebar
    │   ├── SourcePanel (add/manage data sources)
    │   ├── MarketPanel (add/manage markets)
    │   ├── AnalyzerPanel (add/manage analyzers)
    │   └── PerformanceMetrics (P&L display)
    ├── Main Canvas
    │   └── Canvas (interactive node graph with zoom/pan/drag)
    │       └── Node (individual graph node with type-specific rendering)
    ├── Right Sidebar
    │   ├── NodeDetailsPanel (monitoring config, connections)
    │   ├── RawStreamTab (live data stream viewer)
    │   └── NodeDataPanel (stored time-series data)
    └── Bottom Panel
        └── Position monitor (placeholder)
```

### State Management

Zustand store with slices pattern:

| Slice | State | Purpose |
|-------|-------|---------|
| `nodesSlice` | `nodes`, `connections`, `selectedIds`, `viewport` | Graph nodes and visual state |
| `marketsSlice` | `markets`, `orderbooks`, `marketStatus` | Market connections and real-time data |
| `positionsSlice` | `openPositions`, `closedPositions`, `dailyStats` | Trading positions and P&L |
| `uiSlice` | `sidebarOpen`, `theme`, `modalOpen` | UI layout preferences |

Middleware stack: immer (mutable-style updates) -> devtools (Redux DevTools) -> persist (localStorage for UI prefs) -> subscribeWithSelector (backend sync).

### Hooks

| Hook | Purpose |
|------|---------|
| `useInfoSourceEvents` | Listens for `infosource:update` Tauri events |
| `useOrderbook` | Subscribes to orderbook updates for a market |
| `usePersistentOrderbooks` | Maintains always-on orderbook subscriptions |
| `useConsolidatedWebSocket` | Interface to consolidated per-platform WS |
| `useWebSocket` | General WebSocket connection management |
| `useApiKeys` | API key CRUD operations |
| `useRemoteAccess` | Remote gateway state management |
| `useTauriCommand` | Generic command invocation with loading/error state |

---

## IPC Protocol

All frontend-to-backend communication uses Tauri's `invoke`:

```typescript
// Frontend
const result = await invoke<Node[]>('get_data_sources_cmd');

// Backend (main.rs wrapper)
#[tauri::command]
async fn get_data_sources_cmd() -> Result<Vec<Node>, String> {
    commands::get_data_sources().await
}
```

All commands use the `_cmd` suffix. The frontend API layer (`src/utils/api.ts`) wraps all invocations with a `Result<T, ApiError>` pattern for explicit error handling.

Backend-to-frontend communication uses Tauri events:

```rust
// Backend
app_handle.emit("infosource:update", payload)?;

// Frontend
listen("infosource:update", (event) => { ... });
```

---

## Remote Access Architecture

```
[Remote Device] <--wss--> [Relay Server] <--wss--> [Home Desktop]
```

- Home desktop connects **outbound** to relay (no port forwarding)
- Relay is a simple WebSocket bridge (can be self-hosted)
- Pairing uses 6-digit codes (physical access required)
- Auth tokens are 256-bit random hex, stored locally
- Only read-only commands allowed by default
