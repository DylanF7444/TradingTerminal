// ============================================================================
// SERIES REFRESH HOOK
// ============================================================================
//
// Periodically refreshes all series nodes by re-fetching their events
// from the platform search API and merging updated market data.
// ============================================================================

import { useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore, type StoreState } from '../store';
import type { EventSearchResponse, EventSearchResult, SeriesChildMarket } from '../types/markets';

/**
 * Hook that periodically refreshes all series nodes.
 * Should be called once at the App level.
 */
export function useSeriesRefresh() {
  const nodesRef = useRef<StoreState['nodes']>({});
  const updateNodeMetadataRef = useRef<StoreState['updateNodeMetadata']>(() => {});

  // Keep refs in sync to avoid stale closures in the interval
  const nodes = useStore((s: StoreState) => s.nodes);
  const updateNodeMetadata = useStore((s: StoreState) => s.updateNodeMetadata);
  nodesRef.current = nodes;
  updateNodeMetadataRef.current = updateNodeMetadata;

  const refreshSeriesNodes = useCallback(async () => {
    const allNodes = Object.values(nodesRef.current || {});
    const seriesNodes = allNodes.filter((n) => {
      if (!n?.metadata) return false;
      const meta = n.metadata as Record<string, unknown>;
      return meta?.is_series === true;
    });

    for (const node of seriesNodes) {
      try {
        const meta = (node.metadata ?? {}) as Record<string, unknown>;
        const lastRefreshed = (meta.series_last_refreshed as number) || 0;
        const interval = ((meta.series_refresh_interval as number) || 60) * 1000;

        // Skip if not enough time has passed
        if (Date.now() - lastRefreshed < interval) continue;

        const platform = (meta.series_platform as string) || 'Polymarket';
        const searchQuery = (meta.series_event_title as string) || '';
        const eventId = (meta.series_event_id as string) || '';

        if (!searchQuery || !eventId) continue;

        const response = await invoke<EventSearchResponse>('search_events_cmd', {
          platform,
          query: searchQuery,
          cursor: null,
        });

        if (!response?.results) continue;

        // Find matching event by ID
        const matchingEvent = response.results.find(
          (e: EventSearchResult) => e.id === eventId
        );

        if (!matchingEvent) continue;

        // Merge updated market data
        const existingMarkets = ((meta.series_markets as SeriesChildMarket[]) || []);
        const updatedMarkets: SeriesChildMarket[] = (matchingEvent.markets || []).map((m) => {
          const existing = existingMarkets.find((em) => em.id === m.id);
          return {
            id: m.id || '',
            title: m.title || '',
            token_ids: m.token_ids || [],
            yes_price: m.yes_price ?? null,
            no_price: m.no_price ?? null,
            volume: m.volume ?? null,
            liquidity: m.liquidity ?? null,
            status: m.status || 'active',
            end_date: m.end_date ?? null,
            slug: m.slug || '',
            condition_id: m.condition_id ?? null,
            is_resolved: existing?.is_resolved || m.status === 'resolved' || m.status === 'closed',
          };
        });

        const now = Date.now();

        updateNodeMetadataRef.current(node.id, {
          series_markets: updatedMarkets,
          series_last_refreshed: now,
        });

        // Persist to backend (fire and forget)
        invoke('update_data_source_cmd', {
          nodeId: node.id,
          config: { ...meta, series_markets: updatedMarkets, series_last_refreshed: now },
        }).catch((err: unknown) =>
          console.error(`Failed to persist series refresh for ${node.id}:`, err)
        );
      } catch (err) {
        console.error(`Failed to refresh series node ${node.id}:`, err);
      }
    }
  }, []);

  useEffect(() => {
    // Run an initial refresh shortly after mount
    const initialTimeout = setTimeout(refreshSeriesNodes, 5000);

    // Then run on interval
    const intervalId = setInterval(refreshSeriesNodes, 30000);

    return () => {
      clearTimeout(initialTimeout);
      clearInterval(intervalId);
    };
  }, [refreshSeriesNodes]);
}
