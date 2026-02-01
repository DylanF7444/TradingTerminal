// ============================================================================
// INFORMATION SOURCE TYPE DEFINITIONS
// ============================================================================
//
// Module: components/InfoSources/SourceTypes.tsx
// Purpose: Central registry for information source type metadata, configuration schemas,
//          and UI specifications. Acts as the single source of truth for how each
//          data source type is displayed, configured, and validated.
//
// OVERVIEW:
// This module defines the complete specification for all supported information source
// types in the prediction market terminal. It bridges the gap between the backend
// Rust enums (InfoSourceType) and the frontend UI components, providing:
//
// 1. Visual Metadata: Icons, colors, labels, descriptions for canvas and panels
// 2. Configuration Schemas: Form field definitions, validation rules, defaults
// 3. UI Hints: Input types, placeholders, help text, conditional rendering logic
//
// This architecture allows SourcePanel.tsx to dynamically generate configuration
// forms without hardcoding type-specific logic, following the Open/Closed Principle.
// Adding a new data source type requires only:
//   - Adding enum variant in types/nodes.ts
//   - Adding entry in SOURCE_TYPE_DEFINITIONS (this file)
//   - Implementing scraper in src-tauri/src/services/scraper.rs
//
// ARCHITECTURE:
//
// Type Definition Object Pattern:
//   {
//     [InfoSourceType.CryptoPrices]: {
//       metadata: { icon, color, label, description },  // UI rendering
//       configSchema: [                                  // Form generation
//         { field: 'symbols', type: 'text', required: true, validate: ... },
//         { field: 'interval', type: 'range', min: 5, max: 300 }
//       ],
//       defaults: { symbols: ['BTC'], interval: 5 },    // Initial values
//       validator: (config) => Result                   // Runtime validation
//     }
//   }
//
// Consumption Flow:
// SourcePanel.tsx imports SOURCE_TYPE_DEFINITIONS
//   → Maps over entries to render type selection grid (icons, descriptions)
//   → On type selection, looks up configSchema to generate form inputs
//   → Validates input using validator function
//   → Transforms config (comma strings → arrays) for backend
//   → Backend receives strict type via Tauri invoke
//
// Canvas Integration:
// Node.tsx imports getSourceTypeConfig()
//   → Looks up visual metadata for rendering (color, icon)
//   → Applies type-specific styling (crypto=orange circle, news=red circle)
//
// KEY EXPORTS:
//
// 1. SOURCE_TYPE_DEFINITIONS: Record<InfoSourceType, SourceTypeDefinition>
//    - Master configuration object containing all type specifications
//    - Used by SourcePanel for form generation and Node.tsx for rendering
//
// 2. InfoSourceType: Enum (re-exported from ../../types/nodes)
//    - Discriminant union variant for type identification
//    - Matches Rust backend enum exactly (serialization integrity)
//
// 3. SourceConfigSchemas: Type definitions for configuration objects
//    - CryptoPricesConfig, NewsSourceConfig, etc.
//    - Ensures type safety across form handling and API calls
//
// 4. Utility Functions:
//    - getSourceTypeConfig(type): Returns definition for specific type
//    - validateSourceConfig(type, config): Runtime validation
//    - getDefaultConfig(type): Returns populated default object
//    - transformConfigForBackend(type, frontendConfig): Data transformation
//
// CONFIGURATION SCHEMA FIELDS:
//
// Each field in configSchema specifies:
// - field: string - Property name in config object
// - type: 'text' | 'number' | 'range' | 'select' | 'multiselect' | 'checkbox' | 'textarea'
// - label: string - Human-readable label for form
// - placeholder?: string - Input placeholder text
// - required?: boolean - Whether field is mandatory
// - validation?: RegExp | Function - Validation logic
//   * text: min/max length, pattern matching (e.g., comma-separated symbols)
//   * number: min/max values (e.g., interval 5-300 seconds)
//   * url: URL format validation for streams
// - options?: Array<{value, label}> - For select/multiselect types
// - helpText?: string - Tooltip/explanation shown below input
// - advanced?: boolean - Show only in "Advanced Options" section
//
// VALIDATION ARCHITECTURE:
//
// Two-layer validation ensures data integrity:
//
// Layer 1 - Client-side (this file):
//   - Immediate feedback in UI (red borders, error messages)
//   - Prevents unnecessary backend calls
//   - Regex patterns for format validation (symbols, URLs)
//   - Range checks for numeric values
//
// Layer 2 - Backend (Rust commands):
//   - Schema validation using serde deserialization
//   - API key validation (test authentication)
//   - Rate limit checks (prevent too-high intervals)
//   - Sanitization (prevent SQL injection in keywords)
//
// TYPE-SPECIFIC NOTES:
//
// CryptoPrices:
//   - Symbols transformed: "BTC,ETH" → ["BTC", "ETH"] for backend
//   - Common exchanges: binance, coinbase, kraken (affects API endpoint)
//   - Interval clamped: 5-300 seconds (prevent API rate limiting)
//
// NewsSource:
//   - Keywords support boolean operators (AND, OR, NOT) in backend
//   - Sentiment analysis toggle affects processing pipeline (ML model loading)
//   - Source whitelist filters feed providers
//
// Weather:
//   - Location string geocoded by backend (accepts "City" or "lat,lon")
//   - Metrics selection affects API cost (some providers charge per metric)
//
// SocialMedia:
//   - Volume threshold prevents low-signal noise (minimum mentions/period)
//   - Platform affects OAuth flow requirements in backend
//
// Livestream:
//   - URL must be HLS/WebRTC compatible (backend validates stream format)
//   - Analysis type determines computational cost (OCR > Chat > Audio)
//   - Requires significant bandwidth, warns user in helpText
//
// EXTENSIBILITY:
//
// To add a new source type (Example: SatelliteImagery):
//
// 1. Add to types/nodes.ts:
//    export enum InfoSourceType { ..., SatelliteImagery = "SatelliteImagery" }
//
// 2. Add definition here:
//    [InfoSourceType.SatelliteImagery]: {
//      metadata: { icon: Satellite, color: 'text-indigo-400', label: 'Satellite Imagery' },
//      configSchema: [
//        { field: 'coordinates', type: 'text', label: 'Lat, Lon', validation: latLonRegex },
//        { field: 'resolution', type: 'select', options: [{value: 'high', label: 'High Res (0.5m)'}, ...] }
//      ],
//      defaults: { coordinates: '40.7,-74.0', resolution: 'medium' },
//      validator: validateSatelliteConfig
//    }
//
// 3. Implement scraper in Rust:
//    services/scraper.rs -> spawn_satellite_scraper(config) -> JoinHandle
//
// 4. Done. SourcePanel automatically shows new type in grid, renders correct form.
//
// PERFORMANCE CONSIDERATIONS:
//
// - Definitions object is statically defined (no runtime construction)
// - Icons are imported directly (tree-shakeable via lucide-react)
// - Validation functions are pure (memoizable if needed)
// - No external API calls in this file (validation is local pattern matching)
//
// TESTING:
//
// - Unit: Validate each validator function with valid/invalid inputs
// - Integration: Ensure all types have required fields (icon, label, schema)
// - Snapshot: Form generation renders consistently for each type
// - Type: TypeScript ensures exhaustive switch statements when adding types
//
// USAGE EXAMPLE:
//
// ```typescript
// import { SOURCE_TYPE_DEFINITIONS, getSourceTypeConfig } from './SourceTypes';
// import { InfoSourceType } from '../../types/nodes';
//
// // Get display info for canvas node rendering
// const config = getSourceTypeConfig(InfoSourceType.CryptoPrices);
// console.log(config.metadata.icon); // Bitcoin icon component
// console.log(config.metadata.color); // 'text-orange-400'
//
// // Generate form dynamically in SourcePanel
// const schema = SOURCE_TYPE_DEFINITIONS[selectedType].configSchema;
// return schema.map(field => (
//   <FormField key={field.field} type={field.type} {...field} />
// ));
// ```
//
// DEPENDENCIES:
// - React (for Icon components which are React elements)
// - lucide-react (all icon components)
// - ../../types/nodes (InfoSourceType enum definition)
// - Zod (recommended for runtime validation, though plain functions shown here)
//
// FUTURE ENHANCEMENTS:
// - i18n support (translations for labels/descriptions)
// - Dynamic schema fetching (backend tells frontend what fields are required)
// - Conditional field visibility (show field B only if field A is checked)
// - Async validation (check if API key is valid before form submission)
// - Import/export presets (save common configurations as templates)
// - Category grouping (Financial, Social, Environmental, etc.)
// - Icon customization (user uploads custom SVG for sources)
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