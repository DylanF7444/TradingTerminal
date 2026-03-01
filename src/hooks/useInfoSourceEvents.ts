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

import { useEffect } from 'react';
import { useStore, type StoreState } from '../store';

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
              avgLatency: 0,
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
