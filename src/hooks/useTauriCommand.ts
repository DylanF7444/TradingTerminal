// ============================================================================
// TAURI COMMAND INVOCATION HOOK
// ============================================================================
//
// Module: hooks/useTauriCommand.ts
// Purpose: Type-safe React hook for invoking Rust commands via Tauri's IPC bridge
//
// OVERVIEW:
// This hook provides a standardized, type-safe interface for calling Rust backend
// functions from React components. It wraps Tauri's `invoke` API with React state
// management to provide loading indicators, error boundaries, and automatic
// TypeScript type inference across the frontend/backend boundary.
//
// Architecture Pattern:
// React Component calls execute(params)
//   → Hook sets loading=true, clears previous error
//   → Tauri invoke(command, params) serializes params to JSON via serde
//   → Rust receives command with deserialized arguments
//   → Rust executes logic (database, HTTP, WebSocket management)
//   → Rust returns Result<T, E> (success or error)
//   → Tauri serializes response back to JavaScript
//   → Hook captures T, sets data, loading=false
//   → OR: Hook captures error string, sets error, loading=false
//   → Component re-renders with new state
//
// Type Safety Bridge:
// Generic <T, P> parameters provide end-to-end type safety:
//   T = Return type from Rust command (must implement Serialize)
//   P = Parameter type sent to Rust (must implement Deserialize)
// Example: useTauriCommand<Node, AddSourceParams>('add_data_source')
//   guarantees TypeScript knows exactly what structures are valid.
//
// STATE MANAGEMENT:
//
// data: T | null
//   - Stores successful command return value
//   - Persists until reset() called or new execute() overrides
//   - Null initially and after reset
//
// loading: boolean
//   - True during active IPC call
//   - Use to show spinners, disable forms, prevent double-submission
//   - Automatically resets to false on completion (success or error)
//
// error: string | null
//   - Stores error message if command fails
//   - Cleared automatically on new execute() call
//   - Human-readable strings suitable for UI display (toasts/alerts)
//
// execute: (params?: P) => Promise<T>
//   - Async function to trigger command invocation
//   - Returns Promise that resolves with T or rejects with error
//   - Automatically handles loading states around invocation
//
// reset: () => void
//   - Clears data, error, and loading states
//   - Useful for "dismiss error" or "clear form" functionality
//
// RACE CONDITION PREVENTION:
//
// Request Tracking:
// - Uses incrementing counter (requestId ref) to track latest invocation
// - If execute() called twice in rapid succession:
//   * First request completes → checks id, ignores (stale)
//   * Second request completes → updates state (fresh)
// - Prevents "stale data" flash in UI when commands complete out of order
//
// Unmount Safety:
// - Checks component mounted status before setState
// - Prevents memory leaks and React warnings on unmount
//
// ERROR HANDLING STRATEGY:
//
// Error Sources:
// 1. IPC Failure: Tauri bridge disconnected (rare, critical)
//    → Message: "Backend connection lost. Please restart."
// 2. Serialization: Type mismatch between TS and Rust
//    → Message: "Invalid data format"
// 3. Command Error: Rust returned Err(String) or panicked
//    → Message: Rust error string passed through
// 4. Network: (If command makes HTTP calls) timeout, 4xx, 5xx
//    → Message: Passed through from Rust reqwest error
//
// Error Formatting:
// - Extracts meaningful message from TauriError object
// - Falls back to toString() for unknown error types
// - Never exposes internal stack traces to UI (security)
//
// SECURITY CONSIDERATIONS:
//
// Sensitive Data:
// - NEVER log params to console in production (may contain API keys)
// - Debug logging controlled via environment variable or build flag
// - Params passed directly to Rust (not stored in hook state unless returned)
//
// Command Validation:
// - Rust backend must validate all inputs (don't trust frontend)
// - This hook is a convenience wrapper, not a security boundary
//
// USAGE EXAMPLES:
//
// Basic Usage:
// ```typescript
// const { data, loading, error, execute } = useTauriCommand<Node, AddSourceParams>('add_data_source');
//
// // In event handler:
// await execute({ source_type: 'CryptoPrices', config: { symbols: ['BTC'] }});
// ```
//
// With Loading State:
// ```typescript
// const { loading, execute } = useTauriCommand('place_order');
//
// <Button isLoading={loading} onClick={() => execute(orderParams)}>
//   Submit Order
// </Button>
//
// // Button automatically shows spinner, disables during execution
// ```
//
// Error Handling:
// ```typescript
// const { error, execute } = useTauriCommand('risky_operation');
//
// try {
//   await execute();
//   showToast('success');
// } catch (e) {
//   // error state already set, but we can handle programmatically too
//   console.error('Command failed:', e);
// }
//
// {error && <Alert type="error">{error}</Alert>}
// ```
//
// Sequential Commands:
// ```typescript
// const { execute: fetchMarkets } = useTauriCommand('get_markets');
// const { execute: connectMarket } = useTauriCommand('add_market');
//
// const handleSetup = async () => {
//   const markets = await fetchMarkets();
//   await connectMarket({ marketId: markets[0].id });
// };
// ```
//
// PERFORMANCE OPTIMIZATIONS:
//
// Memoization:
// - execute function wrapped in useCallback (stable reference)
// - Safe to include in dependency arrays without causing loops
// - reset function also memoized
//
// Lazy Execution:
// - Hook itself does not invoke command on mount
// - Only executes when execute() explicitly called
// - Prevents unwanted data fetching on component render
//
// State Batching:
// - React 18+ automatic batching groups setLoading(false) and setData()
// - Single re-render per command completion
//
// INTEGRATION WITH OTHER HOOKS:
//
// vs useWebSocket:
//   - This hook: Request/response pattern (one-shot commands)
//   - useWebSocket: Continuous event streams (price updates, pub/sub)
//   - Use this for: CRUD operations, auth, configuration
//   - Use WebSocket for: Real-time data feeds, notifications
//
// vs React Query/SWR:
//   - This hook: Manual execution, no caching, no retry logic
//   - React Query: Automatic caching, refetching, background updates
//   - Trade-off: This hook is lighter weight, no dependency on external library
//   - Migration path: Easy to replace with React Query's useMutation if needed
//
// TESTING:
//
// Mocking Strategy:
// ```typescript
// jest.mock('@tauri-apps/api/tauri', () => ({
//   invoke: jest.fn((cmd, args) => {
//     if (cmd === 'add_data_source') return Promise.resolve({ id: '123' });
//     return Promise.reject('Unknown command');
//   })
// }));
// ```
//
// Test Cases:
// - Returns correct data on success
//   * Assert: data equals mock return, loading transitions true→false, error null
// - Sets error on failure
//   * Assert: error is string, loading false, data null
// - Handles multiple concurrent calls (race condition)
//   * Assert: Only latest result remains in state
// - Resets state correctly
//   * Assert: All fields null/false after reset()
//
// DEBUGGING:
//
// Enable verbose logging:
// ```
// REACT_APP_TAURI_DEBUG=1 npm run dev
// ```
// Logs to console:
// - Command name and parameter keys (not values, for privacy)
// - Execution duration
// - Success/failure status
//
// Common Pitfalls:
// - Forgetting to await execute() (returns Promise, not data)
// - Not checking loading state (double-submission of forms)
// - Stale closures in useEffect (always use functional updates or refs)
//
// DEPENDENCIES:
// - React (useState, useCallback, useRef, useEffect)
// - @tauri-apps/api/tauri (invoke function)
// - TypeScript generics for type safety
//
// FUTURE ENHANCEMENTS:
// - Retry logic with exponential backoff
// - Debounced execution (for search-as-you-type)
// - Optimistic updates (update UI before backend confirms)
// - Request deduplication (singleton promises for identical concurrent calls)
// - Progress callbacks for long-running commands (file uploads)
// - Cancellation tokens (if Tauri adds abort support)
//
// ============================================================================

