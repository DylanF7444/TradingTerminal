// ============================================================================
// ORDERBOOK SUBSCRIPTION HOOK
// ============================================================================
//
// Purpose: React hooks for subscribing to real-time orderbook updates from
// Polymarket/Kalshi prediction markets via Tauri IPC and event listeners.
//
// Hooks provided:
// - useOrderbook(autoReconnect?, maxTrades?): Base hook with full subscribe/unsubscribe control
// - useMarketOrderbook(platform, marketId): Auto-subscribes on mount for a single market
// - useMultipleOrderbooks(markets): Subscribe to multiple markets simultaneously
//
// Data flow:
//   Hook invokes Tauri command -> Backend connects to exchange WebSocket
//   -> Backend emits 'orderbook:update' events -> Hook updates state
//
// Key behaviors:
// - Auto-cleanup on component unmount
// - Connection state and stale data detection
// - Returns: orderbook, status, error, recentTrades
//
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// TYPES
// ============================================================================

/** Single price level in the orderbook */
export interface OrderbookLevel {
  price: number;
  size: number;
  order_count?: number;
}

/** Full orderbook update from backend */
export interface OrderbookUpdate {
  market_id: string;
  platform: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: number;
  sequence: number;
  last_price?: number;
  last_size?: number;
}

/** Connection status for orderbook stream */
export type OrderbookStatus = 'idle' | 'connecting' | 'connected' | 'error' | 'stale';

/** Subscription info from backend */
export interface SubscriptionInfo {
  market_id: string;
  platform: string;
}

/** Trade record for recent trades display */
export interface OrderbookTrade {
  price: number;
  size: number;
  side: 'buy' | 'sell';
  time: number;
}

/** Raw WebSocket message from backend */
export interface RawWebSocketMessage {
  /** Market identifier */
  market_id: string;
  /** Platform (polymarket or kalshi) */
  platform: string;
  /** Raw JSON message as string */
  raw_message: string;
  /** Unix timestamp in milliseconds when received */
  timestamp: number;
  /** Message type (if determinable) */
  msg_type: string | null;
}

/** Return type for the hook */
export interface UseOrderbookReturn {
  /** Current orderbook data */
  orderbook: OrderbookUpdate | null;
  /** Connection status */
  status: OrderbookStatus;
  /** Error message if status is 'error' */
  error: string | null;
  /** Whether currently subscribed and receiving data */
  isConnected: boolean;
  /** Recent trades (derived from last_price updates) */
  recentTrades: OrderbookTrade[];
  /** Subscribe to a market's orderbook */
  subscribe: (platform: 'polymarket' | 'kalshi', marketId: string) => Promise<void>;
  /** Subscribe to Polymarket market using ws/market endpoint (different subscription format) */
  subscribePolymarketMarket: (assetIds: string[]) => Promise<void>;
  /** Subscribe to Kalshi orderbook with authentication */
  subscribeKalshiWithAuth: (marketId: string, apiKey: string, privateKeyPem: string, demo?: boolean) => Promise<void>;
  /** Unsubscribe from current market */
  unsubscribe: () => Promise<void>;
  /** Manually reconnect */
  reconnect: () => Promise<void>;
  /** Active subscriptions */
  subscriptions: SubscriptionInfo[];
}

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

/**
 * Hook for subscribing to real-time orderbook updates
 * 
 * @param autoReconnect - Whether to automatically reconnect on disconnect (default: true)
 * @param maxTrades - Maximum number of recent trades to keep (default: 50)
 */
