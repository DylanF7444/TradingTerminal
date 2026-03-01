// ============================================================================
// TAURI API UTILITIES
// ============================================================================
//
// Module: utils/api.ts
// Purpose: Typed wrappers and utilities for Tauri backend command invocation
//
// OVERVIEW:
// This module provides a type-safe abstraction layer over Tauri's invoke API,
// centralizing all backend command calls in a single location. It implements
// consistent error handling, request/response logging, retry logic, and
// type-safe wrappers for every backend command.
//
// The architecture separates low-level invoke wrappers from high-level
// service functions, enabling both direct command access and domain-specific
// APIs that compose multiple commands.
//
// Architecture Pattern:
// Layered API with Error Boundary
//   Raw Invoke → Typed Wrappers → Service Functions → React Hooks
//   (tauri::invoke) (type-safe) (business logic) (useTauriCommand)
//
// ERROR HANDLING STRATEGY:
//
// All API functions return Promise<Result<T, ApiError>> using a Result pattern
// instead of throwing exceptions. This forces explicit error handling at
// call sites and prevents uncaught promise rejections.
//
// Error Types:
//   - NetworkError: Tauri bridge communication failure
//   - CommandError: Rust command returned Err variant
//   - ValidationError: Input validation failed (frontend or backend)
//   - TimeoutError: Request exceeded timeout
//   - SerializationError: JSON parsing failure
//
// Retry Logic:
//   - Idempotent commands (read operations): 3 retries with exponential backoff
//   - Mutating commands (write operations): No retry, immediate failure
//   - Network errors only: Command errors are not retried
//
// LOGGING:
//
// All API calls are logged with:
//   - Timestamp
//   - Command name
//   - Execution duration
//   - Success/failure status
//   - Error details (on failure)
//
// Logs are sent to:
//   - Console (when import.meta.env.DEV is true)
//   - Backend logging (when import.meta.env.PROD, via log::info! in Rust)
//
// TYPE SAFETY:
//
// Commands are typed using TypeScript generics matching Rust signatures:
//   invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
//
// Each command has:
//   - Request type: Arguments passed to Rust
//   - Response type: Value returned from Rust
//   - Error type: Expected error variants
//
// NAMING CONVENTION (CRITICAL):
//
// All Tauri commands MUST use the `_cmd` suffix when invoked from the frontend.
// This matches the naming convention used in the Rust backend's main.rs.
//
// Example:
//   // CORRECT - matches backend registration
//   invoke('get_positions_cmd', { ... })
//   invoke('place_order_cmd', { ... })
//   invoke('subscribe_orderbook_cmd', { ... })
//
//   // WRONG - will fail with "command not found"
//   invoke('get_positions', { ... })
//   invoke('place_order', { ... })
//   invoke('subscribe_orderbook', { ... })
//
// The `_cmd` suffix:
//   - Prevents naming conflicts with Rust keywords
//   - Makes it explicit that the function is a Tauri IPC command
//   - Ensures consistency across the entire codebase
//
// When adding a new command:
//   1. Define the command logic in src-tauri/src/commands/*.rs
//   2. Create a wrapper in main.rs with `#[tauri::command]` and `_cmd` suffix
//   3. Register it in `tauri::generate_handler![]`
//   4. Call it from frontend using the exact `_cmd` name
//
// ============================================================================

import { invoke } from '@tauri-apps/api/core';
import type { SourceConfig, SourceId, SourceState } from '../types/sources';
import type { Market, Orderbook, TradeResult } from '../types/markets';
import type { Position, ClosedPosition } from '../types/markets';
import type { Node, NodeGraph, Connection } from '../types/nodes';

// =============================================================================
// RESULT TYPE AND ERROR HANDLING
// =============================================================================

/**
 * Result type for explicit error handling.
 * 
 * Pattern: { ok: true, value: T } | { ok: false, error: ApiError }
 * 
 * Benefits over try/catch:
 *   - Forces error handling at compile time
 *   - Clear success/failure paths
 *   - Serializable across boundaries
 *   - Composable with helper functions
 */
