// ============================================================================
// GLOBAL INFOSOURCE EVENT LISTENER HOOK
// ============================================================================
//
// Module: hooks/useInfoSourceEvents.ts
// Purpose: Listens for Tauri 'infosource:update' events from the backend
//          WebSocket scraper and propagates data through the node graph.
//
// Extracted from App.tsx to isolate side-effect logic from the UI layer.
//
// Data Flow:
//   Rust backend (websocket_scraper) → Tauri event bus ('infosource:update')
//     → This hook → rawDataStreams store + node metadata updates
//       → Propagation to connected Market nodes
// ============================================================================

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore, type StoreState } from '../store';

type OrderbookLevel = {
  price: number;
  size: number;
  order_count?: number;
};

type OrderbookUpdate = {
  market_id: string;
  platform: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: number;
  sequence: number;
  last_price?: number;
  last_size?: number;
};

/**
 * Hook that subscribes to the global 'infosource:update' Tauri event.
 *
 * When a price update arrives from the backend WebSocket scraper, this hook:
 * 1. Appends the raw data to the source node's stream display
 * 2. Updates the source node's metadata with latest price/symbol values
 * 3. Propagates data to all connected Market nodes via store connections
 * 4. Updates Market node metadata with incoming data and quality metrics
 *
 * Should be called exactly once, in the root App component.
 */
export function useInfoSourceEvents(): void {
  const appendRawDataEntry = useStore((state: StoreState) => state.appendRawDataEntry);
  const updateNodeMetadata = useStore((state: StoreState) => state.updateNodeMetadata);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        unlisten = await listen('infosource:update', (event) => {
          const payload = event.payload as {
            nodeId: string;
            symbol: string;
            price: number;
            bid?: number;
            ask?: number;
            volume_24h?: string;
            timestamp: number;
            source: string;
          };

          console.log('[Global] Received infosource:update:', payload);

          // 1. Append to raw stream for the source node
          appendRawDataEntry(payload.nodeId, {
            data: {
              type: 'price_update',
              symbol: payload.symbol,
              price: payload.price,
              bid: payload.bid,
              ask: payload.ask,
              volume_24h: payload.volume_24h,
            },
            source: payload.source || 'coinbase_websocket',
            status: 'success',
          });

          // 2. Update source node metadata
          const { nodes, connections } = useStore.getState();
          const node = nodes[payload.nodeId];
          if (!node) return;

          const currentMetadata = (node.metadata as Record<string, any>) || {};
          const existingSymbolValues =
            (currentMetadata.lastData as any)?.symbolValues || {};
          const symbolValues = {
            ...existingSymbolValues,
            [payload.symbol]: {
              price: payload.price,
              bid: payload.bid,
              ask: payload.ask,
              timestamp: payload.timestamp,
            },
          };

          const currentLatency = currentMetadata.quality?.avgLatency ?? 0;
          updateNodeMetadata(payload.nodeId, {
            ...currentMetadata,
            lastData: {
              timestamp: payload.timestamp,
              symbolValues,
              value: payload.price, // backward compat
            },
            quality: {
              ...(currentMetadata.quality || {}),
              successRate: 1.0,
              avgLatency: currentLatency,
              lastError: undefined,
            },
          });

          // 3. Propagate to connected Market nodes
          const outgoing = connections.filter((c) => c.source === payload.nodeId);
          for (const conn of outgoing) {
            const target = nodes[conn.target];
            if (!target?.node_type || !('Market' in target.node_type)) continue;

            const targetMeta = (target.metadata as Record<string, any>) || {};
            const sourceNodeType = (node.node_type as { InfoSource: string }).InfoSource;
            const sourceName =
              targetMeta.sources?.[payload.nodeId] || sourceNodeType || 'source';

            const incomingData = { ...(targetMeta.incomingData || {}) };
            incomingData[payload.nodeId] = {
              sourceName,
              sourceType: sourceNodeType,
              symbol: payload.symbol,
              price: payload.price,
              bid: payload.bid,
              ask: payload.ask,
              volume_24h: payload.volume_24h,
              timestamp: payload.timestamp,
              strength: conn.strength || 1.0,
            };

            updateNodeMetadata(conn.target, {
              ...targetMeta,
              incomingData,
              lastData: {
                timestamp: payload.timestamp,
                value: payload.price,
                sourceId: payload.nodeId,
                symbol: payload.symbol,
              },
              quality: {
                ...(targetMeta.quality || {}),
                successRate: conn.strength || 1.0,
                avgLatency: Math.floor(Math.random() * 50) + 10,
                lastError: undefined,
              },
            });

            appendRawDataEntry(conn.target, {
              data: {
                type: 'source_data',
                fromNode: payload.nodeId,
                sourceName,
                symbol: payload.symbol,
                price: payload.price,
                bid: payload.bid,
                ask: payload.ask,
                volume_24h: payload.volume_24h,
                strength: conn.strength || 1.0,
              },
              source: `info_source:${payload.nodeId}`,
              status: 'success',
            });

            console.log(
              `[DataFlow] Propagated ${payload.symbol} data from ${payload.nodeId} to market ${conn.target}`,
            );
          }
        });

        console.log('[Global] infosource:update listener registered');
      } catch (error) {
        console.warn('[Global] Failed to setup infosource:update listener:', error);
      }
    };

    setup();
    return () => {
      unlisten?.();
    };
  }, [appendRawDataEntry, updateNodeMetadata]);
}

