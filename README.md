# Prediction Market Trading Terminal

A desktop trading terminal for prediction markets (Polymarket, Kalshi) built with Tauri 2, React 19, and Rust. It connects real-time data sources (crypto prices, news, weather, social media) to prediction market orderbooks via an interactive node graph, enabling traders to visualize correlations and execute trades.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Architecture Overview](#architecture-overview)
- [Repository Map](#repository-map)
- [How to Navigate the Code](#how-to-navigate-the-code)
- [Development Guide](#development-guide)
- [Extension Guide](#extension-guide)
- [Key Design Decisions](#key-design-decisions)
- [Critical Conventions](#critical-conventions)
- [Pitfalls to Avoid](#pitfalls-to-avoid)

---

## Project Overview

### What It Does

The terminal lets traders:
1. **Connect data sources** (crypto prices, news feeds, weather, social media, economic indicators) as nodes on an interactive canvas
2. **Connect prediction markets** (Polymarket, Kalshi) and view real-time orderbooks
3. **Draw connections** between data sources and markets to track correlations
4. **Run analyzers** (correlation, momentum, RSI, sentiment, arbitrage, volatility) that generate trading signals
5. **Execute trades** directly on connected markets with risk management (Kelly criterion, position limits)
6. **Monitor positions** with real-time P&L tracking
7. **Access remotely** via a WebSocket relay gateway from other devices

### Key Concepts

- **Node Graph**: The central abstraction. Everything is a node on an infinite canvas -- data sources, markets, and analyzers. Connections between nodes represent data flow and correlation.
- **Info Source Node**: Ingests external data (crypto prices via Coinbase WebSocket, news via RSS, etc.) and stores time-series metrics.
- **Market Node**: Represents a prediction market contract. Displays orderbook, enables trading.
- **Analyzer Node**: Processes data from connected info sources and generates trading signals (e.g., "correlation between BTC price and this market is 0.85").
- **Pipeline**: Data flows through Scraper -> Analyzer -> Executor services in the Rust backend.

### Data Sources

The terminal uses **Coinbase WebSocket** as the primary source for real-time cryptocurrency prices (no API key required). Alternative providers: Binance, CoinGecko, CoinMarketCap, CryptoCompare. Nine source types are supported: CryptoPrices, FinancialPrices, CommodityPrices, NewsSource, SocialMedia, Weather, Livestream, EconomicIndicators, OnChainData.

---

## Architecture Overview

### High-Level Design

The application is a Tauri 2 desktop app with two layers communicating via Tauri's IPC bridge:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        FRONTEND (React 19 + TypeScript)                     │
│                                                                             │
│  Components:                                                                │
│  ┌──────────┐ ┌───────────┐ ┌─────────────┐ ┌──────────┐ ┌──────────────┐ │
│  │ Canvas/  │ │ Markets/  │ │ InfoSources/│ │  Nodes/  │ │  Analyzers/  │ │
│  │Node Graph│ │ Orderbook │ │ Data Feeds  │ │ Details  │ │   Panel      │ │
│  └──────────┘ └───────────┘ └─────────────┘ └──────────┘ └──────────────┘ │
│                                                                             │
│  State:  Zustand Store (nodesSlice, marketsSlice, positionsSlice, uiSlice) │
│  Hooks:  useOrderbook, useWebSocket, useInfoSourceEvents, useApiKeys       │
│  Utils:  api.ts (Result pattern), nodeTransform, nodeHelpers, graphLayout  │
├─────────────────────────────────────────────────────────────────────────────┤
│                          TAURI IPC BRIDGE                                   │
│                 invoke('command_cmd', args) → Result<T>                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                         BACKEND (Rust + Tokio)                              │
│                                                                             │
│  commands/          services/              models/          db/             │
│  ├─ data_sources   ├─ scraper (per-node)  ├─ node          └─ sqlite.rs   │
│  ├─ markets        ├─ analyzer            ├─ market            (WAL mode) │
│  ├─ trading        ├─ executor            ├─ position                     │
│  ├─ orderbook      ├─ orderbook (WS)      ├─ trading_signal              │
│  ├─ storage        ├─ websocket_manager   ├─ analyzer_node               │
│  ├─ analyzers      ├─ persistent_orderbook├─ remote                      │
│  ├─ api_keys       ├─ remote_gateway      │                              │
│  └─ remote         └─ startup             │                              │
│                                                                             │
│  Pipeline: [Scraper] → [Analyzer] → [Executor]                            │
│            Raw Data    Signals      Orders                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Scraper tasks** (one per info source node) poll external APIs or connect via WebSocket, storing time-series data in SQLite and emitting Tauri events to the frontend.
2. **Analyzer service** consumes raw data, runs analysis (correlation, momentum, etc.), and generates `TradingSignal`s.
3. **Executor service** receives signals, applies risk management (Kelly criterion, exposure limits), and places orders on Polymarket/Kalshi APIs.
4. **Frontend** receives real-time updates via Tauri events, updates Zustand store, and re-renders.

### State Management

- **Zustand** (frontend): Slices pattern with immer middl   eware. Nodes and positions are loaded from SQLite on startup; optimistic UI updates are synced back via debounced Tauri commands.
- **SQLite** (backend): Source of truth for nodes, connections, time-series, positions, and API keys. WAL mode for concurrent reads.
- **WebSocket**: Real-time orderbook data via `websocket_manager` (consolidated per-platform connections) and `persistent_orderbook` (always-on subscriptions).

---

## Repository Map

```
TradingTerminal/
├── src/                          # Frontend (React + TypeScript)
│   ├── main.tsx                  # App bootstrap, error boundary, platform detection
│   ├── App.tsx                   # Root layout (3-panel responsive shell)
│   ├── styles.css                # Global styles + Tailwind imports
│   ├── components/
│   │   ├── Canvas/               # Interactive node graph (Canvas.tsx, Node.tsx)
│   │   ├── Markets/              # Market panels, orderbooks, multi-leg orders
│   │   ├── InfoSources/          # Data source config (SourcePanel, SourceTypes)
│   │   ├── Nodes/                # Node detail panels, raw stream, stored data
│   │   ├── Analyzers/            # Analyzer configuration panel
│   │   ├── Metrics/              # Performance metrics, P&L display
│   │   ├── Settings/             # API key management
│   │   ├── Remote/               # Remote access settings
│   │   └── UI/                   # Reusable primitives (Modal, Button, Clock, ErrorBoundary)
│   ├── hooks/                    # React hooks (WebSocket, orderbook, events, API keys)
│   ├── store/                    # Zustand state (nodesSlice, marketsSlice, positionsSlice)
│   ├── types/                    # TypeScript interfaces (nodes, markets, sources, analyzers, remote)
│   └── utils/                    # API wrappers, transforms, helpers, layout algorithms
├── src-tauri/                    # Backend (Rust + Tauri 2)
│   ├── src/
│   │   ├── main.rs               # App entry: DB init, service startup, command registration
│   │   ├── commands/             # IPC handlers (thin controllers delegating to services)
│   │   ├── services/             # Background tasks (scraper, analyzer, executor, WebSocket)
│   │   │   └── analyzers/        # Concrete analyzer implementations (correlation, momentum, RSI...)
│   │   ├── models/               # Serde-serializable data structures (shared with frontend)
│   │   └── db/                   # SQLite schema, CRUD operations, migrations
│   ├── Cargo.toml                # Rust dependencies
│   └── tauri.conf.json           # Tauri window/build configuration
├── package.json                  # Frontend dependencies (React 19, Zustand 5, Tailwind 4)
├── vite.config.ts                # Vite build config (React plugin, Tailwind, dev server)
├── tsconfig.json                 # TypeScript config (ES2020, strict)
└── docs/                         # Architecture and developer documentation
    ├── architecture.md
    ├── module-overview.md
    └── developer-guide.md
```

---

## How to Navigate the Code

### Where to Start

1. **`src-tauri/src/main.rs`** -- Backend entry point. Read this to understand how the app boots: DB initialization, service spawning, command registration.
2. **`src/App.tsx`** -- Frontend entry point (layout). Shows the 3-panel UI structure and how nodes, connections, and events flow.
3. **`src/store/index.ts`** -- State management hub. Shows all Zustand slices and how they compose.

### Core Modules

| Module | Location | Why It Matters |
|--------|----------|----------------|
| Node Graph Types | `src/types/nodes.ts` | Defines the central abstraction (Node, NodeType, Connection) |
| API Layer | `src/utils/api.ts` | All frontend-to-backend communication with Result pattern |
| Zustand Store | `src/store/` | All reactive state (nodes, markets, positions) |
| IPC Commands | `src-tauri/src/commands/` | Every operation the frontend can invoke |
| Service Pipeline | `src-tauri/src/services/` | Background data processing (scrape → analyze → execute) |
| Database | `src-tauri/src/db/sqlite.rs` | Schema, queries, and data persistence |
| Models | `src-tauri/src/models/` | Shared data structures (must match TypeScript types) |

### Execution Flow (adding a data source)

1. User clicks "Add Source" in `SourcePanel.tsx`
2. Frontend calls `invoke('add_data_source_cmd', config)` via `utils/api.ts`
3. Backend `commands/data_sources.rs` validates, inserts into SQLite, spawns scraper task
4. Scraper (`services/scraper.rs`) begins polling external API
5. Data stored in SQLite, events emitted via `Window::emit("infosource:update")`
6. Frontend hook `useInfoSourceEvents` receives event, updates Zustand store
7. Canvas re-renders with new node showing data quality indicators

---

## Development Guide

### Prerequisites

- **Node.js 18+** and **pnpm**
- **Rust 1.70+** and Cargo
- Platform-specific dependencies: see [Tauri prerequisites](https://tauri.app/v2/guides/prerequisites/)

### Setup

```bash
# Install frontend dependencies
pnpm install

# Run development server (starts both Vite and Rust backend)
pnpm tauri dev

# Build production binary
pnpm tauri build
```

### Project Scripts

| Command | Description |
|---------|-------------|
| `pnpm tauri dev` | Start development mode (hot reload frontend + Rust backend) |
| `pnpm tauri build` | Build production binary |
| `pnpm dev` | Start Vite dev server only (frontend, no Rust) |
| `pnpm build` | Build frontend only |

### Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend Framework | React | 19 |
| State Management | Zustand | 5 |
| Build Tool | Vite | 6 |
| CSS | Tailwind CSS | 4 |
| Icons | Lucide React | 0.562 |
| Desktop Framework | Tauri | 2 |
| Backend Language | Rust | 2021 edition |
| Async Runtime | Tokio | 1 (full features) |
| Database | SQLite (rusqlite) | 0.30 (bundled) |
| WebSocket | tokio-tungstenite | 0.21 |
| HTTP Client | reqwest | 0.11 |
| Serialization | serde + serde_json | 1.0 |

### Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) with:
  - [Tauri Extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
  - [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
  - ESLint + Prettier for TypeScript

---

## Extension Guide

### Adding a New Info Source Type

1. Add enum variant to `src/types/nodes.ts` -> `InfoSourceType`
2. Add display name in `src/utils/nodeHelpers.ts` -> `TYPE_DISPLAY_NAMES`
3. Add monitoring config in `src/components/Nodes/NodeDetailsPanel.extracted.tsx` -> `MONITORING_CONFIG`
4. Add configuration interface in `src/types/sources.ts`
5. Add backend scraper logic in `src-tauri/src/services/scraper.rs`
6. Add UI component in `src/components/InfoSources/SourceTypes.tsx`
7. Update connection validation rules in `src/utils/graphLayout.ts`
8. Add model variant in `src-tauri/src/models/node.rs`

### Adding a New Market Platform

1. Add enum variant to `src/types/nodes.ts` -> `MarketType`
2. Add market-specific types in `src/types/markets.ts`
3. Add Rust model in `src-tauri/src/models/market.rs`
4. Add WebSocket handler in `src-tauri/src/services/orderbook.rs`
5. Add IPC commands in `src-tauri/src/commands/markets.rs`
6. Register commands in `src-tauri/src/main.rs`
7. Add API key handling in `src-tauri/src/commands/api_keys.rs`
8. Add UI in `src/components/Markets/MarketPanel.tsx`
9. Add frontend API wrapper in `src/utils/api.ts`

### Adding a New Analyzer Type

1. Add variant to `AnalyzerType` enum in `src-tauri/src/models/analyzer_node.rs`
2. Create implementation in `src-tauri/src/services/analyzers/` implementing `AnalyzerInstance` trait
3. Register in `src-tauri/src/services/analyzers/mod.rs`
4. Add TypeScript type in `src/types/analyzers.ts`
5. Add config UI in `src/components/Analyzers/AnalyzerPanel.tsx`

### Adding a New Tauri Command

1. Define command logic in `src-tauri/src/commands/*.rs`
2. Re-export from `src-tauri/src/commands/mod.rs`
3. Create `#[tauri::command]` wrapper in `main.rs` with `_cmd` suffix
4. Register in `tauri::generate_handler![]`
5. Add typed wrapper in `src/utils/api.ts`
6. Call from frontend: `invoke('your_command_cmd', { args })`

### Modifying the Database Schema

1. Add migration in `src-tauri/src/db/sqlite.rs` -> `setup_schema()`
2. Update Rust models in `src-tauri/src/models/`
3. Update TypeScript types in `src/types/`
4. Update CRUD operations in `src-tauri/src/db/sqlite.rs`
5. Update IPC commands if needed

### Architectural Patterns Used

- **Slices pattern** (Zustand): State split by domain, composed into one store
- **Result pattern** (frontend API): All IPC calls return `Result<T, ApiError>` instead of throwing
- **Pipeline pattern** (backend services): Scraper -> Analyzer -> Executor with independent failure
- **Discriminated unions** (node types): `NodeType = { InfoSource: ... } | { Market: ... } | { Analyzer: ... }`
- **Optimistic updates**: UI updates immediately, async sync to SQLite with rollback on failure
- **Error boundaries**: Each panel wrapped in `PanelErrorBoundary` for isolated crash recovery

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Tauri 2 over Electron** | ~5MB binary vs ~150MB, ~50MB RAM vs ~300MB. Critical for 24/7 trading operations. |
| **SQLite over PostgreSQL** | No external DB server needed. WAL mode gives concurrent reads. Single-file for portability. |
| **Zustand over Redux** | Minimal boilerplate, excellent TypeScript inference, no provider wrapper needed. |
| **Node graph as core abstraction** | Visual representation of data flow matches how traders think about market relationships. |
| **One scraper task per node** | Isolated failure domains -- one broken API doesn't crash all data collection. |
| **`_cmd` suffix on all commands** | Prevents Rust keyword conflicts; makes IPC boundary explicit and grep-able. |
| **Result pattern instead of try/catch** | Forces explicit error handling at every call site; prevents uncaught rejections. |
| **Per-platform WebSocket consolidation** | One connection per exchange instead of one per market reduces connection count and API rate limit usage. |
| **Immer middleware in Zustand** | Enables mutable-style state updates while maintaining immutability guarantees. |
| **Outbound-only relay for remote access** | No port forwarding required on user's network; relay handles NAT traversal. |

---

## Critical Conventions

### Tauri Command Naming

**ALL Tauri commands MUST use the `_cmd` suffix:**

```typescript
// CORRECT
invoke('get_positions_cmd', { ... })
invoke('place_order_cmd', { ... })

// WRONG - will fail with "command not found"
invoke('get_positions', { ... })
```

### Type Mappings (Rust <-> TypeScript)

| Rust | TypeScript | Notes |
|------|-----------|-------|
| `f64` | `number` | All numeric values |
| `u64`, `i64` | `number` | Safe up to 2^53 |
| `Option<T>` | `T \| undefined` | Optional fields |
| `Vec<T>` | `T[]` | Arrays |
| `enum` | String literal union | e.g., `'Polymarket' \| 'Kalshi'` |
| `chrono::DateTime` | `number` | Unix timestamp (ms) |
| `serde_json::Value` | `Record<string, any>` | Metadata objects |

### State Synchronization

Persisted data follows optimistic update + async sync:

```typescript
// 1. Update Zustand store (immediate UI response)
updateNodePosition(nodeId, newPosition);

// 2. Persist to SQLite via Tauri command
try {
  await invoke('update_node_cmd', { node: updatedNode });
} catch (error) {
  revertNodePosition(nodeId, oldPosition); // 3. Rollback on failure
}
```

---

## Pitfalls to Avoid

| Pitfall | Consequence | Solution |
|---------|-------------|----------|
| Forgetting `_cmd` suffix | "Command not found" error | Check `main.rs` for exact command name |
| Modifying Zustand without persisting | Data lost on refresh | Always call backend for persisted data |
| Blocking main thread | UI freezes | Use async operations for heavy work |
| Skipping error handling | Uncaught promise rejections | Use `Result<T, ApiError>` pattern from `api.ts` |
| Mismatched Rust/TS types | Serialization errors | Check type mappings table above |
| Duplicating type guards inline | Inconsistency | Use helpers from `src/utils/nodeHelpers.ts` |
| Adding components inside App.tsx | Monolith regression | Extract to dedicated files under `components/` |
| Forgetting display name for new types | Raw enum value shown in UI | Update `TYPE_DISPLAY_NAMES` in `nodeHelpers.ts` |
| Using `process.env.NODE_ENV` | Undefined in Vite builds | Use `import.meta.env.DEV` / `import.meta.env.PROD` |

---

## Remote Access

The terminal supports remote access from other devices via a WebSocket relay:

```
[Remote Device] <--wss--> [Relay Server] <--wss--> [Home Desktop]
                                                         |
                                                    [Market APIs]
```

- **No port forwarding needed** -- home desktop connects outbound to relay
- **6-digit pairing code** -- physical access required for initial setup
- **Read-only by default** -- trading requires explicit opt-in
- **Session timeouts** -- idle sessions expire after 5 minutes

Configuration: Settings -> Remote Access. See `docs/module-overview.md` for component details.

---

## License

MIT