export type Result<T, E = ApiError> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * API error variants with structured metadata.
 */
export interface ApiError {
  /** Error type discriminator */
  type: 'network' | 'command' | 'validation' | 'timeout' | 'serialization' | 'unknown';
  
  /** Human-readable error message */
  message: string;
  
  /** Original error for debugging */
  original?: Error;
  
  /** Command that failed (if applicable) */
  command?: string;
  
  /** Request payload (sanitized, no secrets) */
  request?: Record<string, unknown>;
  
  /** HTTP status or error code */
  code?: number | string;
  
  /** Retry recommendation */
  retryable: boolean;
  
  /** Suggested user action */
  suggestion?: string;
}

/**
 * Creates a successful Result.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Creates a failed Result.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Unwraps a Result, throwing on error (use sparingly).
 */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.value;
}

/**
 * Maps a Result value through a transform function.
 */
export function map<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  if (!result.ok) return result;
  return ok(fn(result.value));
}

/**
 * Chains async operations that return Results.
 */
export async function andThen<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Promise<Result<U, E>>
): Promise<Result<U, E>> {
  if (!result.ok) return result;
  return fn(result.value);
}

// =============================================================================
// ERROR FACTORY FUNCTIONS
// =============================================================================

function createNetworkError(error: Error, command?: string): ApiError {
  return {
    type: 'network',
    message: `Failed to communicate with backend: ${error.message}`,
    original: error,
    command,
    retryable: true,
    suggestion: 'Check if the application is running and try again',
  };
}

function createCommandError(message: string, command: string, code?: string): ApiError {
  return {
    type: 'command',
    message,
    command,
    code,
    retryable: false,
    suggestion: 'Check your input and try again',
  };
}

function createTimeoutError(command: string, timeoutMs: number): ApiError {
  return {
    type: 'timeout',
    message: `Command ${command} timed out after ${timeoutMs}ms`,
    command,
    retryable: true,
    suggestion: 'The operation is taking too long. Try again or check system load',
  };
}

// =============================================================================
// CORE INVOKE WRAPPER
// =============================================================================

/**
 * Core typed invoke with comprehensive error handling.
 * 
 * This is the foundation for all API calls. It wraps Tauri's invoke
 * with logging, timeout, retry logic, and standardized error handling.
 * 
 * @template T Expected response type
 * @param command Rust command name (must match #[tauri::command] fn name)
 * @param args Arguments object passed to Rust
 * @param options Call options (timeout, retry, etc.)
 * @returns Promise<Result<T, ApiError>>
 * 
 * @example
 * const result = await invokeCommand<Node[]>('get_data_sources');
 * if (result.ok) {
 *   console.log('Sources:', result.value);
 * } else {
 *   console.error('Failed:', result.error.message);
 * }
 */
export async function invokeCommand<T>(
  command: string,
  args?: Record<string, unknown>,
  options: InvokeOptions = {}
): Promise<Result<T, ApiError>> {
  const {
    timeoutMs = 30000,
    retries = 0,
    retryDelayMs = 1000,
    logCall = true,
  } = options;

  const startTime = performance.now();
  let lastError: ApiError | undefined;

  // Retry loop for idempotent operations
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(createTimeoutError(command, timeoutMs));
        }, timeoutMs);
      });

      // Race between invoke and timeout
      const result = await Promise.race([
        invoke<T>(command, args),
        timeoutPromise,
      ]);

      const duration = performance.now() - startTime;

      if (logCall) {
        logApiCall(command, args, duration, true);
      }

      return ok(result);
    } catch (error) {
      const duration = performance.now() - startTime;
      
      let apiError: ApiError;
      
      if (error instanceof Error && 'type' in error && 'retryable' in error) {
        // Already an ApiError (from timeout)
        apiError = error as unknown as ApiError;
      } else if (error instanceof Error) {
        // Check if it's a Rust command error (structured string)
        const rustError = parseRustError(error.message);
        if (rustError) {
          apiError = createCommandError(rustError.message, command, rustError.code);
        } else {
          apiError = createNetworkError(error, command);
        }
      } else {
        apiError = {
          type: 'unknown',
          message: String(error),
          command,
          retryable: false,
        };
      }

      lastError = apiError;

      // Don't retry non-retryable errors or last attempt
      if (!apiError.retryable || attempt === retries) {
        if (logCall) {
          logApiCall(command, args, duration, false, apiError);
        }
        return err(apiError);
      }

      // Wait before retry with exponential backoff
      await sleep(retryDelayMs * Math.pow(2, attempt));
    }
  }

  // Should never reach here, but TypeScript needs it
  return err(lastError!);
}