/**
 * Hook that periodically updates quality metrics (successRate, avgLatency)
 * for all InfoSource and connected Market nodes.
 *
 * Runs every 2 seconds and simulates latency/success tracking for each node.
 * Should be called exactly once, in the root App component.
 */
export function useNodeQualityMetrics(): void {
  const updateNodeMetadata = useStore((state: StoreState) => state.updateNodeMetadata);

  useEffect(() => {
    // Track rolling metrics per node
    const latencyHistory: Record<string, number[]> = {};
    const successCount: Record<string, number> = {};
    const totalCount: Record<string, number> = {};

    const updateInterval = setInterval(() => {
      const { nodes, connections } = useStore.getState();

      Object.values(nodes).forEach((node) => {
        if (!node?.id) return;

        const nodeId = node.id;
        const nodeIsInfoSource = node.node_type && 'InfoSource' in node.node_type;
        const nodeIsMarket = node.node_type && 'Market' in node.node_type;

        if (!nodeIsInfoSource && !nodeIsMarket) return;

        const incomingConns = connections.filter((c) => c.target === nodeId);
        if (nodeIsMarket && incomingConns.length === 0) return;

        // Initialize tracking for new nodes
        if (!latencyHistory[nodeId]) {
          latencyHistory[nodeId] = [];
          successCount[nodeId] = 0;
          totalCount[nodeId] = 0;
        }

        const currentLatency = Math.floor(Math.random() * 65) + 15;
        const isSuccess = Math.random() > 0.02;

        latencyHistory[nodeId].push(currentLatency);
        if (latencyHistory[nodeId].length > 20) latencyHistory[nodeId].shift();

        totalCount[nodeId]++;
        if (isSuccess) successCount[nodeId]++;

        const avgLatency =
          latencyHistory[nodeId].reduce((a, b) => a + b, 0) / latencyHistory[nodeId].length;
        const successRate =
          totalCount[nodeId] > 0 ? successCount[nodeId] / totalCount[nodeId] : 0;

        const currentMetadata = (node.metadata as Record<string, any>) || {};
        const symbolValues = { ...((currentMetadata.lastData as any)?.symbolValues || {}) };
        const firstSymbolPrice = Object.values(symbolValues)[0] as
          | { price?: number }
          | undefined;

        updateNodeMetadata(nodeId, {
          ...currentMetadata,
          quality: {
            successRate,
            avgLatency,
            lastError: isSuccess ? undefined : 'Connection timeout',
          },
          lastData: {
            timestamp: Date.now(),
            symbolValues,
            value: firstSymbolPrice?.price || currentMetadata.lastData?.value,
          },
        });
      });
    }, 2000);

    return () => clearInterval(updateInterval);
  }, [updateNodeMetadata]);
}

/**
 * Hook that subscribes to the global 'orderbook:update' Tauri event.
 * 
 * When orderbook updates arrive from the backend WebSocket connections
 * (for Polymarket/Kalshi markets), this hook:
 * 1. Finds the market node that corresponds to the market_id
 * 2. Updates the node's metadata with marketState (lastPrice, bestBid, bestAsk)
 * 
 * This enables the market node to display ticker/price values on the canvas.
 */
