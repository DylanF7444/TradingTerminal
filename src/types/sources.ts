// ============================================================================
// DATA SOURCE CONFIGURATION TYPE DEFINITIONS
// ============================================================================
//
// Module: types/sources.ts
// Purpose: TypeScript interfaces for information source configurations and APIs
//
// Defines the type system for external data sources (prices, news, sentiment)
// feeding into the prediction market trading terminal.
//
// Architecture: Configuration/State Separation with Provider Pattern
//   SourceConfig = Static parameters (serializable, persistable)
//   SourceState  = Runtime metrics (ephemeral, computed)
//
// Source categories: Price feeds, News aggregators, Social media, Alt data
// Backend: Each source type maps to a scraper in src-tauri/src/services/scraper.rs
//
// ============================================================================

import { InfoSourceType } from './nodes';

// =============================================================================
// BASE SOURCE TYPES
// =============================================================================

/**
 * Unique identifier for a configured data source instance.
 * 
 * Distinct from NodeId - a source may exist without being visualized
 * as a node, or multiple nodes may reference the same source.
 */
export type SourceId = string & { __brand: 'SourceId' };

/**
 * Data format types for source output normalization.
 */
export enum DataFormat {
  /** JSON object or array */
  JSON = 'json',
  
  /** XML document */
  XML = 'xml',
  
  /** CSV rows */
  CSV = 'csv',
  
  /** Plain text */
  Text = 'text',
  
  /** Binary data (images, protobuf) */
  Binary = 'binary',
  
  /** HTML document (requires parsing) */
  HTML = 'html',
}

/**
 * Update delivery modes.
 */
export enum DeliveryMode {
  /** Client polls API at interval */
  Polling = 'polling',
  
  /** Server-sent events (HTTP streaming) */
  SSE = 'sse',
  
  /** WebSocket persistent connection */
  WebSocket = 'websocket',
  
  /** Webhook callbacks (server to server) */
  Webhook = 'webhook',
  
  /** File/rss feed polling */
  Feed = 'feed',
}

/**
 * Authentication methods for API access.
 */
export enum AuthType {
  /** No authentication required */
  None = 'none',
  
  /** API key in header or query parameter */
  ApiKey = 'api_key',
  
  /** OAuth 2.0 flow */
  OAuth2 = 'oauth2',
  
  /** HTTP Basic authentication */
  Basic = 'basic',
  
  /** Bearer token (JWT) */
  Bearer = 'bearer',
  
  /** HMAC signature (API key + secret) */
  HMAC = 'hmac',
  
  /** Custom authentication scheme */
  Custom = 'custom',
}

/**
 * Base configuration shared by all source types.
 */
export interface BaseSourceConfig {
  /** Unique source identifier */
  id: SourceId;
  
  /** User-defined display name */
  name: string;
  
  /** Source category from InfoSourceType */
  type: InfoSourceType;
  
  /** Data delivery mode */
  deliveryMode: DeliveryMode;
  
  /** Authentication configuration */
  auth: AuthConfig;
  
  /** Update interval in seconds (for polling modes) */
  interval: number;
  
  /** Request timeout in milliseconds */
  timeout: number;
  
  /** Maximum retry attempts for failed requests */
  maxRetries: number;
  
  /** Whether source is currently active */
  enabled: boolean;
  
  /** Creation timestamp */
  createdAt: number;
  
  /** Last configuration update */
  updatedAt: number;
}

/**
 * Authentication configuration union.
 */
export type AuthConfig =
  | NoAuthConfig
  | ApiKeyConfig
  | OAuth2Config
  | BasicAuthConfig
  | BearerConfig
  | HMACConfig
  | CustomAuthConfig;

/**
 * No authentication required.
 */
export interface NoAuthConfig {
  type: AuthType.None;
}

/**
 * API key authentication (header or query param).
 */
export interface ApiKeyConfig {
  type: AuthType.ApiKey;
  
  /** Header name or query parameter key */
  keyName: string;
  
  /** API key value (encrypted in backend storage) */
  keyValue: string;
  
  /** Whether to send in header (false = query parameter) */
  inHeader: boolean;
  
  /** Additional headers to include */
  additionalHeaders?: Record<string, string>;
}

/**
 * OAuth 2.0 configuration.
 */
export interface OAuth2Config {
  type: AuthType.OAuth2;
  