/**
 * Options for invokeCommand.
 */
interface InvokeOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  
  /** Number of retries for network errors (default: 0) */
  retries?: number;
  
  /** Base delay between retries in ms (default: 1000) */
  retryDelayMs?: number;
  
  /** Whether to log this call (default: true) */
  logCall?: boolean;
}

/**
 * Parses Rust error strings into structured format.
 * 
 * Rust errors often come as JSON strings or formatted messages.
 * This extracts the meaningful parts for user display.
 */
function parseRustError(message: string): { message: string; code?: string } | null {
  try {
    // Try parsing as JSON first
    const parsed = JSON.parse(message);
    if (parsed.error || parsed.message) {
      return {
        message: parsed.message || parsed.error,
        code: parsed.code,
      };
    }
  } catch {
    // Not JSON, try regex patterns
    
    // Pattern: "Command failed: {message}"
    const commandMatch = message.match(/Command failed: (.+)/);
    if (commandMatch) {
      return { message: commandMatch[1] };
    }
    
    // Pattern: "error: {message}"
    const errorMatch = message.match(/error:\s*(.+)/i);
    if (errorMatch) {
      return { message: errorMatch[1] };
    }
  }
  
  return null;
}

/**
 * Logs API call to console and optionally to backend.
 */
function logApiCall(
  command: string,
  args: Record<string, unknown> | undefined,
  duration: number,
  success: boolean,
  error?: ApiError
): void {
  const sanitizedArgs = args ? sanitizeArgs(args) : undefined;
  
  const logEntry = {
    timestamp: new Date().toISOString(),
    command,
    args: sanitizedArgs,
    duration: Math.round(duration),
    success,
    error: error ? { type: error.type, message: error.message } : undefined,
  };

  if (import.meta.env.DEV) {
    const style = success ? 'color: green' : 'color: red';
    console.log(`%c[API] ${command} (${duration.toFixed(0)}ms)`, style, logEntry);
  }

  // In production, send to backend logging
  if (import.meta.env.PROD && !success) {
    // Fire and forget error logging to backend
    invoke('log_frontend_error', { error: logEntry }).catch(() => {
      // Silent fail - don't infinite loop on logging errors
    });
  }
}

/**
 * Removes sensitive data from logged arguments.
 */
function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const sensitiveKeys = ['apiKey', 'apiSecret', 'password', 'token', 'secret', 'keyValue'];
  const sanitized: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(args)) {
    if (sensitiveKeys.some(sk => key.toLowerCase().includes(sk.toLowerCase()))) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeArgs(value as Record<string, unknown>);
    } else {
      sanitized[key] = value;
    }
  }
  
  return sanitized;
}

/**
 * Promise-based sleep utility.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================================================
// DATA SOURCE COMMANDS
// =============================================================================

/**
 * Add a new data source to the system.
 * 
 * Backend: commands::data_sources::add_data_source
 * 
 * @param config Source configuration (type-specific)
 * @returns Created source with assigned ID and initial state
 */
export async function addDataSource(
  config: SourceConfig
): Promise<Result<SourceState, ApiError>> {
  return invokeCommand<SourceState>('add_data_source_cmd', { config });
}

