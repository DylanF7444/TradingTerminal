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
            console.log('[DEBUG] No market node found for market_id:', update.market_id);
            return;
          }

          console.log('[DEBUG] Found market node:', marketNode.id, 'for market:', update.market_id, 'price:', update.last_price);
          
          const currentMetadata = (marketNode.metadata as Record<string, any>) || {};
          
          const bestBid = update.bids?.length
            ? Math.max(...update.bids.map((b: { price: number }) => b.price))
            : undefined;
          const bestAsk = update.asks?.length
            ? Math.min(...update.asks.map((a: { price: number }) => a.price))
            : undefined;
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
          console.log('[DEBUG] Updated market node', marketNode.id, 'with price:', lastPrice);
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
  // Track subscription keys per node so we can unsubscribe on removal
  const subscriptionKeysRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    // Check for new/removed market nodes every 2 seconds
    const interval = setInterval(() => {
      const { nodes } = useStore.getState();

      // Detect removed nodes and unsubscribe their legacy WebSocket connections
      const currentMarketNodeIds = new Set<string>();
      Object.values(nodes).forEach((node) => {
        if (node?.node_type && 'Market' in node.node_type) {
          currentMarketNodeIds.add(node.id);
        }
      });

      for (const nodeId of subscribedRef.current) {
        if (!currentMarketNodeIds.has(nodeId)) {
          const subscriptionKey = subscriptionKeysRef.current.get(nodeId);
          if (subscriptionKey) {
            console.log(`[AutoSub] Node ${nodeId} removed, unsubscribing legacy key: ${subscriptionKey}`);
            invoke<string>('unsubscribe_orderbook_cmd', { marketId: subscriptionKey }).catch((e) => {
              console.error(`[AutoSub] Failed to unsubscribe removed node ${nodeId}:`, e);
            });
            subscriptionKeysRef.current.delete(nodeId);
          }
          subscribedRef.current.delete(nodeId);
        }
      }

      // Subscribe new market nodes
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
            // Track the subscription key so we can unsubscribe later
            subscriptionKeysRef.current.set(node.id, assetIds.join(','));
            console.log(`[AutoSub] Subscribing Polymarket node ${node.id} with asset IDs:`, assetIds);
            await invoke<string>('subscribe_polymarket_market_cmd', { assetIds });
            console.log(`[AutoSub] Polymarket subscription started for node ${node.id}`);
          } else if (marketType === 'Kalshi') {
            // Track the subscription key
            subscriptionKeysRef.current.set(node.id, marketId);
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
          subscriptionKeysRef.current.delete(node.id);
        }
      });
    }, 2000);

    return () => clearInterval(interval);
  }, []);
}

// ============================================================================
// DATA SOURCE UPDATE LISTENER (HTTP-POLLED SCRAPERS)
// ============================================================================

/**
 * Hook that subscribes to the 'data-source:update' Tauri event emitted by
 * HTTP-polled scrapers (news, weather, etc.).
 *
 * For NewsSource events, this hook:
 * 1. Aggregates headlines from all feed DataPoints
 * 2. Appends to the raw data stream for display in the node panel
 * 3. Updates node metadata with headline data and quality metrics
 * 4. Propagates data to connected Market nodes
 *
 * Should be called exactly once, in the root App component.
 */