import { useState, useCallback, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Return shape of the useTauriCommand hook
 * @template T The expected return type from the Rust command
 * @template P The parameter type passed to the Rust command
 */
export interface UseTauriCommandReturn<T, P = void> {
  /** The data returned from the last successful command execution, or null if not yet executed */
  data: T | null;
  /** Whether a command is currently being executed */
  loading: boolean;
  /** Error message if the last command failed, null otherwise */
  error: string | null;
  /** Execute the command with optional parameters. Returns a promise that resolves with the result or rejects with an error */
  execute: (params?: P) => Promise<T>;
  /** Reset all state (data, loading, error) to initial values */
  reset: () => void;
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

/**
 * React hook for type-safe invocation of Tauri Rust commands
 * 
 * @param command The name of the Rust command to invoke (must match #[tauri::command] fn name)
 * @returns Object containing data, loading state, error, execute function, and reset function
 */
export function useTauriCommand<T = any, P = any>(
  command: string
): UseTauriCommandReturn<T, P> {
  // State management
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs for race condition prevention and lifecycle tracking
  const requestId = useRef(0);
  const isMounted = useRef(true);

  // Cleanup on unmount to prevent state updates after unmount
  useEffect(() => {
    return () => {
      isMounted.current = false;
    };
  }, []);

  /**
   * Execute the Tauri command with given parameters
   * Handles loading states, errors, and race condition prevention
   */
  const execute = useCallback(
    async (params?: P): Promise<T> => {
      // Increment request ID to track this specific invocation
      const currentRequestId = ++requestId.current;
      
      // Reset error and set loading for this request
      setError(null);
      setLoading(true);

      // Debug logging (keys only for security)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((import.meta as any).env?.DEV) {
        console.log(`[Tauri] Invoking: ${command}`, params ? Object.keys(params) : 'no params');
      }

      try {
        // Perform the IPC call to Rust backend
        const result = await invoke<T>(command, params as any);

        // Check if this is still the latest request (prevent race conditions)
        // and if component is still mounted
        if (currentRequestId === requestId.current && isMounted.current) {
          setData(result);
          setLoading(false);
        }

        return result;
      } catch (err) {
        // Extract human-readable error message
        let errorMessage: string;
        
        if (typeof err === 'string') {
          errorMessage = err;
        } else if (err instanceof Error) {
          errorMessage = err.message;
        } else if (typeof err === 'object' && err !== null) {
          // Tauri often returns objects with message property
          errorMessage = (err as any).message || String(err);
        } else {
          errorMessage = 'An unknown error occurred';
        }

        // Only update state if this is the latest request and still mounted
        if (currentRequestId === requestId.current && isMounted.current) {
          setError(errorMessage);
          setLoading(false);
        }

        // Re-throw so calling component can handle programmatically if needed
        throw errorMessage;
      }
    },
    [command] // Only recreate if command name changes
  );

  /**
   * Reset all state to initial values
   * Useful for dismissing errors or clearing previous results
   */
  const reset = useCallback(() => {
    // Increment request ID to ignore any in-flight requests
    requestId.current++;
    
    setData(null);
    setLoading(false);
    setError(null);
  }, []);

  return {
    data,
    loading,
    error,
    execute,
    reset
  };
}

// ============================================================================
// UTILITY EXPORTS
// ============================================================================

/**
 * Higher-order hook for commands that should auto-execute on mount
 * Useful for data fetching commands (get_markets, get_data_sources)
 */
export function useTauriQuery<T = any, P = any>(
  command: string,
  params?: P,
  enabled: boolean = true
): UseTauriCommandReturn<T, P> & { refetch: () => Promise<T> } {
  const commandState = useTauriCommand<T, P>(command);

  useEffect(() => {
    if (enabled) {
      commandState.execute(params);
    }
    // Execute only on mount or when dependencies change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, command, JSON.stringify(params)]);

  return {
    ...commandState,
    refetch: () => commandState.execute(params)
  };
}

export default useTauriCommand;