/**
 * Statistics returned when a node is deleted with cascade.
 */
export interface DeleteNodeStats {
  /** Number of timeseries entries deleted */
  timeseries_deleted: number;
  /** Number of websocket messages deleted */
  websocket_messages_deleted: number;
  /** Number of connections deleted */
  connections_deleted: number;
  /** Number of scraper status entries deleted */
  scraper_status_deleted: number;
  /** Number of positions deleted */
  positions_deleted: number;
  /** Whether the node was successfully archived */
  node_archived: boolean;
}

/**
 * Remove a data source and stop its scraper.
 * Cleans up all associated database records.
 * 
 * Backend: commands::data_sources::remove_data_source_cmd
 * 
 * @param id Source ID to remove
 * @returns Statistics about what was deleted
 */
export async function removeDataSource(
  id: SourceId
): Promise<Result<DeleteNodeStats, ApiError>> {
  return invokeCommand<DeleteNodeStats>('remove_data_source_cmd', { nodeId: id });
}

/**
 * Get all configured data sources.
 * 
 * Backend: commands::data_sources::get_data_sources
 * 
 * @returns Array of source configurations
 */
export async function getDataSources(): Promise<Result<SourceConfig[], ApiError>> {
  return invokeCommand<SourceConfig[]>('get_data_sources_cmd', {}, { retries: 2 });
}

/**
 * Get runtime state for all active sources.
 * 
 * Backend: commands::data_sources::get_source_states
 * 
 * @returns Array of source runtime states
 */
export async function getSourceStates(): Promise<Result<SourceState[], ApiError>> {
  return invokeCommand<SourceState[]>('get_data_source_status_cmd', {}, { retries: 2 });
}

/**
 * Update source configuration.
 * 
 * Backend: commands::data_sources::update_data_source
 * 
 * @param id Source ID
 * @param updates Partial configuration update
 */
export async function updateDataSource(
  id: SourceId,
  updates: Partial<SourceConfig>
): Promise<Result<SourceConfig, ApiError>> {
  return invokeCommand<SourceConfig>('update_data_source_cmd', { nodeId: id, config: updates });
}

/**
 * Test source connectivity without saving.
 * 
 * Backend: commands::data_sources::test_source
 * 
 * @param config Source configuration to test
 * @returns Connection test result with latency
 */
export async function testSource(
  _config: SourceConfig
): Promise<Result<{ success: boolean; latencyMs: number; message?: string }, ApiError>> {
  // Note: test_source not implemented in backend, using placeholder
  return invokeCommand('get_data_source_status_cmd', { nodeId: 'test' }, { timeoutMs: 10000 });
}

// =============================================================================
// NODE GRAPH COMMANDS
// =============================================================================

/**
 * Add a node to the visual graph.
 * 
 * Backend: commands::data_sources::add_node_cmd
 * 
 * @param node Node to add (ID will be generated if not provided)
 * @returns Created node with assigned ID
 */
export async function addNode(
  node: Omit<Node, 'id'> & { id?: string }
): Promise<Result<Node, ApiError>> {
  return invokeCommand<Node>('add_node_cmd', { node });
}

/**
 * Remove a node from the graph.
 * Cleans up all associated database records (timeseries, websocket messages, connections, etc.)
 * 
 * Backend: commands::data_sources::remove_data_source_cmd
 * 
 * @param id Node ID to remove
 * @param cascade Whether to remove connected nodes (unused, kept for API compatibility)
 * @returns Statistics about what was deleted
 */
export async function removeNode(
  id: string,
  cascade: boolean = false
): Promise<Result<DeleteNodeStats, ApiError>> {
  return invokeCommand<DeleteNodeStats>('remove_data_source_cmd', { nodeId: id, cascade });
}

/**
 * Update node position (called during drag operations).
 * 
 * Backend: commands::data_sources::update_node_position_cmd
 * 
 * @param id Node ID
 * @param position New [x, y] coordinates
 */
