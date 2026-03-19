// ============================================================================
// MarketPanel.tsx - Prediction market connection panel
// ============================================================================
//
// Provides the UI for connecting live prediction market platforms
// (Polymarket, Kalshi) to the strategy graph. Displays a list of
// existing market connections with status indicators, and a modal
// flow for adding new markets (platform selection, credential entry,
// event search/browsing with multi-market selection).
//
// Users search for events (groups of markets), select one or more
// markets from an event, and all selected markets are added as nodes.
// Multi-market selections share an event_group_id in metadata.
//
// Stored API keys are retrieved from the backend SQLite database and
// pre-populated when available. Credentials are cleared from frontend
// state immediately after submission or modal close.
//
// Key props: onAddMarket, existingMarkets, className.
//
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  TrendingUp,
  Wallet,
  Link,
  Link2,
  Plus,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Eye,
  EyeOff,
  RefreshCw,
  Unplug,
  Shield,
  Key,
  Search,
  Type,
  X,
  Layers,
  Tag,
  ChevronDown
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { MarketType, Node } from '../../types/nodes';
import { useTauriCommand } from '../../hooks/useTauriCommand';
import MarketBrowser from './MarketBrowser';
import type { SelectedEventMarket, EventSearchResult, EventSearchResponse } from '../../types/markets';
import { useStore, type StoreState } from '../../store';
import { createNodeGroup } from '../../store/groupsSlice';
import { transformNodeFromBackend } from '../../utils/nodeTransform';

// ============================================================================
// API KEY TYPES
// ============================================================================

interface ApiKeyResponse {
  platform: string;
  has_key: boolean;
  api_key: string | null;
  api_secret: string | null;
  private_key: string | null;
  environment: string | null;
  additional_config: Record<string, unknown> | null;
  created_at: number | null;
  updated_at: number | null;
}

// Platform-specific configuration metadata
interface PlatformConfig {
  name: string;
  color: string;
  bgColor: string;
  icon: React.ElementType;
  description: string;
  fields: Array<{
    key: string;
    label: string;
    type: 'password' | 'text' | 'select';
    placeholder?: string;
    helpText?: string;
    required: boolean;
  }>;
  testNetAvailable: boolean;
}

const PLATFORM_CONFIGS: Record<MarketType, PlatformConfig> = {
  [MarketType.Polymarket]: {
    name: 'Polymarket',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500',
    icon: Wallet,
    description: 'Polygon-based prediction market. Trade on crypto, politics, sports outcomes. Market data is public - API keys only needed for trading.',
    testNetAvailable: true,
    fields: [
      {
        key: 'api_key',
        label: 'API Key (Optional)',
        type: 'password',
        placeholder: 'pm_...',
        required: false,
        helpText: 'Only needed for trading. Leave empty for read-only market data.'
      },
      {
        key: 'private_key',
        label: 'Proxy Wallet Private Key (Optional)',
        type: 'password',
        placeholder: '0x...',
        required: false,
        helpText: 'Only needed for on-chain transactions.'
      }
    ]
  },
  [MarketType.Kalshi]: {
    name: 'Kalshi',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500',
    icon: TrendingUp,
    description: 'Regulated US exchange for event contracts. Financial and political markets.',
    testNetAvailable: true,
    fields: [
      {
        key: 'api_key',
        label: 'API Key',
        type: 'password',
        placeholder: 'kalshi_...',
        required: true,
        helpText: 'From Kalshi API dashboard'
      },
      {
        key: 'api_secret',
        label: 'API Secret',
        type: 'password',
        placeholder: 'secret_...',
        required: true,
        helpText: 'Used for request signing (HMAC)'
      },
      {
        key: 'environment',
        label: 'Environment',
        type: 'select',
        required: true,
        helpText: 'Demo for paper trading, Production for real money'
      }
    ]
  }
};

interface MarketPanelProps {
  onAddMarket?: (node: Node) => void;
  existingMarkets?: Node[];
  className?: string;
}

