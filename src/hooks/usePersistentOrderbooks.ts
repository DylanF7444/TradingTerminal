// ============================================================================
// PERSISTENT ORDERBOOK MONITORING HOOK
// ============================================================================
//
// Purpose: Always-on orderbook monitoring across ALL market nodes.
// Mount ONCE at App level. Unlike useOrderbook (per-component), this hook
// keeps subscriptions alive regardless of which UI panel is open.
//
// Key behaviors:
// - Subscribes to ALL active markets, stores in Zustand (marketsSlice.orderbooks)
// - Watches marketsSlice.markets for add/remove, auto-subscribes/unsubscribes
// - Listens for 'orderbook:update' Tauri events and updates central store
// - Max 50 levels/side, max 20 recent trades/market, stale after 5 min
//
// UI components should READ from the central store, not create own subscriptions.
//
// ============================================================================

import { useEffect, useRef, useCallback } from 'react';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';
import type { Orderbook, Level } from '../types/markets';
import type { OrderbookUpdate } from './useOrderbook';

// ============================================================================
// CONSTANTS
// ============================================================================


// ============================================================================
// TYPES
// ============================================================================

/** Monitoring summary from backend */
export interface MonitoringSummary {
  total_markets: number;
  active_subscriptions: number;
  stale_markets: number;
  total_updates: number;
  markets: MonitoredMarket[];
}

/** Individual monitored market info */
export interface MonitoredMarket {
  node_id: string;
  market_id: string;
  platform: string;
  subscribed: boolean;
  last_updated: number | null;
  update_count: number;
}

// ============================================================================
// HELPER: Convert backend OrderbookUpdate to frontend Orderbook
// ============================================================================

function toOrderbook(update: OrderbookUpdate, existing?: Orderbook): Orderbook {
  // Convert backend OrderbookLevel[] to frontend Level[]
  // Only replace existing book data if the update has meaningful levels
  // (non-empty arrays with at least one level that has size > 0)
  const hasNewBids = update.bids.length > 0 && update.bids.some((l: any) => (l.size ?? 0) > 0);
  const hasNewAsks = update.asks.length > 0 && update.asks.some((l: any) => (l.size ?? 0) > 0);
  const bidsRaw = hasNewBids ? update.bids : (existing?.bids ?? []);
  const asksRaw = hasNewAsks ? update.asks : (existing?.asks ?? []);

  const bids: Level[] = bidsRaw.map((l) => ({
    price: 'price' in l ? l.price : (l as Level).price,
    size: 'size' in l ? l.size : (l as Level).size,
    orderCount: ('order_count' in l ? (l as any).order_count : (l as Level).orderCount) ?? 1,
    value: (('price' in l ? l.price : 0) * ('size' in l ? l.size : 0)),
  }));

  const asks: Level[] = asksRaw.map((l) => ({
    price: 'price' in l ? l.price : (l as Level).price,
    size: 'size' in l ? l.size : (l as Level).size,
    orderCount: ('order_count' in l ? (l as any).order_count : (l as Level).orderCount) ?? 1,
    value: (('price' in l ? l.price : 0) * ('size' in l ? l.size : 0)),
  }));

  // Sort: bids descending, asks ascending
  bids.sort((a, b) => b.price - a.price);
  asks.sort((a, b) => a.price - b.price);

  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const spread = bestAsk - bestBid;
  const liquidity =
    bids.reduce((sum, l) => sum + l.value, 0) +
    asks.reduce((sum, l) => sum + l.value, 0);

  return {
    marketId: update.market_id,
    timestamp: update.timestamp,
    bids,
    asks,
    liquidity,
    spread,
    lastPrice: update.last_price ?? existing?.lastPrice,
    lastSize: update.last_size ?? existing?.lastSize,
    lastTradeAt: update.last_price ? update.timestamp : existing?.lastTradeAt,
    sequence: update.sequence || (existing?.sequence ?? 0) + 1,
  };
}

// ============================================================================
// HOOK: usePersistentOrderbooks
// ============================================================================

/**
 * Always-on orderbook monitoring hook.
 *
 * Mount ONCE at the App level. Automatically subscribes to all market nodes
 * and feeds orderbook data into the central marketsSlice store.
 *
 * @returns void - data is stored in Zustand, not returned directly
 */