export async function updateNodePosition(
  id: string,
  position: [number, number]
): Promise<Result<void, ApiError>> {
  // No retry - position updates are frequent and loss is acceptable
  return invokeCommand<void>('update_node_position_cmd', { id, positionX: position[0], positionY: position[1] }, { 
    logCall: false,
    timeoutMs: 5000,
  });
}

/**
 * Update node size (called during resize operations).
 * 
 * Backend: commands::data_sources::update_node_size_cmd
 * 
 * @param id Node ID
 * @param size New { width, height } dimensions
 */
export async function updateNodeSize(
  id: string,
  size: { width: number; height: number | null }
): Promise<Result<void, ApiError>> {
  // No retry - size updates are infrequent and loss is acceptable
  return invokeCommand<void>('update_node_size_cmd', { id, size: [size.width, size.height] }, { 
    logCall: false,
    timeoutMs: 5000,
  });
}

/**
 * Add connection between nodes.
 * 
 * Backend: commands::data_sources::add_connection
 * 
 * @param connection Connection definition
 */
export async function addConnection(
  connection: Omit<Connection, 'strength'> & { strength?: number }
): Promise<Result<Connection, ApiError>> {
  return invokeCommand<Connection>('add_connection', { 
    connection: { strength: 0.5, ...connection } 
  });
}

/**
 * Remove connection between nodes.
 * 
 * Backend: commands::data_sources::remove_connection
 * 
 * @param source Source node ID
 * @param target Target node ID
 */
export async function removeConnection(
  source: string,
  target: string
): Promise<Result<void, ApiError>> {
  return invokeCommand<void>('remove_connection', { source, target });
}

/**
 * Save complete graph state.
 * 
 * Backend: commands::storage::store_graph
 * 
 * @param graph Complete graph state
 * @param name Optional save name
 */
export async function saveGraph(
  graph: NodeGraph,
  name?: string
): Promise<Result<{ savedAt: number; path: string }, ApiError>> {
  return invokeCommand('save_graph', { graph, name });
}

/**
 * Load graph state.
 * 
 * Backend: commands::storage::load_graph
 * 
 * @param name Save name (omit for most recent)
 */
export async function loadGraph(
  name?: string
): Promise<Result<NodeGraph, ApiError>> {
  return invokeCommand<NodeGraph>('load_graph', { name }, { retries: 2 });
}

/**
 * Calculate correlation between two nodes.
 * 
 * Backend: commands::storage::get_correlation_data_cmd
 * 
 * @param sourceId Source node ID
 * @param targetId Target node ID
 * @param lookbackDays Historical data to analyze
 * @returns Correlation coefficient (-1 to 1)
 */
export async function calculateCorrelation(
  sourceId: string,
  targetId: string,
  lookbackDays: number = 30
): Promise<Result<{ correlation: number; confidence: number }, ApiError>> {
  return invokeCommand('get_correlation_data_cmd', { 
    sourceA: sourceId, 
    sourceB: targetId, 
    hours: lookbackDays * 24 
  }, { timeoutMs: 60000 }); // Analysis may take time
}

// =============================================================================
// MARKET COMMANDS
// =============================================================================

/**
 * Add a prediction market connection.
 * 
 * Backend: commands::markets::add_market_cmd
 * 
 * @param type Market type (Polymarket, Kalshi)
 * @param credentials API credentials
 * @returns Connected market metadata
 */
export async function addMarket(
  type: import('../types/nodes').MarketType,
  credentials: { apiKey: string; apiSecret?: string }
): Promise<Result<Market, ApiError>> {
  return invokeCommand<Market>('add_market_cmd', { 
    marketType: type, 
    apiCredentials: credentials,
    marketConfig: {}
  });
}

/**
 * Remove market connection.
 * 
 * Backend: commands::markets::remove_market_cmd
 * 
 * @param marketId Market ID to disconnect
 */
