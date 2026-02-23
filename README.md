# Prediction Market Trading Terminal

A desktop trading terminal for prediction markets (Polymarket, Kalshi) built with Tauri 2, React, and Rust.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (React + TypeScript)                      │
├──────────────────┬──────────────────┬──────────────────┬────────────────────┤
│    Canvas/       │     Markets/     │   InfoSources/   │     Metrics/       │
│  (Node Graph)    │    (Trading)     │  (Data Feeds)    │   (P&L, Stats)     │
│                  │                  │                  │                    │
│ • Canvas.tsx     │ • MarketPanel    │ • SourcePanel    │ • PerformanceMet.. │
│ • Node.tsx       │ • OrderbookView  │ • SourceTypes    │                    │
│                  │ • GlobalOrderb.. │                  │                    │
└──────────────────┴──────────────────┴──────────────────┴────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Zustand Store   │
                    │  (State Slices)   │
                    │                   │
                    │ • nodesSlice      │
                    │ • marketsSlice    │
                    │ • positionsSlice  │
                    └─────────┬─────────┘
                              │
                    ═══════════════════════
                      TAURI IPC BRIDGE
                    ═══════════════════════
                              │
┌─────────────────────────────▼───────────────────────────────────────────────┐
│                            BACKEND (Rust + Tauri)                            │
├──────────────────┬──────────────────┬──────────────────┬────────────────────┤
│   commands/      │    services/     │     models/      │       db/          │
│ (IPC Handlers)   │ (Background)     │ (Data Structs)   │     (SQLite)       │
│                  │                  │                  │                    │
│ • markets.rs     │ • scraper.rs     │ • node.rs        │ • sqlite.rs        │
│ • trading.rs     │ • analyzer.rs    │ • market.rs      │                    │
│ • orderbook.rs   │ • executor.rs    │ • position.rs    │                    │
│ • storage.rs     │ • orderbook.rs   │                  │                    │
│                  │ • websocket_m..  │                  │                    │
└──────────────────┴──────────────────┴──────────────────┴────────────────────┘
```

## Quick Start

### Prerequisites
- Node.js 18+ and pnpm
- Rust 1.70+ and Cargo
- Platform-specific dependencies (see [Tauri docs](https://tauri.app/v2/guides/prerequisites/))

### Development
```bash
# Install dependencies
pnpm install

# Run development server
pnpm tauri dev
```

### Build
```bash
pnpm tauri build
```

## Project Structure

### Frontend (`src/`)

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `components/Canvas/` | Interactive node graph visualization | `Canvas.tsx`, `Node.tsx` |
| `components/Markets/` | Market panels, orderbooks, trading UI | `MarketPanel.tsx`, `OrderbookView.tsx` |
| `components/InfoSources/` | Data source configuration panels | `SourcePanel.tsx`, `SourceTypes.tsx` |
| `components/Metrics/` | Performance tracking, P&L display | `PerformanceMetrics.tsx` |
| `components/Settings/` | API key management, configuration | `ApiKeySettings.tsx` |
| `hooks/` | React hooks for data fetching and WebSocket | `useWebSocket.ts`, `useOrderbook.ts` |
| `store/` | Zustand state slices | `nodesSlice.ts`, `marketsSlice.ts`, `positionsSlice.ts` |
| `types/` | TypeScript interfaces and enums | `nodes.ts`, `markets.ts`, `sources.ts` |
| `utils/` | API wrappers, graph layout algorithms | `api.ts`, `graphLayout.ts` |

### Backend (`src-tauri/src/`)

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `commands/` | Tauri IPC command handlers | `markets.rs`, `trading.rs`, `orderbook.rs` |
| `services/` | Background tasks (scrapers, analyzer, executor) | `scraper.rs`, `analyzer.rs`, `executor.rs` |
| `models/` | Data structures matching TypeScript types | `node.rs`, `market.rs`, `position.rs` |
| `db/` | SQLite database operations | `sqlite.rs` |

---

## Critical Conventions

### ⚠️ Tauri Command Naming

**ALL Tauri commands MUST use the `_cmd` suffix:**

```typescript
// ✅ CORRECT - matches backend registration
invoke('get_positions_cmd', { ... })
invoke('place_order_cmd', { ... })
invoke('subscribe_orderbook_cmd', { ... })