export function useOrderbook(
  _autoReconnect: boolean = true,
  maxTrades: number = 50
): UseOrderbookReturn {
  // State
  const [orderbook, setOrderbook] = useState<OrderbookUpdate | null>(null);
  const [status, setStatus] = useState<OrderbookStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [recentTrades, setRecentTrades] = useState<OrderbookTrade[]>([]);
  const [subscriptions, setSubscriptions] = useState<SubscriptionInfo[]>([]);
  
  // Refs
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const currentMarketRef = useRef<string | null>(null);
  const lastUpdateRef = useRef<number>(Date.now());
  const staleCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  
  // -------------------------------------------------------------------------
  // Subscribe to Tauri events
  // -------------------------------------------------------------------------
  
  useEffect(() => {
    let mounted = true;
    
    const setupListener = async () => {
      // Listen for orderbook updates
      unlistenRef.current = await listen<OrderbookUpdate>('orderbook:update', (event) => {
        if (!mounted) return;
        
        const update = event.payload;
        
        // Filter updates by current market - ignore updates from other markets
        // For Polymarket subscribePolymarketMarket, currentMarketRef is comma-joined asset IDs
        const currentMarket = currentMarketRef.current;
        if (currentMarket) {
          const isMatch = update.market_id === currentMarket || 
            currentMarket.includes(update.market_id) ||
            update.market_id.includes(currentMarket);
          if (!isMatch) return;
        }
        
        lastUpdateRef.current = Date.now();
        
        // Update status
        if (status !== 'connected') {
          setStatus('connected');
          setError(null);
        }
        
        // Update orderbook
        setOrderbook(update);
        
        // Track trades
        if (update.last_price && update.last_size) {
          const trade: OrderbookTrade = {
            price: update.last_price,
            size: update.last_size,
            side: 'buy', // We don't know the side from the update, default to buy
            time: update.timestamp,
          };
          
          setRecentTrades(prev => {
            const newTrades = [trade, ...prev].slice(0, maxTrades);
            return newTrades;
          });
        }
      });
    };
    
    setupListener();
    
    // Staleness detection
    staleCheckRef.current = setInterval(() => {
      const timeSinceUpdate = Date.now() - lastUpdateRef.current;
      if (timeSinceUpdate > 5000 && status === 'connected') {
        setStatus('stale');
      }
    }, 2000);
    
    // Fetch active subscriptions
    invoke<SubscriptionInfo[]>('get_orderbook_subscriptions_cmd')
      .then(subs => {
        if (mounted) setSubscriptions(subs);
      })
      .catch(() => {});
    
    return () => {
      mounted = false;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      if (staleCheckRef.current) {
        clearInterval(staleCheckRef.current);
      }
    };
  }, [maxTrades, status]);
  
  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------
  
  const subscribe = useCallback(async (platform: 'polymarket' | 'kalshi', marketId: string) => {
    if (currentMarketRef.current === marketId && status === 'connected') {
      return; // Already subscribed
    }
    
    setStatus('connecting');
    setError(null);
    currentMarketRef.current = marketId;
    
    try {
      await invoke<string>('subscribe_orderbook_cmd', { platform, marketId });
      setStatus('connected');
      lastUpdateRef.current = Date.now();
      
      // Update subscriptions list
      const subs = await invoke<SubscriptionInfo[]>('get_orderbook_subscriptions_cmd');
      setSubscriptions(subs);
    } catch (e) {
      setStatus('error');
      setError(String(e));
      currentMarketRef.current = null;
    }
  }, [status]);
  
  const unsubscribe = useCallback(async () => {
    if (!currentMarketRef.current) return;
    
    try {
      await invoke<string>('unsubscribe_orderbook_cmd', { marketId: currentMarketRef.current });
      currentMarketRef.current = null;
      setOrderbook(null);
      setStatus('idle');
      setRecentTrades([]);
      
      // Update subscriptions list
      const subs = await invoke<SubscriptionInfo[]>('get_orderbook_subscriptions_cmd');
      setSubscriptions(subs);
    } catch (e) {
      console.error('Failed to unsubscribe:', e);
    }
  }, []);
  
  const reconnect = useCallback(async () => {
    if (!currentMarketRef.current) return;
    
    try {
      await invoke<string>('reconnect_orderbook_cmd', { marketId: currentMarketRef.current });
      setStatus('connecting');
    } catch (e) {
      setStatus('error');
      setError(String(e));
    }
  }, []);
  
  /**
   * Subscribe to Kalshi orderbook with authentication
   * This allows access to orderbook_delta channel for full orderbook data
   */
  const subscribeKalshiWithAuth = useCallback(async (
    marketId: string, 
    apiKey: string, 
    privateKeyPem: string, 
    demo: boolean = false
  ) => {
    if (currentMarketRef.current === marketId && status === 'connected') {
      return; // Already subscribed
    }
    
    setStatus('connecting');
    setError(null);
    currentMarketRef.current = marketId;
    
    try {
      await invoke<string>('subscribe_kalshi_orderbook_auth_cmd', { 
        marketId, 
        apiKey, 
        privateKeyPem, 
        demo 
      });
      setStatus('connected');
      lastUpdateRef.current = Date.now();
      
      // Update subscriptions list
      const subs = await invoke<SubscriptionInfo[]>('get_orderbook_subscriptions_cmd');
      setSubscriptions(subs);
    } catch (e) {
      setStatus('error');
      setError(String(e));
      currentMarketRef.current = null;
    }
  }, [status]);
  
  /**
   * Subscribe to Polymarket market using the ws/market endpoint
   * This uses a different subscription format (assets_ids + type: "market")
   * 
   * @param assetIds - Array of Polymarket asset/token IDs to subscribe to
   * 
   * Example usage:
   * ```typescript
   * // Subscribe to BTC up/down market
   * await subscribePolymarketMarket([
   *   '107505882767731489358349912513945399560393482969656700824895970500493757150417',
   *   '7305630249804085635496399869905769372294302716159034447326228509068694952392'
   * ]);
   * ```
   */
  const subscribePolymarketMarket = useCallback(async (assetIds: string[]) => {
    if (assetIds.length === 0) {
      setError('At least one asset ID is required');
      return;
    }
    
    setStatus('connecting');
    setError(null);
    // Store the composite key for reference
    currentMarketRef.current = assetIds.join(',');
    
    try {
      await invoke<string>('subscribe_polymarket_market_cmd', { assetIds });
      setStatus('connected');
      lastUpdateRef.current = Date.now();
      
      // Update subscriptions list
      const subs = await invoke<SubscriptionInfo[]>('get_orderbook_subscriptions_cmd');
      setSubscriptions(subs);
    } catch (e) {
      setStatus('error');
      setError(String(e));
      currentMarketRef.current = null;
    }
  }, []);
  
  // -------------------------------------------------------------------------
  // Return
  // -------------------------------------------------------------------------
  
  return {
    orderbook,
    status,
    error,
    isConnected: status === 'connected',
    recentTrades,
    subscribe,
    subscribePolymarketMarket,
    subscribeKalshiWithAuth,
    unsubscribe,
    reconnect,
    subscriptions,
  };
}