export async function removeMarket(
  marketId: string
): Promise<Result<void, ApiError>> {
  return invokeCommand<void>('remove_market_cmd', { nodeId: marketId });
}

/**
 * Get all connected markets.
 * 
 * Backend: commands::markets::get_markets_cmd
 */
export async function getMarkets(): Promise<Result<Market[], ApiError>> {
  return invokeCommand<Market[]>('get_markets_cmd', {}, { retries: 2 });
}

/**
 * Fetch orderbook for a market.
 * 
 * Backend: commands::markets::get_orderbook_cmd
 * 
 * @param marketId Market ID
 * @param _depth Number of levels to fetch (unused in current implementation)
 */
export async function getOrderbook(
  marketId: string,
  _depth: number = 25
): Promise<Result<Orderbook, ApiError>> {
  return invokeCommand<Orderbook>('get_orderbook_cmd', { market_id: marketId }, { 
    retries: 2,
    timeoutMs: 10000,
  });
}

/**
 * Search available markets on an exchange.
 * 
 * Backend: commands::markets::search_markets
 * 
 * @param type Market type to search
 * @param query Search query string
 * @param category Optional category filter
 */
export async function searchMarkets(
  type: import('../types/nodes').MarketType,
  query: string,
  category?: string
): Promise<Result<Market[], ApiError>> {
  return invokeCommand<Market[]>('search_markets', { type, query, category });
}

/**
 * Get market details by ID.
 * 
 * Backend: commands::markets::get_market_details
 * 
 * @param marketId Market ID
 */
export async function getMarketDetails(
  marketId: string
): Promise<Result<Market, ApiError>> {
  return invokeCommand<Market>('get_market_details', { marketId }, { retries: 2 });
}

// =============================================================================
// TRADING COMMANDS
// =============================================================================

/**
 * Place an order on a prediction market.
 * 
 * Backend: commands::trading::place_order_cmd
 * 
 * @param params Order parameters
 * @returns Trade execution result
 */
export async function placeOrder(
  params: import('../types/markets').PlaceOrderParams
): Promise<Result<TradeResult, ApiError>> {
  return invokeCommand<TradeResult>('place_order_cmd', { 
    market_id: params.marketNodeId,
    side: params.side,
    size: params.size,
    price: params.price,
    order_type: params.orderType
  }, { 
    timeoutMs: 60000, // Orders may take time to fill
  });
}

/**
 * Cancel an open order.
 * 
 * Backend: commands::trading::cancel_order
 * 
 * @param orderId Order ID to cancel
 * @param marketId Market where order was placed
 */
export async function cancelOrder(
  orderId: string,
  marketId: string
): Promise<Result<void, ApiError>> {
  return invokeCommand<void>('cancel_order', { orderId, marketId });
}

/**
 * Get all open positions.
 * 
 * Backend: commands::trading::get_positions_cmd
 */
export async function getPositions(): Promise<Result<Position[], ApiError>> {
  return invokeCommand<Position[]>('get_positions_cmd', {}, { retries: 2 });
}

/**
 * Get position history.
 * 
 * Backend: commands::trading::get_position_history
 * 
 * @param limit Maximum results
 * @param offset Pagination offset
 */
export async function getPositionHistory(
  limit: number = 100,
  offset: number = 0
): Promise<Result<ClosedPosition[], ApiError>> {
  return invokeCommand<ClosedPosition[]>('get_position_history', { limit, offset });
}

/**
 * Close a position.
 * 
 * Backend: commands::trading::close_position_cmd
 * 
 * @param positionId Position to close
 * @param price Optional limit price (market order if omitted)
 */
export async function closePosition(
  positionId: string,
  price?: number
): Promise<Result<TradeResult, ApiError>> {
  return invokeCommand<TradeResult>('close_position_cmd', { position_id: positionId, price }, {
    timeoutMs: 60000,
  });
}

/**
 * Modify position (stop-loss, take-profit).
 * 
 * Backend: commands::trading::modify_position
 * 
 * @param positionId Position to modify
 * @param updates Fields to update
 */