export function usePersistentOrderbooks(): void {
  const updateOrderbook = useStore((s) => s.updateOrderbook);
  const setMarketStatus = useStore((s) => s.setMarketStatus);
  const markets = useStore((s) => s.markets);

  // Track which markets we've already subscribed to
  const subscribedRef = useRef<Set<string>>(new Set());
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const unlistenStatusRef = useRef<UnlistenFn | null>(null);

  // -------------------------------------------------------------------------
  // STEP 1: Listen for orderbook:update events and feed into central store
  // -------------------------------------------------------------------------
  useEffect(() => {
    let mounted = true;

    const setupListeners = async () => {
      // Listen for ALL orderbook updates (from any market)
      unlistenRef.current = await listen<OrderbookUpdate>(
        'orderbook:update',
        (event) => {
          if (!mounted) return;
          const update = event.payload;
          if (!update.market_id) return;

          // Get existing orderbook from store for merging
          const existing = useStore.getState().orderbooks[update.market_id];

          // Convert to frontend Orderbook and update central store
          const orderbook = toOrderbook(update, existing);
          updateOrderbook(update.market_id, orderbook);

          // Update market status to connected
          setMarketStatus(update.market_id, {
            connected: true,
            connecting: false,
            errorMessage: null,
          });
        }
      );

      // Listen for monitoring status updates
      unlistenStatusRef.current = await listen<MonitoringSummary>(
        'orderbook:monitoring_status',
        (event) => {
          if (!mounted) return;
          // Status updates can be logged or used for UI indicators
          console.log(
            '[PersistentOrderbooks] Monitoring status:',
            event.payload.total_markets, 'markets,',
            event.payload.active_subscriptions, 'active'
          );
        }
      );
    };

    setupListeners();

    return () => {
      mounted = false;
      unlistenRef.current?.();
      unlistenRef.current = null;
      unlistenStatusRef.current?.();
      unlistenStatusRef.current = null;
    };
  }, [updateOrderbook, setMarketStatus]);

  // -------------------------------------------------------------------------
  // STEP 2: Auto-subscribe/unsubscribe when markets change
  // -------------------------------------------------------------------------

  // Extract market IDs for the effect
  const subscribeMarket = useCallback(
    async (nodeId: string, marketId: string, platform: string) => {
      try {
        await invoke<string>('monitor_market_orderbook_cmd', {
          nodeId,
          marketId,
          platform,
        });
        subscribedRef.current.add(nodeId);
        console.log(
          `[PersistentOrderbooks] Subscribed: ${platform}/${marketId} (node: ${nodeId})`
        );
      } catch (e) {
        console.error(
          `[PersistentOrderbooks] Failed to subscribe ${marketId}:`,
          e
        );
      }
    },
    []
  );

  const unsubscribeMarket = useCallback(async (nodeId: string) => {
    try {
      await invoke<string>('unmonitor_market_orderbook_cmd', { nodeId });
      subscribedRef.current.delete(nodeId);
      console.log(`[PersistentOrderbooks] Unsubscribed node: ${nodeId}`);
    } catch (e) {
      console.error(
        `[PersistentOrderbooks] Failed to unsubscribe ${nodeId}:`,
        e
      );
    }
  }, []);

  useEffect(() => {
    // Determine which markets need subscribing/unsubscribing
    const currentMarketNodeIds = new Set<string>();

    for (const market of markets) {
      currentMarketNodeIds.add(market.id);

      // If not yet subscribed, subscribe now
      if (!subscribedRef.current.has(market.id)) {
        // Extract platform and market_id from the market node
        const nodeType = market.node_type;
        let platform = 'polymarket';
        if ('Market' in nodeType) {
          const marketType = String(nodeType.Market).toLowerCase();
          if (marketType.includes('kalshi')) platform = 'kalshi';
          else platform = 'polymarket';
        }

        // Get market_id from metadata (MarketMetadata uses camelCase 'marketId')
        const meta = market.metadata as Record<string, any>;
        const marketId =
          meta?.marketId ??
          meta?.market_id ??
          meta?.condition_id ??
          meta?.slug ??
          '';

        // Get all token_ids for Polymarket (YES and NO tokens)
        const tokenIds: string[] = meta?.token_ids ?? [];

        if (marketId) {
          // Subscribe to primary market ID
          subscribeMarket(market.id, String(marketId), platform);

          // For Polymarket, also subscribe to additional token_ids (NO token)
          // Each token gets its own orderbook data keyed by its token_id
          if (platform === 'polymarket' && tokenIds.length > 0) {
            for (let i = 0; i < tokenIds.length; i++) {
              const tokenId = tokenIds[i];
              // Skip if it's the same as the primary marketId (already subscribed)
              if (tokenId === String(marketId)) continue;
              // Use a synthetic node_id so persistent monitor tracks it separately
              const syntheticNodeId = `${market.id}:token:${i}`;
              subscribeMarket(syntheticNodeId, tokenId, platform);
            }
          }
        }
      }
    }

    // Unsubscribe removed markets (including synthetic token subscriptions)
    for (const nodeId of subscribedRef.current) {
      // Extract the base node id (strip ":token:N" suffix if present)
      const baseNodeId = nodeId.includes(':token:') ? nodeId.split(':token:')[0] : nodeId;
      if (!currentMarketNodeIds.has(baseNodeId)) {
        unsubscribeMarket(nodeId);
      }
    }
  }, [markets, subscribeMarket, unsubscribeMarket]);
}

export default usePersistentOrderbooks;