  /** Authorization endpoint */
  authUrl: string;
  
  /** Token endpoint */
  tokenUrl: string;
  
  /** Client ID */
  clientId: string;
  
  /** Client secret (encrypted) */
  clientSecret: string;
  
  /** OAuth scopes */
  scopes: string[];
  
  /** Current access token (populated at runtime) */
  accessToken?: string;
  
  /** Refresh token (populated at runtime) */
  refreshToken?: string;
  
  /** Token expiration timestamp */
  expiresAt?: number;
}

/**
 * HTTP Basic authentication.
 */
export interface BasicAuthConfig {
  type: AuthType.Basic;
  
  /** Username */
  username: string;
  
  /** Password (encrypted) */
  password: string;
}

/**
 * Bearer token authentication.
 */
export interface BearerConfig {
  type: AuthType.Bearer;
  
  /** JWT or opaque token (encrypted) */
  token: string;
  
  /** Token prefix (default: "Bearer") */
  prefix?: string;
}

/**
 * HMAC signature authentication.
 */
export interface HMACConfig {
  type: AuthType.HMAC;
  
  /** API key (included in signature) */
  apiKey: string;
  
  /** API secret (used for signing, encrypted) */
  apiSecret: string;
  
  /** Signature algorithm */
  algorithm: 'sha256' | 'sha512';
  
  /** Header name for signature */
  signatureHeader: string;
  
  /** Header name for API key */
  keyHeader: string;
  
  /** Include timestamp in signature */
  includeTimestamp: boolean;
}

/**
 * Custom authentication scheme.
 */
export interface CustomAuthConfig {
  type: AuthType.Custom;
  
  /** Custom auth handler identifier */
  handler: string;
  
  /** Opaque configuration for custom handler */
  params: Record<string, any>;
}

// =============================================================================
// PRICE SOURCE CONFIGURATIONS
// =============================================================================

/**
 * Cryptocurrency price source configuration.
 * 
 * Supports multiple providers with normalized output format.
 */
export interface CryptoPricesConfig extends BaseSourceConfig {
  type: InfoSourceType.CryptoPrices;
  
  /** Data provider selection */
  provider: CryptoProvider;
  
  /** Trading pairs to track (e.g., ["BTC-USD", "ETH-USD"]) */
  symbols: string[];
  
  /** Data granularity */
  granularity: 'tick' | '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  
  /** Include orderbook data (L2) */
  includeOrderbook: boolean;
  
  /** Orderbook depth levels */
  orderbookDepth: number;
  
  /** Storage interval for WebSocket data (milliseconds)
   *  When using WebSocket providers (Coinbase), data is received in real-time
   *  but only stored to database at this interval to reduce write load.
   *  Default: 60000 (1 minute)
   */
  storageIntervalMs?: number;
  
  /** Provider-specific settings */
  providerConfig?: {
    /** CoinGecko: API tier (free/pro/enterprise) */
    coingeckoTier?: 'free' | 'pro' | 'enterprise';
    
    /** Binance: WebSocket vs REST preference */
    binancePreferWs?: boolean;
    
    /** Custom provider base URL */
    customBaseUrl?: string;
  };
}

/**
 * Supported crypto data providers.
 */
export enum CryptoProvider {
  /** Coinbase - primary/default WebSocket provider for real-time prices */
  Coinbase = 'coinbase',
  
  /** CoinGecko - free tier available, rate limited */
  CoinGecko = 'coingecko',
  
  /** Binance - high frequency, requires API key */
  Binance = 'binance',
  
  /** CoinMarketCap - comprehensive metadata */
  CoinMarketCap = 'coinmarketcap',
  
  /** CryptoCompare - historical data specialist */
  CryptoCompare = 'cryptocompare',
  
  /** Custom API endpoint */
  Custom = 'custom',
}

/**
 * Traditional financial markets configuration.
 */
export interface FinancialPricesConfig extends BaseSourceConfig {
  type: InfoSourceType.FinancialPrices;
  
  /** Data provider */
  provider: FinancialProvider;
  
  /** Instruments to track (stocks, ETFs, forex pairs) */
  symbols: string[];
  
  /** Asset classes to include */
  assetClasses: Array<'stock' | 'etf' | 'forex' | 'future' | 'option'>;
  
