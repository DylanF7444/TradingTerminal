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

import { useState, useCallback, useEffect } from 'react';
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
  Layers
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { MarketType, Node } from '../../types/nodes';
import { useTauriCommand } from '../../hooks/useTauriCommand';
import MarketBrowser from './MarketBrowser';
import type { SelectedEventMarket, EventSearchResult, SeriesChildMarket } from '../../types/markets';

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
  const [marketInputMode, setMarketInputMode] = useState<'search' | 'manual'>('search');
  const [environment, setEnvironment] = useState<'demo' | 'production'>('demo');
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});

  // Event-based market selection (from search)
  const [selectedEvent, setSelectedEvent] = useState<{
    eventId: string;
    eventTitle: string;
    markets: SelectedEventMarket[];
  } | null>(null);

  // Series event selection (entire event as single node)
  const [seriesEvent, setSeriesEvent] = useState<EventSearchResult | null>(null);

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
    execute: addMarket,
    loading: isConnecting,
    error: apiError,
    reset: resetAddMarket
  } = useTauriCommand<Node, {
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

  // Cleanup sensitive data on unmount or modal close
  const clearSensitiveData = useCallback(() => {
    setCredentials({});
    setSelectedEvent(null);
    setSeriesEvent(null);
    setManualMarketId('');
    setMarketInputMode('search');
    setLocalError(null);
    setSelectedPlatform(null);
    setStep('select');
    setShowPasswords({});
    setHasStoredKey(false);
    setUseStoredKey(true);
    setConnectProgress(null);
    resetAddMarket();
  }, [resetAddMarket]);

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
    if (seriesEvent) return true;
    if (marketInputMode === 'search') {
      return !!selectedEvent && selectedEvent.markets.length > 0;
    }
    return !!manualMarketId.trim();
  };

  // Validate credentials format client-side
  const validateCredentials = (platform: MarketType, creds: Record<string, string>): boolean => {
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

      const platformName = selectedPlatform === MarketType.Polymarket ? 'Polymarket' : 'Kalshi';

      if (seriesEvent) {
        // Series mode: create a single node representing the entire event
        const childMarkets: SeriesChildMarket[] = (seriesEvent.markets || []).map((m) => ({
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
          is_resolved: m.status === 'resolved' || m.status === 'closed',
        }));

        const firstMarket = seriesEvent.markets?.[0];
        const result = await addMarket({
          marketType: selectedPlatform,
          apiCredentials: credPayload,
          marketConfig: {
            market_id: firstMarket?.id || seriesEvent.id || '',
            question: seriesEvent.title || 'Series',
            token_ids: firstMarket?.token_ids || [],
            event_group_id: seriesEvent.id || '',
            event_title: seriesEvent.title || '',
          },
          marketDetails: {
            title: seriesEvent.title || undefined,
            description: seriesEvent.description || undefined,
            image_url: seriesEvent.image_url || undefined,
            category: seriesEvent.category || undefined,
            slug: seriesEvent.slug || undefined,
          },
        });

        if (result) {
          // Enrich metadata with series fields
          const enrichedMetadata = {
            ...(result.metadata || {}),
            is_series: true,
            series_event_id: seriesEvent.id || '',
            series_event_slug: seriesEvent.slug || '',
            series_event_title: seriesEvent.title || '',
            series_image_url: seriesEvent.image_url || null,
            series_category: seriesEvent.category || null,
            series_platform: platformName,
            series_markets: childMarkets,
            series_last_refreshed: Date.now(),
            series_refresh_interval: 60,
            series_hide_resolved: true,
          };

          // Persist enriched metadata to backend
          try {
            await invoke('update_data_source_cmd', {
              nodeId: result.id,
              config: enrichedMetadata,
            });
          } catch (persistErr) {
            console.error('Failed to persist series metadata:', persistErr);
          }

          const seriesNode = {
            ...result,
            metadata: enrichedMetadata,
          };
          onAddMarket?.(seriesNode);
          setIsModalOpen(false);
        }
      } else if (marketInputMode === 'manual') {
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

                  {/* Stored Key Indicator */}
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

                  {/* Market Selection - Search or Manual Entry */}
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
                      </div>
                    </div>

                    {marketInputMode === 'search' ? (
                      <div className="space-y-2">
                        <MarketBrowser
                          platform={selectedPlatform}
                          onSelectMarkets={(eventId, eventTitle, markets) => {
                            setSelectedEvent({ eventId, eventTitle, markets });
                            setSeriesEvent(null);
                            setLocalError(null);
                          }}
                          onAddAsSeries={(event) => {
                            setSeriesEvent(event);
                            setSelectedEvent(null);
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
                        {seriesEvent && (
                          <div className="p-2.5 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                            <div className="flex items-center gap-2">
                              <Layers className="w-4 h-4 text-blue-400 flex-shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="text-sm text-blue-300 truncate">{seriesEvent.title}</p>
                                <p className="text-xs text-gray-500">
                                  Series: {seriesEvent.market_count} market{seriesEvent.market_count !== 1 ? 's' : ''} (auto-updating)
                                </p>
                              </div>
                              <button
                                onClick={() => setSeriesEvent(null)}
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

                  {/* Credential Fields - show if no stored key or user wants to enter new */}
                  {(!hasStoredKey || !useStoredKey) && (
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

                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConnect}
                    disabled={isCurrentlyConnecting}
                    className="flex items-center gap-2 px-6 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm font-medium"
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
