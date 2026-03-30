// ============================================================================
// SERIES MARKET PANEL
// ============================================================================
//
// Displays all markets within a series node. Shows market prices, statuses,
// and provides manual refresh functionality with configurable auto-refresh.
//
// FEATURES:
// - Manual refresh button
// - Configurable auto-refresh intervals
// - Auto-add new markets toggle
// - Hide/show resolved markets
// ============================================================================

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { 
  RefreshCw, 
  Layers, 
  AlertCircle, 
  CheckCircle2, 
  Loader2, 
  Eye, 
  EyeOff, 
  Settings, 
  Clock,
  Bell,
  X,
} from 'lucide-react';
import type { Node } from '../../types/nodes';
import type { 
  SeriesChildMarket, 
  EventSearchResponse, 
  EventSearchResult,
  SeriesInfo,
} from '../../types/markets';
import { useStore, type StoreState } from '../../store';

// Refresh interval options
const REFRESH_INTERVALS = [
  { label: '1 minute', value: 60 },
  { label: '5 minutes', value: 300 },
  { label: '15 minutes', value: 900 },
  { label: '30 minutes', value: 1800 },
  { label: '1 hour', value: 3600 },
  { label: 'Manual only', value: 0 },
] as const;

// ============================================================================
// TYPES
// ============================================================================

interface SeriesMarketPanelProps {
  node: Node;
  className?: string;
}

// ============================================================================
// HELPERS
// ============================================================================

function formatPrice(price: number | null | undefined): string {
  if (price == null) return '\u2014';
  return `${(price * 100).toFixed(1)}\u00A2`;
}