  /** Market data feed type */
  feedType: 'delayed' | 'realtime';
  
  /** Include fundamental data (P/E, market cap) */
  includeFundamentals: boolean;
}

/**
 * Supported financial data providers.
 */
export enum FinancialProvider {
  /** Yahoo Finance - free, delayed data */
  YahooFinance = 'yahoo',
  
  /** Alpha Vantage - API key required */
  AlphaVantage = 'alphavantage',
  
  /** IEX Cloud - reliable, affordable */
  IEXCloud = 'iex',
  
  /** Polygon.io - professional grade */
  Polygon = 'polygon',
  
  /** Twelve Data - forex specialist */
  TwelveData = 'twelvedata',
}

/**
 * Commodity prices configuration.
 */
export interface CommodityPricesConfig extends BaseSourceConfig {
  type: InfoSourceType.CommodityPrices;
  
  /** Commodity categories */
  categories: Array<'energy' | 'metals' | 'agriculture' | 'livestock'>;
  
  /** Specific commodities (e.g., ["crude-oil", "gold"]) */
  commodities: string[];
  
  /** Price unit preference */
  unit: 'usd' | 'eur' | 'local';
  
  /** Include futures curve data */
  includeFuturesCurve: boolean;
}

// =============================================================================
// NEWS & CONTENT SOURCE CONFIGURATIONS
// =============================================================================

/**
 * News aggregator configuration.
 */
export interface NewsSourceConfig extends BaseSourceConfig {
  type: InfoSourceType.NewsSource;
  
  /** News providers */
  providers: NewsProvider[];
  
  /** Keywords for filtering (empty = all) */
  keywords: string[];
  
  /** Required categories */
  categories: Array<'business' | 'politics' | 'technology' | 'science' | 'health' | 'sports'>;
  
  /** Language filter (ISO 639-1 codes) */
  languages: string[];
  
  /** Geographic focus (ISO 3166-1 alpha-2 codes) */
  countries: string[];
  
  /** Minimum relevance score (0-1) */
  minRelevance: number;
  
  /** NLP processing options */
  nlpProcessing: {
    /** Extract named entities */
    extractEntities: boolean;
    
    /** Sentiment analysis */
    sentimentAnalysis: boolean;
    
    /** Keyword extraction */
    extractKeywords: boolean;
    
    /** Summarization */
    summarize: boolean;
  };
  
  /** Historical lookback for initial fetch (hours) */
  lookbackHours: number;
}

/**
 * Supported news providers.
 */
export enum NewsProvider {
  /** NewsAPI.org - general news aggregator */
  NewsAPI = 'newsapi',
  
  /** GDELT Project - global news database */
  GDELT = 'gdelt',
  
  /** Event Registry - semantic news analysis */
  EventRegistry = 'eventregistry',
  
  /** RSS feeds (custom URLs) */
  RSS = 'rss',
  
  /** Specific outlets (NYT, Reuters, etc.) */
  NYT = 'nyt',
  Reuters = 'reuters',
  Bloomberg = 'bloomberg',
  WSJ = 'wsj',
}

/**
 * Social media source configuration.
 */
export interface SocialMediaConfig extends BaseSourceConfig {
  type: InfoSourceType.SocialMedia;
  
  /** Platform selection */
  platforms: SocialPlatform[];
  
  /** Accounts to monitor (e.g., ["@elonmusk", "@saylor"]) */
  accounts: string[];
  
  /** Hashtags to track */
  hashtags: string[];
  
  /** Keywords for filtering */
  keywords: string[];
  
  /** Minimum follower count for account inclusion */
  minFollowers: number;
  
  /** Content types to include */
  contentTypes: Array<'post' | 'reply' | 'retweet' | 'thread'>;
  
  /** Sentiment analysis configuration */
  sentimentConfig: {
    /** Model to use */
    model: 'vader' | 'textblob' | 'transformer';
    
    /** Aggregate window (minutes) */
    windowMinutes: number;
    
    /** Include emoji sentiment */
    includeEmoji: boolean;
  };
  
  /** Volume metrics tracking */
  volumeMetrics: {
    /** Track post count */
    postCount: boolean;
    
    /** Track engagement (likes, replies) */
    engagement: boolean;
    
    /** Track velocity (posts per minute) */
    velocity: boolean;
  };
}

