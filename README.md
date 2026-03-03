# Prediction Market Trading Terminal

A desktop trading terminal for prediction markets (Polymarket, Kalshi) built with Tauri 2, React, and Rust.

## Data Sources

### Crypto Price Feeds
The terminal uses **Coinbase WebSocket** as the primary/default source for real-time cryptocurrency prices. Coinbase provides:
- Real-time ticker updates (price, bid/ask spreads)
- Level 2 orderbook data via `level2_batch` channel
- Reliable WebSocket connections with automatic reconnection
- No API key required for public market data

Supported trading pairs include: BTC-USD, ETH-USD, SOL-USD, and more.

Alternative crypto providers available:
- **Binance** - High frequency, requires API key
- **CoinGecko** - Free tier, rate limited (REST API only)
- **CoinMarketCap** - Comprehensive metadata
- **CryptoCompare** - Historical data specialist

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FRONTEND (React + TypeScript)                      │
├──────────────────┬──────────────────┬──────────────────┬────────────────────┤
│    Canvas/       │     Markets/     │   InfoSources/   │     Nodes/         │
│  (Node Graph)    │    (Trading)     │  (Data Feeds)    │   (Detail Panels)  │
│                  │                  │                  │                    │
│ • Canvas.tsx     │ • MarketPanel    │ • SourcePanel    │ • NodeDetailsPanel │
│ • Node.tsx       │ • OrderbookView  │ • SourceTypes    │ • RawStreamTab     │
│                  │ • GlobalOrderb.. │                  │ • NodeDataPanel    │
├──────────────────┴──────────────────┴──────────────────┴────────────────────┤
│  UI/               │  hooks/              │  utils/                         │
│ • Clock.tsx        │ • useInfoSource..    │ • nodeTransform.ts              │
│ • ErrorBoundary    │ • useOrderbook.ts    │ • nodeHelpers.ts                │
│ • Modal.tsx        │ • useWebSocket.ts    │ • demoData.ts                   │
│ • Button.tsx       │ • useApiKeys.ts      │ • api.ts / graphLayout.ts       │
├────────────────────┴──────────────────────┴─────────────────────────────────┤
│  Metrics/            │  Settings/                                           │
│ • PerformanceMetrics │ • ApiKeySettings                                     │
└──────────────────────┴──────────────────────────────────────────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │   Zustand Store   │
                    │  (State Slices)   │
                    │                   │
                    │ • nodesSlice      │
                    │ • marketsSlice    │
                    │ • positionsSlice  │
                    │ • uiSlice         │
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
│ • storage.rs     │ • orderbook.rs   │ • remote.rs      │                    │
│ • remote.rs      │ • websocket_m..  │                  │                    │
│                  │ • remote_gate..  │                  │                    │
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
| `components/Nodes/` | Node detail panels (details, raw stream, stored data) | `NodeDetailsPanel.extracted.tsx`, `RawStreamTab.tsx`, `NodeDataPanel.tsx` |
| `components/Metrics/` | Performance tracking, P&L display | `PerformanceMetrics.tsx` |
| `components/Settings/` | API key management, configuration | `ApiKeySettings.tsx` |
| `components/Remote/` | Remote desktop access management panel | `RemoteAccessPanel.tsx` |
| `components/UI/` | Reusable UI primitives and error boundaries | `Modal.tsx`, `Button.tsx`, `Clock.tsx`, `ErrorBoundary.tsx` |
| `hooks/` | React hooks for data fetching, WebSocket, and events | `useInfoSourceEvents.ts`, `useWebSocket.ts`, `useOrderbook.ts`, `useRemoteAccess.ts` |
| `store/` | Zustand state slices | `nodesSlice.ts`, `marketsSlice.ts`, `positionsSlice.ts` |
| `types/` | TypeScript interfaces and enums | `nodes.ts`, `markets.ts`, `sources.ts`, `remote.ts` |
| `utils/` | API wrappers, transforms, helpers, layout algorithms | `api.ts`, `nodeTransform.ts`, `nodeHelpers.ts`, `demoData.ts`, `graphLayout.ts` |

### Backend (`src-tauri/src/`)

