// ============================================================================
// CONSOLIDATED WEBSOCKET HOOK
// ============================================================================
//
// Module: hooks/useConsolidatedWebSocket.ts
// Purpose: React hook for subscribing to consolidated WebSocket streams
//
// OVERVIEW:
// This hook provides a simplified interface for subscribing to market data
// streams using the consolidated WebSocket manager. Instead of creating a
// new WebSocket connection for each market, it uses a single connection
// per platform and multiplexes subscriptions.
//
// BENEFITS:
// - Reduced connection overhead (1 connection per platform vs 1 per market)
// - Efficient subscription management (add/remove without reconnecting)
// - Automatic cleanup on unmount
// - Shared event listeners across components
//
// USAGE:
// ```typescript
// const { subscribe, unsubscribe, subscriptions, isConnected } = useConsolidatedWebSocket();
//
// // Subscribe to a market
// await subscribe('polymarket', '0x123...');
//
// // Unsubscribe from a market
// await unsubscribe('polymarket', '0x123...');
//
// // Check active subscriptions
// console.log(subscriptions); // { polymarket: ['0x123...', '0x456...'] }
// ```
//
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// ============================================================================
// TYPES
// ============================================================================

export type Platform = 'polymarket' | 'kalshi' | 'binance';

export interface ConsolidatedSubscriptionInfo {
  platform: string;
  markets: string[];
}

export interface OrderbookUpdate {
  market_id: string;
  platform: string;
  bids: Array<{ price: number; size: number; order_count?: number }>;
  asks: Array<{ price: number; size: number; order_count?: number }>;
  timestamp: number;
  sequence: number;
  last_price?: number;
  last_size?: number;
}

export interface RawWebSocketMessage {
  market_id: string;
  platform: string;
  raw_message: string;
  timestamp: number;
  msg_type?: string;
}

export interface UseConsolidatedWebSocketReturn {
  /** Subscribe to a market on a platform */
  subscribe: (platform: Platform, marketId: string) => Promise<void>;
  /** Unsubscribe from a market */
  unsubscribe: (platform: Platform, marketId: string) => Promise<void>;
  /** Unsubscribe from all markets on a platform */
  unsubscribePlatform: (platform: Platform) => Promise<void>;
  /** Get all active subscriptions */
  subscriptions: ConsolidatedSubscriptionInfo[];
  /** Latest orderbook updates by market ID */
  orderbooks: Map<string, OrderbookUpdate>;
  /** Raw WebSocket messages (for debugging) */
  rawMessages: RawWebSocketMessage[];
  /** Connection status by platform */
  connectionStatus: Map<Platform, 'connected' | 'disconnected' | 'connecting'>;
  /** Whether any platform is connected */
  isConnected: boolean;
  /** Set Kalshi credentials for authenticated connections */
  setKalshiCredentials: (apiKey: string, privateKeyPem: string, demo: boolean) => Promise<void>;
  /** Clear Kalshi credentials */
  clearKalshiCredentials: () => Promise<void>;
  /** Error message if any */
  error: string | null;
  /** Clear error */
  clearError: () => void;
}

// ============================================================================
// GLOBAL STATE (Shared across hook instances)
// ============================================================================

// Global subscription tracking to prevent duplicate subscriptions
const globalSubscriptions = new Map<Platform, Set<string>>();
const globalOrderbooks = new Map<string, OrderbookUpdate>();
const globalListeners = new Map<string, number>(); // Reference counting for event listeners
let globalUnlistenOrderbook: UnlistenFn | null = null;
let globalUnlistenRaw: UnlistenFn | null = null;

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

