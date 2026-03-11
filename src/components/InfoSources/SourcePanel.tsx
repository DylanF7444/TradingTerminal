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
  Loader2
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
    description: 'Stock, forex, and ETF market data',
    color: 'text-blue-400',
    defaultConfig: { tickers: 'SPY,AAPL', provider: 'yahoo' }
  },
  [InfoSourceType.CommodityPrices]: {
    label: 'Commodity Prices',
    icon: Activity,
    description: 'Gold, oil, agriculture futures',
    color: 'text-yellow-400',
    defaultConfig: { commodities: 'GOLD,OIL', unit: 'USD' }
  },
  [InfoSourceType.NewsSource]: {
    label: 'News Feed',
    icon: Newspaper,
    description: 'Real-time news and headline analysis',
    color: 'text-red-400',
    defaultConfig: { keywords: 'bitcoin,federal reserve', sources: 'reuters,bloomberg', sentiment_analysis: true }
  },
  [InfoSourceType.SocialMedia]: {
    label: 'Social Media',
    icon: MessageCircle,
    description: 'Twitter, Reddit sentiment tracking',
    color: 'text-purple-400',
    defaultConfig: { platform: 'twitter', keywords: 'btc,crypto', volume_threshold: 100 }
  },
  [InfoSourceType.Weather]: {
    label: 'Weather Data',
    icon: Cloud,
    description: 'Temperature, precipitation, forecasts',
    color: 'text-cyan-400',
    defaultConfig: { location: 'New York, NY', metrics: ['temperature', 'precipitation'] }
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
        keywords: config.keywords?.split(',').map((s: string) => s.trim()),
        // Convert storage_interval_seconds to storageIntervalMs for backend
        storageIntervalMs: config.storage_interval_seconds ? config.storage_interval_seconds * 1000 : 1000,
      };

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
              <label className={labelClass}>Keywords (comma-separated)</label>
              <input
                type="text"
                value={config.keywords || ''}
                onChange={(e) => handleConfigChange('keywords', e.target.value)}
                placeholder="bitcoin, federal reserve, inflation"
                className={commonInputClass}
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="sentiment"
                checked={config.sentiment_analysis}
                onChange={(e) => handleConfigChange('sentiment_analysis', e.target.checked)}
                className="rounded bg-gray-800 border-gray-700 text-blue-500"
              />
              <label htmlFor="sentiment" className="text-sm text-gray-300">Enable sentiment analysis</label>
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
                placeholder="City, Country or Lat, Lon"
                className={commonInputClass}
              />
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