function formatVolume(vol: number | null | undefined): string {
  if (vol == null) return '\u2014';
  if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}M`;
  if (vol >= 1_000) return `$${(vol / 1_000).toFixed(1)}K`;
  return `$${vol.toFixed(0)}`;
}

function timeAgo(timestamp: number | null | undefined): string {
  if (!timestamp) return 'never';
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function formatNextRefresh(lastRefreshed: number, intervalSeconds: number): string {
  if (intervalSeconds === 0) return 'Manual';
  const nextRefresh = lastRefreshed + intervalSeconds * 1000;
  const remaining = Math.max(0, Math.floor((nextRefresh - Date.now()) / 1000));
  if (remaining === 0) return 'Now';
  if (remaining < 60) return `${remaining}s`;
  if (remaining < 3600) return `${Math.floor(remaining / 60)}m`;
  return `${Math.floor(remaining / 3600)}h`;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function SeriesMarketPanel({ node, className = '' }: SeriesMarketPanelProps) {
  const updateNodeMetadata = useStore((state: StoreState) => state.updateNodeMetadata);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [newMarketsDetected, setNewMarketsDetected] = useState<string[]>([]);
  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Safely extract series metadata
  const meta = (node?.metadata ?? {}) as Record<string, unknown>;
  const isSeries = meta?.is_series === true;

  const eventTitle = (meta?.series_event_title as string) || 'Series';
  const eventId = (meta?.series_event_id as string) || '';
  const eventSlug = (meta?.series_event_slug as string) || eventId;
  const imageUrl = (meta?.series_image_url as string) || null;
  const category = (meta?.series_category as string) || null;
  const platform = (meta?.series_platform as string) || 'Polymarket';
  const lastRefreshed = (meta?.series_last_refreshed as number) || 0;
  const hideResolved = (meta?.series_hide_resolved as boolean) ?? true;
  const rawMarkets = (meta?.series_markets as SeriesChildMarket[]) || [];
  
  // Auto-refresh settings
  const refreshIntervalSeconds = (meta?.series_refresh_interval as number) ?? 300; // default 5 min
  const autoAddNewMarkets = (meta?.series_auto_add_new_markets as boolean) ?? false;

  // Sort and filter markets
  const markets = useMemo(() => {
    const sorted = [...rawMarkets].sort((a, b) => {
      // Resolved markets last
      if (a.is_resolved && !b.is_resolved) return 1;
      if (!a.is_resolved && b.is_resolved) return -1;
      // Then by YES price descending
      return (b.yes_price ?? 0) - (a.yes_price ?? 0);
    });
    return sorted;
  }, [rawMarkets]);

  const visibleMarkets = useMemo(() => {
    if (hideResolved) return markets.filter((m) => !m.is_resolved);
    return markets;
  }, [markets, hideResolved]);

  const activeCount = useMemo(() => markets.filter((m) => !m.is_resolved).length, [markets]);
  const totalCount = markets.length;

  // Toggle hide resolved
  const toggleHideResolved = useCallback(() => {
    const newVal = !hideResolved;
    updateNodeMetadata(node.id, { series_hide_resolved: newVal });
    // Persist to backend (fire and forget)
    try {
      invoke('update_data_source_cmd', {
        nodeId: node.id,
        config: { ...meta, series_hide_resolved: newVal },
      }).catch((err: unknown) => console.error('Failed to persist hide_resolved:', err));
    } catch (_) { /* ignore */ }
  }, [hideResolved, node.id, meta, updateNodeMetadata]);

  // Update refresh interval
  const updateRefreshInterval = useCallback((newInterval: number) => {
    updateNodeMetadata(node.id, { series_refresh_interval: newInterval });
    try {
      invoke('update_data_source_cmd', {
        nodeId: node.id,
        config: { ...meta, series_refresh_interval: newInterval },
      }).catch((err: unknown) => console.error('Failed to persist refresh interval:', err));
    } catch (_) { /* ignore */ }
  }, [node.id, meta, updateNodeMetadata]);

  // Toggle auto-add new markets
  const toggleAutoAddNewMarkets = useCallback(() => {
    const newVal = !autoAddNewMarkets;
    updateNodeMetadata(node.id, { series_auto_add_new_markets: newVal });
    try {
      invoke('update_data_source_cmd', {
        nodeId: node.id,
        config: { ...meta, series_auto_add_new_markets: newVal },
      }).catch((err: unknown) => console.error('Failed to persist auto-add setting:', err));
    } catch (_) { /* ignore */ }
  }, [autoAddNewMarkets, node.id, meta, updateNodeMetadata]);

  // Manual refresh - uses the Series API
  const handleRefresh = useCallback(async (silent = false) => {
    if (isRefreshing) return;
    if (!silent) setIsRefreshing(true);
    setRefreshError(null);

    try {
      // Use the Series API for more accurate results
      const seriesInfo = await invoke<SeriesInfo>('get_series_cmd', {
        platform,
        seriesId: eventSlug || eventId,
      });

      if (!seriesInfo?.markets) {
        if (!silent) setRefreshError('No markets returned');
        return;
      }

      // Detect new markets
      const existingIds = new Set(rawMarkets.map(m => m.id));
      const newMarketIds = seriesInfo.markets
        .filter(m => !existingIds.has(m.id))
        .map(m => m.id);

      if (newMarketIds.length > 0) {
        setNewMarketsDetected(newMarketIds);
      }

      // Merge updated market data
      const updatedMarkets: SeriesChildMarket[] = seriesInfo.markets.map((m) => {
        const existing = rawMarkets.find((em) => em.id === m.id);
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

      const updatedMeta = {
        ...meta,
        series_markets: updatedMarkets,
        series_last_refreshed: Date.now(),
      };

      updateNodeMetadata(node.id, {
        series_markets: updatedMarkets,
        series_last_refreshed: Date.now(),
      });

      // Persist to backend
      try {
        await invoke('update_data_source_cmd', {
          nodeId: node.id,
          config: updatedMeta,
        });
      } catch (persistErr) {
        console.error('Failed to persist refreshed series data:', persistErr);
      }
    } catch (err) {
      console.error('Series refresh failed:', err);
      
      // Fallback to events search if Series API fails
      try {
        const response = await invoke<EventSearchResponse>('search_events_cmd', {
          platform,
          query: eventTitle,
          cursor: null,
        });

        const matchingEvent = response?.results?.find(
          (e: EventSearchResult) => e.id === eventId || e.slug === eventSlug
        );

        if (matchingEvent) {
          const updatedMarkets: SeriesChildMarket[] = (matchingEvent.markets || []).map((m) => {
            const existing = rawMarkets.find((em) => em.id === m.id);
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

          updateNodeMetadata(node.id, {
            series_markets: updatedMarkets,
            series_last_refreshed: Date.now(),
          });
        } else if (!silent) {
          setRefreshError('Event not found');
        }
      } catch (fallbackErr) {
        if (!silent) {
          setRefreshError(typeof err === 'string' ? err : 'Refresh failed');
        }
      }
    } finally {
      if (!silent) setIsRefreshing(false);
    }
  }, [isRefreshing, platform, eventSlug, eventId, eventTitle, rawMarkets, meta, node.id, updateNodeMetadata]);

  // Auto-refresh effect
  useEffect(() => {
    // Clear existing interval
    if (autoRefreshRef.current) {
      clearInterval(autoRefreshRef.current);
      autoRefreshRef.current = null;
    }

    // Set up new interval if enabled
    if (isSeries && refreshIntervalSeconds > 0) {
      autoRefreshRef.current = setInterval(() => {
        handleRefresh(true); // Silent refresh
      }, refreshIntervalSeconds * 1000);
    }

    return () => {
      if (autoRefreshRef.current) {
        clearInterval(autoRefreshRef.current);
      }
    };
  }, [isSeries, refreshIntervalSeconds, handleRefresh]);

  // Dismiss new markets notification
  const dismissNewMarkets = useCallback(() => {
    setNewMarketsDetected([]);
  }, []);

  if (!isSeries) {
    return null;
  }

  return (
    <div className={`space-y-3 ${className}`}>
      {/* New Markets Notification */}
      {newMarketsDetected.length > 0 && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3">
          <div className="flex items-start gap-2">
            <Bell className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs font-medium text-blue-300">
                {newMarketsDetected.length} new market{newMarketsDetected.length > 1 ? 's' : ''} detected!
              </p>
              <p className="text-[10px] text-blue-400/70 mt-0.5">
                Refresh the page to see updated markets
              </p>
            </div>
            <button
              onClick={dismissNewMarkets}
              className="text-blue-400 hover:text-blue-300 p-1"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="bg-gray-800/50 rounded-lg p-3">
        <div className="flex items-start gap-3">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt=""
              className="w-12 h-12 rounded-lg object-cover flex-shrink-0 bg-gray-700"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
            />
          ) : (
            <div className="w-12 h-12 rounded-lg bg-gray-700 flex items-center justify-center flex-shrink-0">
              <Layers className="w-6 h-6 text-blue-400" />
            </div>
          )}
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-semibold text-white leading-tight">{eventTitle}</h3>
            <div className="flex items-center gap-2 mt-1 text-xs text-gray-500">
              {category && <span className="text-blue-400">{category}</span>}
              <span>{activeCount} active / {totalCount} total</span>
            </div>
          </div>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`p-1.5 rounded hover:bg-gray-700 transition-colors ${showSettings ? 'bg-gray-700 text-blue-400' : 'text-gray-500'}`}
            title="Refresh settings"
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>

        {/* Settings Panel */}
        {showSettings && (
          <div className="mt-3 pt-3 border-t border-gray-700 space-y-3">
            {/* Refresh Interval */}
            <div>
              <label className="text-[10px] text-gray-500 uppercase tracking-wide">Auto-refresh</label>
              <select
                value={refreshIntervalSeconds}
                onChange={(e) => updateRefreshInterval(Number(e.target.value))}
                className="w-full mt-1 bg-gray-700 border border-gray-600 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-blue-500"
              >
                {REFRESH_INTERVALS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Auto-add toggle */}
            <button
              onClick={toggleAutoAddNewMarkets}
              className="flex items-center gap-2 w-full text-left"
            >
              <div className={`w-8 h-4 rounded-full transition-colors ${autoAddNewMarkets ? 'bg-blue-500' : 'bg-gray-600'}`}>
                <div className={`w-3 h-3 rounded-full bg-white shadow transform transition-transform mt-0.5 ${autoAddNewMarkets ? 'translate-x-4.5 ml-0.5' : 'translate-x-0.5'}`} />
              </div>
              <span className="text-xs text-gray-400">Auto-add new markets</span>
            </button>

            {/* Next refresh indicator */}
            {refreshIntervalSeconds > 0 && (
              <div className="flex items-center gap-1.5 text-[10px] text-gray-500">
                <Clock className="w-3 h-3" />
                Next refresh: {formatNextRefresh(lastRefreshed, refreshIntervalSeconds)}
              </div>
            )}
          </div>
        )}

        {/* Refresh row */}
        <div className="flex items-center justify-between mt-3 pt-2 border-t border-gray-700">
          <span className="text-xs text-gray-500">
            Refreshed: {timeAgo(lastRefreshed)}
          </span>
          <button
            onClick={() => handleRefresh(false)}
            disabled={isRefreshing}
            className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isRefreshing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <RefreshCw className="w-3 h-3" />
            )}
            Refresh Now
          </button>
        </div>

        {refreshError && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-red-400">
            <AlertCircle className="w-3 h-3 flex-shrink-0" />
            <span>{refreshError}</span>
          </div>
        )}
      </div>

      {/* Hide resolved toggle */}
      <button
        onClick={toggleHideResolved}
        className="flex items-center gap-2 w-full px-3 py-2 bg-gray-800/30 hover:bg-gray-800/50 rounded-lg text-xs text-gray-400 transition-colors"
      >
        {hideResolved ? (
          <EyeOff className="w-3.5 h-3.5" />
        ) : (
          <Eye className="w-3.5 h-3.5" />
        )}
        {hideResolved ? 'Resolved markets hidden' : 'Showing all markets'}
        {hideResolved && totalCount - activeCount > 0 && (
          <span className="text-gray-600 ml-auto">
            ({totalCount - activeCount} hidden)
          </span>
        )}
      </button>

      {/* Market list */}
      <div className="space-y-1">
        {visibleMarkets.length === 0 ? (
          <div className="text-center py-4 text-xs text-gray-500">
            {totalCount === 0 ? 'No markets in this series' : 'All markets resolved'}
          </div>
        ) : (
          visibleMarkets.map((market) => (
            <div
              key={market.id}
              className={`bg-gray-800/40 rounded-lg px-3 py-2 ${
                market.is_resolved ? 'opacity-50' : ''
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-xs text-gray-200 leading-snug flex-1 min-w-0">
                  {market.title || 'Unknown market'}
                </p>
                {market.is_resolved ? (
                  <span className="flex items-center gap-1 text-[10px] text-blue-400 flex-shrink-0">
                    <CheckCircle2 className="w-3 h-3" />
                    Resolved
                  </span>
                ) : (
                  <span className={`text-[10px] flex-shrink-0 px-1.5 py-0.5 rounded ${
                    market.status === 'active' || market.status === 'open'
                      ? 'bg-green-500/20 text-green-400'
                      : 'bg-gray-700 text-gray-400'
                  }`}>
                    {(market.status || 'unknown').charAt(0).toUpperCase() + (market.status || 'unknown').slice(1)}
                  </span>
                )}
              </div>
              {!market.is_resolved && (
                <div className="flex items-center gap-3 mt-1.5 text-xs">
                  {market.yes_price != null && (
                    <span className="text-emerald-400 font-mono">
                      YES {formatPrice(market.yes_price)}
                    </span>
                  )}
                  {market.no_price != null && (
                    <span className="text-red-400 font-mono">
                      NO {formatPrice(market.no_price)}
                    </span>
                  )}
                  {market.volume != null && (
                    <span className="text-gray-500 ml-auto">
                      Vol: {formatVolume(market.volume)}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