export default function MarketPanel({
  onAddMarket,
  existingMarkets = [],
  className = ''
}: MarketPanelProps) {
  // Modal and selection state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState<MarketType | null>(null);
  const [step, setStep] = useState<'select' | 'configure'>('select');

  // Form state (sensitive - cleared aggressively)
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [marketInputMode, setMarketInputMode] = useState<'search' | 'manual' | 'series'>('search');
  const [environment, setEnvironment] = useState<'demo' | 'production'>('demo');
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});

  // Series search state
  const [seriesQuery, setSeriesQuery] = useState('');
  const [seriesResults, setSeriesResults] = useState<EventSearchResult[]>([]);
  const [isSeriesSearching, setIsSeriesSearching] = useState(false);
  const [seriesError, setSeriesError] = useState<string | null>(null);
  const [seriesHasSearched, setSeriesHasSearched] = useState(false);
  const [seriesHasMore, setSeriesHasMore] = useState(false);
  const [seriesNextCursor, setSeriesNextCursor] = useState<string | null>(null);
  const [isSeriesLoadingMore, setIsSeriesLoadingMore] = useState(false);
  const [selectedSeries, setSelectedSeries] = useState<EventSearchResult | null>(null);
  const seriesDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Store actions for series
  const addNode = useStore((s: StoreState) => s.addNode);
  const addGroup = useStore((s: StoreState) => s.addGroup);
  const viewport = useStore((s: StoreState) => s.viewport);

  // Event-based market selection (from search)
  const [selectedEvent, setSelectedEvent] = useState<{
    eventId: string;
    eventTitle: string;
    markets: SelectedEventMarket[];
  } | null>(null);

  // Manual entry fallback (single market)
  const [manualMarketId, setManualMarketId] = useState('');

  // Stored API key state
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [useStoredKey, setUseStoredKey] = useState(true);
  const [isLoadingKey, setIsLoadingKey] = useState(false);

  // UI state
  const [localError, setLocalError] = useState<string | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [connectProgress, setConnectProgress] = useState<{ current: number; total: number } | null>(null);

  // Backend command hook
  const {
    execute: addMarketRaw,
    loading: isConnecting,
    error: apiError,
    reset: resetAddMarket
  } = useTauriCommand<{ node: Node }, {
    marketType: MarketType;
    apiCredentials: Record<string, any>;
    marketConfig: Record<string, any>;
    marketDetails?: {
      title?: string;
      description?: string;
      image_url?: string;
      category?: string;
      end_date?: string;
      status?: string;
      slug?: string;
      token_ids?: string[];
      condition_id?: string;
      created_at?: string;
    } | null;
  }>('add_market_cmd');

  // Wrapper to extract node from response
  const addMarket = useCallback(async (params: Parameters<typeof addMarketRaw>[0]) => {
    const result = await addMarketRaw(params);
    return result?.node;
  }, [addMarketRaw]);

  // Cleanup sensitive data on unmount or modal close
  const clearSensitiveData = useCallback(() => {
    setCredentials({});
    setSelectedEvent(null);
    setManualMarketId('');
    setMarketInputMode('search');
    setLocalError(null);
    setSelectedPlatform(null);
    setStep('select');
    setShowPasswords({});
    setHasStoredKey(false);
    setUseStoredKey(true);
    setConnectProgress(null);
    // Clear series state
    setSeriesQuery('');
    setSeriesResults([]);
    setSeriesError(null);
    setSeriesHasSearched(false);
    setSeriesHasMore(false);
    setSeriesNextCursor(null);
    setSelectedSeries(null);
    resetAddMarket();
  }, [resetAddMarket]);

  // Cleanup series debounce on unmount
  useEffect(() => {
    return () => {
      if (seriesDebounceRef.current) {
        clearTimeout(seriesDebounceRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isModalOpen) {
      clearSensitiveData();
    }
  }, [isModalOpen, clearSensitiveData]);

  // Handle platform selection - check for stored keys
  const handlePlatformSelect = async (platform: MarketType) => {
    setSelectedPlatform(platform);
    setStep('configure');
    setIsLoadingKey(true);

    // Pre-populate with empty strings for required fields
    const emptyCreds: Record<string, string> = {};
    PLATFORM_CONFIGS[platform].fields.forEach(f => {
      if (f.key !== 'environment') emptyCreds[f.key] = '';
    });
    setCredentials(emptyCreds);

    // Check for stored API key
    try {
      const platformName = platform === MarketType.Polymarket ? 'Polymarket' : 'Kalshi';
      const keyResponse = await invoke<ApiKeyResponse>('get_api_key_cmd', {
        platform: platformName
      });

      if (keyResponse.has_key) {
        setHasStoredKey(true);
        setUseStoredKey(true);

        // Pre-populate credentials from stored key
        const storedCreds: Record<string, string> = {};
        if (keyResponse.api_key) storedCreds.api_key = keyResponse.api_key;
        if (keyResponse.api_secret) storedCreds.api_secret = keyResponse.api_secret;
        if (keyResponse.private_key) storedCreds.private_key = keyResponse.private_key;
        setCredentials(storedCreds);

        if (keyResponse.environment) {
          setEnvironment(keyResponse.environment as 'demo' | 'production');
        }
      } else {
        setHasStoredKey(false);
        setUseStoredKey(false);
      }
    } catch (err) {
      console.error('Failed to check stored API key:', err);
      setHasStoredKey(false);
      setUseStoredKey(false);
    } finally {
      setIsLoadingKey(false);
    }
  };

  // Toggle password visibility for specific field
  const togglePasswordVisibility = (fieldKey: string) => {
    setShowPasswords(prev => ({ ...prev, [fieldKey]: !prev[fieldKey] }));
  };

  // Handle credential input change
  const handleCredentialChange = (key: string, value: string) => {
    setCredentials(prev => ({ ...prev, [key]: value }));
    setLocalError(null); // Clear error on input
  };

  // ============================================================================
  // SERIES SEARCH FUNCTIONALITY
  // ============================================================================

  const platformName = selectedPlatform === MarketType.Polymarket ? 'Polymarket' : 'Kalshi';

  // Fetch series results (events)
  const fetchSeriesResults = useCallback(
    async (searchQuery: string, cursor: string | null, append: boolean) => {
      if (!searchQuery.trim() || !selectedPlatform) {
        setSeriesResults([]);
        setSeriesHasSearched(false);
        setSeriesHasMore(false);
        setSeriesNextCursor(null);
        setSeriesError(null);
        return;
      }

      if (append) {
        setIsSeriesLoadingMore(true);
      } else {
        setIsSeriesSearching(true);
      }
      setSeriesError(null);
      setSeriesHasSearched(true);

      try {
        const pName = selectedPlatform === MarketType.Polymarket ? 'Polymarket' : 'Kalshi';
        const response = await invoke<EventSearchResponse>('search_events_cmd', {
          platform: pName,
          query: searchQuery.trim(),
          cursor,
        });

        if (append) {
          setSeriesResults((prev) => [...prev, ...response.results]);
        } else {
          setSeriesResults(response.results);
        }

        setSeriesHasMore(response.has_more);
        setSeriesNextCursor(response.next_cursor);
      } catch (err) {
        console.error('Series search failed:', err);
        setSeriesError(typeof err === 'string' ? err : 'Search failed. Please try again.');
        if (!append) {
          setSeriesResults([]);
        }
      } finally {
        setIsSeriesSearching(false);
        setIsSeriesLoadingMore(false);
      }
    },
    [selectedPlatform]
  );

  const performSeriesSearch = useCallback(
    (searchQuery: string) => {
      setSeriesNextCursor(null);
      setSeriesHasMore(false);
      fetchSeriesResults(searchQuery, null, false);
    },
    [fetchSeriesResults]
  );

  const loadMoreSeries = useCallback(() => {
    if (isSeriesLoadingMore || !seriesHasMore) return;
    fetchSeriesResults(seriesQuery, seriesNextCursor, true);
  }, [seriesQuery, seriesNextCursor, isSeriesLoadingMore, seriesHasMore, fetchSeriesResults]);

  const handleSeriesQueryChange = useCallback(
    (value: string) => {
      setSeriesQuery(value);
      if (seriesDebounceRef.current) {
        clearTimeout(seriesDebounceRef.current);
      }
      seriesDebounceRef.current = setTimeout(() => {
        performSeriesSearch(value);
      }, 350);
    },
    [performSeriesSearch]
  );

  const handleSeriesSelect = (event: EventSearchResult) => {
    setSelectedSeries(event);
    setLocalError(null);
  };

  // Series platform color config
  const SERIES_PLATFORM_CONFIG = {
    [MarketType.Polymarket]: { seriesColor: '#8b5cf6' },
    [MarketType.Kalshi]: { seriesColor: '#10b981' },
  };

  // Test connection before saving (optional validation)
  const handleTestConnection = async () => {
    if (!selectedPlatform) return;
    setIsTesting(true);
    setLocalError(null);

    try {
      const valid = validateCredentials(selectedPlatform, credentials);
      if (valid) {
        await new Promise(r => setTimeout(r, 1000)); // Simulate
      }
    } catch (e) {
      setLocalError('Connection test failed. Check credentials.');
    } finally {
      setIsTesting(false);
    }
  };

  // Check if we have a valid market selection
  const hasMarketSelection = (): boolean => {
    if (marketInputMode === 'search') {
      return !!selectedEvent && selectedEvent.markets.length > 0;
    }
    if (marketInputMode === 'series') {
      return !!selectedSeries && selectedSeries.markets.length > 0;
    }
    return !!manualMarketId.trim();
  };

  // Validate credentials format client-side
  const validateCredentials = (platform: MarketType, creds: Record<string, string>): boolean => {
    // For series mode, check if series is selected
    if (marketInputMode === 'series') {
      if (!selectedSeries || selectedSeries.markets.length === 0) {
        setLocalError('Please select a series');
        return false;
      }
      return true;
    }

    // If using stored key, skip credential validation
    if (hasStoredKey && useStoredKey) {
      if (!hasMarketSelection()) {
        setLocalError('Please select at least one market');
        return false;
      }
      return true;
    }

    const config = PLATFORM_CONFIGS[platform];
    for (const field of config.fields) {
      if (field.key === 'environment') {
        continue;
      }
      if (field.required && !creds[field.key]) {
        setLocalError(`${field.label} is required`);
        return false;
      }
    }
    if (!hasMarketSelection()) {
      setLocalError('Please select at least one market');
      return false;
    }
    return true;
  };

  // Submit connection request
  const handleConnect = async () => {
    if (!selectedPlatform) return;

    if (!validateCredentials(selectedPlatform, credentials)) {
      return;
    }

    try {
      const credPayload = {
        ...credentials,
        environment: selectedPlatform === MarketType.Kalshi ? environment : undefined
      };

      if (marketInputMode === 'manual') {
        // Manual entry: single market, no event group
        const result = await addMarket({
          marketType: selectedPlatform,
          apiCredentials: credPayload,
          marketConfig: {
            market_id: manualMarketId.trim(),
          },
        });

        if (result) {
          onAddMarket?.(result);
          setIsModalOpen(false);
        }
      } else if (marketInputMode === 'series' && selectedSeries) {
        // Series mode: add all markets and create a group
        const markets = selectedSeries.markets || [];
        if (markets.length === 0) {
          setLocalError('No markets found in this series');
          return;
        }

        const createdNodeIds: string[] = [];
        const pName = selectedPlatform === MarketType.Polymarket ? 'Polymarket' : 'Kalshi';

        // Grid layout for new nodes
        const GRID_COLS = 3;
        const SPACING_X = 220;
        const SPACING_Y = 160;
        const baseX = -viewport.x / viewport.zoom + 300;
        const baseY = -viewport.y / viewport.zoom + 200;

        setConnectProgress({ current: 0, total: markets.length });

        // Create individual market nodes
        for (let i = 0; i < markets.length; i++) {
          const market = markets[i];
          const col = i % GRID_COLS;
          const row = Math.floor(i / GRID_COLS);
          const posX = baseX + col * SPACING_X;
          const posY = baseY + row * SPACING_Y;

          setConnectProgress({ current: i + 1, total: markets.length });

          try {
            const result = await invoke<{ node: Node }>('add_market_cmd', {
              marketType: selectedPlatform,
              apiCredentials: credPayload,
              marketConfig: {
                market_id: market.id,
                question: market.title,
                token_ids: market.token_ids || [],
                event_group_id: selectedSeries.id,
                event_title: selectedSeries.title,
              },
              marketDetails: {
                title: market.title,
                description: market.description || undefined,
                image_url: selectedSeries.image_url || undefined,
                category: selectedSeries.category || undefined,
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
              onAddMarket?.(node);
            }
          } catch (err) {
            console.error(`Failed to add market ${market.id}:`, err);
          }
        }

        // Create the group
        if (createdNodeIds.length > 0) {
          const seriesColor = SERIES_PLATFORM_CONFIG[selectedPlatform]?.seriesColor || '#8b5cf6';
          const group = createNodeGroup(
            selectedSeries.title || 'Series',
            createdNodeIds,
            {
              type: 'series',
              platform: pName,
              seriesEventId: selectedSeries.id,
              seriesEventSlug: selectedSeries.slug,
              seriesEventTitle: selectedSeries.title,
              seriesImageUrl: selectedSeries.image_url,
              seriesCategory: selectedSeries.category,
              seriesRefreshInterval: 60,
              seriesLastRefreshed: Date.now(),
            },
            seriesColor
          );
          addGroup(group);
        }

        setConnectProgress(null);
        setIsModalOpen(false);
      } else if (selectedEvent) {
        // Event-based: add each selected market
        const markets = selectedEvent.markets;

        // Generate shared group ID for multi-market events
        const eventGroupId = markets.length > 1
          ? crypto.randomUUID()
          : undefined;

        setConnectProgress({ current: 0, total: markets.length });

        for (let i = 0; i < markets.length; i++) {
          const market = markets[i];
          setConnectProgress({ current: i + 1, total: markets.length });

          const result = await addMarket({
            marketType: selectedPlatform,
            apiCredentials: credPayload,
            marketConfig: {
              market_id: market.id,
              question: market.title,
              token_ids: market.tokenIds.length > 0 ? market.tokenIds : undefined,
              event_group_id: eventGroupId,
              event_title: selectedEvent.eventTitle,
            },
            marketDetails: market.details || undefined,
          });

          if (result) {
            onAddMarket?.(result);
          }
        }

        setConnectProgress(null);
        setIsModalOpen(false);
      }
    } catch (err) {
      console.error('Failed to connect market(s):', err);
      setConnectProgress(null);
    }
  };

  // Remove market connection
  const handleRemove = async (nodeId: string) => {
    if (!confirm('Disconnect this market? Open positions will remain but no new trades can be placed.')) {
      return;
    }

    try {
      await invoke('remove_market_cmd', { nodeId });
    } catch (err) {
      console.error('Failed to remove market:', err);
      alert('Failed to disconnect. Please try again.');
    }
  };

  // Refresh connection (re-establish WebSocket)
  const handleRefresh = async (nodeId: string) => {
    try {
      await invoke('refresh_market_connection_cmd', { nodeId });
    } catch (err) {
      console.error('Failed to refresh:', err);
    }
  };

  const isCurrentlyConnecting = isConnecting || connectProgress !== null;

  return (
    <div className={`bg-gray-900 rounded-lg border border-gray-800 overflow-hidden ${className}`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-emerald-400" />
          Prediction Markets
        </h3>
        <span className="text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded-full">
          {existingMarkets.length} connected
        </span>
      </div>

      {/* Connected Markets List */}
      <div className="max-h-64 overflow-y-auto">
        {existingMarkets.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            <Link className="w-8 h-8 mx-auto mb-2 opacity-50" />
            No markets connected
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {existingMarkets.map((market) => {
              // Type guard: Check if this is a Market node
              if (!('Market' in market.node_type)) return null;

              const platform = market.node_type.Market;
              const config = PLATFORM_CONFIGS[platform];
              if (!config) return null;

              const Icon = config.icon;

              // Safely access metadata properties with type assertions
              const metadata = market.metadata as Record<string, any>;
              const quality = metadata?.quality;
              const isConnected = quality?.successRate !== undefined && quality.successRate > 0.5;
              const latency = quality?.avgLatency;
              const balance = metadata?.balance || 0;
              const displayName = metadata?.question || metadata?.market_id || config.name;
              const eventTitle = metadata?.event_title;

              return (
                <div
                  key={market.id}
                  className="px-4 py-3 flex items-center justify-between hover:bg-gray-800/50 transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg bg-gray-800 ${config.color}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-gray-200 truncate">
                        {displayName}
                      </div>
                      <div className="text-xs text-gray-500 flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'}`} />
                        {isConnected ? 'Connected' : 'Connecting...'}
                        {eventTitle && (
                          <>
                            <span className="text-gray-600">&middot;</span>
                            <span className="text-blue-400 truncate max-w-[120px]">{eventTitle}</span>
                          </>
                        )}
                        {latency !== undefined && (
                          <>
                            <span className="text-gray-600">&middot;</span>
                            <span className="text-blue-400">{latency.toFixed(0)}ms</span>
                          </>
                        )}
                        <span className="text-gray-600">&middot;</span>
                        <span className="text-emerald-400">${balance.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleRefresh(market.id)}
                      className="p-1.5 text-gray-500 hover:text-blue-400 hover:bg-blue-400/10 rounded transition-colors"
                      title="Refresh connection"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleRemove(market.id)}
                      className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                      title="Disconnect"
                    >
                      <Unplug className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Add Button */}
      <div className="p-4 border-t border-gray-800">
        <button
          onClick={() => setIsModalOpen(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          Connect Market
        </button>
      </div>

      {/* Connection Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="bg-gray-900 rounded-xl border border-gray-800 shadow-2xl w-full max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">
                  {step === 'select' ? 'Select Platform' : `Connect to ${selectedPlatform}`}
                </h2>
                {step === 'configure' && (
                  <p className="text-sm text-gray-500 mt-0.5">
                    Search for events and select markets to connect
                  </p>
                )}
              </div>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <Link2 className="w-5 h-5" />
              </button>
            </div>

            {/* Security Banner */}
            <div className="px-6 py-3 bg-blue-900/20 border-b border-blue-900/30 flex items-center gap-2 text-sm text-blue-200">
              <Shield className="w-4 h-4 flex-shrink-0" />
              <span>API keys are encrypted and stored in your system keychain. They are never stored in the browser.</span>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6">
              {step === 'select' ? (
                // Platform Selection Grid
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {Object.entries(PLATFORM_CONFIGS).map(([type, config]) => (
                    <button
                      key={type}
                      onClick={() => handlePlatformSelect(type as MarketType)}
                      className="p-6 rounded-xl border border-gray-800 hover:border-gray-600 hover:bg-gray-800/50 transition-all text-left group relative overflow-hidden"
                    >
                      <div className={`absolute inset-0 opacity-0 group-hover:opacity-10 transition-opacity ${config.bgColor}`} />
                      <div className={`p-3 w-fit rounded-xl bg-gray-800 mb-4 group-hover:scale-110 transition-transform ${config.color}`}>
                        <config.icon className="w-6 h-6" />
                      </div>
                      <h3 className="font-semibold text-gray-200 mb-1">{config.name}</h3>
                      <p className="text-sm text-gray-500 leading-relaxed">
                        {config.description}
                      </p>
                      <div className="mt-4 flex items-center gap-2 text-xs text-gray-600">
                        <ExternalLink className="w-3 h-3" />
                        <span>Get API keys &rarr;</span>
                      </div>
                    </button>
                  ))}
                </div>
              ) : selectedPlatform ? (
                // Configuration Form
                <div className="space-y-6">
                  {/* Back button */}
                  <button
                    onClick={() => setStep('select')}
                    className="text-sm text-gray-500 hover:text-gray-300 flex items-center gap-1"
                  >
                    &larr; Back to platforms
                  </button>

                  {/* Stored Key Indicator - hide for series mode */}
                  {marketInputMode !== 'series' && (
                    <>
                      {isLoadingKey ? (
                        <div className="flex items-center gap-2 p-3 bg-gray-800/50 rounded-lg">
                          <Loader2 className="w-4 h-4 animate-spin text-gray-400" />
                          <span className="text-sm text-gray-400">Checking for stored credentials...</span>
                        </div>
                      ) : hasStoredKey ? (
                        <div className="flex items-center justify-between p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                          <div className="flex items-center gap-2">
                            <Key className="w-4 h-4 text-emerald-400" />
                            <span className="text-sm text-emerald-300">Stored credentials found</span>
                          </div>
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={useStoredKey}
                              onChange={(e) => setUseStoredKey(e.target.checked)}
                              className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-emerald-500 focus:ring-emerald-500 focus:ring-offset-gray-900"
                            />
                            <span className="text-sm text-gray-300">Use stored</span>
                          </label>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 p-3 bg-gray-800/50 rounded-lg">
                          <Key className="w-4 h-4 text-gray-500" />
                          <span className="text-sm text-gray-400">
                            No stored credentials. Enter your API keys below.
                          </span>
                        </div>
                      )}
                    </>
                  )}

                  {/* Market Selection - Search, Manual, or Series */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="block text-sm font-medium text-gray-300">
                        Market
                      </label>
                      <div className="flex items-center bg-gray-800 rounded-lg p-0.5 border border-gray-700">
                        <button
                          type="button"
                          onClick={() => setMarketInputMode('search')}
                          className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                            marketInputMode === 'search'
                              ? 'bg-emerald-600 text-white'
                              : 'text-gray-400 hover:text-gray-200'
                          }`}
                        >
                          <Search className="w-3 h-3" />
                          Search
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMarketInputMode('manual');
                            setSelectedEvent(null);
                            setSelectedSeries(null);
                          }}
                          className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                            marketInputMode === 'manual'
                              ? 'bg-emerald-600 text-white'
                              : 'text-gray-400 hover:text-gray-200'
                          }`}
                        >
                          <Type className="w-3 h-3" />
                          Manual
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setMarketInputMode('series');
                            setSelectedEvent(null);
                          }}
                          className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                            marketInputMode === 'series'
                              ? 'bg-purple-600 text-white'
                              : 'text-gray-400 hover:text-gray-200'
                          }`}
                        >
                          <Layers className="w-3 h-3" />
                          Series
                        </button>
                      </div>
                    </div>

                    {marketInputMode === 'search' ? (
                      <div className="space-y-2">
                        <MarketBrowser
                          platform={selectedPlatform}
                          onSelectMarkets={(eventId, eventTitle, markets) => {
                            setSelectedEvent({ eventId, eventTitle, markets });
                            setLocalError(null);
                          }}
                        />
                        {selectedEvent && (
                          <div className="p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
                            <div className="flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm text-emerald-300 truncate">{selectedEvent.eventTitle}</p>
                                <p className="text-xs text-gray-500">
                                  {selectedEvent.markets.length} market{selectedEvent.markets.length !== 1 ? 's' : ''} selected
                                </p>
                              </div>
                              <button
                                onClick={() => setSelectedEvent(null)}
                                className="text-gray-500 hover:text-gray-300 flex-shrink-0"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            {selectedEvent.markets.length > 1 && (
                              <div className="mt-2 space-y-0.5 pl-6">
                                {selectedEvent.markets.map(m => (
                                  <p key={m.id} className="text-xs text-gray-400 truncate">
                                    &bull; {m.title}
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : marketInputMode === 'series' ? (
                      <div className="space-y-3">
                        {/* Series search header info */}
                        <div className="flex items-center gap-2 p-2.5 bg-purple-900/20 border border-purple-500/30 rounded-lg">
                          <Layers className="w-4 h-4 text-purple-400 flex-shrink-0" />
                          <p className="text-xs text-purple-300">
                            Add an entire event series as a grouped collection. All markets in the series will be added and grouped together.
                          </p>
                        </div>

                        {/* Series search input */}
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                          <input
                            type="text"
                            value={seriesQuery}
                            onChange={(e) => handleSeriesQueryChange(e.target.value)}
                            placeholder={`Search ${platformName} series/events...`}
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-10 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:border-purple-500 transition-colors text-sm"
                          />
                          {seriesQuery && !isSeriesSearching && (
                            <button
                              onClick={() => {
                                setSeriesQuery('');
                                setSeriesResults([]);
                                setSeriesHasSearched(false);
                                setSeriesHasMore(false);
                                setSeriesNextCursor(null);
                                setSeriesError(null);
                                setSelectedSeries(null);
                              }}
                              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          )}
                          {isSeriesSearching && (
                            <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-purple-400 animate-spin" />
                          )}
                        </div>

                        {/* Series search results */}
                        <div className="max-h-64 overflow-y-auto rounded-lg border border-gray-800 bg-gray-900/50">
                          {seriesError ? (
                            <div className="px-4 py-6 text-center">
                              <AlertCircle className="w-6 h-6 text-red-400 mx-auto mb-2" />
                              <p className="text-sm text-red-400">{seriesError}</p>
                              <button
                                onClick={() => performSeriesSearch(seriesQuery)}
                                className="mt-2 text-xs text-gray-400 hover:text-gray-200 underline"
                              >
                                Retry
                              </button>
                            </div>
                          ) : seriesResults.length > 0 ? (
                            <div className="divide-y divide-gray-800">
                              {seriesResults.map((event) => {
                                const isSelected = selectedSeries?.id === event.id;

                                return (
                                  <button
                                    key={`${event.platform}-${event.id}`}
                                    onClick={() => handleSeriesSelect(event)}
                                    className={`w-full text-left px-4 py-3 hover:bg-gray-800/70 transition-colors ${
                                      isSelected
                                        ? 'bg-purple-500/10 border-l-2 border-purple-500'
                                        : ''
                                    }`}
                                  >
                                    <div className="flex items-start gap-3">
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
                                          <Layers className="w-5 h-5 text-gray-600" />
                                        </div>
                                      )}

                                      <div className="flex-1 min-w-0">
                                        <p className="text-sm font-medium text-gray-200 truncate leading-tight">
                                          {event.title}
                                        </p>
                                        <div className="flex items-center gap-3 mt-1.5 text-xs">
                                          <span className="flex items-center gap-1 text-purple-400">
                                            <Layers className="w-3 h-3" />
                                            {event.market_count} market{event.market_count !== 1 ? 's' : ''}
                                          </span>
                                          {event.category && (
                                            <span className="flex items-center gap-1 text-gray-500">
                                              <Tag className="w-3 h-3" />
                                              {event.category}
                                            </span>
                                          )}
                                        </div>
                                      </div>

                                      {isSelected && (
                                        <span className="text-purple-400 text-xs font-medium flex-shrink-0 mt-1">
                                          Selected
                                        </span>
                                      )}
                                    </div>
                                  </button>
                                );
                              })}

                              {/* Load More button */}
                              {seriesHasMore && (
                                <button
                                  onClick={loadMoreSeries}
                                  disabled={isSeriesLoadingMore}
                                  className="w-full px-4 py-3 text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-800/50 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                                >
                                  {isSeriesLoadingMore ? (
                                    <>
                                      <Loader2 className="w-4 h-4 animate-spin" />
                                      Loading...
                                    </>
                                  ) : (
                                    <>
                                      <ChevronDown className="w-4 h-4" />
                                      Load more
                                    </>
                                  )}
                                </button>
                              )}
                            </div>
                          ) : seriesHasSearched && !isSeriesSearching ? (
                            <div className="px-4 py-8 text-center text-gray-500 text-sm">
                              <Search className="w-6 h-6 mx-auto mb-2 opacity-50" />
                              No series found for "{seriesQuery}"
                            </div>
                          ) : !seriesHasSearched ? (
                            <div className="px-4 py-8 text-center text-gray-500 text-sm">
                              <Search className="w-6 h-6 mx-auto mb-2 opacity-50" />
                              Type to search {platformName} series
                            </div>
                          ) : null}
                        </div>

                        {/* Selected series indicator */}
                        {selectedSeries && (
                          <div className="p-2.5 bg-purple-500/10 border border-purple-500/30 rounded-lg">
                            <div className="flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 text-purple-400 flex-shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm text-purple-300 truncate">{selectedSeries.title}</p>
                                <p className="text-xs text-gray-500">
                                  {selectedSeries.market_count} markets will be added as a grouped series
                                </p>
                              </div>
                              <button
                                onClick={() => setSelectedSeries(null)}
                                className="text-gray-500 hover:text-gray-300 flex-shrink-0"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div>
                        <input
                          type="text"
                          value={manualMarketId}
                          onChange={(e) => {
                            setManualMarketId(e.target.value);
                            setLocalError(null);
                          }}
                          placeholder={selectedPlatform === MarketType.Polymarket ? "0x123... or slug-name" : "Event-contract-ticker"}
                          className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-emerald-500 transition-colors"
                        />
                        <p className="mt-1.5 text-xs text-gray-500">
                          Enter the market identifier directly (e.g., slug, condition ID, or ticker)
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Credential Fields - show if no stored key or user wants to enter new (hide for series mode) */}
                  {(!hasStoredKey || !useStoredKey) && marketInputMode !== 'series' && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h4 className="text-sm font-medium text-gray-300">API Credentials</h4>
                        {hasStoredKey && (
                          <button
                            onClick={() => setUseStoredKey(true)}
                            className="text-xs text-emerald-400 hover:text-emerald-300"
                          >
                            Use stored instead
                          </button>
                        )}
                      </div>
                      {PLATFORM_CONFIGS[selectedPlatform].fields.map((field) => (
                        <div key={field.key}>
                          <label className="block text-sm font-medium text-gray-300 mb-2">
                            {field.label}
                            {field.required && <span className="text-red-400 ml-1">*</span>}
                          </label>

                          {field.type === 'select' ? (
                            <select
                              value={environment}
                              onChange={(e) => setEnvironment(e.target.value as 'demo' | 'production')}
                              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-emerald-500 transition-colors"
                            >
                              <option value="demo">Demo (Paper Trading)</option>
                              <option value="production">Production (Real Money)</option>
                            </select>
                          ) : (
                            <div className="relative">
                              <input
                                type={field.type === 'password' && !showPasswords[field.key] ? 'password' : 'text'}
                                value={credentials[field.key] || ''}
                                onChange={(e) => handleCredentialChange(field.key, e.target.value)}
                                placeholder={field.placeholder}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:border-emerald-500 transition-colors pr-10"
                              />
                              {field.type === 'password' && (
                                <button
                                  type="button"
                                  onClick={() => togglePasswordVisibility(field.key)}
                                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
                                >
                                  {showPasswords[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                              )}
                            </div>
                          )}

                          {field.helpText && (
                            <p className="mt-1.5 text-xs text-gray-500">{field.helpText}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Error Display */}
                  {(localError || apiError) && (
                    <div className="flex items-center gap-2 p-4 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      <span>{localError || apiError}</span>
                    </div>
                  )}
                </div>
              ) : null}
            </div>

            {/* Modal Footer */}
            {step === 'configure' && selectedPlatform && (
              <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-between">
                {/* Test Connection - hide for series mode */}
                {marketInputMode !== 'series' && (
                  <button
                    onClick={handleTestConnection}
                    disabled={isTesting || isCurrentlyConnecting}
                    className="text-sm text-gray-400 hover:text-gray-200 disabled:opacity-50 flex items-center gap-2"
                  >
                    {isTesting ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4" />
                    )}
                    Test Connection
                  </button>
                )}
                {marketInputMode === 'series' && <div />}

                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConnect}
                    disabled={isCurrentlyConnecting || (marketInputMode === 'series' && !selectedSeries)}
                    className={`flex items-center gap-2 px-6 py-2 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm font-medium ${
                      marketInputMode === 'series'
                        ? 'bg-purple-600 hover:bg-purple-500'
                        : 'bg-emerald-600 hover:bg-emerald-500'
                    }`}
                  >
                    {connectProgress ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Adding {connectProgress.current}/{connectProgress.total}...
                      </>
                    ) : isConnecting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Connecting...
                      </>
                    ) : marketInputMode === 'series' ? (
                      <>
                        <Layers className="w-4 h-4" />
                        Add Series{selectedSeries ? ` (${selectedSeries.market_count} markets)` : ''}
                      </>
                    ) : (
                      <>
                        <Link className="w-4 h-4" />
                        Connect{selectedEvent && selectedEvent.markets.length > 1 ? ` ${selectedEvent.markets.length} markets` : ''}
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
