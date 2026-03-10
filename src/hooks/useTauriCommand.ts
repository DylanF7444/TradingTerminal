// ============================================================================
// TAURI COMMAND INVOCATION HOOK
// ============================================================================
//
// Purpose: Type-safe React hook for invoking Rust commands via Tauri's IPC bridge.
// Wraps Tauri's invoke() with loading/error state management and TypeScript generics.
//
// Architecture:
//   execute(params) -> invoke(command, params) -> Rust -> Result<T, E> -> state update
//
// Generic parameters: T = Rust return type, P = parameter type.
//   e.g. useTauriCommand<Node, AddSourceParams>('add_data_source')
//
// Key behaviors:
// - Lazy execution: only runs when execute() is called, not on mount
// - Race condition safe: uses request ID tracking so only the latest result is kept
// - Unmount safe: checks mounted status before setState
// - Memoized execute/reset (stable refs, safe in dependency arrays)
//
// State: data (T | null), loading (boolean), error (string | null)
// Returns: { data, loading, error, execute, reset }
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