| Directory | Purpose | Key Files |
|-----------|---------|-----------|
| `commands/` | Tauri IPC command handlers | `markets.rs`, `trading.rs`, `orderbook.rs`, `remote.rs` |
| `services/` | Background tasks (scrapers, analyzer, executor, remote gateway) | `scraper.rs`, `analyzer.rs`, `executor.rs`, `remote_gateway.rs` |
| `models/` | Data structures matching TypeScript types | `node.rs`, `market.rs`, `position.rs`, `remote.rs` |
| `db/` | SQLite database operations | `sqlite.rs` |

---

## Remote Access (Remote Desktop Gateway)

### Overview

The trading terminal supports remote access, allowing you to connect to your home desktop running the app from a remote device (laptop, tablet, etc.) via a WebSocket relay server.

```
[Remote Device] <──WebSocket──> [Relay Server] <──WebSocket──> [Home Desktop]
                                                                     │
                                                              [Market APIs]
```

### Architecture

- **Home Desktop**: Runs the full trading terminal. Connects *outbound* to the relay server (no port forwarding needed).
- **Relay Server**: Lightweight signaling/bridge server. Handles NAT traversal. Can be self-hosted or managed.
- **Remote Device**: Connects to the same relay. Authenticates with pairing credentials. Commands are proxied to home desktop.

### Key Components

| Component | Location | Purpose |
|-----------|----------|---------|
| `RemoteConnectionManager` | `services/remote_gateway.rs` | Central gateway manager (spawns relay connection task) |
| `RemoteCommand` | `models/remote.rs` | Protocol messages (auth, pair, forward, heartbeat) |
| `remote.rs` commands | `commands/remote.rs` | Tauri IPC handlers for frontend control |
| `useRemoteAccess` | `hooks/useRemoteAccess.ts` | React hook for gateway state management |
| `RemoteAccessPanel` | `components/Remote/RemoteAccessPanel.tsx` | Settings UI for enabling/managing remote access |
| `remote.ts` types | `types/remote.ts` | TypeScript type definitions for remote data |

### Remote Access Commands

| Command | Frontend Invoke | Description |
|---------|----------------|-------------|
| `enable_remote_access_cmd` | `invoke('enable_remote_access_cmd', { request })` | Connect to relay, accept remotes |
| `disable_remote_access_cmd` | `invoke('disable_remote_access_cmd')` | Disconnect all, stop gateway |
| `get_remote_status_cmd` | `invoke('get_remote_status_cmd')` | Gateway status snapshot |
| `generate_pairing_code_cmd` | `invoke('generate_pairing_code_cmd')` | Create 6-digit pairing code |
| `revoke_remote_device_cmd` | `invoke('revoke_remote_device_cmd', { deviceId })` | Revoke paired device |
| `get_paired_devices_cmd` | `invoke('get_paired_devices_cmd')` | List paired devices |
| `update_relay_config_cmd` | `invoke('update_relay_config_cmd', { request })` | Change relay settings |

### Security

- **TLS Encryption**: All relay traffic uses `wss://` (WebSocket Secure)
- **Device Pairing**: 6-digit code displayed on home desktop (physical access required)
- **Auth Tokens**: 256-bit random hex tokens generated on pairing, stored locally
- **Command Whitelist**: Only read-only commands allowed via remote by default (trading requires explicit opt-in)
- **Session Timeouts**: Idle sessions expire after configurable timeout (default: 5 minutes)
- **Device Revocation**: Paired devices can be revoked at any time, immediately disconnecting them

### Usage

1. Open **Settings** → scroll to **Remote Access**
2. Enter relay server URL (or use the default localhost for testing)
3. Toggle the gateway **on**
4. Click **Generate Code** to create a 6-digit pairing code
5. On your remote device, enter the pairing code to connect
6. Monitor connected devices and statistics in the panel

### Tauri Events (Backend → Frontend)