// ❌ WRONG - will fail with "command not found"
invoke('get_positions', { ... })
invoke('place_order', { ... })
```

When adding a new command:
1. Define the command logic in `src-tauri/src/commands/*.rs`
2. Create a wrapper in `main.rs` with `#[tauri::command]` and `_cmd` suffix
3. Register it in `tauri::generate_handler![]`
4. Call it from frontend using the exact `_cmd` name

### Type Mappings (Rust ↔ TypeScript)

| Rust Type | TypeScript Type | Notes |
|-----------|-----------------|-------|
| `f64` | `number` | All numeric values |
| `u64`, `i64` | `number` | Safe up to 2^53 |
| `Option<T>` | `T \| undefined` | Optional fields |
| `Vec<T>` | `T[]` | Arrays |
| `enum` | String literal union | e.g., `'polymarket' \| 'kalshi'` |
| `chrono::DateTime` | `number` | Unix timestamp (ms) |
| `serde_json::Value` | `Record<string, any>` | Metadata objects |

### State Synchronization Pattern

When modifying persisted data, follow this pattern:

```typescript
// 1. Update Zustand store (optimistic UI update)
updateNodePosition(nodeId, newPosition);

// 2. Persist to SQLite via Tauri command
try {
  await invoke('update_node_cmd', { node: updatedNode });
} catch (error) {
  // 3. Handle errors (rollback if needed)
  revertNodePosition(nodeId, oldPosition);
  showError(error);
}
```

---

## Common Tasks Checklist

### Add a New Info Source Type

1. [ ] Add enum variant to `src/types/nodes.ts` → `InfoSourceType`
2. [ ] Add configuration interface in `src/types/sources.ts`
3. [ ] Add backend scraper logic in `src-tauri/src/services/scraper.rs`
4. [ ] Add UI component in `src/components/InfoSources/SourceTypes.tsx`
5. [ ] Update connection validation rules in `src/utils/graphLayout.ts`
6. [ ] Add model variant in `src-tauri/src/models/node.rs`

### Add a New Market Platform

1. [ ] Add enum variant to `src/types/nodes.ts` → `MarketType`
2. [ ] Add market-specific types in `src/types/markets.ts`
3. [ ] Add Rust model in `src-tauri/src/models/market.rs`
4. [ ] Add WebSocket handler in `src-tauri/src/services/orderbook.rs`
5. [ ] Add IPC commands in `src-tauri/src/commands/markets.rs`
6. [ ] Register commands in `src-tauri/src/main.rs`
7. [ ] Add API key handling in `src-tauri/src/commands/api_keys.rs`
8. [ ] Add UI in `src/components/Markets/MarketPanel.tsx`
9. [ ] Add frontend API wrapper in `src/utils/api.ts`

### Modify Trading Logic

1. [ ] Update position calculation in `src/store/positionsSlice.ts`
2. [ ] Update backend execution in `src-tauri/src/services/executor.rs`
3. [ ] Update signal analysis in `src-tauri/src/services/analyzer.rs`
4. [ ] Add tests for new logic
5. [ ] Update P&L display in `src/components/Metrics/PerformanceMetrics.tsx`

### Database Schema Changes

1. [ ] Add migration in `src-tauri/src/db/sqlite.rs` → `setup_schema()`
2. [ ] Update Rust models in `src-tauri/src/models/`
3. [ ] Update TypeScript types in `src/types/`
4. [ ] Update CRUD operations in `src-tauri/src/db/sqlite.rs`
5. [ ] Update IPC commands if needed

---

## Key Files Reference

| File | Purpose | When to Modify |
|------|---------|----------------|
| `src/App.tsx` | Main layout shell, panel orchestration | Adding new panels, changing layout |
| `src/store/index.ts` | Zustand store configuration | Adding new slices, middleware |
| `src/utils/api.ts` | All backend communication | Adding new Tauri commands |
| `src/types/nodes.ts` | Core type definitions | Adding node/market types |
| `src-tauri/main.rs` | Backend initialization, command registration | Adding new commands, services |
| `src-tauri/services/mod.rs` | Background service coordination | Adding new services |
| `src-tauri/db/sqlite.rs` | Database schema and operations | Schema changes, new queries |

---

## Pitfalls to Avoid

| Pitfall | Consequence | Solution |
|---------|-------------|----------|
| Forgetting `_cmd` suffix | "Command not found" error | Always check `main.rs` for exact command name |
| Modifying Zustand without persisting | Data lost on refresh | Always call backend for persisted data |
| Blocking main thread | UI freezes | Use async operations for heavy work |
| Skipping error handling | Uncaught promise rejections | Use `Result<T, ApiError>` pattern |
| Mismatched Rust/TS types | Serialization errors | Check type mappings table above |

---

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/)
- [Tauri Extension](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
- [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
- [TypeScript Vue Plugin (Volar)](https://marketplace.visualstudio.com/items?itemName=Vue.volar) - for TypeScript support

---

## Tech Stack

**Frontend:**
- React 19 + TypeScript
- Vite 6
- Tailwind CSS 4
- Zustand 5 (state management)
- Lucide React (icons)

**Backend:**
- Tauri 2
- Rust (Tokio async runtime)
- SQLite with WAL mode
- tokio-tungstenite (WebSocket)
- reqwest (HTTP client)

---

## License

MIT
