# Developer Guide

Practical guide for working with the Prediction Market Trading Terminal codebase.

---

## Getting Started

### Prerequisites

- **Node.js 18+** with **pnpm** (install via `npm install -g pnpm`)
- **Rust 1.70+** with Cargo (install via [rustup](https://rustup.rs/))
- Platform-specific Tauri dependencies: [Tauri prerequisites](https://tauri.app/v2/guides/prerequisites/)

### First-Time Setup

```bash
# Clone and install
git clone <repo-url>
cd TradingTerminal
pnpm install

# Start development (hot-reload frontend + auto-rebuild Rust)
pnpm tauri dev
```

The first `pnpm tauri dev` will compile the Rust backend, which can be slow. Subsequent builds are incremental.

### Building for Production

```bash
pnpm tauri build
```

Output binary is in `src-tauri/target/release/`.

---

## Development Workflow

### Making Frontend Changes

1. Edit files in `src/`
2. Vite hot-reloads automatically (no restart needed)
3. Use React DevTools and Redux DevTools (Zustand supports it) for debugging

### Making Backend Changes

1. Edit files in `src-tauri/src/`
2. Tauri auto-rebuilds the Rust backend (restarts the app)
3. Use `println!()` or `log::info!()` for debugging (appears in terminal)

### Adding a New Feature (end-to-end)

Typical flow for adding a new Tauri command:

```
1. Define types   →  src-tauri/src/models/*.rs  +  src/types/*.ts
2. Write logic    →  src-tauri/src/commands/*.rs  (or services/ for background work)
3. Register cmd   →  src-tauri/src/main.rs  (add_xxx_cmd wrapper + generate_handler!)
4. Frontend call  →  src/utils/api.ts  (typed wrapper with Result pattern)
5. UI integration →  src/components/*.tsx  (call the api wrapper)
```

---

## Code Patterns

### Result Pattern (Frontend API)

All Tauri command calls use `Result<T, ApiError>` instead of try/catch:

```typescript
import { invokeCommand, ok, err } from '../utils/api';

// Calling a command
const result = await invokeCommand<Node[]>('get_data_sources_cmd');

if (result.ok) {
  const nodes = result.value;
} else {
  console.error(result.error.message);
  // result.error.type: 'network' | 'command' | 'timeout' | ...
  // result.error.retryable: boolean
}
```

### Zustand State Updates

```typescript
// Reading state in components
const nodes = useStore((s) => s.nodes);
const addNode = useStore((s) => s.addNode);

// Reading state outside React
const state = useStore.getState();

// Updating (immer middleware allows mutable-style)
set((state) => {
  state.nodes[node.id] = node; // OK with immer
});
```

### Tauri Command Pattern (Backend)

```rust
// 1. In commands/your_module.rs
pub async fn your_function(args: YourArgs) -> Result<YourResponse, String> {
    // Validate, get DB connection, do work
    let db = crate::db::get_connection().await?;
    let conn = db.lock().unwrap();
    // ...
    Ok(response)
}

// 2. In main.rs (wrapper with _cmd suffix)
#[tauri::command]
async fn your_function_cmd(args: YourArgs) -> Result<YourResponse, String> {
    commands::your_function(args).await
}

// 3. Register in generate_handler!
tauri::generate_handler![
    // ... existing commands ...
    your_function_cmd,
]
```

### Tauri Events (Backend -> Frontend)

```rust
// Emitting from backend
app_handle.emit("your_event_name", &payload)?;

// Listening in frontend
import { listen } from '@tauri-apps/api/event';

const unlisten = await listen('your_event_name', (event) => {
  const data = event.payload;
  // Update Zustand store...
});

// Clean up on unmount
return () => unlisten();
```

---

## Naming Conventions

### Commands

- Rust function: `get_data_sources` (descriptive)
- Tauri wrapper: `get_data_sources_cmd` (always `_cmd` suffix)
- Frontend invoke: `invoke('get_data_sources_cmd')`

### Files

- Components: `PascalCase.tsx` (e.g., `MarketPanel.tsx`)
- Hooks: `camelCase.ts` (e.g., `useOrderbook.ts`)
- Utils: `camelCase.ts` (e.g., `nodeHelpers.ts`)
- Types: `camelCase.ts` (e.g., `nodes.ts`)
- Rust modules: `snake_case.rs` (e.g., `websocket_manager.rs`)

### TypeScript

- Interfaces: `PascalCase` (e.g., `Node`, `Orderbook`)
- Enums: `PascalCase` with `PascalCase` members (e.g., `InfoSourceType.CryptoPrices`)
- Functions: `camelCase` (e.g., `transformNodeFromBackend`)
- Constants: `SCREAMING_SNAKE_CASE` (e.g., `PANEL_WIDTHS`)

### Rust

- Types/Structs: `PascalCase` (e.g., `TradingSignal`)
- Functions: `snake_case` (e.g., `spawn_scraper`)
- Constants: `SCREAMING_SNAKE_CASE`
- Modules: `snake_case` (e.g., `websocket_manager`)

---

## Type Synchronization

When modifying shared types, update both sides:

| Change | Rust File | TypeScript File |
|--------|-----------|----------------|
| New node type | `models/node.rs` | `types/nodes.ts` |
| New market type | `models/node.rs` | `types/nodes.ts` |
| Orderbook changes | `models/market.rs` | `types/markets.ts` |
| Position changes | `models/position.rs` | `types/markets.ts` |
| Analyzer changes | `models/analyzer_node.rs` | `types/analyzers.ts` |
| Remote changes | `models/remote.rs` | `types/remote.ts` |
| Source config | `commands/data_sources.rs` | `types/sources.ts` |

### Key Type Mappings

| Rust | TypeScript |
|------|-----------|
| `f64` | `number` |
| `Option<T>` | `T \| undefined` |
| `Vec<T>` | `T[]` |
| `String` | `string` |
| `serde_json::Value` | `Record<string, any>` |
| Tagged enum `NodeType::InfoSource(x)` | `{ InfoSource: InfoSourceType }` |

---

## Database Operations

### Schema

Defined in `src-tauri/src/db/sqlite.rs` -> `setup_schema()`. Tables are created on first run. To add a migration, append `CREATE TABLE IF NOT EXISTS` or `ALTER TABLE` statements.

### Common Operations

```rust
use crate::db;

// Get connection
let conn_arc = db::get_connection().await?;
let conn = conn_arc.lock().unwrap();
let conn_ref = conn.as_ref().ok_or("DB not initialized")?;

// CRUD
db::insert_node(conn_ref, &node)?;
let nodes = db::get_all_active_nodes(conn_ref)?;
db::delete_node_cascade(conn_ref, node_id)?;
```

### WAL Mode

SQLite runs in WAL (Write-Ahead Logging) mode for concurrent reads. This is configured in `apply_optimizations()`.

---

## Error Handling

### Frontend

Use the `Result` type from `utils/api.ts`:

```typescript
const result = await getDataSources();
if (!result.ok) {
  // Handle by error type
  switch (result.error.type) {
    case 'network': // Retry or show connection error
    case 'command': // Show backend error message
    case 'timeout': // Suggest retry
  }
}
```

### Backend

Commands return `Result<T, String>`. Use `map_err` to convert errors:

```rust
let node = db::get_node_by_id(conn, id)
    .map_err(|e| format!("Failed to get node: {}", e))?;
```

### Error Boundaries

Each UI panel is wrapped in `PanelErrorBoundary` (from `components/UI/ErrorBoundary.tsx`). A crash in one panel doesn't bring down the app.

---

## Debugging Tips

### Frontend

- **React DevTools**: Inspect component tree and state
- **Redux DevTools**: Zustand integrates with it (store name: `PredictionMarketTerminal`)
- **Console logs**: API calls are logged in development with timing info
- **Network tab**: WebSocket connections visible in browser devtools

### Backend

- **Terminal output**: `println!()` and `log::info!()` appear in the Vite dev server terminal
- **env_logger**: Set `RUST_LOG=debug` for verbose logging
- **Rust analyzer**: In-editor type checking and error reporting

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| "Command not found" | Missing `_cmd` suffix | Check `main.rs` for exact command name |
| Serialization error | Rust/TS type mismatch | Compare model definitions on both sides |
| Node not appearing | Missing `transformNodeFromBackend` call | Ensure backend node is transformed before adding to store |
| WebSocket not connecting | Missing API key or wrong URL | Check `ApiKeySettings` and backend logs |
| Database locked | Long-running query on main connection | Use async operations, avoid blocking |

---

## Testing

### Backend Tests

```bash
cd src-tauri
cargo test
```

Tests use `tempfile` for database isolation and `wiremock` for HTTP mocking.

### Frontend

No test runner is currently configured. The codebase uses TypeScript strict mode for compile-time safety.

---

## Key Files Reference

Quick lookup for the most commonly modified files:

| When You Need To... | Look At |
|---------------------|---------|
| Add a new node type | `src/types/nodes.ts`, `src-tauri/src/models/node.rs` |
| Add display name for type | `src/utils/nodeHelpers.ts` |
| Add a new Tauri command | `src-tauri/src/commands/`, `src-tauri/src/main.rs`, `src/utils/api.ts` |
| Change the UI layout | `src/App.tsx` |
| Add a new component | `src/components/` (extract into appropriate subdirectory) |
| Change database schema | `src-tauri/src/db/sqlite.rs` |
| Add a new service | `src-tauri/src/services/`, `src-tauri/src/services/mod.rs` |
| Add a new analyzer | `src-tauri/src/services/analyzers/`, `src-tauri/src/models/analyzer_node.rs` |
| Add backend→frontend events | Backend: `app_handle.emit()`, Frontend: `listen()` from `@tauri-apps/api/event` |
| Change state management | `src/store/` (add or modify slices) |
