# Copilot Instructions for Prediction Market Trading Terminal

## Project Overview

A Tauri 2 desktop trading terminal for prediction markets (Polymarket, Kalshi) with React 19 frontend and Rust backend. Uses an interactive node graph to connect data sources (crypto prices, news, weather) to market orderbooks.

## Quick Reference

### Build & Run Commands

```bash
pnpm install              # Install frontend dependencies
pnpm tauri dev            # Start dev mode (Vite + Rust backend with hot reload)
pnpm tauri build          # Build production binary
pnpm dev                  # Start Vite dev server only (no Rust)
```

### Test Commands

```bash
cd src-tauri && cargo test              # Run all backend tests
cd src-tauri && cargo test test_name    # Run single test by name
cd src-tauri && cargo test module::     # Run all tests in a module
```

Tests use `tempfile` for DB isolation and `wiremock` for HTTP mocking. No frontend test runner is configured.

### Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React 19, Zustand 5, Tailwind 4, Vite 6 |
| Backend | Rust 2021, Tauri 2, Tokio, SQLite (rusqlite) |
| IPC | Tauri invoke with `_cmd` suffix convention |

## Critical Conventions

### Tauri Command Naming (MANDATORY)

**ALL Tauri commands MUST use the `_cmd` suffix:**

```typescript
// ✅ CORRECT
invoke('get_positions_cmd', { ... })
invoke('place_order_cmd', { ... })

// ❌ WRONG - will fail with "command not found"
invoke('get_positions', { ... })
```

### Type Mappings (Rust ↔ TypeScript)

| Rust | TypeScript |
|------|------------|
| `f64` | `number` |
| `Option<T>` | `T \| undefined` |
| `Vec<T>` | `T[]` |
| `enum` | String literal union |
| `chrono::DateTime` | `number` (Unix timestamp ms) |

### State Management Pattern

Frontend uses **optimistic updates** with async SQLite sync:

```typescript
// 1. Update Zustand store immediately
updateNodePosition(nodeId, newPosition);

// 2. Persist to SQLite
await invoke('update_node_cmd', { node: updatedNode });
// On failure: rollback Zustand state
```

## Architecture

```
Frontend (React 19)          Tauri IPC              Backend (Rust + Tokio)
├── components/              invoke('_cmd')         ├── commands/   (IPC handlers)
├── store/ (Zustand)    ←─────────────────────→    ├── services/   (scraper, analyzer, executor)
├── hooks/                                          ├── models/     (shared types)
├── types/                                          └── db/sqlite.rs
└── utils/api.ts (Result pattern)
```

**Data Pipeline:** Scraper → Analyzer → Executor (each service can fail independently)

## Analyzer Pipeline

The analyzer pipeline routes data events to analyzer instances and forwards signals to the executor:

```
DataEvent (from Scraper)
    ↓
AnalyzerPipeline.process_event()
    ↓
AnalyzerInstance.process_event() → Option<TradingSignal>
    ↓
signal_tx.send() → Executor
```

**Key concepts:**
- `AnalyzerInstance` trait: All analyzers implement `process_event()`, `get_latest_result()`, `update_config()`
- Analyzers are attached to nodes: `node_analyzers: HashMap<node_id, Vec<AnalyzerInstance>>`
- **Chaining**: Output of one analyzer can feed another via `process_chained_input()`
- Factory: `analyzers::create_analyzer(AnalyzerNode)` creates instances by type

**Available analyzer types:** Correlation, Momentum, Arbitrage, Sentiment, RSI, Volatility

**Adding a new analyzer:**
1. Create `src-tauri/src/services/analyzers/your_analyzer.rs`
2. Implement `AnalyzerInstance` trait
3. Add to `create_analyzer()` match in `analyzers/mod.rs`
4. Add `AnalyzerType::YourType` variant to `models/analyzer_node.rs`

## WebSocket Patterns

**Consolidated connections** (one per platform, not per market):

```
WebSocketManager
├── connections: HashMap<PlatformType, PlatformConnection>
│   └── PlatformConnection { task_handle, command_tx, subscribed_markets }
└── subscribe_market(platform, id) → AddSubscription command → WS message
```

**Supported platforms:** Polymarket, Kalshi, Binance, Coinbase

**Frontend subscription pattern:**
```typescript
// Hook manages lifecycle automatically
const { subscribe, unsubscribe } = useConsolidatedWebSocket();
await subscribe('polymarket', '0x123...');

// Listen for updates
listen('orderbook:update', (event) => { ... });
listen('infosource:update', (event) => { ... });
```

**Key events emitted by backend:**
| Event | Payload | Source |
|-------|---------|--------|
| `orderbook:update` | `OrderbookUpdate` | `websocket_manager.rs` |
| `infosource:update` | Price/data updates | `websocket_scraper.rs` |
| `position:update` | Position changes | `executor.rs` |

## Key Files

| Purpose | Location |
|---------|----------|
| Backend entry | `src-tauri/src/main.rs` |
| Frontend layout | `src/App.tsx` |
| State store | `src/store/index.ts` |
| API layer | `src/utils/api.ts` |
| Node types | `src/types/nodes.ts` |
| Type helpers | `src/utils/nodeHelpers.ts` |
| DB schema | `src-tauri/src/db/sqlite.rs` |

## Common Extension Tasks

### Adding a New Tauri Command

1. Add command in `src-tauri/src/commands/*.rs`
2. Re-export from `src-tauri/src/commands/mod.rs`
3. Create `#[tauri::command]` wrapper in `main.rs` with `_cmd` suffix
4. Register in `tauri::generate_handler![]`
5. Add typed wrapper in `src/utils/api.ts`

### Adding a New Info Source Type

1. Add variant to `InfoSourceType` in `src/types/nodes.ts`
2. Add display name in `src/utils/nodeHelpers.ts` → `TYPE_DISPLAY_NAMES`
3. Add scraper logic in `src-tauri/src/services/scraper.rs`
4. Add UI in `src/components/InfoSources/SourceTypes.tsx`

### Adding a New Analyzer Type

1. Add variant to `AnalyzerType` in `src-tauri/src/models/analyzer_node.rs`
2. Implement `AnalyzerInstance` trait in `src-tauri/src/services/analyzers/`
3. Register in `src-tauri/src/services/analyzers/mod.rs`
4. Add TypeScript type in `src/types/analyzers.ts`
5. Add config UI in `src/components/Analyzers/AnalyzerPanel.tsx`

## Pitfalls to Avoid

| Issue | Solution |
|-------|----------|
| "Command not found" error | Check `_cmd` suffix on Tauri invoke |
| Data lost on refresh | Always persist to SQLite via backend commands |
| UI freezes | Use async operations for heavy work |
| Uncaught promise rejections | Use `Result<T, ApiError>` pattern from `api.ts` |
| Serialization errors | Verify Rust/TypeScript type mappings match |
| Raw enum shown in UI | Update `TYPE_DISPLAY_NAMES` in `nodeHelpers.ts` |
| `process.env.NODE_ENV` undefined | Use `import.meta.env.DEV` / `import.meta.env.PROD` |

## Code Style

- **Frontend:** Extract components to dedicated files under `components/`, don't add to `App.tsx`
- **Type guards:** Use helpers from `src/utils/nodeHelpers.ts`, don't duplicate inline
- **Error handling:** Always use Result pattern, never bare try/catch for IPC calls
- **Components:** Each panel wrapped in `PanelErrorBoundary` for isolated crash recovery
- **Comments:** Update comment sections of files to reflect any changes made