export function useDataSourceEvents(): void {
  const appendRawDataEntry = useStore((state: StoreState) => state.appendRawDataEntry);
  const updateNodeMetadata = useStore((state: StoreState) => state.updateNodeMetadata);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        unlisten = await listen('data-source:update', (event) => {
          const payload = event.payload as {
            nodeId: string;
            sourceType: string;
            data: {
              points: Array<{
                metric_type: string;
                value: number;
                metadata?: Record<string, unknown>;
              }>;
              metadata: Record<string, unknown>;
            };
            timestamp: number;
          };

          if (payload.sourceType === 'NewsSource') {
            // Aggregate all headlines from all source DataPoints
            const allHeadlines: Array<Record<string, unknown>> = [];
            const sourceNames: string[] = [];
            for (const point of payload.data.points) {
              const meta = point.metadata as Record<string, unknown> | undefined;
              const headlines = (meta?.headlines as Array<Record<string, unknown>>) || [];
              allHeadlines.push(...headlines);
              if (meta?.source_name) sourceNames.push(meta.source_name as string);
            }

            // 1. Append to raw stream
            appendRawDataEntry(payload.nodeId, {
              data: {
                type: 'news_update',
                totalArticles: allHeadlines.length,
                sources: sourceNames,
                headlines: allHeadlines.slice(0, 10),
              },
              source: 'rss_scraper',
              status: 'success',
            });

            // 2. Update node metadata
            const { nodes, connections } = useStore.getState();
            const node = nodes[payload.nodeId];
            if (!node) return;

            const currentMetadata = (node.metadata as Record<string, any>) || {};
            updateNodeMetadata(payload.nodeId, {
              ...currentMetadata,
              lastData: {
                timestamp: payload.timestamp,
                value: allHeadlines.length,
                headlines: allHeadlines,
                sources: sourceNames,
              },
              quality: {
                ...(currentMetadata.quality || {}),
                successRate: 1.0,
                lastError: undefined,
              },
            });

            // 3. Propagate to connected Market nodes
            const outgoing = connections.filter((c) => c.source === payload.nodeId);
            for (const conn of outgoing) {
              const target = nodes[conn.target];
              if (!target?.node_type || !('Market' in target.node_type)) continue;

              const targetMeta = (target.metadata as Record<string, any>) || {};
              const incomingData = { ...(targetMeta.incomingData || {}) };
              incomingData[payload.nodeId] = {
                sourceName: 'News Feed',
                sourceType: 'NewsSource',
                headlines: allHeadlines.slice(0, 5),
                articleCount: allHeadlines.length,
                sources: sourceNames,
                timestamp: payload.timestamp,
                strength: conn.strength || 1.0,
              };

              updateNodeMetadata(conn.target, {
                ...targetMeta,
                incomingData,
                lastData: {
                  timestamp: payload.timestamp,
                  value: allHeadlines.length,
                  sourceId: payload.nodeId,
                },
              });
            }

            console.log(`[DataSource] News update for ${payload.nodeId}: ${allHeadlines.length} headlines from ${sourceNames.join(', ')}`);
          } else if (payload.sourceType === 'SocialMedia') {
            // Aggregate posts from all platform DataPoints (Reddit, Twitter, HN)
            const allPosts: Array<Record<string, unknown>> = [];
            const platformNames: string[] = [];
            const metrics: Record<string, number> = {};

            for (const point of payload.data.points) {
              const meta = point.metadata as Record<string, unknown> | undefined;
              const platform = (meta?.platform as string) || 'unknown';

              // Collect posts from metadata (different platforms use different field names)
              const posts = (meta?.top_posts as Array<Record<string, unknown>>)
                || (meta?.tweets as Array<Record<string, unknown>>)
                || (meta?.posts as Array<Record<string, unknown>>)
                || [];
              allPosts.push(...posts);

              if (!platformNames.includes(platform)) platformNames.push(platform);

              // Track metrics by key (e.g., "reddit:r/bitcoin:post_count")
              metrics[point.metric_type] = point.value;
            }

            // 1. Append to raw stream
            appendRawDataEntry(payload.nodeId, {
              data: {
                type: 'social_update',
                totalPosts: allPosts.length,
                platforms: platformNames,
                posts: allPosts.slice(0, 10),
                metrics,
              },
              source: 'social_scraper',
              status: 'success',
            });

            // 2. Update node metadata
            const { nodes, connections } = useStore.getState();
            const node = nodes[payload.nodeId];
            if (!node) return;

            const currentMetadata = (node.metadata as Record<string, any>) || {};
            updateNodeMetadata(payload.nodeId, {
              ...currentMetadata,
              lastData: {
                timestamp: payload.timestamp,
                value: allPosts.length,
                posts: allPosts,
                platforms: platformNames,
                metrics,
              },
              quality: {
                ...(currentMetadata.quality || {}),
                successRate: 1.0,
                lastError: undefined,
              },
            });

            // 3. Propagate to connected Market nodes
            const outgoing = connections.filter((c) => c.source === payload.nodeId);
            for (const conn of outgoing) {
              const target = nodes[conn.target];
              if (!target?.node_type || !('Market' in target.node_type)) continue;

              const targetMeta = (target.metadata as Record<string, any>) || {};
              const incomingData = { ...(targetMeta.incomingData || {}) };
              incomingData[payload.nodeId] = {
                sourceName: 'Social Media',
                sourceType: 'SocialMedia',
                posts: allPosts.slice(0, 5),
                postCount: allPosts.length,
                platforms: platformNames,
                metrics,
                timestamp: payload.timestamp,
                strength: conn.strength || 1.0,
              };

              updateNodeMetadata(conn.target, {
                ...targetMeta,
                incomingData,
                lastData: {
                  timestamp: payload.timestamp,
                  value: allPosts.length,
                  sourceId: payload.nodeId,
                },
              });
            }

            console.log(
              `[DataSource] Social update for ${payload.nodeId}: ${allPosts.length} posts from ${platformNames.join(', ')}`
            );
          } else if (payload.sourceType === 'Weather') {
            // Parse weather DataPoints into current conditions
            const conditions: Record<string, { value: number; unit: string; extra?: Record<string, unknown> }> = {};
            for (const point of payload.data.points) {
              const meta = point.metadata as Record<string, unknown> | undefined;
              conditions[point.metric_type] = {
                value: point.value,
                unit: (meta?.unit as string) || '',
                extra: meta,
              };
            }

            const weatherMeta = payload.data.metadata as Record<string, unknown>;
            const locationName = (weatherMeta?.location as string) || 'Unknown';
            const weatherDesc = (weatherMeta?.weather_description as string) || '';
            const weatherCode = (weatherMeta?.weather_code as number) ?? 0;
            const forecast = weatherMeta?.daily_forecast;

            // 1. Append to raw stream
            appendRawDataEntry(payload.nodeId, {
              data: {
                type: 'weather_update',
                location: locationName,
                country: weatherMeta?.country,
                description: weatherDesc,
                weather_code: weatherCode,
                conditions,
                forecast,
              },
              source: 'open_meteo',
              status: 'success',
            });

            // 2. Update node metadata
            const { nodes, connections } = useStore.getState();
            const node = nodes[payload.nodeId];
            if (!node) return;

            const currentMetadata = (node.metadata as Record<string, any>) || {};
            updateNodeMetadata(payload.nodeId, {
              ...currentMetadata,
              lastData: {
                timestamp: payload.timestamp,
                location: locationName,
                country: weatherMeta?.country,
                latitude: weatherMeta?.latitude,
                longitude: weatherMeta?.longitude,
                timezone: weatherMeta?.timezone,
                weatherDescription: weatherDesc,
                weatherCode,
                conditions,
                forecast,
                temperatureUnit: weatherMeta?.temperature_unit,
                windSpeedUnit: weatherMeta?.wind_speed_unit,
              },
              quality: {
                ...(currentMetadata.quality || {}),
                successRate: 1.0,
                lastError: undefined,
              },
            });

            // 3. Propagate to connected Market nodes
            const outgoing = connections.filter((c) => c.source === payload.nodeId);
            for (const conn of outgoing) {
              const target = nodes[conn.target];
              if (!target?.node_type || !('Market' in target.node_type)) continue;

              const targetMeta = (target.metadata as Record<string, any>) || {};
              const incomingData = { ...(targetMeta.incomingData || {}) };
              incomingData[payload.nodeId] = {
                sourceName: `Weather - ${locationName}`,
                sourceType: 'Weather',
                conditions,
                weatherDescription: weatherDesc,
                location: locationName,
                timestamp: payload.timestamp,
                strength: conn.strength || 1.0,
              };

              updateNodeMetadata(conn.target, {
                ...targetMeta,
                incomingData,
                lastData: {
                  timestamp: payload.timestamp,
                  value: conditions.temperature?.value ?? 0,
                  sourceId: payload.nodeId,
                },
              });
            }

            console.log(
              `[DataSource] Weather update for ${payload.nodeId}: ${weatherDesc} at ${locationName}`
            );
          }
        });

        console.log('[Global] data-source:update listener registered');
      } catch (error) {
        console.warn('[Global] Failed to setup data-source:update listener:', error);
      }
    };

    setup();
    return () => {
      unlisten?.();
    };
  }, [appendRawDataEntry, updateNodeMetadata]);
}
