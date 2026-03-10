// ============================================================================
// SourceTypes.tsx - Central registry for information source type definitions
// ============================================================================
//
// Defines metadata, configuration schemas, default values, validators, and
// optional transformers for every supported InfoSourceType. Acts as the
// single source of truth consumed by SourcePanel (form generation) and
// Node.tsx (icon/color rendering).
//
// Adding a new source type requires only adding an entry to
// SOURCE_TYPE_DEFINITIONS and implementing the backend scraper.
//
// Key exports: SOURCE_TYPE_DEFINITIONS, getSourceTypeConfig,
// getDefaultConfig, validateSourceConfig, transformConfigForBackend,
// getAllSourceTypes, isFieldVisible.
//
// ============================================================================

import { 
  Bitcoin, 
  TrendingUp, 
  Activity, 
  Newspaper, 
  MessageCircle, 
  Cloud, 
  Video, 
  type LucideIcon 
} from 'lucide-react';
import { InfoSourceType } from '../../types/nodes';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type ConfigFieldType = 
  | 'text' 
  | 'number' 
  | 'range' 
  | 'select' 
  | 'multiselect' 
  | 'checkbox' 
  | 'textarea'
  | 'password';

export interface ConfigField {
  field: string;
  type: ConfigFieldType;
  label: string;
  placeholder?: string;
  required?: boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string | number; label: string }>;
  validation?: (value: any) => string | null; // Returns error message or null
  helpText?: string;
  advanced?: boolean;
  secret?: boolean; // For API keys (masked input)
}

export interface SourceTypeMetadata {
  label: string;
  icon: LucideIcon;
  description: string;
  color: string; // Tailwind text color class
  bgColor: string; // Tailwind bg color class
}

export interface SourceTypeDefinition {
  metadata: SourceTypeMetadata;
  configSchema: ConfigField[];
  defaults: Record<string, any>;
  validator: (config: Record<string, any>) => { valid: boolean; errors: Record<string, string> };
  transformer?: (config: Record<string, any>) => Record<string, any>; // Frontend → Backend
}

// ============================================================================
// CONFIGURATION SCHEMAS
// ============================================================================