export function useMarketOrderbookEvents(): void {
  const updateNodeMetadata = useStore((state: StoreState) => state.updateNodeMetadata);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        unlisten = await listen<OrderbookUpdate>('orderbook:update', (event) => {
          const update = event.payload;
          
          console.log('[Global] Received orderbook:update for market:', update.market_id);

          const { nodes } = useStore.getState();
          
          const marketNode = Object.values(nodes).find((node) => {
            if (!node?.node_type || !('Market' in node.node_type)) return false;
            
            const meta = node.metadata as Record<string, any> | undefined;
            const nodeMarketId = meta?.marketId || meta?.market_id;
            
            return nodeMarketId === update.market_id || 
                   node.id === update.market_id ||
                   (meta?.token_ids && meta.token_ids.includes(update.market_id));
          });

          if (!marketNode) {
            return;
          }

          const currentMetadata = (marketNode.metadata as Record<string, any>) || {};
          
          const bestBid = update.bids?.[0]?.price;
          const bestAsk = update.asks?.[0]?.price;
          const lastPrice = update.last_price || bestBid || bestAsk;

          updateNodeMetadata(marketNode.id, {
            ...currentMetadata,
            status: 'live',
            marketState: {
              status: 'open',
              bestBid: bestBid ?? 0,
              bestAsk: bestAsk ?? 0,
              lastPrice: lastPrice ?? 0,
              volume24h: 0,
            },
            lastData: {
              timestamp: update.timestamp,
              value: lastPrice,
            },
          });
        });

        console.log('[Global] orderbook:update listener registered');
      } catch (error) {
        console.warn('[Global] Failed to setup orderbook:update listener:', error);
      }
    };

    setup();
    return () => {
      unlisten?.();
    };
  }, [updateNodeMetadata]);
}

// ============================================================================
// AUTO MARKET SUBSCRIPTION HOOK
// ============================================================================

/**
 * Hook that automatically subscribes to orderbook WebSocket feeds for all
 * market nodes. It watches the store for new market nodes and subscribes
 * them when they appear.
 *
 * For Polymarket: uses subscribe_polymarket_market_cmd with token IDs
 * For Kalshi: uses subscribe_kalshi_orderbook_auth_cmd (if credentials stored)
 *             or subscribe_orderbook_cmd (public channels) as fallback
 *
 * Combined with useMarketOrderbookEvents (which routes incoming orderbook:update
 * events to the correct node's metadata), this ensures market nodes always
 * display live ticker data on the canvas.
 *
 * Should be called exactly once, in the root App component.
 */
export function useAutoMarketSubscriptions(): void {
  const subscribedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Check for new market nodes every 2 seconds
    const interval = setInterval(() => {
      const { nodes } = useStore.getState();

      Object.values(nodes).forEach(async (node) => {
        if (!node?.node_type || !('Market' in node.node_type)) return;
        if (subscribedRef.current.has(node.id)) return;

        // Mark as subscribed immediately to avoid double-subscription
        subscribedRef.current.add(node.id);

        const meta = node.metadata as Record<string, any> | undefined;
        const marketId = meta?.market_id || meta?.marketId || '';
        const tokenIds: string[] = meta?.token_ids || [];
        const marketType = (node.node_type as { Market: string }).Market;

        if (!marketId && tokenIds.length === 0) {
          console.warn(`[AutoSub] Market node ${node.id} has no market_id or token_ids, skipping`);
          return;
        }

        try {
          if (marketType === 'Polymarket') {
            // For Polymarket, use the ws/market endpoint with CLOB token IDs
            const assetIds = tokenIds.length > 0 ? tokenIds : [marketId];
            console.log(`[AutoSub] Subscribing Polymarket node ${node.id} with asset IDs:`, assetIds);
            await invoke<string>('subscribe_polymarket_market_cmd', { assetIds });
            console.log(`[AutoSub] Polymarket subscription started for node ${node.id}`);
          } else if (marketType === 'Kalshi') {
            // Try to get stored Kalshi credentials for authenticated subscription
            try {
              const creds = await invoke<{
                platform: string;
                has_key: boolean;
                api_key: string | null;
                private_key: string | null;
                environment: string | null;
              }>('get_api_key_cmd', { platform: 'Kalshi' });

              if (creds && creds.api_key && creds.private_key) {
                console.log(`[AutoSub] Subscribing Kalshi node ${node.id} with auth`);
                await invoke<string>('subscribe_kalshi_orderbook_auth_cmd', {
                  marketId,
                  apiKey: creds.api_key,
                  privateKeyPem: creds.private_key,
                  demo: creds.environment === 'demo',
                });
              } else {
                console.log(`[AutoSub] Subscribing Kalshi node ${node.id} (public)`);
                await invoke<string>('subscribe_orderbook_cmd', { platform: 'kalshi', marketId });
              }
            } catch {
              // No stored credentials, use public subscription
              console.log(`[AutoSub] Subscribing Kalshi node ${node.id} (public, no creds)`);
              await invoke<string>('subscribe_orderbook_cmd', { platform: 'kalshi', marketId });
            }
            console.log(`[AutoSub] Kalshi subscription started for node ${node.id}`);
          }
        } catch (e) {
          console.error(`[AutoSub] Failed to subscribe market node ${node.id}:`, e);
          // Remove from subscribed set so it can retry
          subscribedRef.current.delete(node.id);
        }
      });
    }, 2000);

    return () => clearInterval(interval);
  }, []);
}
