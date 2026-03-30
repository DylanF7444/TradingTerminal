// ============================================================================
// SERIES BROWSER / SEARCH COMPONENT
// ============================================================================
//
// Module: components/Markets/MarketBrowser.tsx
// Purpose: Search and browse prediction market series on Polymarket/Kalshi
//
// OVERVIEW:
// Provides a search interface for discovering series (groups of markets) on
// supported platforms. Users search by keyword, browse series results, expand
// series to see nested markets, and select one or more markets to add.
//
// For single-market series, clicking the series directly selects the market.
// For multi-market series, the user expands the series card and selects
// individual markets via checkboxes.
//
// Features:
// - Debounced search input (350ms delay)
// - Platform-specific series search (Polymarket /series API, Kalshi /series API)
// - Expandable series cards with nested market selection
// - Single-market series auto-select on click
// - Multi-market series with checkbox selection and "Select All"
// - Loading, error, and pagination states
//
// Backend Command: search_series_cmd (Rust, src-tauri/src/commands/markets.rs)
//   - Polymarket: queries gamma-api.polymarket.com/series
//   - Kalshi: queries api.elections.kalshi.com/trade-api/v2/series
//
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { Search, Loader2, TrendingUp, BarChart3, Tag, AlertCircle, X, ChevronDown, ChevronRight, Check, Layers } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { MarketType } from '../../types/nodes';
import type { SeriesSearchResult, SeriesSearchResponse, SeriesMarketItem, SelectedEventMarket } from '../../types/markets';

// ============================================================================
// TYPES
// ============================================================================

