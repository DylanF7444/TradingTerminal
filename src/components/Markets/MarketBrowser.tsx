// ============================================================================
// MARKET BROWSER / SEARCH COMPONENT
// ============================================================================
//
// Module: components/Markets/MarketBrowser.tsx
// Purpose: Search and browse available prediction markets on Polymarket/Kalshi
//
// OVERVIEW:
// Provides a search interface for discovering markets on supported platforms.
// Users can search by keyword, browse results, and select a market to populate
// the Market ID field in the MarketPanel connect flow.
//
// Features:
// - Debounced search input (300ms delay)
// - Platform-specific search (Polymarket Gamma API, Kalshi public API)
// - Result cards showing title, price, volume, category
// - Click-to-select fills Market ID in parent component
// - Toggle between "Search" and "Manual Entry" modes
// - Loading and error states
//
// ARCHITECTURE:
// MarketBrowser
//   ├── SearchInput (debounced text field)
//   ├── ResultsList (scrollable market cards)
//   │   └── MarketCard (individual result with price/volume)
//   └── EmptyState / ErrorState
//
// Backend Command: search_markets_cmd (Rust, src-tauri/src/commands/markets.rs)
//   - Polymarket: queries gamma-api.polymarket.com/markets
//   - Kalshi: queries api.elections.kalshi.com/trade-api/v2/events
//
// PROPS:
// - platform: MarketType - which platform to search
// - onSelectMarket: (id: string, title: string) => void - callback when market selected
// - className?: string - additional styling
//
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { Search, Loader2, TrendingUp, BarChart3, Clock, Tag, AlertCircle, X, ChevronDown } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { MarketType } from '../../types/nodes';

// ============================================================================
// TYPES
// ============================================================================

/** Search result from the backend search_markets_cmd */
export interface MarketSearchResult {
  id: string;
  title: string;
  description: string;
  image_url: string | null;
  yes_price: number | null;
  no_price: number | null;
  volume_24h: number | null;
  liquidity: number | null;
  category: string | null;
  status: string;
  end_date: string | null;
  platform: string;
  slug: string;
  /** CLOB token IDs for Polymarket (needed for WebSocket orderbook subscription) */
  token_ids?: string[];
  /** Condition ID for Polymarket REST API queries */
  condition_id?: string | null;
}

/** Paginated response from the backend search_markets_cmd */
interface MarketSearchResponse {
  results: MarketSearchResult[];
  has_more: boolean;
  next_cursor: string | null;
  page_size: number;
}

interface MarketBrowserProps {
  platform: MarketType;
  onSelectMarket: (id: string, title: string, tokenIds?: string[]) => void;
  className?: string;
}

// ============================================================================
// COMPONENT
// ============================================================================

