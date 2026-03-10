// ============================================================================
// REAL-TIME WEBSOCKET EVENT HOOK
// ============================================================================
//
// Purpose: Subscribe to real-time event streams from Rust backend via Tauri's
// event system. Handles server-sent events (pub/sub) for live data updates.
//
// Architecture:
//   Rust WebSocket (tokio_tungstenite) receives market data
//   -> Emits Tauri event via window.emit("channel", payload)
//   -> This hook's listen() callback receives the payload
//   -> Updates Zustand store or local React state
//
// WebSocket connections happen in Rust (not browser) for CORS bypass,
// credential security, and background execution when minimized.
//
// Key behaviors:
// - Channel-based subscriptions (price_update, orderbook:update, etc.)
// - Auto-cleanup: calls unlisten() on unmount to prevent leaks
// - Reconnection with exponential backoff on heartbeat timeout (30s default)
// - Throttle support to limit re-render frequency on high-frequency streams
// - Rolling message history buffer (default 100, FIFO eviction)
// - Connection status tracking: connecting | connected | disconnected | error
//
// State: lastMessage, messageHistory, connectionStatus, error
// Returns: isConnected, reconnect(), disconnect(), clearHistory(), send()
//
// ============================================================================

import { useState, useEffect, useRef, useCallback } from 'react';
import { listen, emit, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// TYPES
// ============================================================================

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface WebSocketOptions<T> {
  /** Callback for each incoming message */
  onMessage?: (payload: T) => void;
  /** Callback when connection established */
  onConnect?: () => void;
  /** Callback when connection lost */
  onDisconnect?: () => void;
  /** Callback on connection errors */
  onError?: (error: string) => void;
  /** Minimum ms between message processing (throttling) */
  throttleMs?: number;
  /** Maximum messages to keep in history buffer */
  maxHistorySize?: number;
  /** Ms without messages before considering connection dead */
  heartbeatTimeoutMs?: number;
  /** Whether to auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Initial value for lastMessage */
  initialState?: T | null;
}

export interface UseWebSocketReturn<T> {
  /** Most recent message payload */
  lastMessage: T | null;
  /** Rolling buffer of recent messages (FIFO, capped at maxHistorySize) */
  messageHistory: T[];
  /** Current connection state */
  connectionStatus: ConnectionStatus;
  /** Error message if connectionStatus is 'error' */
  error: string | null;
  /** Convenience: connectionStatus === 'connected' */
  isConnected: boolean;
  /** Convenience: connectionStatus === 'connecting' */
  isConnecting: boolean;
  /** Manually trigger reconnection */
  reconnect: () => Promise<void>;
  /** Manually disconnect/cleanup */
  disconnect: () => void;
  /** Clear message history buffer */
  clearHistory: () => void;
  /** Send message to backend (if bidirectional channel) */
  send: (payload: unknown) => Promise<void>;
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

export function useWebSocket<T = any>(
  channel: string,
  options: WebSocketOptions<T> = {}
): UseWebSocketReturn<T> {
  const {
    onMessage,
    onConnect,
    onDisconnect,
    onError,
    throttleMs = 0,
    maxHistorySize = 100,
    heartbeatTimeoutMs = 30000,
    autoReconnect = true,
    initialState = null
  } = options;

  // State
  const [lastMessage, setLastMessage] = useState<T | null>(initialState);
  const [messageHistory, setMessageHistory] = useState<T[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting');
  const [error, setError] = useState<string | null>(null);

  // Refs for mutable state that shouldn't trigger re-renders
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const isMountedRef = useRef(true);
  const lastMessageTimeRef = useRef<number>(Date.now());

  // Throttled message handler
  const processMessage = useCallback((payload: T) => {
    if (!isMountedRef.current) return;

    const now = Date.now();
    lastMessageTimeRef.current = now;

    // Update status if we were disconnected/error
    if (connectionStatus !== 'connected') {
      setConnectionStatus('connected');
      setError(null);
      reconnectAttemptRef.current = 0;
      onConnect?.();
    }

    // Update state
    setLastMessage(payload);
    setMessageHistory(prev => {
      const newHistory = [...prev, payload];
      if (newHistory.length > maxHistorySize) {
        return newHistory.slice(newHistory.length - maxHistorySize);
      }
      return newHistory;
    });

    // Call user callback
    onMessage?.(payload);
  }, [connectionStatus, maxHistorySize, onConnect, onMessage]);

  // Setup heartbeat checker
  const setupHeartbeat = useCallback(() => {
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
    }

    heartbeatTimerRef.current = setInterval(() => {
      const timeSinceLastMessage = Date.now() - lastMessageTimeRef.current;
      
      if (timeSinceLastMessage > heartbeatTimeoutMs && connectionStatus === 'connected') {
        console.warn(`WebSocket heartbeat timeout for channel: ${channel}`);
        setConnectionStatus('disconnected');
        setError('Connection timeout - no data received');
        onDisconnect?.();
        
        if (autoReconnect) {
          attemptReconnect();
        }
      }
    }, Math.min(heartbeatTimeoutMs / 3, 10000)); // Check 3x before timeout, max 10s
  }, [channel, connectionStatus, heartbeatTimeoutMs, autoReconnect, onDisconnect]);

  // Reconnection logic
  const attemptReconnect = useCallback(() => {
    if (reconnectAttemptRef.current >= 10) {
      setError('Max reconnection attempts reached. Please reconnect manually.');
      setConnectionStatus('error');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, reconnectAttemptRef.current), 60000);
    reconnectAttemptRef.current++;

    console.log(`Attempting reconnect to ${channel} in ${delay}ms (attempt ${reconnectAttemptRef.current})`);

    reconnectTimerRef.current = setTimeout(() => {
      if (!isMountedRef.current) return;
      
      setConnectionStatus('connecting');
      
      // Trigger backend reconnection via command
      invoke('reconnect_websocket_cmd', { channel })
        .then(() => {
          console.log(`Reconnected to ${channel}`);
          setupHeartbeat();
        })
        .catch((err: Error) => {
          console.error(`Reconnect failed for ${channel}:`, err);
          setError(`Reconnection failed: ${err}`);
          setConnectionStatus('error');
          onError?.(String(err));
          
          // Try again
          if (autoReconnect) {
            attemptReconnect();
          }
        });
    }, delay);
  }, [channel, autoReconnect, setupHeartbeat, onError]);

  // Main setup effect
  useEffect(() => {
    isMountedRef.current = true;
    
    let currentUnlisten: UnlistenFn | null = null;

    const setup = async () => {
      try {
        setConnectionStatus('connecting');
        
        // Subscribe to Tauri event channel
        currentUnlisten = await listen<T>(channel, (event) => {
          if (!isMountedRef.current) return;
          
          if (throttleMs > 0) {
            // Simple throttle using setTimeout
            if (throttleTimeoutRef.current) {
              clearTimeout(throttleTimeoutRef.current);
            }
            throttleTimeoutRef.current = setTimeout(() => {
              processMessage(event.payload);
            }, throttleMs);
          } else {
            processMessage(event.payload);
          }
        });

        unlistenRef.current = currentUnlisten;
        setupHeartbeat();
        
        // Initial status check
        lastMessageTimeRef.current = Date.now();
        
      } catch (err) {
        console.error(`Failed to setup WebSocket listener for ${channel}:`, err);
        setError(`Setup failed: ${err}`);
        setConnectionStatus('error');
        onError?.(String(err));
        
        if (autoReconnect) {
          attemptReconnect();
        }
      }
    };

    setup();

    // Cleanup
    return () => {
      isMountedRef.current = false;
      
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      
      if (heartbeatTimerRef.current) {
        clearInterval(heartbeatTimerRef.current);
      }
      
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      
      if (throttleTimeoutRef.current) {
        clearTimeout(throttleTimeoutRef.current);
      }
    };
  }, [channel]); // Only re-run if channel changes

  // Throttle timeout ref
  const throttleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Manual actions
  const reconnect = useCallback(async () => {
    reconnectAttemptRef.current = 0;
    setError(null);
    
    // Cleanup existing
    if (unlistenRef.current) {
      unlistenRef.current();
    }
    
    // Force backend reconnect then re-run setup
    try {
      await invoke('reconnect_websocket_cmd', { channel });
      // The effect cleanup/re-run will handle re-subscription
    } catch (err) {
      setError(`Reconnect failed: ${err}`);
    }
  }, [channel]);

  const disconnect = useCallback(() => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    if (heartbeatTimerRef.current) {
      clearInterval(heartbeatTimerRef.current);
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }
    setConnectionStatus('disconnected');
    onDisconnect?.();
    
    // Notify backend
    invoke('disconnect_websocket_cmd', { channel }).catch(console.error);
  }, [channel, onDisconnect]);

  const clearHistory = useCallback(() => {
    setMessageHistory([]);
  }, []);

  const send = useCallback(async (payload: unknown) => {
    try {
      // Send via Tauri event to backend
      await emit(`${channel}:send`, payload);
    } catch (err) {
      console.error(`Failed to send message on ${channel}:`, err);
      throw err;
    }
  }, [channel]);

  return {
    lastMessage,
    messageHistory,
    connectionStatus,
    error,
    isConnected: connectionStatus === 'connected',
    isConnecting: connectionStatus === 'connecting',
    reconnect,
    disconnect,
    clearHistory,
    send
  };
}

// Convenience hooks for common channels

export function usePriceUpdate(symbol?: string) {
  const { lastMessage, ...rest } = useWebSocket<{
    symbol: string;
    price: number;
    timestamp: number;
  }>('price:update');

  // Filter by symbol if provided
  const filteredMessage = symbol && lastMessage
    ? lastMessage.symbol === symbol ? lastMessage : null
    : lastMessage;

  return { lastMessage: filteredMessage, ...rest };
}

export function useOrderbookUpdates(_marketId: string) {
  return useWebSocket<{
    market_id: string;
    bids: [number, number][];
    asks: [number, number][];
    timestamp: string;
  }>('orderbook:update', {
    heartbeatTimeoutMs: 5000 // Faster timeout for orderbook (should be frequent)
  });
}

export default useWebSocket;