interface MarketBrowserProps {
  platform: MarketType;
  onSelectMarkets: (
    eventId: string,
    eventTitle: string,
    markets: SelectedEventMarket[]
  ) => void;
  className?: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function MarketBrowser({
  platform,
  onSelectMarkets,
  className = '',
}: MarketBrowserProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SeriesSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Event expansion and market selection state
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [selectedMarkets, setSelectedMarkets] = useState<Record<string, Set<string>>>({});
  const [confirmedEventId, setConfirmedEventId] = useState<string | null>(null);

  const platformName = platform === MarketType.Polymarket ? 'Polymarket' : 'Kalshi';

  // Core search function that handles both initial and paginated requests
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
          cursor: cursor,
        });

        if (append) {
          setResults((prev) => [...prev, ...response.results]);
        } else {
          setResults(response.results);
          setExpandedEventId(null);
          setSelectedMarkets({});
          setConfirmedEventId(null);
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

  // Initial search (reset pagination)
  const performSearch = useCallback(
    (searchQuery: string) => {
      setNextCursor(null);
      setHasMore(false);
      fetchResults(searchQuery, null, false);
    },
    [fetchResults]
  );

  // Load more results (append to existing)
  const loadMore = useCallback(() => {
    if (isLoadingMore || !hasMore) return;
    fetchResults(query, nextCursor, true);
  }, [query, nextCursor, isLoadingMore, hasMore, fetchResults]);

  // Handle input change with debounce
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

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  // Build SelectedEventMarket from SeriesMarketItem
  const buildSelectedMarket = (market: SeriesMarketItem, series: SeriesSearchResult): SelectedEventMarket => ({
    id: market.id,
    title: market.title,
    tokenIds: market.token_ids || [],
    details: {
      description: market.description || undefined,
      image_url: series.image_url || undefined,
      category: series.category || undefined,
      end_date: market.end_date || undefined,
      status: market.status || undefined,
      slug: market.slug || undefined,
      condition_id: market.condition_id || undefined,
    },
  });

  // Handle series card click
  const handleEventClick = (series: SeriesSearchResult) => {
    if (series.market_count === 1) {
      // Single-market series: auto-select and confirm
      const market = series.markets[0];
      setConfirmedEventId(series.id);
      setExpandedEventId(null);
      onSelectMarkets(series.id, series.title, [buildSelectedMarket(market, series)]);
    } else {
      // Multi-market series: toggle expansion
      setExpandedEventId((prev) => (prev === series.id ? null : series.id));
    }
  };

  // Toggle individual market selection within a series
  const toggleMarketSelection = (eventId: string, marketId: string) => {
    setSelectedMarkets((prev) => {
      const eventSet = new Set(prev[eventId] || []);
      if (eventSet.has(marketId)) {
        eventSet.delete(marketId);
      } else {
        eventSet.add(marketId);
      }
      return { ...prev, [eventId]: eventSet };
    });
  };

  // Select all markets in a series
  const selectAllInEvent = (series: SeriesSearchResult) => {
    setSelectedMarkets((prev) => ({
      ...prev,
      [series.id]: new Set(series.markets.map((m) => m.id)),
    }));
  };

  // Deselect all markets in a series
  const deselectAllInEvent = (eventId: string) => {
    setSelectedMarkets((prev) => ({
      ...prev,
      [eventId]: new Set<string>(),
    }));
  };

  // Confirm selection of markets from a series
  const handleConfirmSelection = (series: SeriesSearchResult) => {
    const selected = selectedMarkets[series.id];
    if (!selected || selected.size === 0) return;

    const chosenMarkets: SelectedEventMarket[] = series.markets
      .filter((m) => selected.has(m.id))
      .map((m) => buildSelectedMarket(m, series));

    setConfirmedEventId(series.id);
    onSelectMarkets(series.id, series.title, chosenMarkets);
  };

  // Format price as cents
  const formatPrice = (price: number | null): string => {
    if (price === null || price === undefined) return '\u2014';
    return `${(price * 100).toFixed(1)}\u00A2`;
  };

  // Format volume
  const formatVolume = (vol: number | null): string => {
    if (vol === null || vol === undefined) return '\u2014';
    if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}M`;
    if (vol >= 1_000) return `$${(vol / 1_000).toFixed(1)}K`;
    return `$${vol.toFixed(0)}`;
  };

  // Get selected count for a series
  const getSelectedCount = (eventId: string): number => {
    return selectedMarkets[eventId]?.size || 0;
  };

  // Check if all markets in series are selected
  const isAllSelected = (series: SeriesSearchResult): boolean => {
    const selected = selectedMarkets[series.id];
    return !!selected && selected.size === series.markets.length;
  };

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Search Input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          value={query}
          onChange={(e) => handleQueryChange(e.target.value)}
          placeholder={`Search ${platformName} events...`}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-10 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors text-sm"
          autoFocus
        />
        {query && !isSearching && (
          <button
            onClick={() => {
              setQuery('');
              setResults([]);
              setHasSearched(false);
              setHasMore(false);
              setNextCursor(null);
              setError(null);
              setExpandedEventId(null);
              setSelectedMarkets({});
              setConfirmedEventId(null);
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
          >
            <X className="w-4 h-4" />
          </button>
        )}
        {isSearching && (
          <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-emerald-400 animate-spin" />
        )}
      </div>

      {/* Results */}
      <div ref={scrollRef} className="max-h-80 overflow-y-auto rounded-lg border border-gray-800 bg-gray-900/50">
        {error ? (
          <div className="px-4 py-6 text-center">
            <AlertCircle className="w-6 h-6 text-red-400 mx-auto mb-2" />
            <p className="text-sm text-red-400">{error}</p>
            <button
              onClick={() => performSearch(query)}
              className="mt-2 text-xs text-gray-400 hover:text-gray-200 underline"
            >
              Retry
            </button>
          </div>
        ) : results.length > 0 ? (
          <div className="divide-y divide-gray-800">
            {results.map((event) => {
              const isExpanded = expandedEventId === event.id;
              const isConfirmed = confirmedEventId === event.id;
              const selectedCount = getSelectedCount(event.id);
              const isSingleMarket = event.market_count === 1;

              return (
                <div key={`${event.platform}-${event.id}`}>
                  {/* Event Header Card */}
                  <button
                    onClick={() => handleEventClick(event)}
                    className={`w-full text-left px-4 py-3 hover:bg-gray-800/70 transition-colors ${
                      isConfirmed
                        ? 'bg-emerald-500/10 border-l-2 border-emerald-500'
                        : isExpanded
                          ? 'bg-gray-800/50'
                          : ''
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      {/* Event image or fallback */}
                      {event.image_url ? (
                        <img
                          src={event.image_url}
                          alt=""
                          className="w-10 h-10 rounded-lg object-cover flex-shrink-0 bg-gray-800"
                          onError={(e) => {
                            (e.target as HTMLImageElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-gray-800 flex items-center justify-center flex-shrink-0">
                          <TrendingUp className="w-5 h-5 text-gray-600" />
                        </div>
                      )}

                      <div className="flex-1 min-w-0">
                        {/* Title */}
                        <p className="text-sm font-medium text-gray-200 truncate leading-tight">
                          {event.title}
                        </p>

                        {/* Metrics row */}
                        <div className="flex items-center gap-3 mt-1.5 text-xs">
                          {/* Market count badge */}
                          <span className="flex items-center gap-1 text-blue-400">
                            <Layers className="w-3 h-3" />
                            {event.market_count} market{event.market_count !== 1 ? 's' : ''}
                          </span>

                          {/* Category */}
                          {event.category && (
                            <span className="flex items-center gap-1 text-gray-500">
                              <Tag className="w-3 h-3" />
                              {event.category}
                            </span>
                          )}

                          {/* Single market: show YES price inline */}
                          {isSingleMarket && event.markets[0]?.yes_price !== null && (
                            <span className="flex items-center gap-1 text-emerald-400">
                              <span className="font-semibold">
                                {formatPrice(event.markets[0].yes_price)}
                              </span>
                              <span className="text-gray-600">YES</span>
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Right side: expand indicator or confirmed badge */}
                      {isConfirmed ? (
                        <span className="text-emerald-400 text-xs font-medium flex-shrink-0 mt-1">
                          Selected
                        </span>
                      ) : isSingleMarket ? null : (
                        <div className="flex items-center gap-2 flex-shrink-0 mt-1">
                          {selectedCount > 0 && (
                            <span className="text-xs text-emerald-400 font-medium">
                              {selectedCount}
                            </span>
                          )}
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-gray-500" />
                          ) : (
                            <ChevronRight className="w-4 h-4 text-gray-500" />
                          )}
                        </div>
                      )}
                    </div>
                  </button>

                  {/* Expanded Market List */}
                  {isExpanded && !isSingleMarket && (
                    <div className="bg-gray-950/50 border-t border-gray-800">
                      {/* Select All / Deselect All */}
                      <div className="px-4 py-2 flex items-center justify-between border-b border-gray-800/50">
                        <span className="text-xs text-gray-500">
                          {selectedCount} of {event.market_count} selected
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isAllSelected(event)) {
                              deselectAllInEvent(event.id);
                            } else {
                              selectAllInEvent(event);
                            }
                          }}
                          className="text-xs text-blue-400 hover:text-blue-300"
                        >
                          {isAllSelected(event) ? 'Deselect all' : 'Select all'}
                        </button>
                      </div>

                      {/* Market Rows */}
                      <div className="max-h-48 overflow-y-auto">
                        {event.markets.map((market) => {
                          const isMarketSelected = selectedMarkets[event.id]?.has(market.id) || false;

                          return (
                            <button
                              key={market.id}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleMarketSelection(event.id, market.id);
                              }}
                              className={`w-full text-left px-4 py-2 flex items-center gap-3 hover:bg-gray-800/50 transition-colors ${
                                isMarketSelected ? 'bg-emerald-500/5' : ''
                              }`}
                            >
                              {/* Checkbox */}
                              <div
                                className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                                  isMarketSelected
                                    ? 'border-emerald-500 bg-emerald-500'
                                    : 'border-gray-600'
                                }`}
                              >
                                {isMarketSelected && (
                                  <Check className="w-3 h-3 text-white" />
                                )}
                              </div>

                              {/* Market info */}
                              <div className="flex-1 min-w-0">
                                <p className="text-sm text-gray-300 truncate">
                                  {market.title}
                                </p>
                              </div>

                              {/* YES price */}
                              {market.yes_price !== null && (
                                <span className="text-xs text-emerald-400 font-mono flex-shrink-0">
                                  {formatPrice(market.yes_price)}
                                </span>
                              )}

                              {/* Volume */}
                              {market.volume !== null && (
                                <span className="text-xs text-gray-500 flex-shrink-0 flex items-center gap-1">
                                  <BarChart3 className="w-3 h-3" />
                                  {formatVolume(market.volume)}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>

                      {/* Confirm Selection Button */}
                      {selectedCount > 0 && (
                        <div className="px-4 py-2 border-t border-gray-800/50">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              handleConfirmSelection(event);
                            }}
                            className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-medium transition-colors"
                          >
                            Add {selectedCount} market{selectedCount !== 1 ? 's' : ''}
                          </button>
                        </div>
                      )}

                    </div>
                  )}
                </div>
              );
            })}

            {/* Load More button */}
            {hasMore && (
              <button
                onClick={loadMore}
                disabled={isLoadingMore}
                className="w-full px-4 py-3 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                {isLoadingMore ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading...
                  </>
                ) : (
                  <>
                    <ChevronDown className="w-4 h-4" />
                    Load more events
                  </>
                )}
              </button>
            )}
          </div>
        ) : hasSearched && !isSearching ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            <Search className="w-6 h-6 mx-auto mb-2 opacity-50" />
            No events found for "{query}"
          </div>
        ) : !hasSearched ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            <Search className="w-6 h-6 mx-auto mb-2 opacity-50" />
            Type to search {platformName} events
          </div>
        ) : null}
      </div>

      {/* Result count */}
      {results.length > 0 && (
        <p className="text-xs text-gray-600 text-right">
          {results.length} event{results.length !== 1 ? 's' : ''} shown{hasMore ? ' \u2014 scroll for more' : ''}
        </p>
      )}
    </div>
  );
}