/**
 * Supported social media platforms.
 */
export enum SocialPlatform {
  /** Twitter/X - high frequency, API restrictions */
  Twitter = 'twitter',
  
  /** Reddit - community sentiment, subreddit focus */
  Reddit = 'reddit',
  
  /** Telegram - channel monitoring */
  Telegram = 'telegram',
  
  /** Discord - server/channel monitoring */
  Discord = 'discord',
  
  /** StockTwits - investor-focused */
  StockTwits = 'stocktwits',
}

// =============================================================================
// ALTERNATIVE DATA SOURCE CONFIGURATIONS
// =============================================================================

/**
 * Weather data configuration.
 */
export interface WeatherConfig extends BaseSourceConfig {
  type: InfoSourceType.Weather;
  
  /** Weather provider */
  provider: WeatherProvider;
  
  /** Locations to monitor (city names or lat,lng) */
  locations: string[];
  
  /** Data types to fetch */
  metrics: Array<'temperature' | 'precipitation' | 'wind' | 'humidity' | 'pressure' | 'severe_alerts'>;
  
  /** Forecast horizon */
  forecastDays: number;
  
  /** Historical data depth */
  historicalDays: number;
  
  /** Update frequency (weather changes slowly) */
  interval: 300 | 600 | 1800 | 3600; // 5min, 10min, 30min, 1hr
}

/**
 * Weather data providers.
 */
export enum WeatherProvider {
  /** OpenWeatherMap - popular, affordable */
  OpenWeatherMap = 'openweathermap',
  
  /** WeatherAPI - simple, reliable */
  WeatherAPI = 'weatherapi',
  
  /** NOAA/NWS - US government, free */
  NOAA = 'noaa',
  
  /** Weather Underground - crowd-sourced */
  Wunderground = 'wunderground',
}

/**
 * Livestream metrics configuration.
 */
export interface LivestreamConfig extends BaseSourceConfig {
  type: InfoSourceType.Livestream;
  
  /** Platform */
  platform: StreamPlatform;
  
  /** Channels/streams to monitor */
  channels: string[];
  
  /** Metrics to track */
  metrics: Array<'viewers' | 'chat_rate' | 'sentiment' | 'subscribers'>;
  
  /** Chat analysis options */
  chatAnalysis?: {
    /** Analyze chat messages */
    enabled: boolean;
    
    /** Sentiment model */
    sentimentModel: 'simple' | 'advanced';
    
    /** Keyword triggers */
    keywords: string[];
  };
}

/**
 * Streaming platforms.
 */
export enum StreamPlatform {
  YouTube = 'youtube',
  Twitch = 'twitch',
  Kick = 'kick',
  Rumble = 'rumble',
}

/**
 * Economic indicators configuration.
 */
export interface EconomicIndicatorsConfig extends BaseSourceConfig {
  type: InfoSourceType.EconomicIndicators;
  
  /** Data source */
  source: EconomicSource;
  
  /** Indicators to track */
  indicators: EconomicIndicator[];
  
  /** Countries/regions (ISO codes) */
  countries: string[];
  
  /** Frequency preference */
  frequency: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  
  /** Include revisions history */
  includeRevisions: boolean;
  
  /** Include forecasts/consensus */
  includeForecasts: boolean;
}

/**
 * Economic data sources.
 */
export enum EconomicSource {
  /** FRED (Federal Reserve) - comprehensive, free */
  FRED = 'fred',
  
  /** World Bank - global development data */
  WorldBank = 'worldbank',
  
  /** IMF - international statistics */
  IMF = 'imf',
  
  /** OECD - developed economies */
  OECD = 'oecd',
  
  /** Trading Economics - aggregated */
  TradingEconomics = 'tradingeconomics',
}

/**
 * Available economic indicators.
 */
export enum EconomicIndicator {
  // Employment
  NonfarmPayrolls = 'nonfarm_payrolls',
  UnemploymentRate = 'unemployment_rate',
  InitialClaims = 'initial_claims',
  
  // Inflation
  CPI = 'cpi',
  CoreCPI = 'core_cpi',
  PPI = 'ppi',
  PCE = 'pce',
  
  // Growth
  GDP = 'gdp',
  GDPGrowth = 'gdp_growth',
  RetailSales = 'retail_sales',
  