export const SOURCE_TYPE_DEFINITIONS: Record<InfoSourceType, SourceTypeDefinition> = {
  [InfoSourceType.CryptoPrices]: {
    metadata: {
      label: 'Crypto Prices',
      icon: Bitcoin,
      description: 'Real-time cryptocurrency price feeds from major exchanges',
      color: 'text-orange-400',
      bgColor: 'bg-orange-500'
    },
    configSchema: [
      {
        field: 'symbols',
        type: 'text',
        label: 'Trading Pairs',
        placeholder: 'BTC, ETH, SOL, ADA',
        required: true,
        validation: (val: string) => {
          if (!val || val.trim().length < 2) return 'Enter at least one symbol';
          if (!/^[A-Z0-9,\s]+$/.test(val)) return 'Invalid symbols (uppercase letters/numbers only)';
          return null;
        },
        helpText: 'Comma-separated list of cryptocurrency symbols (e.g., BTC, ETH)'
      },
      {
        field: 'update_interval_seconds',
        type: 'range',
        label: 'Update Interval',
        required: true,
        min: 5,
        max: 300,
        step: 5,
        helpText: 'How often to fetch new price data (seconds)'
      },
      {
        field: 'exchange',
        type: 'select',
        label: 'Exchange',
        required: false,
        options: [
          { value: 'binance', label: 'Binance (Global)' },
          { value: 'coinbase', label: 'Coinbase Pro' },
          { value: 'kraken', label: 'Kraken' },
          { value: 'kucoin', label: 'KuCoin' },
          { value: 'aggregate', label: 'Aggregate (Best Price)' }
        ],
        helpText: 'Primary exchange for price data (aggregate uses multiple sources)'
      },
      {
        field: 'include_volume',
        type: 'checkbox',
        label: 'Include Volume Data',
        helpText: 'Also track trading volume (increases storage usage)',
        advanced: true
      }
    ],
    defaults: {
      symbols: 'BTC, ETH',
      update_interval_seconds: 5,
      exchange: 'aggregate',
      include_volume: false
    },
    validator: (config) => {
      const errors: Record<string, string> = {};
      const symbols = config.symbols?.split(',').filter((s: string) => s.trim());
      if (!symbols || symbols.length === 0) {
        errors.symbols = 'At least one symbol required';
      }
      if (symbols?.length > 10) {
        errors.symbols = 'Maximum 10 symbols per source';
      }
      if (config.update_interval_seconds < 5) {
        errors.update_interval_seconds = 'Minimum interval is 5 seconds';
      }
      return { valid: Object.keys(errors).length === 0, errors };
    },
    transformer: (config) => ({
      ...config,
      symbols: config.symbols.split(',').map((s: string) => s.trim().toUpperCase())
    })
  },

  [InfoSourceType.FinancialPrices]: {
    metadata: {
      label: 'Financial Markets',
      icon: TrendingUp,
      description: 'Stocks, ETFs, forex, and bond market data',
      color: 'text-blue-400',
      bgColor: 'bg-blue-500'
    },
    configSchema: [
      {
        field: 'tickers',
        type: 'text',
        label: 'Tickers',
        placeholder: 'SPY, AAPL, TSLA, EURUSD=X',
        required: true,
        validation: (val: string) => {
          if (!val || val.length < 1) return 'Enter at least one ticker';
          return null;
        },
        helpText: 'Stock symbols or forex pairs (comma-separated)'
      },
      {
        field: 'provider',
        type: 'select',
        label: 'Data Provider',
        required: true,
        options: [
          { value: 'yahoo', label: 'Yahoo Finance (Free)' },
          { value: 'alphavantage', label: 'Alpha Vantage' },
          { value: 'polygon', label: 'Polygon.io' }
        ]
      },
      {
        field: 'api_key',
        type: 'password',
        label: 'API Key',
        required: false,
        secret: true,
        helpText: 'Required for Alpha Vantage and Polygon (stored securely)',
        validation: (val: string) => {
          if (val && val.length < 10) return 'API key seems too short';
          return null;
        }
      }
    ],
    defaults: {
      tickers: 'SPY, QQQ',
      provider: 'yahoo',
      api_key: ''
    },
    validator: (config) => {
      const errors: Record<string, string> = {};
      if (config.provider !== 'yahoo' && !config.api_key) {
        errors.api_key = `API key required for ${config.provider}`;
      }
      return { valid: Object.keys(errors).length === 0, errors };
    },
    transformer: (config) => ({
      ...config,
      tickers: config.tickers.split(',').map((s: string) => s.trim().toUpperCase())
    })
  },

  [InfoSourceType.CommodityPrices]: {
    metadata: {
      label: 'Commodities',
      icon: Activity,
      description: 'Gold, silver, oil, gas, and agricultural futures',
      color: 'text-yellow-400',
      bgColor: 'bg-yellow-500'
    },
    configSchema: [
      {
        field: 'commodities',
        type: 'multiselect',
        label: 'Commodities',
        required: true,
        options: [
          { value: 'GOLD', label: 'Gold (XAU/USD)' },
          { value: 'SILVER', label: 'Silver (XAG/USD)' },
          { value: 'OIL_WTI', label: 'Crude Oil (WTI)' },
          { value: 'OIL_BRENT', label: 'Brent Oil' },
          { value: 'NATURAL_GAS', label: 'Natural Gas' },
          { value: 'WHEAT', label: 'Wheat Futures' },
          { value: 'CORN', label: 'Corn Futures' }
        ],
        helpText: 'Select commodities to track'
      },
      {
        field: 'unit',
        type: 'select',
        label: 'Price Unit',
        options: [
          { value: 'USD', label: 'USD' },
          { value: 'EUR', label: 'EUR' }
        ]
      }
    ],
    defaults: {
      commodities: ['GOLD', 'OIL_WTI'],
      unit: 'USD'
    },
    validator: (config) => {
      const errors: Record<string, string> = {};
      if (!config.commodities || config.commodities.length === 0) {
        errors.commodities = 'Select at least one commodity';
      }
      return { valid: Object.keys(errors).length === 0, errors };
    }
  },

  [InfoSourceType.NewsSource]: {
    metadata: {
      label: 'News Feed',
      icon: Newspaper,
      description: 'Real-time news headlines with optional sentiment analysis',
      color: 'text-red-400',
      bgColor: 'bg-red-500'
    },
    configSchema: [
      {
        field: 'keywords',
        type: 'text',
        label: 'Keywords',
        placeholder: 'bitcoin, fed rate, inflation, election',
        required: true,
        validation: (val: string) => {
          if (!val || val.split(',').length < 1) return 'Enter at least one keyword';
          return null;
        },
        helpText: 'Keywords to monitor (comma-separated). Supports AND/OR/NOT operators'
      },
      {
        field: 'sources',
        type: 'multiselect',
        label: 'News Sources',
        options: [
          { value: 'reuters', label: 'Reuters' },
          { value: 'bloomberg', label: 'Bloomberg' },
          { value: 'coindesk', label: 'CoinDesk' },
          { value: 'cryptonews', label: 'CryptoNews' },
          { value: 'ap', label: 'Associated Press' }
        ],
        helpText: 'Leave empty to monitor all available sources'
      },
      {
        field: 'sentiment_analysis',
        type: 'checkbox',
        label: 'Enable Sentiment Analysis',
        helpText: 'Use ML model to score article sentiment (uses more CPU)'
      },
      {
        field: 'min_impact_score',
        type: 'range',
        label: 'Minimum Impact Filter',
        min: 0,
        max: 100,
        step: 10,
        helpText: 'Filter out low-impact news (0 = all news, 100 = major headlines only)',
        advanced: true
      }
    ],
    defaults: {
      keywords: 'bitcoin, crypto',
      sources: [],
      sentiment_analysis: true,
      min_impact_score: 30
    },
    validator: (config) => {
      const errors: Record<string, string> = {};
      if (!config.keywords || config.keywords.trim().length < 2) {
        errors.keywords = 'Keywords required';
      }
      return { valid: Object.keys(errors).length === 0, errors };
    }
  },

  [InfoSourceType.SocialMedia]: {
    metadata: {
      label: 'Social Media',
      icon: MessageCircle,
      description: 'Twitter/X and Reddit sentiment and volume tracking',
      color: 'text-purple-400',
      bgColor: 'bg-purple-500'
    },
    configSchema: [
      {
        field: 'platform',
        type: 'select',
        label: 'Platform',
        required: true,
        options: [
          { value: 'twitter', label: 'Twitter/X' },
          { value: 'reddit', label: 'Reddit' },
          { value: 'both', label: 'Both (aggregated)' }
        ]
      },
      {
        field: 'keywords',
        type: 'text',
        label: 'Keywords / Hashtags',
        placeholder: '$BTC, #crypto, ethereum',
        required: true,
        helpText: 'Track specific cashtags, hashtags, or keywords'
      },
      {
        field: 'volume_threshold',
        type: 'number',
        label: 'Volume Threshold',
        placeholder: '100',
        helpText: 'Minimum mentions per hour to trigger alert (filters noise)',
        validation: (val: number) => {
          if (val < 0) return 'Threshold must be positive';
          return null;
        }
      },
      {
        field: 'ignore_bots',
        type: 'checkbox',
        label: 'Filter Bot Accounts',
        helpText: 'Remove suspected bot posts from analysis (experimental)',
        advanced: true
      }
    ],
    defaults: {
      platform: 'twitter',
      keywords: 'bitcoin, btc',
      volume_threshold: 50,
      ignore_bots: true
    },
    validator: (config) => {
      const errors: Record<string, string> = {};
      if (!config.keywords) errors.keywords = 'Keywords required';
      if (config.volume_threshold < 0) errors.volume_threshold = 'Must be positive';
      return { valid: Object.keys(errors).length === 0, errors };
    }
  },

  [InfoSourceType.Weather]: {
    metadata: {
      label: 'Weather Data',
      icon: Cloud,
      description: 'Temperature, precipitation, and severe weather alerts',
      color: 'text-cyan-400',
      bgColor: 'bg-cyan-500'
    },
    configSchema: [
      {
        field: 'location',
        type: 'text',
        label: 'Location',
        placeholder: 'New York, NY or 40.7128,-74.0060',
        required: true,
        validation: (val: string) => {
          if (!val || val.length < 2) return 'Location required';
          return null;
        },
        helpText: 'City name or latitude,longitude coordinates'
      },
      {
        field: 'metrics',
        type: 'multiselect',
        label: 'Metrics to Track',
        required: true,
        options: [
          { value: 'temperature', label: 'Temperature' },
          { value: 'precipitation', label: 'Precipitation' },
          { value: 'wind_speed', label: 'Wind Speed' },
          { value: 'humidity', label: 'Humidity' },
          { value: 'severe_alerts', label: 'Severe Weather Alerts' }
        ]
      },
      {
        field: 'forecast_days',
        type: 'range',
        label: 'Forecast Horizon',
        min: 1,
        max: 14,
        step: 1,
        helpText: 'Days of forecast data to include'
      }
    ],
    defaults: {
      location: 'New York, NY',
      metrics: ['temperature', 'precipitation'],
      forecast_days: 3
    },
    validator: (config) => {
      const errors: Record<string, string> = {};
      if (!config.location) errors.location = 'Location required';
      if (!config.metrics || config.metrics.length === 0) {
        errors.metrics = 'Select at least one metric';
      }
      return { valid: Object.keys(errors).length === 0, errors };
    }
  },

  [InfoSourceType.Livestream]: {
    metadata: {
      label: 'Livestream Monitor',
      icon: Video,
      description: 'Real-time video/audio analysis (OCR, transcription, chat)',
      color: 'text-pink-400',
      bgColor: 'bg-pink-500'
    },
    configSchema: [
      {
        field: 'url',
        type: 'text',
        label: 'Stream URL',
        placeholder: 'https://youtube.com/watch?v=... or wss://...',
        required: true,
        validation: (val: string) => {
          if (!val) return 'URL required';
          if (!val.startsWith('http') && !val.startsWith('wss')) {
            return 'Must be HTTP, HTTPS, or WebSocket URL';
          }
          return null;
        },
        helpText: 'HLS, DASH, or WebRTC stream URL'
      },
      {
        field: 'analysis_type',
        type: 'select',
        label: 'Analysis Type',
        required: true,
        options: [
          { value: 'ocr', label: 'Screen Text Recognition (OCR)' },
          { value: 'audio', label: 'Audio Transcription (Speech-to-Text)' },
          { value: 'chat', label: 'Live Chat Monitoring' },
          { value: 'all', label: 'All Modes (CPU intensive)' }
        ],
        helpText: 'What to extract from the stream'
      },
      {
        field: 'sampling_interval',
        type: 'select',
        label: 'Frame Sampling',
        options: [
          { value: 1, label: 'Every frame (Realtime)' },
          { value: 5, label: 'Every 5th frame' },
          { value: 30, label: 'Every 30th frame (1fps @ 30fps)' }
        ],
        helpText: 'How often to analyze frames (higher = less CPU)',
        advanced: true
      },
      {
        field: 'alert_keywords',
        type: 'text',
        label: 'Alert Keywords',
        placeholder: 'breaking, urgent, announcement',
        helpText: 'Trigger notification if these words appear (optional)',
        advanced: true
      }
    ],
    defaults: {
      url: '',
      analysis_type: 'ocr',
      sampling_interval: 5,
      alert_keywords: ''
    },
    validator: (config) => {
      const errors: Record<string, string> = {};
      if (!config.url) errors.url = 'Stream URL required';
      // Loose URL validation
      const urlPattern = /^https?:\/\/.+/i;
      if (config.url && !urlPattern.test(config.url)) {
        errors.url = 'Invalid URL format';
      }
      return { valid: Object.keys(errors).length === 0, errors };
    }
  },

  [InfoSourceType.EconomicIndicators]: {
    metadata: {
      label: 'Economic Indicators',
      icon: TrendingUp,
      description: 'CPI, unemployment, GDP, and other macroeconomic data',
      color: 'text-green-400',
      bgColor: 'bg-green-500'
    },
    configSchema: [
      {
        field: 'indicators',
        type: 'multiselect',
        label: 'Indicators',
        required: true,
        options: [
          { value: 'CPI', label: 'Consumer Price Index (CPI)' },
          { value: 'UNEMPLOYMENT', label: 'Unemployment Rate' },
          { value: 'GDP', label: 'Gross Domestic Product' },
          { value: 'FED_RATE', label: 'Federal Funds Rate' },
          { value: 'PPI', label: 'Producer Price Index' },
          { value: 'RETAIL_SALES', label: 'Retail Sales' },
          { value: 'NONFARM_PAYROLL', label: 'Non-Farm Payroll' }
        ],
        helpText: 'Select economic indicators to track'
      },
      {
        field: 'country',
        type: 'select',
        label: 'Country',
        required: true,
        options: [
          { value: 'US', label: 'United States' },
          { value: 'EU', label: 'European Union' },
          { value: 'UK', label: 'United Kingdom' },
          { value: 'JP', label: 'Japan' },
          { value: 'CN', label: 'China' }
        ],
        helpText: 'Country/region for economic data'
      }
    ],
    defaults: {
      indicators: ['CPI', 'UNEMPLOYMENT'],
      country: 'US'
    },
    validator: (config) => {
      const errors: Record<string, string> = {};
      if (!config.indicators || config.indicators.length === 0) {
        errors.indicators = 'Select at least one indicator';
      }
      return { valid: Object.keys(errors).length === 0, errors };
    }
  },

  [InfoSourceType.OnChainData]: {
    metadata: {
      label: 'On-Chain Data',
      icon: Activity,
      description: 'Blockchain metrics including transaction volume and gas fees',
      color: 'text-indigo-400',
      bgColor: 'bg-indigo-500'
    },
    configSchema: [
      {
        field: 'network',
        type: 'select',
        label: 'Blockchain Network',
        required: true,
        options: [
          { value: 'ethereum', label: 'Ethereum' },
          { value: 'bitcoin', label: 'Bitcoin' },
          { value: 'polygon', label: 'Polygon' },
          { value: 'arbitrum', label: 'Arbitrum' },
          { value: 'optimism', label: 'Optimism' },
          { value: 'solana', label: 'Solana' }
        ],
        helpText: 'Blockchain network to monitor'
      },
      {
        field: 'metrics',
        type: 'multiselect',
        label: 'On-Chain Metrics',
        required: true,
        options: [
          { value: 'transaction_volume', label: 'Transaction Volume' },
          { value: 'gas_fees', label: 'Gas Fees' },
          { value: 'active_addresses', label: 'Active Addresses' },
          { value: 'hash_rate', label: 'Hash Rate' },
          { value: 'block_size', label: 'Block Size' },
          { value: 'validator_count', label: 'Validator Count' }
        ],
        helpText: 'Select metrics to track'
      }
    ],
    defaults: {
      network: 'ethereum',
      metrics: ['transaction_volume', 'gas_fees']
    },
    validator: (config) => {
      const errors: Record<string, string> = {};
      if (!config.network) errors.network = 'Network selection required';
      if (!config.metrics || config.metrics.length === 0) {
        errors.metrics = 'Select at least one metric';
      }
      return { valid: Object.keys(errors).length === 0, errors };
    }
  },

  [InfoSourceType.CustomAPI]: {
    metadata: {
      label: 'Custom API',
      icon: Cloud,
      description: 'Connect to any custom REST API endpoint',
      color: 'text-gray-400',
      bgColor: 'bg-gray-500'
    },
    configSchema: [
      {
        field: 'endpoint_url',
        type: 'text',
        label: 'API Endpoint URL',
        placeholder: 'https://api.example.com/v1/data',
        required: true,
        validation: (val: string) => {
          if (!val) return 'URL required';
          if (!val.startsWith('http')) return 'Must be HTTP or HTTPS URL';
          return null;
        },
        helpText: 'Full URL of the API endpoint'
      },
      {
        field: 'method',
        type: 'select',
        label: 'HTTP Method',
        required: true,
        options: [
          { value: 'GET', label: 'GET' },
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'PATCH', label: 'PATCH' }
        ],
        helpText: 'HTTP method for the request'
      },
      {
        field: 'api_key',
        type: 'password',
        label: 'API Key',
        required: false,
        secret: true,
        helpText: 'API key or bearer token (stored securely)'
      },
      {
        field: 'headers',
        type: 'textarea',
        label: 'Custom Headers',
        placeholder: '{"X-Custom-Header": "value"}',
        helpText: 'Additional HTTP headers as JSON object',
        advanced: true
      },
      {
        field: 'poll_interval',
        type: 'range',
        label: 'Polling Interval (seconds)',
        min: 5,
        max: 3600,
        step: 5,
        helpText: 'How often to poll the endpoint',
        advanced: true
      }
    ],
    defaults: {
      endpoint_url: '',
      method: 'GET',
      api_key: '',
      headers: '{}',
      poll_interval: 60
    },
    validator: (config) => {
      const errors: Record<string, string> = {};
      if (!config.endpoint_url) errors.endpoint_url = 'Endpoint URL required';
      if (config.endpoint_url && !config.endpoint_url.startsWith('http')) {
        errors.endpoint_url = 'Invalid URL format';
      }
      return { valid: Object.keys(errors).length === 0, errors };
    }
  }
};

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Retrieves the complete definition for a specific source type
 * Used by Node.tsx for rendering and SourcePanel for form generation
 */
