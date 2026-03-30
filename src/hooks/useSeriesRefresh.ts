// ============================================================================
// SERIES GROUP REFRESH HOOK
// ============================================================================
//
// Periodically refreshes all series groups by re-fetching their events
// from the platform search API and updating member node metadata.
// Detects new markets and creates nodes for them, updates prices for
// existing markets, and marks resolved markets.
// ============================================================================

import { useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore, type StoreState } from '../store';
import type { SeriesSearchResponse, SeriesSearchResult } from '../types/markets';
import type { Node, NodeGroup } from '../types/nodes';
import { transformNodeFromBackend } from '../utils/nodeTransform';

/**
 * Hook that periodically refreshes all series groups.
 * Should be called once at the App level.
 */
export function useSeriesRefresh() {
  const groupsRef = useRef<StoreState['groups']>({});
  const nodesRef = useRef<StoreState['nodes']>({});

  const groups = useStore((s: StoreState) => s.groups);
  const nodes = useStore((s: StoreState) => s.nodes);
  const updateGroup = useStore((s: StoreState) => s.updateGroup);
  const addNodesToGroup = useStore((s: StoreState) => s.addNodesToGroup);
  const addNode = useStore((s: StoreState) => s.addNode);
  const updateNodeMetadata = useStore((s: StoreState) => s.updateNodeMetadata);

  // Keep refs in sync to avoid stale closures
  groupsRef.current = groups;
  nodesRef.current = nodes;

  const refreshSeriesGroups = useCallback(async () => {
    const allGroups = Object.values(groupsRef.current || {});
    const seriesGroups = allGroups.filter(
      (g: NodeGroup) => g.origin.type === 'series'
    );

    for (const group of seriesGroups) {
      try {
        const origin = group.origin;
        const lastRefreshed = origin.seriesLastRefreshed || 0;
        const interval = (origin.seriesRefreshInterval || 60) * 1000;

        if (Date.now() - lastRefreshed < interval) continue;

        const platform = origin.platform || 'Polymarket';
        const searchQuery = origin.seriesEventTitle || '';
        const eventId = origin.seriesEventId || '';

        if (!searchQuery || !eventId) continue;

        const response = await invoke<SeriesSearchResponse>('search_series_cmd', {
          platform,
          query: searchQuery,
          cursor: null,
        });

        if (!response?.results) continue;

        const matchingEvent = response.results.find(
          (e: SeriesSearchResult) => e.id === eventId
        );

        if (!matchingEvent) continue;

        // Get current member nodes
        const currentNodes = group.memberIds
          .map((id) => nodesRef.current[id])
          .filter(Boolean) as Node[];

        const currentMarketIds = new Set(
          currentNodes.map((n) => {
            const meta = n.metadata as Record<string, unknown>;
            return (meta?.market_id as string) || (meta?.marketId as string) || '';
          }).filter(Boolean)
        );

        // Detect new markets not yet in the group
        const newMarkets = (matchingEvent.markets || []).filter(
          (m) => !currentMarketIds.has(m.id)
        );

        // Create nodes for new markets
        if (newMarkets.length > 0) {
          const credPayload = { environment: 'demo' };
          const newNodeIds: string[] = [];

          // Position new nodes near existing group members
          const existingPositions = currentNodes
            .filter((n) => n.position)
            .map((n) => n.position);
          const baseX = existingPositions.length > 0
            ? Math.max(...existingPositions.map((p) => p[0])) + 220
            : 300;
          const baseY = existingPositions.length > 0
            ? Math.min(...existingPositions.map((p) => p[1]))
            : 300;

          for (let i = 0; i < newMarkets.length; i++) {
            const market = newMarkets[i];
            try {
              const result = await invoke<{ node: Node }>('add_market_cmd', {
                marketType: platform === 'Polymarket' ? 'Polymarket' : 'Kalshi',
                apiCredentials: credPayload,
                marketConfig: {
                  market_id: market.id,
                  question: market.title,
                  token_ids: market.token_ids || [],
                  event_group_id: eventId,
                  event_title: origin.seriesEventTitle || '',
                },
                marketDetails: {
                  title: market.title,
                  description: market.description || undefined,
                  image_url: origin.seriesImageUrl || undefined,
                  category: origin.seriesCategory || undefined,
                  status: market.status || undefined,
                },
              });

              if (result?.node) {
                // Transform node from backend format to frontend format
                const transformedNode = transformNodeFromBackend(result.node as unknown as Record<string, unknown>);
                const node = {
                  ...transformedNode,
                  position: [baseX, baseY + i * 160] as [number, number],
                };
                addNode(node);
                newNodeIds.push(node.id);
              }
            } catch (err) {
              console.error(`Failed to add new market ${market.id}:`, err);
            }
          }

          if (newNodeIds.length > 0) {
            addNodesToGroup(group.id, newNodeIds);
          }
        }

        // Update existing member nodes with latest prices/status
        for (const node of currentNodes) {
          const meta = node.metadata as Record<string, unknown>;
          const marketId = (meta?.market_id as string) || (meta?.marketId as string) || '';
          const apiMarket = (matchingEvent.markets || []).find((m) => m.id === marketId);
          if (!apiMarket) continue;

          const updates: Record<string, unknown> = {};
          if (apiMarket.status === 'resolved' || apiMarket.status === 'closed') {
            updates.status = apiMarket.status;
          }
          if (apiMarket.yes_price != null) {
            updates.marketState = {
              ...((meta?.marketState as Record<string, unknown>) || {}),
              lastPrice: apiMarket.yes_price,
              status: apiMarket.status || 'active',
            };
          }

          if (Object.keys(updates).length > 0) {
            updateNodeMetadata(node.id, updates);
          }
        }

        // Update group's last refreshed timestamp
        updateGroup(group.id, {
          origin: {
            ...origin,
            seriesLastRefreshed: Date.now(),
          },
        });
      } catch (err) {
        console.error(`Failed to refresh series group ${group.id}:`, err);
      }
    }
  }, [updateGroup, addNodesToGroup, addNode, updateNodeMetadata]);

  useEffect(() => {
    const initialTimeout = setTimeout(refreshSeriesGroups, 5000);
    const intervalId = setInterval(refreshSeriesGroups, 30000);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(intervalId);
    };
  }, [refreshSeriesGroups]);
}