| Event | Payload | Description |
|-------|---------|-------------|
| `remote:status_update` | `RemoteStatus` | Periodic gateway status update |
| `remote:pairing_code` | `{ code, expiresInSeconds }` | New pairing code generated |
| `remote:device_connected` | `{ deviceId, sessionId }` | Remote device authenticated |
| `remote:device_disconnected` | `{ reason }` | Remote device disconnected |
| `remote:relay_connected` | `()` | Relay WebSocket connected |
| `remote:relay_disconnected` | `()` | Relay WebSocket disconnected |
| `remote:reconnect_failed` | `{ attempt, maxAttempts, error }` | Reconnection attempt failed |

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
2. [ ] Add display name in `src/utils/nodeHelpers.ts` → `TYPE_DISPLAY_NAMES`
3. [ ] Add monitoring config in `src/components/Nodes/NodeDetailsPanel.extracted.tsx` → `MONITORING_CONFIG`
4. [ ] Add configuration interface in `src/types/sources.ts`
5. [ ] Add backend scraper logic in `src-tauri/src/services/scraper.rs`
6. [ ] Add UI component in `src/components/InfoSources/SourceTypes.tsx`
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
| `src/App.tsx` | Layout shell, responsive renderers, shared callbacks | Adding new panels, changing layout |
| `src/utils/nodeHelpers.ts` | Type guards, display names, color schemes | Adding new node types or categories |
| `src/utils/nodeTransform.ts` | Backend→frontend node data transform | Changing node data schema |
| `src/utils/demoData.ts` | Demo node creation for first-time users | Changing default nodes/connections |
| `src/hooks/useInfoSourceEvents.ts` | Global Tauri event listener, quality metrics | Changing data propagation or metrics |
| `src/components/Nodes/NodeDetailsPanel.extracted.tsx` | Node detail panel (monitoring, config, connections) | Adding new node metadata displays |
| `src/components/Nodes/RawStreamTab.tsx` | Raw data stream viewer for nodes | Changing stream display or simulation |
| `src/components/UI/ErrorBoundary.tsx` | Panel-level error boundary wrapper | Changing error recovery behavior |
| `src/store/index.ts` | Zustand store configuration, typed slice creators | Adding new slices, middleware |
| `src/utils/api.ts` | All backend communication (Result pattern) | Adding new Tauri commands |
| `src/types/nodes.ts` | Core type definitions | Adding node/market types |
| `src-tauri/main.rs` | Backend initialization, command registration | Adding new commands, services |
| `src-tauri/services/mod.rs` | Background service coordination | Adding new services |
| `src-tauri/db/sqlite.rs` | Database schema and operations | Schema changes, new queries |
| `src-tauri/services/remote_gateway.rs` | Remote desktop gateway relay service | Remote access features, relay protocol |
| `src-tauri/commands/remote.rs` | Remote access IPC command handlers | Adding remote control commands |
| `src-tauri/models/remote.rs` | Remote access data structures | Remote protocol, session, credential types |
| `src/hooks/useRemoteAccess.ts` | React hook for remote gateway control | Remote access UI state/operations |
| `src/components/Remote/RemoteAccessPanel.tsx` | Remote access settings UI panel | Remote access UI changes |
| `src/types/remote.ts` | TypeScript remote access type definitions | Remote data structure changes |

---

## Pitfalls to Avoid

| Pitfall | Consequence | Solution |
|---------|-------------|----------|
| Forgetting `_cmd` suffix | "Command not found" error | Always check `main.rs` for exact command name |
| Modifying Zustand without persisting | Data lost on refresh | Always call backend for persisted data |
| Blocking main thread | UI freezes | Use async operations for heavy work |
| Skipping error handling | Uncaught promise rejections | Use `Result<T, ApiError>` pattern |
| Mismatched Rust/TS types | Serialization errors | Check type mappings table above |
| Duplicating type guards inline | Inconsistency, stale code | Use helpers from `src/utils/nodeHelpers.ts` |
| Adding components inside App.tsx | Monolith regression | Extract to dedicated files under `components/` |
| Forgetting `nodeHelpers` display name | New types show raw enum value | Update `TYPE_DISPLAY_NAMES` in `nodeHelpers.ts` |
| Using `process.env.NODE_ENV` | Undefined in Vite builds | Use `import.meta.env.DEV` / `import.meta.env.PROD` |

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