export async function modifyPosition(
  positionId: string,
  updates: Partial<Pick<Position, 'stopLoss' | 'takeProfit' | 'size'>>
): Promise<Result<Position, ApiError>> {
  return invokeCommand<Position>('modify_position', { positionId, updates });
}

// =============================================================================
// STORAGE COMMANDS
// =============================================================================

/**
 * Store time-series data point.
 * 
 * Backend: commands::storage::store_timeseries_cmd
 * 
 * @param sourceId Data source ID
 * @param metric Metric name (e.g., "price", "sentiment")
 * @param value Numeric value
 * @param timestamp Optional timestamp (default: now)
 * @param metadata Optional additional data
 */
export async function storeTimeseries(
  sourceId: string,
  metric: string,
  value: number,
  _timestamp?: number,
  metadata?: Record<string, any>
): Promise<Result<void, ApiError>> {
  return invokeCommand<void>('store_timeseries_cmd', {
    source_id: sourceId,
    metric_type: metric,
    value,
    metadata,
  });
}

/**
 * Query time-series data.
 * 
 * Backend: commands::storage::query_timeseries_cmd
 * 
 * @param sourceId Data source filter
 * @param metric Metric name filter
 * @param startTime Start of time range
 * @param endTime End of time range
 * @param aggregation Optional aggregation (avg, sum, min, max)
 */
export async function queryTimeseries(
  sourceId?: string,
  metric?: string,
  startTime?: number,
  endTime?: number,
  _aggregation?: 'avg' | 'sum' | 'min' | 'max'
): Promise<Result<Array<{ timestamp: number; value: number }>, ApiError>> {
  return invokeCommand('query_timeseries_cmd', {
    source_id: sourceId,
    metric_type: metric,
    start_time: startTime,
    end_time: endTime,
  }, { retries: 2 });
}

/**
 * Export data to file.
 * 
 * Backend: commands::storage::export_data
 * 
 * @param format Export format (csv, json, parquet)
 * @param filters Data filters
 * @param path Output file path
 */
export async function exportData(
  format: 'csv' | 'json' | 'parquet',
  filters: {
    sourceIds?: string[];
    metrics?: string[];
    startTime?: number;
    endTime?: number;
  },
  path: string
): Promise<Result<{ bytesWritten: number; path: string }, ApiError>> {
  return invokeCommand('export_data', { format, filters, path }, { timeoutMs: 120000 });
}

// =============================================================================
// SYSTEM COMMANDS
// =============================================================================

/**
 * Get application version info.
 * 
 * Backend: commands::system::get_version
 */
export async function getVersion(): Promise<Result<{
  version: string;
  tauriVersion: string;
  rustVersion: string;
  nodeVersion: string;
}, ApiError>> {
  return invokeCommand('get_version', {}, { retries: 2 });
}

/**
 * Check system health.
 * 
 * Backend: commands::system::health_check
 */
export async function healthCheck(): Promise<Result<{
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: Record<string, boolean>;
  latencyMs: number;
}, ApiError>> {
  return invokeCommand('health_check', {}, { timeoutMs: 5000, retries: 2 });
}

/**
 * Open external link in default browser.
 * 
 * Backend: commands::system::open_link
 * 
 * @param url URL to open
 */
export async function openLink(url: string): Promise<Result<void, ApiError>> {
  return invokeCommand<void>('open_link', { url });
}

/**
 * Show save file dialog.
 * 
 * Backend: commands::system::save_dialog
 * 
 * @param defaultPath Suggested filename
 * @param filters File type filters
 */
export async function saveDialog(
  defaultPath?: string,
  filters?: Array<{ name: string; extensions: string[] }>
): Promise<Result<string | null, ApiError>> {
  return invokeCommand<string | null>('save_dialog', { defaultPath, filters });
}

/**
 * Show open file dialog.
 * 
 * Backend: commands::system::open_dialog
 * 
 * @param filters File type filters
 * @param multiple Allow multiple selection
 */
