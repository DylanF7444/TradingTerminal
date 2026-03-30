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
//
// FEATURES:
// - Text search for events/series
// - URL paste support (kalshi.com/markets/... or polymarket.com/event/...)
// - Configurable auto-refresh settings
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
  Link,
  ExternalLink,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { MarketType, type Node } from '../../types/nodes';
import type { 
  SeriesSearchResult, 
  SeriesSearchResponse, 
  SeriesInfo, 
  ParsedMarketUrl,
} from '../../types/markets';
import { useStore, type StoreState } from '../../store';
import { createNodeGroup } from '../../store/groupsSlice';
import { transformNodeFromBackend } from '../../utils/nodeTransform';

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
    urlPattern: 'polymarket.com',
  },
  [MarketType.Kalshi]: {
    name: 'Kalshi',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500',
    icon: TrendingUp,
    seriesColor: '#10b981',
    urlPattern: 'kalshi.com',
  },
};

// Detect if input looks like a URL
function isLikelyUrl(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.includes('kalshi.com') ||
    trimmed.includes('polymarket.com')
  );
}

export default function SeriesSearchPanel({
  platform,
  className = '',
}: SeriesSearchPanelProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SeriesSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isAddingSeries, setIsAddingSeries] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isCollapsed, setIsCollapsed] = useState(false);
  
  // URL input state
  const [urlInput, setUrlInput] = useState('');
  const [urlPreview, setUrlPreview] = useState<SeriesInfo | null>(null);
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

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
        const response = await invoke<SeriesSearchResponse>('search_series_cmd', {
          platform: platformName,
          query: searchQuery.trim(),
          cursor,
        });

        console.debug(`[${platformName}] Search results for "${searchQuery.trim()}":`, response.results);
        for (const event of response.results) {
          console.debug(`[${platformName}] Event: ${event.title}`, { markets: event.markets });
        }

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
    async (series: SeriesSearchResult) => {
      if (isAddingSeries) return;
      setIsAddingSeries(series.id);

      try {
        const markets = series.markets || [];
        if (markets.length === 0) {
          setError('No markets found in this series');
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
                event_group_id: series.id,
                event_title: series.title,
              },
              marketDetails: {
                title: market.title,
                description: market.description || undefined,
                image_url: series.image_url || undefined,
                category: series.category || undefined,
                end_date: market.end_date || undefined,
                status: market.status || undefined,
                slug: market.slug || undefined,
              },
            });

            if (result?.node) {
              // Transform node from backend format to frontend format
              const transformedNode = transformNodeFromBackend(result.node as unknown as Record<string, unknown>);
              const node = {
                ...transformedNode,
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
            series.title || 'Series',
            createdNodeIds,
            {
              type: 'series',
              platform: platformName,
              seriesEventId: series.id,
              seriesEventSlug: series.slug,
              seriesEventTitle: series.title,
              seriesImageUrl: series.image_url,
              seriesCategory: series.category,
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

  // Handle URL input - fetch series from URL
  const handleUrlSubmit = useCallback(async () => {
    if (!urlInput.trim() || isLoadingUrl) return;
    
    setIsLoadingUrl(true);
    setUrlError(null);
    setUrlPreview(null);

    try {
      // First parse the URL to validate it
      const parsed = await invoke<ParsedMarketUrl>('parse_market_url_cmd', {
        url: urlInput.trim(),
      });

      // Check if URL matches this platform
      if (parsed.platform !== platformName) {
        setUrlError(`This is a ${parsed.platform} URL. Use the ${parsed.platform} panel instead.`);
        setIsLoadingUrl(false);
        return;
      }

      // Fetch the series/event data
      const seriesInfo = await invoke<SeriesInfo>('fetch_from_url_cmd', {
        url: urlInput.trim(),
      });

      setUrlPreview(seriesInfo);
    } catch (err) {
      console.error('Failed to parse/fetch URL:', err);
      setUrlError(typeof err === 'string' ? err : 'Failed to load from URL. Check the URL format.');
    } finally {
      setIsLoadingUrl(false);
    }
  }, [urlInput, isLoadingUrl, platformName]);

  // Add series from URL preview
  const handleAddFromUrl = useCallback(async () => {
    if (!urlPreview || isAddingSeries) return;

    // Convert SeriesInfo to SeriesSearchResult format for reuse
    const seriesResult: SeriesSearchResult = {
      id: urlPreview.id,
      title: urlPreview.title,
      description: urlPreview.description || '',
      image_url: urlPreview.image_url ?? null,
      category: urlPreview.category ?? null,
      platform: urlPreview.platform,
      slug: urlPreview.slug,
      markets: urlPreview.markets,
      market_count: urlPreview.market_count,
      created_at: null,
    };

    await handleAddSeries(seriesResult);

    // Clear URL input
    setUrlInput('');
    setUrlPreview(null);
    setUrlError(null);
  }, [urlPreview, isAddingSeries, handleAddSeries]);

  // Handle paste event for URL detection
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>) => {
    const pastedText = e.clipboardData.getData('text');
    if (isLikelyUrl(pastedText)) {
      e.preventDefault();
      setUrlInput(pastedText);
      // Auto-submit after a short delay
      setTimeout(() => {
        invoke<SeriesInfo>('fetch_from_url_cmd', { url: pastedText.trim() })
          .then((seriesInfo) => {
            if (seriesInfo.platform === platformName) {
              setUrlPreview(seriesInfo);
            } else {
              setUrlError(`This is a ${seriesInfo.platform} URL.`);
            }
          })
          .catch((err) => {
            setUrlError(typeof err === 'string' ? err : 'Failed to load from URL.');
          });
      }, 100);
    }
  }, [platformName]);

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
          {/* URL Input Section */}
          <div className="space-y-2">
            <div className="relative">
              <Link className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onPaste={handlePaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleUrlSubmit();
                }}
                placeholder={`Paste ${platformName} URL...`}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-9 pr-20 py-2 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors text-sm"
              />
              {urlInput && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  {isLoadingUrl ? (
                    <Loader2 className="w-4 h-4 text-blue-400 animate-spin" />
                  ) : (
                    <>
                      <button
                        onClick={handleUrlSubmit}
                        className="text-blue-400 hover:text-blue-300 p-1"
                        title="Load from URL"
                      >
                        <ExternalLink className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          setUrlInput('');
                          setUrlPreview(null);
                          setUrlError(null);
                        }}
                        className="text-gray-500 hover:text-gray-300 p-1"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* URL Error */}
            {urlError && (
              <div className="flex items-center gap-2 p-2 rounded bg-red-500/10 border border-red-500/20">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <span className="text-xs text-red-400">{urlError}</span>
              </div>
            )}

            {/* URL Preview */}
            {urlPreview && (
              <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20">
                <div className="flex items-start gap-2">
                  {urlPreview.image_url ? (
                    <img
                      src={urlPreview.image_url}
                      alt=""
                      className="w-10 h-10 rounded object-cover flex-shrink-0 bg-gray-800"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <div className="w-10 h-10 rounded bg-gray-800 flex items-center justify-center flex-shrink-0">
                      <Layers className="w-5 h-5 text-blue-400" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-200 truncate">{urlPreview.title}</p>
                    <div className="flex items-center gap-2 mt-1 text-[10px]">
                      <span className="flex items-center gap-1 text-blue-400">
                        <Layers className="w-3 h-3" />
                        {urlPreview.market_count} markets
                      </span>
                      {urlPreview.category && (
                        <span className="text-gray-500">{urlPreview.category}</span>
                      )}
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleAddFromUrl}
                  disabled={!!isAddingSeries}
                  className="w-full mt-2 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 text-white text-xs font-medium rounded-lg transition-colors flex items-center justify-center gap-1"
                >
                  {isAddingSeries === urlPreview.id ? (
                    <>
                      <Loader2 className="w-3 h-3 animate-spin" />
                      Adding...
                    </>
                  ) : (
                    <>
                      <Layers className="w-3 h-3" />
                      Add Series
                    </>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Divider */}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-px bg-gray-800" />
            <span className="text-[10px] text-gray-600 uppercase">or search</span>
            <div className="flex-1 h-px bg-gray-800" />
          </div>

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