export function getSourceTypeConfig(type: InfoSourceType): SourceTypeDefinition {
  const config = SOURCE_TYPE_DEFINITIONS[type];
  if (!config) {
    throw new Error(`Unknown source type: ${type}`);
  }
  return config;
}

/**
 * Returns default configuration object for a type
 * Used to initialize form state in SourcePanel
 */
export function getDefaultConfig(type: InfoSourceType): Record<string, any> {
  return { ...SOURCE_TYPE_DEFINITIONS[type].defaults };
}

/**
 * Validates configuration for a specific source type
 * Returns validation result with specific field errors
 */
export function validateSourceConfig(
  type: InfoSourceType, 
  config: Record<string, any>
): { valid: boolean; errors: Record<string, string> } {
  const definition = SOURCE_TYPE_DEFINITIONS[type];
  return definition.validator(config);
}

/**
 * Transforms frontend config format to backend format
 * Handles comma-string → array conversion, trimming, etc.
 */
export function transformConfigForBackend(
  type: InfoSourceType,
  config: Record<string, any>
): Record<string, any> {
  const definition = SOURCE_TYPE_DEFINITIONS[type];
  if (definition.transformer) {
    return definition.transformer(config);
  }
  return config;
}

/**
 * Get all source types as array for iteration
 * Useful for rendering type selection grids
 */
export function getAllSourceTypes(): InfoSourceType[] {
  return Object.values(InfoSourceType);
}

/**
 * Check if a field should be shown based on advanced mode
 */
export function isFieldVisible(field: ConfigField, showAdvanced: boolean): boolean {
  if (!field.advanced) return true;
  return showAdvanced;
}