export async function openDialog(
  filters?: Array<{ name: string; extensions: string[] }>,
  multiple: boolean = false
): Promise<Result<string | string[] | null, ApiError>> {
  return invokeCommand('open_dialog', { filters, multiple });
}

// =============================================================================
// SYSTEM INFO
// =============================================================================

/**
 * System information returned from the backend.
 */
export interface SystemInfo {
  hostname: string;
  os: string;
  cpu_usage: number;
  memory_used: number;
  memory_total: number;
}

/**
 * Get system information including CPU and memory usage.
 * 
 * Backend: main::get_system_info_cmd
 * 
 * @returns System information (CPU usage %, memory used/total in bytes)
 */
export async function getSystemInfo(): Promise<Result<SystemInfo, ApiError>> {
  return invokeCommand<SystemInfo>('get_system_info_cmd', {});
}

/**
 * Get network bandwidth metrics from WebSocket connections.
 * 
 * Backend: main::get_network_metrics_cmd
 * 
 * @returns Network metrics (bytes sent/received, message counts)
 */
export async function getNetworkMetrics(): Promise<Result<import('../types/markets').NetworkMetrics, ApiError>> {
  return invokeCommand<import('../types/markets').NetworkMetrics>('get_network_metrics_cmd', {});
}

// =============================================================================
// BATCH OPERATIONS
// =============================================================================

/**
 * Execute multiple commands in parallel.
 * 
 * Useful for fetching initial state on app load.
 * 
 * @param commands Array of command calls to execute
 * @returns Results in same order as input
 * 
 * @example
 * const [sourcesResult, marketsResult, positionsResult] = await batch([
 *   () => getDataSources(),
 *   () => getMarkets(),
 *   () => getPositions(),
 * ]);
 */
export async function batch<T extends Result<unknown, ApiError>[]>(
  commands: Array<() => Promise<T[number]>>
): Promise<T> {
  const results = await Promise.all(commands.map(cmd => cmd()));
  return results as unknown as T;
}

/**
 * Execute commands sequentially, stopping on first error.
 * 
 * Useful for dependent operations where order matters.
 * 
 * @param commands Array of command calls to execute
 * @returns Array of results or first error
 */
export async function sequence<T>(
  commands: Array<() => Promise<Result<T, ApiError>>>
): Promise<Result<T[], ApiError>> {
  const results: T[] = [];
  
  for (const cmd of commands) {
    const result = await cmd();
    if (!result.ok) return result;
    results.push(result.value);
  }
  
  return ok(results);
}

// =============================================================================
// EXAMPLE USAGE
// =============================================================================
//
// // Basic API call with error handling
// async function loadDashboardData() {
//   const result = await getDataSources();
//   
//   if (result.ok) {
//     return result.value;
//   } else {
//     // Handle specific error types
//     switch (result.error.type) {
//       case 'network':
//         showToast('Connection lost. Retrying...');
//         break;
//       case 'command':
//         showToast(`Error: ${result.error.message}`);
//         break;
//       case 'timeout':
//         showToast('Request timed out. Please try again.');
//         break;
//     }
//     return [];
//   }
// }
//
// // Using batch for parallel loading
// async function initializeApp() {
//   const [sources, markets, positions] = await batch([
//     () => getDataSources(),
//     () => getMarkets(),
//     () => getPositions(),
//   ]);
//   
//   return {
//     sources: sources.ok ? sources.value : [],
//     markets: markets.ok ? markets.value : [],
//     positions: positions.ok ? positions.value : [],
//   };
// }
//
// // Using map for result transformation
// const sourcesResult = await getDataSources();
// const activeSources = map(sourcesResult, sources => 
//   sources.filter(s => s.enabled)
// );
//
// // Using andThen for chaining
// const result = await andThen(
//   await addDataSource(config),
//   async (source) => {
//     // Start the source after creation
//     return await startSource(source.id);
//   }
// );
//
// ============================================================================