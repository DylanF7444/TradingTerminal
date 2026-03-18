// ============================================================================
// SeriesSearchPanel.tsx - Sidebar panel for searching and adding series
// ============================================================================
//
// A self-contained sidebar component for searching events on Polymarket or
// Kalshi and adding them as market groups with expanded individual nodes.
//
// When a series is selected:
// 1. Individual market nodes are created for each child market
// 2. A NodeGroup is created with origin.type = 'series' to track the event
// 3. Nodes are positioned in a grid layout near viewport center
// 4. The group auto-refreshes to detect new/closed markets
// ============================================================================

import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Search,
  Loader2,
  TrendingUp,
  Wallet,
  Layers,
  AlertCircle,
  X,
  ChevronDown,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { MarketType, type Node } from '../../types/nodes';
import type { EventSearchResult, EventSearchResponse } from '../../types/markets';
import { useStore, type StoreState } from '../../store';
import { createNodeGroup } from '../../store/groupsSlice';

interface SeriesSearchPanelProps {
  platform: MarketType;
  className?: string;
}

const PLATFORM_CONFIG = {
  [MarketType.Polymarket]: {
    name: 'Polymarket',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500',
    icon: Wallet,
    seriesColor: '#8b5cf6',
  },
  [MarketType.Kalshi]: {
    name: 'Kalshi',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500',
    icon: TrendingUp,
    seriesColor: '#10b981',
  },
};