  // Monetary
  FedFundsRate = 'fed_funds_rate',
  TreasuryYield10Y = 'treasury_10y',
  
  // Sentiment
  ConsumerConfidence = 'consumer_confidence',
  PMIManufacturing = 'pmi_manufacturing',
}

/**
 * On-chain data configuration.
 */
export interface OnChainDataConfig extends BaseSourceConfig {
  type: InfoSourceType.OnChainData;
  
  /** Blockchain networks */
  networks: Array<'bitcoin' | 'ethereum' | 'arbitrum' | 'optimism' | 'polygon'>;
  
  /** Metrics to track */
  metrics: OnChainMetric[];
  
  /** Address monitoring */
  watchAddresses: string[];
  
  /** Whale threshold (USD) */
  whaleThreshold: number;
  
  /** Mempool monitoring */
  mempoolMonitoring: boolean;
}

/**
 * On-chain metrics available.
 */
export enum OnChainMetric {
  // Bitcoin
  BtcHashRate = 'btc_hashrate',
  BtcDifficulty = 'btc_difficulty',
  BtcMempoolSize = 'btc_mempool_size',
  BtcActiveAddresses = 'btc_active_addresses',
  
  // Ethereum
  EthGasPrice = 'eth_gas_price',
  EthActiveAddresses = 'eth_active_addresses',
  EthTransactionCount = 'eth_tx_count',
  EthStakingDeposits = 'eth_staking_deposits',
  
  // DeFi
  TVL = 'tvl',
  DexVolume = 'dex_volume',
  StablecoinSupply = 'stablecoin_supply',
  
  // General
  ExchangeInflows = 'exchange_inflows',
  ExchangeOutflows = 'exchange_outflows',
  WhaleMovements = 'whale_movements',
}

/**
 * Custom API source configuration.
 */
export interface CustomAPIConfig extends BaseSourceConfig {
  type: InfoSourceType.CustomAPI;
  
  /** HTTP method */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  
  /** Full URL endpoint */
  endpoint: string;
  
  /** Request headers */
  headers: Record<string, string>;
  
  /** Request body template (for POST/PUT) */
  bodyTemplate?: string;
  
  /** Query parameters */
  queryParams: Record<string, string>;
  
  /** Response parsing */
  responseParsing: {
    /** Data format */
    format: DataFormat;
    
    /** JSONPath or XPath to extract data */
    path: string;
    
    /** Value transformation */
    transform?: 'none' | 'multiply' | 'divide' | 'add' | 'subtract';
    
    /** Transformation factor */
    factor?: number;
  };
  
  /** Expected response schema (for validation) */
  schema?: Record<string, any>;
}

// =============================================================================
// SOURCE CONFIGURATION UNION
// =============================================================================

/**
 * Discriminated union of all source configurations.
 * 
 * Use this type for functions that accept any source config.
 * Narrow using the `type` field (InfoSourceType enum).
 */
export type SourceConfig =
  | CryptoPricesConfig
  | FinancialPricesConfig
  | CommodityPricesConfig
  | NewsSourceConfig
  | SocialMediaConfig
  | WeatherConfig
  | LivestreamConfig
  | EconomicIndicatorsConfig
  | OnChainDataConfig
  | CustomAPIConfig;

// =============================================================================
// SOURCE RUNTIME STATE
// =============================================================================

/**
 * Runtime connection and data quality state.
 * 
 * Separate from configuration - this represents ephemeral
 * metrics that change during operation.
 */
export interface SourceState {
  /** Reference to configuration */
  sourceId: SourceId;
  
  /** Connection status */
  status: SourceStatus;
  
  /** Last successful data timestamp */
  lastSuccessAt?: number;
  
  /** Last error timestamp */
  lastErrorAt?: number;
  
  /** Last error message */
  lastErrorMessage?: string;
  
  /** Consecutive error count */
  consecutiveErrors: number;
  
  /** Total successful updates */
  totalUpdates: number;
  
  /** Total failed updates */
  totalErrors: number;
  
  /** Average latency (ms) over last 10 updates */
  avgLatencyMs: number;
  
  /** Data points in current window */
  dataPointsThisHour: number;
  
  /** Current data snapshot (last received) */
  currentData?: SourceDataSnapshot;
  
