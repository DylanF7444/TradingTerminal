# Project Rules

## Before Any Changes
Read README.md for architecture overview and conventions.

## Critical Conventions
- All Tauri commands use `_cmd` suffix (e.g., `get_positions_cmd`)
- Rust types map to TypeScript: f64→number, Option<T>→T|undefined, Vec<T>→T[]
- Always persist state changes to SQLite via Tauri commands

## Key Files
- src/types/ - TypeScript definitions
- src/utils/api.ts - Backend communication
- src-tauri/src/main.rs - Command registration
- src-tauri/src/db/sqlite.rs - Database schema