export default function SeriesSearchPanel({
  platform,
  className = '',
}: SeriesSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<EventSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isAddingSeries, setIsAddingSeries] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);

  const config = PLATFORM_CONFIG[platform];
  const platformName = config.name;
  const Icon = config.icon;

  // Store actions
  const addNode = useStore((s: StoreState) => s.addNode);
  const addGroup = useStore((s: StoreState) => s.addGroup);
  const viewport = useStore((s: StoreState) => s.viewport);

  // Search function
  const fetchResults = useCallback(
    async (searchQuery: string, cursor: string | null, append: boolean) => {
      if (!searchQuery.trim()) {
        setResults([]);
        setHasSearched(false);
        setHasMore(false);
        setNextCursor(null);
        setError(null);
        return;
      }

      if (append) {
        setIsLoadingMore(true);
      } else {
        setIsSearching(true);
      }
      setError(null);
      setHasSearched(true);

      try {
        const response = await invoke<EventSearchResponse>('search_events_cmd', {
          platform: platformName,
          query: searchQuery.trim(),
          cursor,
        });

        if (append) {
          setResults((prev) => [...prev, ...response.results]);
        } else {
          setResults(response.results);
        }

        setHasMore(response.has_more);
        setNextCursor(response.next_cursor);
      } catch (err) {
        console.error('Event search failed:', err);
        setError(typeof err === 'string' ? err : 'Search failed. Please try again.');
        if (!append) {
          setResults([]);
        }
      } finally {
        setIsSearching(false);
        setIsLoadingMore(false);
      }
    },
    [platformName]
  );

  const performSearch = useCallback(
    (searchQuery: string) => {
      setNextCursor(null);
      setHasMore(false);
      fetchResults(searchQuery, null, false);
    },
    [fetchResults]
  );

  const loadMore = useCallback(() => {
    if (isLoadingMore || !hasMore) return;
    fetchResults(query, nextCursor, true);
  }, [query, nextCursor, isLoadingMore, hasMore, fetchResults]);

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        performSearch(value);
      }, 350);
    },
    [performSearch]
  );

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // Add series as a group with expanded nodes
  const handleAddSeries = useCallback(
    async (event: EventSearchResult) => {
      if (isAddingSeries) return;
      setIsAddingSeries(event.id);

      try {
        const markets = event.markets || [];
        if (markets.length === 0) {
          setError('No markets found in this event');
          setIsAddingSeries(null);
          return;
        }

        const credPayload = { environment: 'demo' };
        const createdNodeIds: string[] = [];

        // Grid layout for new nodes
        const GRID_COLS = 3;
        const SPACING_X = 220;
        const SPACING_Y = 160;
        const baseX = -viewport.x / viewport.zoom + 300;
        const baseY = -viewport.y / viewport.zoom + 200;

        // Create individual market nodes
        for (let i = 0; i < markets.length; i++) {
          const market = markets[i];
          const col = i % GRID_COLS;
          const row = Math.floor(i / GRID_COLS);
          const posX = baseX + col * SPACING_X;
          const posY = baseY + row * SPACING_Y;

          try {
            const result = await invoke<{ node: Node }>('add_market_cmd', {
              marketType: platform,
              apiCredentials: credPayload,
              marketConfig: {
                market_id: market.id,
                question: market.title,
                token_ids: market.token_ids || [],
                event_group_id: event.id,
                event_title: event.title,
              },
              marketDetails: {
                title: market.title,
                description: market.description || undefined,
                image_url: event.image_url || undefined,
                category: event.category || undefined,
                end_date: market.end_date || undefined,
                status: market.status || undefined,
                slug: market.slug || undefined,
              },
            });

            if (result?.node) {
              const node = {
                ...result.node,
                position: [posX, posY] as [number, number],
              };
              addNode(node);
              createdNodeIds.push(node.id);
            }
          } catch (err) {
            console.error(`Failed to add market ${market.id}:`, err);
          }
        }

        // Create the group
        if (createdNodeIds.length > 0) {
          const group = createNodeGroup(
            event.title || 'Series',
            createdNodeIds,
            {
              type: 'series',
              platform: platformName,
              seriesEventId: event.id,
              seriesEventSlug: event.slug,
              seriesEventTitle: event.title,
              seriesImageUrl: event.image_url,
              seriesCategory: event.category,
              seriesRefreshInterval: 60,
              seriesLastRefreshed: Date.now(),
            },
            config.seriesColor
          );
          addGroup(group);
        }

        // Clear search
        setQuery('');
        setResults([]);
        setHasSearched(false);
      } catch (err) {
        console.error('Failed to add series:', err);
        setError('Failed to add series. Please try again.');
      } finally {
        setIsAddingSeries(null);
      }
    },
    [isAddingSeries, platform, platformName, viewport, addNode, addGroup, config.seriesColor]
  );

  const formatPrice = (price: number | null): string => {
    if (price === null || price === undefined) return '\u2014';
    return `${(price * 100).toFixed(1)}\u00A2`;
  };

  return (
    <div className={`bg-gray-900 rounded-lg border border-gray-800 overflow-hidden ${className}`}>
      {/* Header */}
      <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full px-4 py-3 border-b border-gray-800 flex items-center justify-between hover:bg-gray-800/50 transition-colors"
      >
        <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
          <Icon className={`w-4 h-4 ${config.color}`} />
          {platformName} Series
        </h3>
        <ChevronDown
          className={`w-4 h-4 text-gray-500 transition-transform ${
            isCollapsed ? '-rotate-90' : ''
          }`}
        />
      </button>

      {!isCollapsed && (
        <div className="p-3 space-y-3">
          {/* Search Input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              placeholder={`Search ${platformName} events...`}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-9 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors text-sm"
            />
            {query && !isSearching && (
              <button
                onClick={() => {
                  setQuery('');
                  setResults([]);
                  setHasSearched(false);
                  setError(null);
                }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            {isSearching && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-blue-400 animate-spin" />
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-2 rounded bg-red-500/10 border border-red-500/20">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
              <span className="text-xs text-red-400">{error}</span>
            </div>
          )}

          {/* Results */}
          <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-800 bg-gray-950/50">
            {results.length > 0 ? (
              <div className="divide-y divide-gray-800">
                {results.map((event) => {
                  const isAdding = isAddingSeries === event.id;
                  const firstMarket = event.markets?.[0];

                  return (
                    <button
                      key={`${event.platform}-${event.id}`}
                      onClick={() => handleAddSeries(event)}
                      disabled={!!isAddingSeries}
                      className={`w-full text-left px-3 py-2.5 hover:bg-gray-800/70 transition-colors ${
                        isAdding ? 'bg-blue-500/10' : ''
                      } disabled:opacity-50`}
                    >
                      <div className="flex items-start gap-2">
                        {event.image_url ? (
                          <img
                            src={event.image_url}
                            alt=""
                            className="w-8 h-8 rounded object-cover flex-shrink-0 bg-gray-800"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <div className="w-8 h-8 rounded bg-gray-800 flex items-center justify-center flex-shrink-0">
                            <TrendingUp className="w-4 h-4 text-gray-600" />
                          </div>
                        )}

                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium text-gray-200 truncate">
                            {event.title}
                          </p>
                          <div className="flex items-center gap-2 mt-1 text-[10px]">
                            <span className="flex items-center gap-1 text-blue-400">
                              <Layers className="w-3 h-3" />
                              {event.market_count}
                            </span>
                            {event.category && (
                              <span className="text-gray-500 truncate">
                                {event.category}
                              </span>
                            )}
                            {firstMarket?.yes_price != null && (
                              <span className="text-emerald-400">
                                {formatPrice(firstMarket.yes_price)}
                              </span>
                            )}
                          </div>
                        </div>

                        {isAdding && (
                          <Loader2 className="w-4 h-4 text-blue-400 animate-spin flex-shrink-0" />
                        )}
                      </div>
                    </button>
                  );
                })}

                {hasMore && (
                  <button
                    onClick={loadMore}
                    disabled={isLoadingMore}
                    className="w-full px-3 py-2 text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors flex items-center justify-center gap-1"
                  >
                    {isLoadingMore ? (
                      <>
                        <Loader2 className="w-3 h-3 animate-spin" />
                        Loading...
                      </>
                    ) : (
                      <>
                        <ChevronDown className="w-3 h-3" />
                        Load more
                      </>
                    )}
                  </button>
                )}
              </div>
            ) : hasSearched && !isSearching ? (
              <div className="px-3 py-6 text-center text-gray-500 text-xs">
                <Search className="w-5 h-5 mx-auto mb-1.5 opacity-50" />
                No events found
              </div>
            ) : !hasSearched ? (
              <div className="px-3 py-6 text-center text-gray-500 text-xs">
                <Layers className="w-5 h-5 mx-auto mb-1.5 opacity-50" />
                Search to find series
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