  /** Rate limit status */
  rateLimit?: {
    /** Remaining requests in window */
    remaining: number;
    
    /** Total limit */
    limit: number;
    
    /** Window reset timestamp */
    resetAt: number;
  };
}

/**
 * Source connection status.
 */
export enum SourceStatus {
  /** Initial state, not yet connected */
  Idle = 'idle',
  
  /** Actively fetching data */
  Active = 'active',
  
  /** Connected but no recent data (stale) */
  Stale = 'stale',
  
  /** Connection error, retrying */
  Error = 'error',
  
  /** Permanently failed (max retries exceeded) */
  Failed = 'failed',
  
  /** Explicitly paused by user */
  Paused = 'paused',
}

/**
 * Generic data snapshot from any source type.
 */
export interface SourceDataSnapshot {
  /** Source that produced this data */
  sourceId: SourceId;
  
  /** Data timestamp (from source, not received time) */
  timestamp: number;
  
  /** Received timestamp (local) */
  receivedAt: number;
  
  /** Data format */
  format: DataFormat;
  
  /** Raw data payload */
  raw: any;
  
  /** Normalized/parsed data */
  normalized?: NormalizedData;
  
  /** Processing metadata */
  meta: {
    /** Latency from source to receipt (ms) */
    latencyMs: number;
    
    /** Parsing/processing time (ms) */
    processingMs: number;
    
    /** Data size in bytes */
    sizeBytes: number;
    
    /** Schema version used for parsing */
    schemaVersion: string;
  };
}

/**
 * Normalized data format regardless of source.
 * 
 * All sources convert to this common structure for
// consistent downstream processing.
 */
export interface NormalizedData {
  /** Data type discriminator */
  type: 'price' | 'news' | 'sentiment' | 'indicator' | 'event' | 'custom';
  
  /** Source symbol/identifier */
  symbol: string;
  
  /** Numeric value (if applicable) */
  value?: number;
  
  /** Text content (if applicable) */
  content?: string;
  
  /** Structured data payload */
  payload: Record<string, any>;
  
  /** Confidence score (0-1) */
  confidence: number;
  
  /** Related symbols/entities */
  relatedSymbols: string[];
  
  /** Sentiment score (-1 to 1, if applicable) */
  sentiment?: number;
}

// =============================================================================
// SOURCE EVENTS
// =============================================================================

/**
 * Base interface for source-related events.
 */
export interface SourceEvent {
  /** Event type */
  type: string;
  
  /** Affected source ID */
  sourceId: SourceId;
  
  /** Event timestamp */
  timestamp: number;
}

/**
 * Data update event from source.
 */
export interface SourceDataEvent extends SourceEvent {
  type: 'data';
  
  /** Data snapshot */
  data: SourceDataSnapshot;
  
  /** Whether this is historical backfill */
  isBackfill: boolean;
}

/**
 * Source status change event.
 */
export interface SourceStatusEvent extends SourceEvent {
  type: 'status_change';
  
  /** Previous status */
  from: SourceStatus;
  
  /** New status */
  to: SourceStatus;
  
  /** Reason for change */
  reason?: string;
}

/**
 * Source error event.
 */
export interface SourceErrorEvent extends SourceEvent {
  type: 'error';
  
  /** Error details */
  error: {
    code: string;
    message: string;
    retryable: boolean;
  };
  
  /** Request that caused error (sanitized) */
  request?: {
    url: string;
    method: string;
  };
}

/**
 * Union of all source events.
 */
export type SourceEvents =
  | SourceDataEvent
  | SourceStatusEvent
  | SourceErrorEvent;

// =============================================================================
// SOURCE MANAGEMENT API
// =============================================================================

/**
 * Parameters for creating a new source.
 */
export interface CreateSourceParams {
  /** Source type */
  type: InfoSourceType;
  
  /** Display name */
  name: string;
  
  /** Type-specific configuration */
  config: Omit<SourceConfig, 'id' | 'createdAt' | 'updatedAt'>;
}

/**
 * Parameters for updating a source.
 */
export interface UpdateSourceParams {
  /** Source ID to update */
  id: SourceId;
  
  /** New display name */
  name?: string;
  
  /** Configuration updates (merged) */
  config?: Partial<Omit<SourceConfig, 'id' | 'type' | 'createdAt' | 'updatedAt'>>;
  
  /** Enable/disable */
  enabled?: boolean;
}