// ============================================================================
// CONVENIENCE HOOKS
// ============================================================================

/**
 * Hook for subscribing to a specific market's orderbook
 * Automatically subscribes on mount and unsubscribes on unmount
 * 
 * @param platform - The market platform
 * @param marketId - The market identifier
 */
export function useMarketOrderbook(
  platform: 'polymarket' | 'kalshi' | null,
  marketId: string | null
): UseOrderbookReturn {
  const orderbook = useOrderbook();
  
  useEffect(() => {
    if (!marketId || !platform) {
      orderbook.unsubscribe();
      return;
    }
    
    orderbook.subscribe(platform, marketId);
    
    return () => {
      orderbook.unsubscribe();
    };
  }, [platform, marketId]);
  
  return orderbook;
}

/**
 * Hook for managing multiple orderbook subscriptions
 * Useful for arbitrage views or portfolio displays
 */
export function useMultipleOrderbooks() {
  const [subscriptions, setSubscriptions] = useState<Map<string, OrderbookUpdate>>(new Map());
  const [status, setStatus] = useState<OrderbookStatus>('idle');
  const unlistenRef = useRef<UnlistenFn | null>(null);
  
  useEffect(() => {
    const setup = async () => {
      unlistenRef.current = await listen<OrderbookUpdate>('orderbook:update', (event) => {
        const update = event.payload;
        setSubscriptions(prev => {
          const next = new Map(prev);
          next.set(update.market_id, update);
          return next;
        });
      });
    };
    
    setup();
    
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
      }
    };
  }, []);
  
  const subscribe = useCallback(async (platform: 'polymarket' | 'kalshi', marketId: string) => {
    try {
      await invoke<string>('subscribe_orderbook_cmd', { platform, marketId });
      setStatus('connected');
    } catch (e) {
      console.error('Failed to subscribe:', e);
    }
  }, []);
  
  const unsubscribe = useCallback(async (marketId: string) => {
    try {
      await invoke<string>('unsubscribe_orderbook_cmd', { marketId });
      setSubscriptions(prev => {
        const next = new Map(prev);
        next.delete(marketId);
        return next;
      });
    } catch (e) {
      console.error('Failed to unsubscribe:', e);
    }
  }, []);
  
  const unsubscribeAll = useCallback(async () => {
    try {
      await invoke<string>('unsubscribe_all_orderbooks_cmd');
      setSubscriptions(new Map());
      setStatus('idle');
    } catch (e) {
      console.error('Failed to unsubscribe all:', e);
    }
  }, []);
  
  return {
    orderbooks: subscriptions,
    status,
    subscribe,
    unsubscribe,
    unsubscribeAll,
  };
}

// ============================================================================
// RAW WEBSOCKET MESSAGE HOOK
// ============================================================================

/**
 * Hook for capturing raw WebSocket messages from orderbook subscriptions
 * Useful for debugging and displaying the raw data stream
 * 
 * @param maxMessages - Maximum number of raw messages to keep in history (default: 50)
 * @param filterMarketId - Optional market ID to filter messages for
 */
export function useRawOrderbookMessages(
  maxMessages: number = 50,
  filterMarketId?: string
) {
  const [rawMessages, setRawMessages] = useState<RawWebSocketMessage[]>([]);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  
  useEffect(() => {
    let mounted = true;
    
    const setupListener = async () => {
      unlistenRef.current = await listen<RawWebSocketMessage>('orderbook:raw', (event) => {
        if (!mounted) return;
        
        const msg = event.payload;
        
        // Filter by market ID if specified
        if (filterMarketId && msg.market_id !== filterMarketId && !msg.market_id.includes(filterMarketId)) {
          return;
        }
        
        setRawMessages(prev => {
          const newMessages = [msg, ...prev].slice(0, maxMessages);
          return newMessages;
        });
      });
    };
    
    setupListener();
    
    return () => {
      mounted = false;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, [maxMessages, filterMarketId]);
  
  const clearMessages = useCallback(() => {
    setRawMessages([]);
  }, []);
  
  return {
    rawMessages,
    clearMessages,
  };
}

export default useOrderbook;