export default function MarketBrowser({
  platform,
  onSelectMarket,
  className = '',
}: MarketBrowserProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MarketSearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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
        const response = await invoke<MarketSearchResponse>('search_markets_cmd', {
          platform: platformName,
          query: searchQuery.trim(),
          cursor: cursor,
        });

        if (append) {
          setResults((prev) => [...prev, ...response.results]);
        } else {
          setResults(response.results);
        }

        setHasMore(response.has_more);
        setNextCursor(response.next_cursor);
      } catch (err) {
        console.error('Market search failed:', err);
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

  // Handle market selection
  const handleSelect = (result: MarketSearchResult) => {
    setSelectedId(result.id);
    // Use result.id for both platforms:
    // - Polymarket: id is now the first CLOB token ID (needed for orderbook WS)
    // - Kalshi: id is the ticker
    onSelectMarket(result.id, result.title, result.token_ids);
  };

  // Format price as percentage
  const formatPrice = (price: number | null): string => {
    if (price === null || price === undefined) return '—';
    return `${(price * 100).toFixed(1)}¢`;
  };

  // Format volume
  const formatVolume = (vol: number | null): string => {
    if (vol === null || vol === undefined) return '—';
    if (vol >= 1_000_000) return `$${(vol / 1_000_000).toFixed(1)}M`;
    if (vol >= 1_000) return `$${(vol / 1_000).toFixed(1)}K`;
    return `$${vol.toFixed(0)}`;
  };

  // Format end date
  const formatEndDate = (dateStr: string | null): string => {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = date.getTime() - now.getTime();
      const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
      if (diffDays < 0) return 'Ended';
      if (diffDays === 0) return 'Today';
      if (diffDays === 1) return 'Tomorrow';
      if (diffDays < 30) return `${diffDays}d`;
      if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
      return `${Math.floor(diffDays / 365)}y`;
    } catch {
      return '';
    }
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
          placeholder={`Search ${platformName} markets...`}
          className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-10 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-emerald-500 transition-colors text-sm"
          autoFocus
        />
        {query && (
          <button
            onClick={() => {
              setQuery('');
              setResults([]);
              setHasSearched(false);
              setHasMore(false);
              setNextCursor(null);
              setError(null);
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
      <div ref={scrollRef} className="max-h-64 overflow-y-auto rounded-lg border border-gray-800 bg-gray-900/50">
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
            {results.map((result) => (
              <button
                key={`${result.platform}-${result.id}`}
                onClick={() => handleSelect(result)}
                className={`w-full text-left px-4 py-3 hover:bg-gray-800/70 transition-colors ${
                  selectedId === result.id
                    ? 'bg-emerald-500/10 border-l-2 border-emerald-500'
                    : ''
                }`}
              >
                <div className="flex items-start gap-3">
                  {/* Market image or fallback icon */}
                  {result.image_url ? (
                    <img
                      src={result.image_url}
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
                      {result.title}
                    </p>

                    {/* Description (if short enough) */}
                    {result.description && (
                      <p className="text-xs text-gray-500 truncate mt-0.5">
                        {result.description}
                      </p>
                    )}

                    {/* Metrics row */}
                    <div className="flex items-center gap-3 mt-1.5 text-xs">
                      {/* YES price */}
                      {result.yes_price !== null && (
                        <span className="flex items-center gap-1 text-emerald-400">
                          <span className="font-semibold">
                            {formatPrice(result.yes_price)}
                          </span>
                          <span className="text-gray-600">YES</span>
                        </span>
                      )}

                      {/* Volume */}
                      {result.volume_24h !== null && (
                        <span className="flex items-center gap-1 text-gray-400">
                          <BarChart3 className="w-3 h-3" />
                          {formatVolume(result.volume_24h)}
                        </span>
                      )}

                      {/* Category */}
                      {result.category && (
                        <span className="flex items-center gap-1 text-gray-500">
                          <Tag className="w-3 h-3" />
                          {result.category}
                        </span>
                      )}

                      {/* End date */}
                      {result.end_date && (
                        <span className="flex items-center gap-1 text-gray-500">
                          <Clock className="w-3 h-3" />
                          {formatEndDate(result.end_date)}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Selection indicator */}
                  {selectedId === result.id && (
                    <span className="text-emerald-400 text-xs font-medium flex-shrink-0 mt-1">
                      Selected
                    </span>
                  )}
                </div>
              </button>
            ))}

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
                    Load more markets
                  </>
                )}
              </button>
            )}
          </div>
        ) : hasSearched && !isSearching ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            <Search className="w-6 h-6 mx-auto mb-2 opacity-50" />
            No markets found for "{query}"
          </div>
        ) : !hasSearched ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            <Search className="w-6 h-6 mx-auto mb-2 opacity-50" />
            Type to search {platformName} markets
          </div>
        ) : null}
      </div>

      {/* Result count */}
      {results.length > 0 && (
        <p className="text-xs text-gray-600 text-right">
          {results.length} market{results.length !== 1 ? 's' : ''} shown{hasMore ? ' — scroll for more' : ''}
        </p>
      )}
    </div>
  );
}