/**
 * Source health check result.
 */
export interface SourceHealth {
  /** Source ID */
  sourceId: SourceId;
  
  /** Overall health status */
  status: 'healthy' | 'degraded' | 'unhealthy';
  
  /** Health score (0-100) */
  score: number;
  
  /** Component checks */
  checks: {
    connectivity: boolean;
    authentication: boolean;
    dataQuality: boolean;
    rateLimit: boolean;
  };
  
  /** Recommendations if issues detected */
  recommendations: string[];
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Type guard for crypto price configs.
 */
export function isCryptoPricesConfig(config: SourceConfig): config is CryptoPricesConfig {
  return config.type === InfoSourceType.CryptoPrices;
}

/**
 * Type guard for news source configs.
 */
export function isNewsSourceConfig(config: SourceConfig): config is NewsSourceConfig {
  return config.type === InfoSourceType.NewsSource;
}

/**
 * Type guard for social media configs.
 */
export function isSocialMediaConfig(config: SourceConfig): config is SocialMediaConfig {
  return config.type === InfoSourceType.SocialMedia;
}

/**
 * Get default configuration for a source type.
 */
export function getDefaultConfig(
  type: InfoSourceType
): Partial<SourceConfig> {
  const base: Partial<BaseSourceConfig> = {
    deliveryMode: DeliveryMode.Polling,
    auth: { type: AuthType.None },
    interval: 60,
    timeout: 30000,
    maxRetries: 3,
    enabled: true,
  };
  
  switch (type) {
    case InfoSourceType.CryptoPrices:
      return {
        ...base,
        type,
        provider: CryptoProvider.Coinbase,
        symbols: ['BTC-USD', 'ETH-USD'],
        granularity: 'tick',
        includeOrderbook: true,
        orderbookDepth: 10,
        interval: 0, // Real-time via WebSocket
        deliveryMode: DeliveryMode.WebSocket,
      } as Partial<CryptoPricesConfig>;
      
    case InfoSourceType.NewsSource:
      return {
        ...base,
        type,
        providers: [NewsProvider.NewsAPI],
        keywords: [],
        categories: ['business', 'technology'],
        languages: ['en'],
        countries: ['US'],
        minRelevance: 0.5,
        nlpProcessing: {
          extractEntities: true,
          sentimentAnalysis: true,
          extractKeywords: true,
          summarize: false,
        },
        lookbackHours: 24,
        interval: 60,
      } as Partial<NewsSourceConfig>;
      
    case InfoSourceType.SocialMedia:
      return {
        ...base,
        type,
        platforms: [SocialPlatform.Twitter],
        accounts: [],
        hashtags: [],
        keywords: [],
        minFollowers: 1000,
        contentTypes: ['post'],
        sentimentConfig: {
          model: 'vader',
          windowMinutes: 15,
          includeEmoji: true,
        },
        volumeMetrics: {
          postCount: true,
          engagement: true,
          velocity: true,
        },
        interval: 30,
      } as Partial<SocialMediaConfig>;
      
    default:
      return base as Partial<SourceConfig>;
  }
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum sources per type (prevent abuse) */
export const MAX_SOURCES_PER_TYPE: Record<InfoSourceType, number> = {
  [InfoSourceType.CryptoPrices]: 10,
  [InfoSourceType.FinancialPrices]: 5,
  [InfoSourceType.CommodityPrices]: 5,
  [InfoSourceType.NewsSource]: 3,
  [InfoSourceType.SocialMedia]: 3,
  [InfoSourceType.Weather]: 5,
  [InfoSourceType.Livestream]: 5,
  [InfoSourceType.EconomicIndicators]: 3,
  [InfoSourceType.OnChainData]: 5,
  [InfoSourceType.CustomAPI]: 10,
};

/** Default rate limits (requests per minute) by provider */
export const DEFAULT_RATE_LIMITS: Record<string, number> = {
  [CryptoProvider.Coinbase]: 10000,     // WebSocket primary, high limit
  [CryptoProvider.CoinGecko]: 50,      // Free tier
  [CryptoProvider.Binance]: 1200,
  [NewsProvider.NewsAPI]: 100,          // Developer tier
  [SocialPlatform.Twitter]: 450,        // Essential tier
  [WeatherProvider.OpenWeatherMap]: 60, // Free tier
};