export function useConsolidatedWebSocket(): UseConsolidatedWebSocketReturn {
  const [subscriptions, setSubscriptions] = useState<ConsolidatedSubscriptionInfo[]>([]);
  const [orderbooks, setOrderbooks] = useState<Map<string, OrderbookUpdate>>(new Map(globalOrderbooks));
  const [rawMessages, setRawMessages] = useState<RawWebSocketMessage[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<Map<Platform, 'connected' | 'disconnected' | 'connecting'>>(
    new Map([
      ['polymarket', 'disconnected'],
      ['kalshi', 'disconnected'],
      ['binance', 'disconnected'],
    ])
  );
  const [error, setError] = useState<string | null>(null);
  
  const isMountedRef = useRef(true);
  const instanceIdRef = useRef(Math.random().toString(36).substring(7));

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================

  useEffect(() => {
    isMountedRef.current = true;

    // Setup global event listeners (only once across all instances)
    const setupListeners = async () => {
      // Orderbook update listener
      if (!globalUnlistenOrderbook) {
        globalUnlistenOrderbook = await listen<OrderbookUpdate>('orderbook:update', (event) => {
          const update = event.payload;
          globalOrderbooks.set(update.market_id, update);
          
          // Update connection status
          const platform = update.platform as Platform;
          if (globalListeners.has(`orderbook:${platform}`)) {
            // Notify all instances
            window.dispatchEvent(new CustomEvent('consolidated:orderbook:update', { detail: update }));
          }
        });
      }

      // Raw message listener
      if (!globalUnlistenRaw) {
        globalUnlistenRaw = await listen<RawWebSocketMessage>('orderbook:raw', (event) => {
          window.dispatchEvent(new CustomEvent('consolidated:raw:message', { detail: event.payload }));
        });
      }

      // Increment reference count
      globalListeners.set(instanceIdRef.current, 1);
    };

    setupListeners();

    // Listen for updates from other instances
    const handleOrderbookUpdate = (e: CustomEvent<OrderbookUpdate>) => {
      if (!isMountedRef.current) return;
      setOrderbooks(new Map(globalOrderbooks));
      
      // Update connection status based on received data
      const platform = e.detail.platform as Platform;
      setConnectionStatus(prev => {
        const next = new Map(prev);
        next.set(platform, 'connected');
        return next;
      });
    };

    const handleRawMessage = (e: CustomEvent<RawWebSocketMessage>) => {
      if (!isMountedRef.current) return;
      setRawMessages(prev => {
        const next = [...prev, e.detail];
        if (next.length > 100) next.shift(); // Keep last 100 messages
        return next;
      });
    };

    window.addEventListener('consolidated:orderbook:update', handleOrderbookUpdate as EventListener);
    window.addEventListener('consolidated:raw:message', handleRawMessage as EventListener);

    // Fetch current subscriptions
    fetchSubscriptions();

    return () => {
      isMountedRef.current = false;
      window.removeEventListener('consolidated:orderbook:update', handleOrderbookUpdate as EventListener);
      window.removeEventListener('consolidated:raw:message', handleRawMessage as EventListener);

      // Decrement reference count
      globalListeners.delete(instanceIdRef.current);

      // Cleanup global listeners when no instances are active
      if (globalListeners.size === 0) {
        if (globalUnlistenOrderbook) {
          globalUnlistenOrderbook();
          globalUnlistenOrderbook = null;
        }
        if (globalUnlistenRaw) {
          globalUnlistenRaw();
          globalUnlistenRaw = null;
        }
      }
    };
  }, []);

  // ============================================================================
  // ACTIONS
  // ============================================================================

  const fetchSubscriptions = useCallback(async () => {
    try {
      const subs = await invoke<ConsolidatedSubscriptionInfo[]>('get_consolidated_subscriptions_cmd');
      if (isMountedRef.current) {
        setSubscriptions(subs);
        
        // Update global subscription tracking
        for (const sub of subs) {
          const platform = sub.platform as Platform;
          if (!globalSubscriptions.has(platform)) {
            globalSubscriptions.set(platform, new Set());
          }
          for (const market of sub.markets) {
            globalSubscriptions.get(platform)!.add(market);
          }
        }
        
        // Update connection status for platforms with subscriptions
        setConnectionStatus(prev => {
          const next = new Map(prev);
          for (const sub of subs) {
            if (sub.markets.length > 0) {
              next.set(sub.platform as Platform, 'connecting');
            }
          }
          return next;
        });
      }
    } catch (err) {
      console.error('Failed to fetch subscriptions:', err);
    }
  }, []);

  const subscribe = useCallback(async (platform: Platform, marketId: string) => {
    // Check if already subscribed globally
    if (globalSubscriptions.has(platform) && globalSubscriptions.get(platform)!.has(marketId)) {
      console.log(`[ConsolidatedWS] Already subscribed to ${marketId} on ${platform}`);
      return;
    }

    try {
      setError(null);
      setConnectionStatus(prev => {
        const next = new Map(prev);
        next.set(platform, 'connecting');
        return next;
      });

      await invoke('subscribe_consolidated_cmd', { platform, marketId });

      // Update global tracking
      if (!globalSubscriptions.has(platform)) {
        globalSubscriptions.set(platform, new Set());
      }
      globalSubscriptions.get(platform)!.add(marketId);

      // Refresh subscriptions
      await fetchSubscriptions();
      
      console.log(`[ConsolidatedWS] Subscribed to ${marketId} on ${platform}`);
    } catch (err) {
      const errorMsg = `Failed to subscribe to ${marketId} on ${platform}: ${err}`;
      console.error(errorMsg);
      setError(errorMsg);
      
      setConnectionStatus(prev => {
        const next = new Map(prev);
        next.set(platform, 'disconnected');
        return next;
      });
    }
  }, [fetchSubscriptions]);

  const unsubscribe = useCallback(async (platform: Platform, marketId: string) => {
    try {
      setError(null);
      
      await invoke('unsubscribe_consolidated_cmd', { platform, marketId });

      // Update global tracking
      if (globalSubscriptions.has(platform)) {
        globalSubscriptions.get(platform)!.delete(marketId);
      }
      globalOrderbooks.delete(marketId);

      // Refresh subscriptions
      await fetchSubscriptions();
      
      console.log(`[ConsolidatedWS] Unsubscribed from ${marketId} on ${platform}`);
    } catch (err) {
      const errorMsg = `Failed to unsubscribe from ${marketId} on ${platform}: ${err}`;
      console.error(errorMsg);
      setError(errorMsg);
    }
  }, [fetchSubscriptions]);

  const unsubscribePlatform = useCallback(async (platform: Platform) => {
    try {
      setError(null);
      
      await invoke('unsubscribe_platform_cmd', { platform });

      // Update global tracking
      if (globalSubscriptions.has(platform)) {
        // Remove orderbooks for this platform
        for (const marketId of globalSubscriptions.get(platform)!) {
          globalOrderbooks.delete(marketId);
        }
        globalSubscriptions.get(platform)!.clear();
      }

      // Refresh subscriptions
      await fetchSubscriptions();
      
      setConnectionStatus(prev => {
        const next = new Map(prev);
        next.set(platform, 'disconnected');
        return next;
      });
      
      console.log(`[ConsolidatedWS] Unsubscribed from all ${platform} markets`);
    } catch (err) {
      const errorMsg = `Failed to unsubscribe from ${platform}: ${err}`;
      console.error(errorMsg);
      setError(errorMsg);
    }
  }, [fetchSubscriptions]);

  const setKalshiCredentials = useCallback(async (apiKey: string, privateKeyPem: string, demo: boolean) => {
    try {
      setError(null);
      await invoke('set_kalshi_credentials_cmd', { apiKey, privateKeyPem, demo });
      console.log('[ConsolidatedWS] Kalshi credentials set');
    } catch (err) {
      const errorMsg = `Failed to set Kalshi credentials: ${err}`;
      console.error(errorMsg);
      setError(errorMsg);
    }
  }, []);

  const clearKalshiCredentials = useCallback(async () => {
    try {
      setError(null);
      await invoke('clear_kalshi_credentials_cmd');
      console.log('[ConsolidatedWS] Kalshi credentials cleared');
    } catch (err) {
      const errorMsg = `Failed to clear Kalshi credentials: ${err}`;
      console.error(errorMsg);
      setError(errorMsg);
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // ============================================================================
  // RETURN
  // ============================================================================

  return {
    subscribe,
    unsubscribe,
    unsubscribePlatform,
    subscriptions,
    orderbooks,
    rawMessages,
    connectionStatus,
    isConnected: Array.from(connectionStatus.values()).some(s => s === 'connected'),
    setKalshiCredentials,
    clearKalshiCredentials,
    error,
    clearError,
  };
}

// ============================================================================
// CONVENIENCE HOOKS
// ============================================================================

/**
 * Hook for subscribing to a single market's orderbook
 */
export function useOrderbook(
  platform: Platform,
  marketId: string
): {
  orderbook: OrderbookUpdate | null;
  isConnected: boolean;
  error: string | null;
} {
  const { subscribe, unsubscribe, orderbooks, connectionStatus, error } = useConsolidatedWebSocket();

  useEffect(() => {
    subscribe(platform, marketId);
    
    return () => {
      unsubscribe(platform, marketId);
    };
  }, [platform, marketId, subscribe, unsubscribe]);

  const orderbook = orderbooks.get(marketId) || null;
  const isConnected = connectionStatus.get(platform) === 'connected';

  return { orderbook, isConnected, error };
}

/**
 * Hook for subscribing to multiple markets on the same platform
 */
export function useMultiOrderbook(
  platform: Platform,
  marketIds: string[]
): {
  orderbooks: Map<string, OrderbookUpdate>;
  isConnected: boolean;
  error: string | null;
} {
  const { subscribe, unsubscribe, orderbooks, connectionStatus, error } = useConsolidatedWebSocket();
  const prevMarketIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(marketIds);
    const prevIds = prevMarketIdsRef.current;

    // Subscribe to new markets
    for (const id of currentIds) {
      if (!prevIds.has(id)) {
        subscribe(platform, id);
      }
    }

    // Unsubscribe from removed markets
    for (const id of prevIds) {
      if (!currentIds.has(id)) {
        unsubscribe(platform, id);
      }
    }

    prevMarketIdsRef.current = currentIds;
  }, [platform, marketIds.join(','), subscribe, unsubscribe]);

  const filteredOrderbooks = new Map<string, OrderbookUpdate>();
  for (const id of marketIds) {
    const ob = orderbooks.get(id);
    if (ob) {
      filteredOrderbooks.set(id, ob);
    }
  }

  const isConnected = connectionStatus.get(platform) === 'connected';

  return { orderbooks: filteredOrderbooks, isConnected, error };
}

export default useConsolidatedWebSocket;
