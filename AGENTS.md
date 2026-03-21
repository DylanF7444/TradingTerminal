# AGENTS.md - Agentic Coding Guidelines

This file provides guidance for AI agents working in this codebase.

## Project Overview

Tauri 2 desktop trading terminal for prediction markets (Polymarket, Kalshi). React 19 frontend with Zustand state management, Tailwind CSS styling, and Rust backend.

## Build Commands

```bash
# Install dependencies
pnpm install

# Frontend only (Vite dev server)
pnpm dev

# Full app (Vite + Rust backend with hot reload)
pnpm tauri dev

# Build production binary
pnpm tauri build
```

## Test Commands

```bash
# Run all backend (Rust) tests
cd src-tauri && cargo test

# Run single backend test by name
cd src-tauri && cargo test test_name

# Run all tests in a module
cd src-tauri && cargo test module::

# No frontend test runner configured
```

## Code Style Guidelines

### TypeScript Configuration

- Strict mode enabled (`tsconfig.json`)
- `noUnusedLocals: true`, `noUnusedParameters: true`
- Use ESNext module resolution with bundler mode

### Imports

- Group imports: external packages first, then relative paths
- Use type-only imports where appropriate: `import type { ... }`
- Example:
  ```typescript
  import { useState, useEffect } from 'react';
  import { invoke } from '@tauri-apps/api/core';
  import type { Node, Connection } from '../types/nodes';
  import { useNodesStore } from '../store';
  ```

### Naming Conventions

- **Components**: PascalCase (e.g., `NodeDetailsPanel.tsx`)
- **Hooks**: camelCase with `use` prefix (e.g., `useOrderbook.ts`)
- **Types/Interfaces**: PascalCase (e.g., `OrderbookUpdate`)
- **Files**: kebab-case (e.g., `node-helpers.ts`)
- **Tauri Commands**: MUST use `_cmd` suffix (e.g., `get_positions_cmd`)

### Error Handling

- Always use `Result<T, ApiError>` pattern from `src/utils/api.ts`
- Never use bare try/catch for Tauri IPC calls
- Structure:
  ```typescript
  const result = await invoke('get_positions_cmd');
  if (!result.ok) {
    // Handle error with result.error.message, result.error.retryable, etc.
  }
  // Use result.value
  ```

### State Management

- Use Zustand with immer middleware
- State split into slices (nodesSlice, marketsSlice, positionsSlice, groupsSlice)
- Optimistic updates with async SQLite persistence
- Pattern:
  ```typescript
  // 1. Update Zustand store immediately
  updateNodePosition(nodeId, newPosition);
  // 2. Persist to SQLite, rollback on failure
  await invoke('update_node_cmd', { node: updatedNode });
  ```

### Components

- Extract to dedicated files under `src/components/`
- Wrap each panel in `PanelErrorBoundary` for isolated crash recovery
- Use type guards from `src/utils/nodeHelpers.ts` - don't duplicate inline
- Use Tailwind CSS utility classes
- Polymorphic components with `as` prop pattern (see Button.tsx)

### React Patterns

- Use functional components with hooks
- Custom hooks for reusable logic (prefixed with `use`)
- Memoize expensive computations with `useMemo`
- Memoize callbacks with `useCallback`
- Use `import.meta.env.DEV` / `import.meta.env.PROD` for environment checks

### Rust Backend

- Tauri commands in `src-tauri/src/commands/*.rs`
- All commands wrapped with `#[tauri::command]` and `_cmd` suffix
- Register in `tauri::generate_handler![]` in main.rs
- Use Result pattern for error handling
- Tests use `tempfile` for DB isolation, `wiremock` for HTTP mocking

### Tauri IPC Convention

```typescript
// CORRECT - uses _cmd suffix
invoke('get_positions_cmd', { accountId })
invoke('place_order_cmd', { marketId, side, size })

// WRONG - will fail with "command not found"
invoke('get_positions', { accountId })
```

### Type Mappings (Rust <-> TypeScript)

| Rust | TypeScript |
|------|------------|
| `f64` | `number` |
| `Option<T>` | `T \| undefined` |
| `Vec<T>` | `T[]` |
| `enum` | String literal union |
| `chrono::DateTime` | `number` (Unix timestamp ms) |

### Adding New Features

**New Tauri Command:**
1. Add command in `src-tauri/src/commands/*.rs`
2. Re-export from `src-tauri/src/commands/mod.rs`
3. Create `#[tauri::command]` wrapper in `main.rs` with `_cmd` suffix
4. Register in `tauri::generate_handler![]`
5. Add typed wrapper in `src/utils/api.ts`

**New Info Source:**
1. Add variant to `InfoSourceType` in `src/types/nodes.ts`
2. Add display name in `src/utils/nodeHelpers.ts` → `TYPE_DISPLAY_NAMES`
3. Add scraper logic in `src-tauri/src/services/scraper.rs`
4. Add UI in `src/components/InfoSources/SourceTypes.tsx`

**New Analyzer:**
1. Add variant to `AnalyzerType` in `src-tauri/src/models/analyzer_node.rs`
2. Implement `AnalyzerInstance` trait in `src-tauri/src/services/analyzers/`
3. Register in `src-tauri/src/services/analyzers/mod.rs`
4. Add TypeScript type in `src/types/analyzers.ts`
5. Add config UI in `src/components/Analyzers/AnalyzerPanel.tsx`

### WebSocket Patterns

- One connection per platform (Polymarket, Kalshi, Binance, Coinbase)
- Use `useConsolidatedWebSocket` hook for frontend subscription
- Listen for events: `orderbook:update`, `infosource:update`, `position:update`

### Common Pitfalls

| Issue | Solution |
|-------|----------|
| "Command not found" | Check `_cmd` suffix on invoke |
| Data lost on refresh | Persist to SQLite via backend |
| UI freezes | Use async for heavy operations |
| Uncaught rejections | Use Result pattern from api.ts |
| Serialization errors | Verify Rust/TS type mappings |
| Raw enum in UI | Update TYPE_DISPLAY_NAMES in nodeHelpers.ts |
| NODE_ENV undefined | Use `import.meta.env.DEV` |

### Key Files

| Purpose | Location |
|---------|----------|
| Backend entry | `src-tauri/src/main.rs` |
| Frontend layout | `src/App.tsx` |
| State store | `src/store/index.ts` |
| API layer | `src/utils/api.ts` |
| Node types | `src/types/nodes.ts` |
| Type helpers | `src/utils/nodeHelpers.ts` |
| DB schema | `src-tauri/src/db/sqlite.rs` |

### Style Notes

- Use `clsx` utility for conditional class names
- Dark theme by default (gray-900 backgrounds)
- Component comments at file top describing purpose and props
- Update comment sections when making changes
