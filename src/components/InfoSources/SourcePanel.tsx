// ============================================================================
// SourcePanel.tsx - Information source management panel
// ============================================================================
//
// Provides the UI for adding, viewing, and removing data source nodes
// (crypto prices, news, weather, social media, livestreams, etc.) in
// the trading strategy graph. Displays a list of active sources with
// connection status, and a modal flow for adding new sources with
// type-specific configuration forms.
//
// Flow: user selects source type from a grid of cards, fills in the
// dynamic config form, and submits via the Tauri add_data_source_cmd
// backend command. The new node is added to the Zustand store and
// rendered on the canvas.
//
// Key props: onAddSource, existingSources, className.
//
// Source type metadata (icons, colors, default configs) is defined
// inline in SOURCE_TYPE_METADATA.
//
// ============================================================================

import { useState, useCallback, useEffect } from 'react';
import { 
  Bitcoin, 
  Newspaper, 
  Cloud, 
  MessageCircle, 
  TrendingUp, 
  Video, 
  Plus, 
  Trash2, 
  Activity,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Users
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { InfoSourceType, Node } from '../../types/nodes';
import { useTauriCommand } from '../../hooks/useTauriCommand';

interface SourcePanelProps {
  onAddSource?: (node: Node) => void;
  existingSources?: Node[];
  className?: string;
}

// Type metadata for UI rendering
const SOURCE_TYPE_METADATA: Record<InfoSourceType, {
  label: string;
  icon: React.ElementType;
  description: string;
  color: string;
  defaultConfig: any;
}> = {
  [InfoSourceType.CryptoPrices]: {
    label: 'Crypto Prices',
    icon: Bitcoin,
    description: 'Real-time cryptocurrency price feeds via WebSocket',
    color: 'text-orange-400',
    defaultConfig: { symbols: 'BTC-USD,ETH-USD', storage_interval_seconds: 1, provider: 'coinbase' }
  },
  [InfoSourceType.FinancialPrices]: {
    label: 'Financial Prices',
    icon: TrendingUp,
    description: 'Real-time stock and forex prices via Finnhub WebSocket',
    color: 'text-blue-400',
    defaultConfig: { symbols: 'AAPL,MSFT,GOOGL', provider: 'finnhub', storage_interval_seconds: 1 }
  },
  [InfoSourceType.CommodityPrices]: {
    label: 'Commodity Prices',
    icon: Activity,
    description: 'Real-time gold, silver, and commodity prices via WebSocket',
    color: 'text-yellow-400',
    defaultConfig: { symbols: 'OANDA:XAU_USD,OANDA:XAG_USD', provider: 'finnhub', storage_interval_seconds: 1 }
  },
  [InfoSourceType.NewsSource]: {
    label: 'News Feed',
    icon: Newspaper,
    description: 'Real-time news headlines from major outlets',
    color: 'text-red-400',
    defaultConfig: { sources: [], keywords: '', update_interval_seconds: 300 }
  },
  [InfoSourceType.SocialMedia]: {
    label: 'Social Media',
    icon: MessageCircle,
    description: 'Reddit, Twitter/X, and Hacker News social signal tracking',
    color: 'text-purple-400',
    defaultConfig: { platforms: ['reddit'], category: 'crypto', subreddits: 'CryptoCurrency, Bitcoin', twitter_accounts: '', keywords: '', update_interval_seconds: 60 }
  },
  [InfoSourceType.Weather]: {
    label: 'Weather Data',
    icon: Cloud,
    description: 'Real-time weather conditions and 7-day forecasts via Open-Meteo',
    color: 'text-cyan-400',
    defaultConfig: { location: 'New York', temperature_unit: 'fahrenheit', wind_speed_unit: 'mph', metrics: ['temperature', 'humidity', 'wind_speed', 'precipitation', 'pressure', 'uv_index'], update_interval_seconds: 600 }
  },
  [InfoSourceType.Livestream]: {
    label: 'Livestream',
    icon: Video,
    description: 'Video/audio stream monitoring (OCR, transcription)',
    color: 'text-pink-400',
    defaultConfig: { url: '', analysis_type: 'ocr' }
  },
  [InfoSourceType.EconomicIndicators]: {
    label: 'Economic Indicators',
    icon: TrendingUp,
    description: 'CPI, unemployment, GDP data',
    color: 'text-emerald-400',
    defaultConfig: { indicators: 'CPI,unemployment', country: 'US' }
  },
  [InfoSourceType.OnChainData]: {
    label: 'On-Chain Data',
    icon: Activity,
    description: 'Blockchain metrics and analytics',
    color: 'text-indigo-400',
    defaultConfig: { metrics: 'volume,gas', network: 'ethereum' }
  },
  [InfoSourceType.CustomAPI]: {
    label: 'Custom API',
    icon: Cloud,
    description: 'User-defined API endpoint',
    color: 'text-gray-400',
    defaultConfig: { endpoint: '', headers: {}, refresh_interval: 60 }
  },
  [InfoSourceType.PolymarketUserTrades]: {
    label: 'Polymarket User Trades',
    icon: Users,
    description: 'Track trades from specific Polymarket wallets (whale tracking)',
    color: 'text-violet-400',
    defaultConfig: { user_address: '', update_interval_seconds: 30 }
  }
};

export default function SourcePanel({ 
  onAddSource, 
  existingSources = [],
  className = '' 
}: SourcePanelProps) {
  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<InfoSourceType | null>(null);
  const [config, setConfig] = useState<any>({});
  const [localError, setLocalError] = useState<string | null>(null);
  
  // Use custom hook for backend communication
  const { execute: addSource, loading: isSubmitting, error: apiError } = useTauriCommand<Node, {
    sourceType: string;
    config: Record<string, any>;
  }>('add_data_source_cmd');

  // Reset state when modal opens/closes
  useEffect(() => {
    if (!isModalOpen) {
      setSelectedType(null);
      setConfig({});
      setLocalError(null);
    }
  }, [isModalOpen]);

  // Handle type selection
  const handleTypeSelect = useCallback((type: InfoSourceType) => {
    setSelectedType(type);
    setConfig(SOURCE_TYPE_METADATA[type].defaultConfig);
  }, []);

  // Handle config changes
  const handleConfigChange = useCallback((key: string, value: any) => {
    setConfig((prev: any) => ({ ...prev, [key]: value }));
  }, []);

  // Validate and submit
  const handleSubmit = useCallback(async () => {
    if (!selectedType) return;

    // Basic validation
    if (selectedType === InfoSourceType.CryptoPrices && !config.symbols) {
      setLocalError('Please enter at least one cryptocurrency symbol');
      return;
    }

    // Validate Coinbase symbol format (must be BTC-USD, not BTC)
    if (selectedType === InfoSourceType.CryptoPrices && config.provider === 'coinbase') {
      const symbols = config.symbols?.split(',').map((s: string) => s.trim()) || [];
      const invalidSymbols = symbols.filter((s: string) => !s.includes('-'));
      if (invalidSymbols.length > 0) {
        setLocalError(`Coinbase symbols must include currency pair (e.g., BTC-USD). Invalid: ${invalidSymbols.join(', ')}`);
        return;
      }
    }

    if (selectedType === InfoSourceType.FinancialPrices && !config.symbols) {
      setLocalError('Please enter at least one symbol');
      return;
    }

    if (selectedType === InfoSourceType.FinancialPrices && config.provider === 'finnhub' && !config.api_key) {
      setLocalError('Finnhub API key is required. Get a free key at finnhub.io');
      return;
    }

    if (selectedType === InfoSourceType.CommodityPrices && !config.symbols) {
      setLocalError('Please enter at least one commodity symbol');
      return;
    }

    if (selectedType === InfoSourceType.CommodityPrices && config.provider === 'finnhub' && !config.api_key) {
      setLocalError('Finnhub API key is required for commodity prices. Get a free key at finnhub.io');
      return;
    }
    
    if (selectedType === InfoSourceType.Livestream && !config.url) {
      setLocalError('Please enter a valid stream URL');
      return;
    }

    try {
      // Transform config for backend (arrays from comma-separated strings)
      const transformedConfig = {
        ...config,
        symbols: config.symbols?.split(',').map((s: string) => s.trim()),
        tickers: config.tickers?.split(',').map((s: string) => s.trim()),
        keywords: config.keywords?.trim() ? config.keywords.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
        // Convert storage_interval_seconds to storageIntervalMs for backend
        storageIntervalMs: config.storage_interval_seconds ? config.storage_interval_seconds * 1000 : 1000,
      };

      // SocialMedia-specific: split comma-separated subreddits and accounts into arrays
      if (selectedType === InfoSourceType.SocialMedia) {
        transformedConfig.subreddits = config.subreddits?.trim()
          ? config.subreddits.split(',').map((s: string) => s.trim()).filter(Boolean)
          : [];
        transformedConfig.twitter_accounts = config.twitter_accounts?.trim()
          ? config.twitter_accounts.split(',').map((s: string) => s.trim().replace(/^@/, '')).filter(Boolean)
          : [];
        transformedConfig.platforms = config.platforms || ['reddit'];
      }

      const result = await addSource({
        sourceType: selectedType as string,
        config: transformedConfig
      });

      if (result) {
        onAddSource?.(result);
        setIsModalOpen(false);
      }
    } catch (err) {
      console.error('Failed to add source:', err);
    }
  }, [selectedType, config, addSource, onAddSource]);

  // Remove source handler
  const handleRemove = useCallback(async (nodeId: string) => {
    if (!confirm('Are you sure you want to remove this data source?')) return;
    
    try {
      await invoke('remove_data_source_cmd', { nodeId });
      // Parent should refresh the existingSources prop
    } catch (err) {
      console.error('Failed to remove source:', err);
    }
  }, []);

  // Render configuration form based on type
  const renderConfigForm = () => {
    if (!selectedType) return null;

    const commonInputClass = "w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-blue-500 transition-colors";
    const labelClass = "block text-sm font-medium text-gray-400 mb-1";

    switch (selectedType) {
      case InfoSourceType.CryptoPrices:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Provider</label>
              <select
                value={config.provider || 'coinbase'}
                onChange={(e) => handleConfigChange('provider', e.target.value)}
                className={commonInputClass}
              >
                <option value="coinbase">Coinbase (WebSocket - Real-time)</option>
                <option value="coingecko">CoinGecko (HTTP Polling)</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {config.provider === 'coinbase' 
                  ? 'WebSocket connection for real-time price updates'
                  : 'HTTP polling with 5-second intervals'}
              </p>
            </div>
            <div>
              <label className={labelClass}>
                Symbols (comma-separated)
                {config.provider === 'coinbase' && (
                  <span className="text-xs text-gray-500 ml-1">(use BTC-USD format)</span>
                )}
              </label>
              <input
                type="text"
                value={config.symbols || ''}
                onChange={(e) => handleConfigChange('symbols', e.target.value)}
                placeholder={config.provider === 'coinbase' ? "BTC-USD, ETH-USD, SOL-USD" : "BTC, ETH, SOL"}
                className={commonInputClass}
              />
            </div>
            {config.provider === 'coinbase' && (
              <div>
                <label className={labelClass}>
                  Database Storage Interval (seconds)
                  <span className="text-xs text-gray-500 ml-1">(raw stream updates in real-time)</span>
                </label>
                <input
                  type="range"
                  min="1"
                  max="300"
                  step="1"
                  value={config.storage_interval_seconds || 1}
                  onChange={(e) => handleConfigChange('storage_interval_seconds', parseInt(e.target.value))}
                  className="w-full"
                />
                <span className="text-sm text-gray-500">{config.storage_interval_seconds || 1}s</span>
                <p className="text-xs text-gray-600 mt-1">
                  Price updates are displayed in real-time in the raw stream tab. 
                  Database writes happen at this interval to reduce disk I/O.
                </p>
              </div>
            )}
            {config.provider !== 'coinbase' && (
              <div>
                <label className={labelClass}>Polling Interval (seconds)</label>
                <input
                  type="range"
                  min="5"
                  max="300"
                  step="5"
                  value={config.update_interval_seconds || 30}
                  onChange={(e) => handleConfigChange('update_interval_seconds', parseInt(e.target.value))}
                  className="w-full"
                />
                <span className="text-sm text-gray-500">{config.update_interval_seconds || 30}s</span>
              </div>
            )}
          </div>
        );

      case InfoSourceType.NewsSource:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>News Sources</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'abc_news', label: 'ABC News' },
                  { value: 'al_jazeera', label: 'Al Jazeera' },
                  { value: 'ap_news', label: 'Associated Press' },
                  { value: 'bbc', label: 'BBC' },
                  { value: 'cnn', label: 'CNN' },
                  { value: 'yahoo_finance', label: 'Yahoo Finance' },
                ].map((source) => (
                  <label key={source.value} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={(config.sources || []).includes(source.value)}
                      onChange={(e) => {
                        const current = config.sources || [];
                        if (e.target.checked) {
                          handleConfigChange('sources', [...current, source.value]);
                        } else {
                          handleConfigChange('sources', current.filter((s: string) => s !== source.value));
                        }
                      }}
                      className="rounded bg-gray-800 border-gray-700 text-blue-500"
                    />
                    {source.label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-1">Leave all unchecked to monitor all sources</p>
            </div>
            <div>
              <label className={labelClass}>Keywords (optional, comma-separated)</label>
              <input
                type="text"
                value={config.keywords || ''}
                onChange={(e) => handleConfigChange('keywords', e.target.value)}
                placeholder="bitcoin, federal reserve, inflation"
                className={commonInputClass}
              />
              <p className="text-xs text-gray-500 mt-1">Filter headlines by keyword. Leave empty for all headlines.</p>
            </div>
            <div>
              <label className={labelClass}>Update Interval</label>
              <input
                type="range"
                min="60"
                max="1800"
                step="60"
                value={config.update_interval_seconds || 300}
                onChange={(e) => handleConfigChange('update_interval_seconds', parseInt(e.target.value))}
                className="w-full"
              />
              <span className="text-sm text-gray-400">{config.update_interval_seconds || 300}s ({Math.round((config.update_interval_seconds || 300) / 60)} min)</span>
            </div>
          </div>
        );

      case InfoSourceType.Weather:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Location</label>
              <input
                type="text"
                value={config.location || ''}
                onChange={(e) => handleConfigChange('location', e.target.value)}
                placeholder="New York, London, Tokyo..."
                className={commonInputClass}
              />
              <p className="text-xs text-gray-500 mt-1">City name — geocoded automatically via Open-Meteo (free, no API key)</p>
            </div>

            <div>
              <label className={labelClass}>Metrics to Track</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'temperature', label: 'Temperature' },
                  { value: 'humidity', label: 'Humidity' },
                  { value: 'wind_speed', label: 'Wind Speed' },
                  { value: 'precipitation', label: 'Precipitation' },
                  { value: 'pressure', label: 'Pressure' },
                  { value: 'uv_index', label: 'UV Index' },
                ].map((metric) => (
                  <label key={metric.value} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={(config.metrics || []).includes(metric.value)}
                      onChange={(e) => {
                        const current = config.metrics || [];
                        if (e.target.checked) {
                          handleConfigChange('metrics', [...current, metric.value]);
                        } else {
                          handleConfigChange('metrics', current.filter((m: string) => m !== metric.value));
                        }
                      }}
                      className="rounded bg-gray-800 border-gray-700 text-cyan-500"
                    />
                    {metric.label}
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className={labelClass}>Temperature Unit</label>
                <select
                  value={config.temperature_unit || 'fahrenheit'}
                  onChange={(e) => handleConfigChange('temperature_unit', e.target.value)}
                  className={commonInputClass}
                >
                  <option value="fahrenheit">Fahrenheit</option>
                  <option value="celsius">Celsius</option>
                </select>
              </div>
              <div>
                <label className={labelClass}>Wind Speed Unit</label>
                <select
                  value={config.wind_speed_unit || 'mph'}
                  onChange={(e) => handleConfigChange('wind_speed_unit', e.target.value)}
                  className={commonInputClass}
                >
                  <option value="mph">mph</option>
                  <option value="kmh">km/h</option>
                  <option value="ms">m/s</option>
                  <option value="kn">knots</option>
                </select>
              </div>
            </div>

            <div>
              <label className={labelClass}>Update Interval</label>
              <input
                type="range"
                min="300"
                max="3600"
                step="300"
                value={config.update_interval_seconds || 600}
                onChange={(e) => handleConfigChange('update_interval_seconds', parseInt(e.target.value))}
                className="w-full"
              />
              <span className="text-sm text-gray-400">{config.update_interval_seconds || 600}s ({Math.round((config.update_interval_seconds || 600) / 60)} min)</span>
              <p className="text-xs text-gray-500 mt-1">Includes current conditions + 7-day forecast on each update</p>
            </div>
          </div>
        );

      case InfoSourceType.Livestream:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Stream URL</label>
              <input
                type="url"
                value={config.url || ''}
                onChange={(e) => handleConfigChange('url', e.target.value)}
                placeholder="https://..."
                className={commonInputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Analysis Type</label>
              <select
                value={config.analysis_type}
                onChange={(e) => handleConfigChange('analysis_type', e.target.value)}
                className={commonInputClass}
              >
                <option value="ocr">OCR (Text Recognition)</option>
                <option value="audio">Audio Transcription</option>
                <option value="chat">Chat/Comments</option>
              </select>
            </div>
          </div>
        );

      case InfoSourceType.SocialMedia: {
        const curatedMap: Record<string, { subreddits: string; accounts: string }> = {
          crypto: { subreddits: 'CryptoCurrency, Bitcoin, ethereum, solana', accounts: 'whale_alert, CoinDesk, WatcherGuru' },
          politics: { subreddits: 'politics, PoliticalDiscussion, Conservative, neoliberal', accounts: 'POTUS, RealClearNews' },
          sports: { subreddits: 'nba, nfl, soccer, sportsbook', accounts: 'SportsCenter, wojespn, AdamSchefter' },
          economics: { subreddits: 'wallstreetbets, stocks, economics, investing', accounts: 'markets, business' },
          science: { subreddits: 'science, climate, space', accounts: 'NASA, NOAA' },
          tech: { subreddits: 'technology, programming, artificial', accounts: '' },
          world: { subreddits: 'worldnews, geopolitics', accounts: 'Reuters, AP' },
          entertainment: { subreddits: 'entertainment, movies, television', accounts: '' },
        };

        return (
          <div className="space-y-4">
            {/* Platform Selection */}
            <div>
              <label className={labelClass}>Platforms</label>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'reddit', label: 'Reddit (Free)' },
                  { value: 'twitter', label: 'X/Twitter (Nitter RSS)' },
                  { value: 'hackernews', label: 'Hacker News (Free)' },
                ].map((platform) => (
                  <label key={platform.value} className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={(config.platforms || ['reddit']).includes(platform.value)}
                      onChange={(e) => {
                        const current = config.platforms || ['reddit'];
                        if (e.target.checked) {
                          handleConfigChange('platforms', [...current, platform.value]);
                        } else {
                          handleConfigChange('platforms', current.filter((p: string) => p !== platform.value));
                        }
                      }}
                      className="rounded bg-gray-800 border-gray-700 text-purple-500"
                    />
                    {platform.label}
                  </label>
                ))}
              </div>
              <p className="text-xs text-gray-500 mt-1">All platforms use free public APIs — no API keys required</p>
            </div>

            {/* Market Category Quick-Select */}
            <div>
              <label className={labelClass}>Market Category</label>
              <select
                value={config.category || ''}
                onChange={(e) => {
                  const category = e.target.value;
                  handleConfigChange('category', category);
                  if (curatedMap[category]) {
                    handleConfigChange('subreddits', curatedMap[category].subreddits);
                    handleConfigChange('twitter_accounts', curatedMap[category].accounts);
                  }
                }}
                className={commonInputClass}
              >
                <option value="">Custom (enter manually)</option>
                <option value="crypto">Crypto</option>
                <option value="politics">Politics</option>
                <option value="sports">Sports</option>
                <option value="economics">Economics / Finance</option>
                <option value="science">Science / Climate</option>
                <option value="tech">Tech</option>
                <option value="world">World Events</option>
                <option value="entertainment">Entertainment</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">Auto-populates recommended subreddits and accounts for this category</p>
            </div>

            {/* Reddit Subreddits */}
            {(config.platforms || ['reddit']).includes('reddit') && (
              <div>
                <label className={labelClass}>Subreddits (comma-separated)</label>
                <input
                  type="text"
                  value={config.subreddits || ''}
                  onChange={(e) => handleConfigChange('subreddits', e.target.value)}
                  placeholder="CryptoCurrency, Bitcoin, wallstreetbets"
                  className={commonInputClass}
                />
                <p className="text-xs text-gray-500 mt-1">
                  No API key needed. Uses Reddit's public JSON API.
                </p>
              </div>
            )}

            {/* Twitter/X Accounts */}
            {(config.platforms || []).includes('twitter') && (
              <div>
                <label className={labelClass}>X/Twitter Accounts (comma-separated)</label>
                <input
                  type="text"
                  value={config.twitter_accounts || ''}
                  onChange={(e) => handleConfigChange('twitter_accounts', e.target.value)}
                  placeholder="@whale_alert, @Reuters, @CoinDesk"
                  className={commonInputClass}
                />
                <p className="text-xs text-gray-500 mt-1">
                  Uses Nitter RSS (free, no API key). Falls back across multiple instances.
                </p>
              </div>
            )}

            {/* Keywords */}
            <div>
              <label className={labelClass}>Keywords (optional, comma-separated)</label>
              <input
                type="text"
                value={config.keywords || ''}
                onChange={(e) => handleConfigChange('keywords', e.target.value)}
                placeholder="bitcoin, election, inflation"
                className={commonInputClass}
              />
              <p className="text-xs text-gray-500 mt-1">Filter posts by keyword. Leave empty for all posts.</p>
            </div>

            {/* Update Interval */}
            <div>
              <label className={labelClass}>Update Interval</label>
              <input
                type="range"
                min="30"
                max="600"
                step="30"
                value={config.update_interval_seconds || 60}
                onChange={(e) => handleConfigChange('update_interval_seconds', parseInt(e.target.value))}
                className="w-full"
              />
              <span className="text-sm text-gray-400">{config.update_interval_seconds || 60}s ({Math.round((config.update_interval_seconds || 60) / 60)} min)</span>
            </div>
          </div>
        );
      }

      case InfoSourceType.FinancialPrices:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Provider</label>
              <select
                value={config.provider || 'finnhub'}
                onChange={(e) => handleConfigChange('provider', e.target.value)}
                className={commonInputClass}
              >
                <option value="finnhub">Finnhub (WebSocket - Real-time)</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                Real-time trade data via Finnhub WebSocket. Free API key required from finnhub.io
              </p>
            </div>
            <div>
              <label className={labelClass}>API Key</label>
              <input
                type="password"
                value={config.api_key || ''}
                onChange={(e) => handleConfigChange('api_key', e.target.value)}
                placeholder="Your Finnhub API key (free at finnhub.io)"
                className={commonInputClass}
              />
              <p className="text-xs text-gray-500 mt-1">
                Get a free API key at <span className="text-blue-400">finnhub.io</span> — supports up to 50 symbols
              </p>
            </div>
            <div>
              <label className={labelClass}>Asset Type</label>
              <select
                value={config.asset_type || 'stocks'}
                onChange={(e) => {
                  const assetType = e.target.value;
                  handleConfigChange('asset_type', assetType);
                  const presets: Record<string, string> = {
                    stocks: 'AAPL,MSFT,GOOGL,AMZN,TSLA',
                    etfs: 'SPY,QQQ,IWM,DIA,VTI',
                    forex: 'OANDA:EUR_USD,OANDA:GBP_USD,OANDA:USD_JPY,OANDA:AUD_USD',
                    indices: 'BINANCE:BTCUSDT',
                  };
                  if (presets[assetType]) {
                    handleConfigChange('symbols', presets[assetType]);
                  }
                }}
                className={commonInputClass}
              >
                <option value="stocks">US Stocks</option>
                <option value="etfs">ETFs</option>
                <option value="forex">Forex Pairs</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>
                Symbols (comma-separated)
                <span className="text-xs text-gray-500 ml-1">
                  {config.asset_type === 'forex' ? '(use OANDA:EUR_USD format)' : '(e.g., AAPL, MSFT)'}
                </span>
              </label>
              <input
                type="text"
                value={config.symbols || ''}
                onChange={(e) => handleConfigChange('symbols', e.target.value)}
                placeholder={config.asset_type === 'forex' ? "OANDA:EUR_USD, OANDA:GBP_USD" : "AAPL, MSFT, GOOGL"}
                className={commonInputClass}
              />
              <p className="text-xs text-gray-500 mt-1">
                Stocks: AAPL, MSFT | Forex: OANDA:EUR_USD | Max 50 symbols on free tier
              </p>
            </div>
            <div>
              <label className={labelClass}>
                Database Storage Interval (seconds)
                <span className="text-xs text-gray-500 ml-1">(raw stream updates in real-time)</span>
              </label>
              <input
                type="range"
                min="1"
                max="300"
                step="1"
                value={config.storage_interval_seconds || 1}
                onChange={(e) => handleConfigChange('storage_interval_seconds', parseInt(e.target.value))}
                className="w-full"
              />
              <span className="text-sm text-gray-500">{config.storage_interval_seconds || 1}s</span>
            </div>
          </div>
        );

      case InfoSourceType.CommodityPrices:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Provider</label>
              <select
                value={config.provider || 'finnhub'}
                onChange={(e) => {
                  const provider = e.target.value;
                  handleConfigChange('provider', provider);
                  const presets: Record<string, string> = {
                    finnhub: 'OANDA:XAU_USD,OANDA:XAG_USD',
                    binance: 'PAXGUSDT',
                  };
                  if (presets[provider]) {
                    handleConfigChange('symbols', presets[provider]);
                  }
                }}
                className={commonInputClass}
              >
                <option value="finnhub">Finnhub (Gold/Silver via Forex - Real-time)</option>
                <option value="binance">Binance (PAXG Gold Token - No API key)</option>
              </select>
              <p className="text-xs text-gray-500 mt-1">
                {config.provider === 'binance'
                  ? 'PAXG is a tokenized gold asset (1 PAXG = 1 troy ounce). No API key needed.'
                  : 'Precious metals via OANDA forex pairs. Free API key required from finnhub.io'}
              </p>
            </div>
            {config.provider !== 'binance' && (
              <div>
                <label className={labelClass}>API Key</label>
                <input
                  type="password"
                  value={config.api_key || ''}
                  onChange={(e) => handleConfigChange('api_key', e.target.value)}
                  placeholder="Your Finnhub API key (free at finnhub.io)"
                  className={commonInputClass}
                />
              </div>
            )}
            <div>
              <label className={labelClass}>Commodity Preset</label>
              <select
                value={config.commodity_preset || 'precious_metals'}
                onChange={(e) => {
                  const preset = e.target.value;
                  handleConfigChange('commodity_preset', preset);
                  if (config.provider === 'binance') {
                    handleConfigChange('symbols', 'PAXGUSDT');
                  } else {
                    const presets: Record<string, string> = {
                      precious_metals: 'OANDA:XAU_USD,OANDA:XAG_USD',
                      gold_only: 'OANDA:XAU_USD',
                      silver_only: 'OANDA:XAG_USD',
                      metals_and_forex: 'OANDA:XAU_USD,OANDA:XAG_USD,OANDA:EUR_USD,OANDA:GBP_USD',
                    };
                    if (presets[preset]) {
                      handleConfigChange('symbols', presets[preset]);
                    }
                  }
                }}
                className={commonInputClass}
              >
                {config.provider === 'binance' ? (
                  <option value="paxg">PAXG (Tokenized Gold)</option>
                ) : (
                  <>
                    <option value="precious_metals">Gold + Silver (XAU + XAG)</option>
                    <option value="gold_only">Gold Only (XAU/USD)</option>
                    <option value="silver_only">Silver Only (XAG/USD)</option>
                    <option value="metals_and_forex">Metals + Major Forex</option>
                  </>
                )}
              </select>
            </div>
            <div>
              <label className={labelClass}>
                Symbols (comma-separated)
                <span className="text-xs text-gray-500 ml-1">
                  {config.provider === 'binance' ? '(Binance pair format)' : '(OANDA forex pair format)'}
                </span>
              </label>
              <input
                type="text"
                value={config.symbols || ''}
                onChange={(e) => handleConfigChange('symbols', e.target.value)}
                placeholder={config.provider === 'binance' ? "PAXGUSDT" : "OANDA:XAU_USD, OANDA:XAG_USD"}
                className={commonInputClass}
              />
              <p className="text-xs text-gray-500 mt-1">
                {config.provider === 'binance'
                  ? 'Binance symbols: PAXGUSDT (gold)'
                  : 'Gold: OANDA:XAU_USD | Silver: OANDA:XAG_USD | Platinum: OANDA:XPT_USD'}
              </p>
            </div>
            <div>
              <label className={labelClass}>
                Database Storage Interval (seconds)
                <span className="text-xs text-gray-500 ml-1">(raw stream updates in real-time)</span>
              </label>
              <input
                type="range"
                min="1"
                max="300"
                step="1"
                value={config.storage_interval_seconds || 1}
                onChange={(e) => handleConfigChange('storage_interval_seconds', parseInt(e.target.value))}
                className="w-full"
              />
              <span className="text-sm text-gray-500">{config.storage_interval_seconds || 1}s</span>
            </div>
          </div>
        );

      default:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Configuration JSON</label>
              <textarea
                value={JSON.stringify(config, null, 2)}
                onChange={(e) => {
                  try {
                    setConfig(JSON.parse(e.target.value));
                  } catch {}
                }}
                className={`${commonInputClass} font-mono text-xs h-32`}
              />
            </div>
          </div>
        );
    }
  };

  return (
    <div className={`bg-gray-900 rounded-lg border border-gray-800 overflow-hidden ${className}`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
          <Activity className="w-4 h-4 text-blue-400" />
          Data Sources
        </h3>
        <span className="text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded-full">
          {existingSources.length} active
        </span>
      </div>

      {/* Existing Sources List */}
      <div className="max-h-64 overflow-y-auto">
        {existingSources.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
            No data sources connected
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {existingSources.map((source) => {
              // Check if node is an InfoSource type and extract the type
              let type: InfoSourceType | null = null;
              if ('InfoSource' in source.node_type) {
                type = source.node_type.InfoSource;
              }
              const meta = type ? SOURCE_TYPE_METADATA[type] : null;
              const Icon = meta?.icon || Activity;
              // Use quality.successRate from metadata to determine connection status
              // Cast metadata to access quality field
              const sourceMetadata = source.metadata as Record<string, any>;
              const quality = sourceMetadata?.quality;
              const isConnected = quality?.successRate !== undefined && quality.successRate > 0.5;
              const latency = quality?.avgLatency;

              return (
                <div 
                  key={source.id} 
                  className="px-4 py-3 flex items-center justify-between hover:bg-gray-800/50 transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg bg-gray-800 ${meta?.color || 'text-gray-400'}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-200">
                        {source.name || meta?.label || 'Unknown'}
                      </div>
                      <div className="text-xs text-gray-500 flex items-center gap-1">
                        <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'}`} />
                        {isConnected ? 'Active' : 'Connecting...'}
                        {latency !== undefined && (
                          <span className="text-blue-400 ml-1">{latency.toFixed(0)}ms</span>
                        )}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleRemove(source.id)}
                    className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-400/10 rounded transition-all"
                    title="Remove source"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
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
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          Add Data Source
        </button>
      </div>

      {/* Add Source Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-gray-900 rounded-xl border border-gray-800 shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">
                {selectedType ? 'Configure Source' : 'Select Source Type'}
              </h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6">
              {(!selectedType) ? (
                // Type Selection Grid
                <div className="grid grid-cols-2 gap-3">
                  {Object.entries(SOURCE_TYPE_METADATA).map(([type, meta]) => (
                    <button
                      key={type}
                      onClick={() => handleTypeSelect(type as InfoSourceType)}
                      className="p-4 rounded-lg border border-gray-800 hover:border-gray-600 hover:bg-gray-800/50 transition-all text-left group"
                    >
                      <div className={`p-2 w-fit rounded-lg bg-gray-800 mb-3 group-hover:scale-110 transition-transform ${meta.color}`}>
                        <meta.icon className="w-5 h-5" />
                      </div>
                      <div className="font-medium text-gray-200 mb-1">{meta.label}</div>
                      <div className="text-xs text-gray-500 leading-relaxed">
                        {meta.description}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                // Configuration Form
                <div className="space-y-6">
                  <div className="flex items-center gap-3 pb-4 border-b border-gray-800">
                    <button
                      onClick={() => setSelectedType(null)}
                      className="text-sm text-gray-500 hover:text-gray-300"
                    >
                      ← Back
                    </button>
                    <div className={`p-2 rounded-lg bg-gray-800 ${SOURCE_TYPE_METADATA[selectedType].color}`}>
                      {(() => {
                        const Icon = SOURCE_TYPE_METADATA[selectedType].icon;
                        return <Icon className="w-5 h-5" />;
                      })()}
                    </div>
                    <div>
                      <div className="font-medium text-white">{SOURCE_TYPE_METADATA[selectedType].label}</div>
                      <div className="text-xs text-gray-500">Configure connection settings</div>
                    </div>
                  </div>

                  {renderConfigForm()}

                  {(localError || apiError) && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      {localError || apiError}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            {selectedType && (
              <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-end gap-3">
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm font-medium"
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      Add Source
                    </>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}