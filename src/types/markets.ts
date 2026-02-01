// ============================================================================
// MARKET DATA TYPE DEFINITIONS
// ============================================================================
//
// Module: types/markets.ts
// Purpose: Core TypeScript interfaces for prediction market data structures
//
// OVERVIEW:
// This module defines the complete type system for prediction market interactions,
// including orderbook structures, market metadata, trade execution results, and
// WebSocket event payloads. These types ensure end-to-end type safety between
// the Rust backend and React frontend, with serialization compatibility for
// Tauri's IPC bridge.
//
// The type hierarchy mirrors the backend's Rust structs (src-tauri/src/models/market.rs)
// with TypeScript-specific enhancements for frontend consumption. All monetary
// values use number (float) for calculations, with explicit precision notes
// where fixed-point arithmetic is required.
//
// Architecture Pattern:
// Domain-Driven Types with Discriminated Unions
//   Market ↔ Orderbook ↔ Order ↔ Trade (entity relationships)
//   WebSocketEvent = PriceUpdate | OrderbookUpdate | TradeUpdate (union types)
//
// SERIALIZATION NOTES:
//
// Tauri IPC Bridge Compatibility:
//   - All types must be JSON-serializable (no functions, no undefined)
//   - Enums use string literal unions (match Rust's serde serialization)
//   - Optional fields use ? notation (maps to Rust Option<T>)
//   - Timestamps use number (milliseconds since epoch) for JS compatibility
//
// Rust ↔ TypeScript Mapping:
//   Rust f64           → TypeScript number
//   Rust u64/i64       → TypeScript number (safe up to 2^53)
//   Rust Option<T>     → TypeScript T | undefined
//   Rust Vec<T>        → TypeScript T[]
//   Rust enum          → TypeScript string literal union
//   Rust struct        → TypeScript interface
//   Rust chrono::DateTime → TypeScript number (timestamp)
//
// PRECISION HANDLING:
//
// Prediction markets use decimal prices (0.00 - 1.00 for binary markets).
// JavaScript's floating point can introduce errors (0.1 + 0.2 !== 0.3).
// Critical financial calculations should use:
//   - toFixed(4) for display
//   - Math.round(value * 10000) / 10000 for 4-decimal precision
//   - Or integrate a decimal library (decimal.js) for complex calculations
//
// TYPE CATEGORIES:
//
// 1. Core Market Types (Market, MarketStatus, MarketCategory)
// 2. Orderbook Types (Orderbook, Level, Spread)
// 3. Order Types (Order, OrderSide, OrderType, TimeInForce)
// 4. Position/Trade Types (Trade, TradeResult, Fill)
// 5. WebSocket Event Types (Real-time updates)
// 6. API Response Types (Backend command returns)
// 7. Utility Types (Pagination, Filters, Constraints)
//
// EXTENSIBILITY:
//
// New prediction markets (e.g., Betfair, PredictIt) can be added by:
//   1. Extending MarketType enum
//   2. Adding market-specific metadata interfaces
//   3. Implementing corresponding scraper in backend services/scraper.rs
//   4. Adding market-specific WebSocket event variants
//
// ============================================================================

// =============================================================================
// CORE MARKET TYPES
// =============================================================================

/**
 * Supported prediction market exchanges/platforms.
 * 
 * Backend Mapping: src-tauri/src/models/node.rs MarketType enum
 * Serialization: Matches Rust enum variant names exactly
 */
export enum MarketType {
  /** Polymarket - Crypto-native prediction markets on Polygon */
  Polymarket = 'Polymarket',
  
  /** Kalshi - Regulated US prediction markets */
  Kalshi = 'Kalshi',
  
  // Future extensions:
  // Betfair = 'Betfair',
  // PredictIt = 'PredictIt',
  // Smarkets = 'Smarkets',
}

/**
 * Market status lifecycle.
 * 
 * Markets progress through states from creation to resolution.
 * Certain actions are only valid in specific states (e.g., trading
 * only allowed when status is 'open').
 */
export enum MarketStatus {
  /** Market created but not yet open for trading */
  Pending = 'pending',
  
  /** Active trading allowed */
  Open = 'open',
  
  /** Trading suspended (volatility, investigation, etc.) */
  Suspended = 'suspended',
  
  /** Market closed, awaiting resolution */
  Closed = 'closed',
  
  /** Resolved, payouts distributed */
  Resolved = 'resolved',
  
  /** Cancelled, positions refunded */
  Cancelled = 'cancelled',
}

/**
 * Market categories for organization and filtering.
 */
export enum MarketCategory {
  /** Cryptocurrency price predictions */
  Crypto = 'crypto',
  
  /** Political elections and events */
  Politics = 'politics',
  
  /** Financial markets and economic indicators */
  Finance = 'finance',
  
  /** Sports outcomes */
  Sports = 'sports',
  
  /** Entertainment and celebrity events */
  Entertainment = 'entertainment',
  
  /** Science and technology milestones */
  Science = 'science',
  
  /** Weather and natural events */
  Weather = 'weather',
  
  /** Custom/uncategorized */
  Other = 'other',
}

/**
 * Outcome type for binary vs multi-outcome markets.
 */
export enum OutcomeType {
  /** Yes/No binary market (price 0-1 represents probability) */
  Binary = 'binary',
  
  /** Multiple choice outcome (e.g., Candidate A, B, C) */
  Categorical = 'categorical',
  
  /** Scalar/numeric outcome (e.g., BTC price on date) */
  Scalar = 'scalar',
}

/**
 * Core market metadata.
 * 
 * Represents a prediction market as displayed in the node graph.
 * Links to node ID for visualization and position tracking.
 */
export interface Market {
  /** Unique identifier (exchange-specific) */
  id: string;
  
  /** Reference to node graph node ID */
  nodeId: string;
  
  /** Exchange/market type */
  type: MarketType;
  
  /** Human-readable market question */
  question: string;
  
  /** Detailed description/rules */
  description: string;
  
  /** Current market status */
  status: MarketStatus;
  
  /** Market category for filtering */
  category: MarketCategory;
  
  /** Outcome type determines pricing model */
  outcomeType: OutcomeType;
  
  /** For categorical markets: available outcomes */
  outcomes?: Outcome[];
  
  /** For scalar markets: min/max bounds */
  scalarBounds?: {
    min: number;
    max: number;
    unit: string;
  };
  
  /** Market creation timestamp */
  createdAt: number;
  
  /** Trading open time */
  opensAt: number;
  
  /** Trading close time (market locks) */
  closesAt: number;
  
  /** Expected resolution time */
  resolvesAt: number;
  
  /** Resolution source (URL, API endpoint, oracle) */
  resolutionSource: string;
  
  /** Current best bid/ask for quick reference */
  bestBid: number;
  bestAsk: number;
  
  /** 24h volume in contracts */
  volume24h: number;
  
  /** Total open interest (outstanding contracts) */
  openInterest: number;
  
  /** Liquidity metric (sum of orderbook depth) */
  liquidity: number;
  
  /** Market maker fee (e.g., 0.02 for 2%) */
  feeRate: number;
  
  /** Market image/icon URL */
  imageUrl?: string;
  
  /** Additional exchange-specific metadata */
  metadata: Record<string, any>;
  
  /** Last update timestamp from exchange */
  lastUpdated: number;
}

/**
 * Outcome definition for categorical markets.
 */
export interface Outcome {
  /** Outcome ID (unique within market) */
  id: string;
  
  /** Display name (e.g., "Donald Trump") */
  name: string;
  
  /** Current implied probability (0-1) */
  probability: number;
  
  /** Best bid/ask for this outcome */
  bestBid: number;
  bestAsk: number;
  
  /** Volume for this specific outcome */
  volume: number;
}

// =============================================================================
// ORDERBOOK TYPES
// =============================================================================

/**
 * Price level in the orderbook.
 * 
 * Represents aggregated orders at a specific price point.
 * Size is in number of contracts (notional value = size * price).
 */
export interface Level {
  /** Price level (0.00 - 1.00 for binary markets) */
  price: number;
  
  /** Total size available at this price */
  size: number;
  
  /** Number of orders aggregated at this level */
  orderCount: number;
  
  /** Total value locked at this level (size * price) */
  value: number;
}

/**
 * Full orderbook snapshot.
 * 
 * Maintained in real-time via WebSocket updates.
 * Bids sorted descending (highest first), asks sorted ascending.
 */
export interface Orderbook {
  /** Market ID this orderbook represents */
  marketId: string;
  
  /** Timestamp of this snapshot */
  timestamp: number;
  
  /** Bid levels (buy orders) - sorted price descending */
  bids: Level[];
  
  /** Ask levels (sell orders) - sorted price ascending */
  asks: Level[];
  
  /** Last trade price (if available) */
  lastPrice?: number;
  
  /** Last trade size */
  lastSize?: number;
  
  /** Last trade timestamp */
  lastTradeAt?: number;
  
  /** Sequence number for ordering updates */
  sequence: number;
}

/**
 * Calculated spread metrics from orderbook.
 */
export interface Spread {
  /** Best bid price */
  bid: number;
  
  /** Best ask price */
  ask: number;
  
  /** Absolute spread (ask - bid) */
  absolute: number;
  
  /** Relative spread (absolute / mid) */
  relative: number;
  
  /** Mid price ((bid + ask) / 2) */
  mid: number;
  
  /** Weighted mid price (size-adjusted) */
  weightedMid: number;
}

/**
 * Depth analysis for liquidity assessment.
 */
export interface Depth {
  /** Total bid size within 5% of mid price */
  bidDepth5: number;
  
  /** Total ask size within 5% of mid price */
  askDepth5: number;
  
  /** Total bid size within 10% of mid price */
  bidDepth10: number;
  
  /** Total ask size within 10% of mid price */
  askDepth10: number;
  
  /** Bid/ask depth imbalance ratio */
  imbalance: number;
}

// =============================================================================
// ORDER TYPES
// =============================================================================

/**
 * Order side (buy = YES/long, sell = NO/short).
 */
export enum OrderSide {
  Buy = 'buy',
  Sell = 'sell',
}

/**
 * Order type determines execution behavior.
 */
export enum OrderType {
  /** Execute immediately at best available price */
  Market = 'market',
  
  /** Execute at specified price or better */
  Limit = 'limit',
  
  /** Trigger market order when price reaches stop level */
  Stop = 'stop',
  
  /** Trigger limit order when price reaches stop level */
  StopLimit = 'stop_limit',
  
  /** Immediate-or-cancel (fill available, cancel remainder) */
  IOC = 'ioc',
  
  /** Fill-or-kill (complete fill or cancel) */
  FOK = 'fok',
}

/**
 * Time in force - how long order remains active.
 */
export enum TimeInForce {
  /** Good till cancelled (default) */
  GTC = 'GTC',
  
  /** Good till time (specify expiration) */
  GTT = 'GTT',
  
  /** Immediate or cancel */
  IOC = 'IOC',
  
  /** Fill or kill */
  FOK = 'FOK',
}

/**
 * Order status lifecycle.
 */
export enum OrderStatus {
  /** Pending submission to exchange */
  Pending = 'pending',
  
  /** Submitted, awaiting fill */
  Open = 'open',
  
  /** Partially filled */
  Partial = 'partial',
  
  /** Completely filled */
  Filled = 'filled',
  
  /** Cancelled by user */
  Cancelled = 'cancelled',
  
  /** Rejected by exchange */
  Rejected = 'rejected',
  
  /** Expired (GTT orders) */
  Expired = 'expired',
}

/**
 * Order structure for placement and tracking.
 * 
 * Maps to backend Order struct in src-tauri/src/models/market.rs
 */
export interface Order {
  /** Unique order ID (generated by exchange or client) */
  id: string;
  
  /** Associated market ID */
  marketId: string;
  
  /** Reference to node graph node */
  marketNodeId: string;
  
  /** Exchange type */
  market: MarketType;
  
  /** Buy or sell */
  side: OrderSide;
  
  /** Order type */
  type: OrderType;
  
  /** Number of contracts */
  size: number;
  
  /** Filled quantity */
  filledSize: number;
  
  /** Remaining quantity */
  remainingSize: number;
  
  /** Order price (undefined for market orders) */
  price?: number;
  
  /** Stop trigger price (for stop/stop-limit orders) */
  stopPrice?: number;
  
  /** Time in force */
  timeInForce: TimeInForce;
  
  /** Order expiration (for GTT) */
  expireAt?: number;
  
  /** Current status */
  status: OrderStatus;
  
  /** Creation timestamp */
  createdAt: number;
  
  /** Last update timestamp */
  updatedAt: number;
  
  /** Average fill price (0 if unfilled) */
  avgFillPrice: number;
  
  /** Total fees paid */
  fees: number;
  
  /** Client-provided reference ID */
  clientOrderId?: string;
  
  /** Linked position ID (for closing orders) */
  positionId?: string;
  
  /** Stop-loss trigger price (attached to position) */
  stopLoss?: number;
  
  /** Take-profit trigger price (attached to position) */
  takeProfit?: number;
}

// =============================================================================
// TRADE & EXECUTION TYPES
// =============================================================================

/**
 * Individual fill/execution record.
 * 
 * A single order may have multiple fills (partial execution).
 */
export interface Fill {
  /** Fill ID (unique) */
  id: string;
  
  /** Parent order ID */
  orderId: string;
  
  /** Market ID */
  marketId: string;
  
  /** Filled quantity */
  size: number;
  
  /** Fill price */
  price: number;
  
  /** Side (redundant but convenient) */
  side: OrderSide;
  
  /** Fees for this fill */
  fees: number;
  
  /** Fill timestamp */
  timestamp: number;
  
  /** Liquidity provider rebate (if applicable) */
  rebate?: number;
}

/**
 * Trade execution result from backend.
 * 
 * Returned by trading::place_order command.
 */
export interface TradeResult {
  /** Whether execution was successful */
  success: boolean;
  
  /** Error message if failed */
  error?: string;
  
  /** Executed order (if successful) */
  order?: Order;
  
  /** Fill details (if filled) */
  fills?: Fill[];
  
  /** Created position (if opening trade) */
  position?: import('./positions').Position;
  
  /** Updated balances */
  balances?: Record<string, number>;
  
  /** Execution latency in milliseconds */
  latency: number;
  
  /** Exchange timestamp */
  exchangeTimestamp?: number;
}

/**
 * Trade history entry (completed trades).
 */
export interface Trade {
  /** Trade ID */
  id: string;
  
  /** Market ID */
  marketId: string;
  
  /** Market type */
  market: MarketType;
  
  /** Order ID that generated this trade */
  orderId: string;
  
  /** Position ID affected */
  positionId: string;
  
  /** Buy or sell */
  side: OrderSide;
  
  /** Size in contracts */
  size: number;
  
  /** Execution price */
  price: number;
  
  /** Total value (size * price) */
  value: number;
  
  /** Fees paid */
  fees: number;
  
  /** Net proceeds (value - fees for sells, value + fees for buys) */
  netAmount: number;
  
  /** Trade timestamp */
  timestamp: number;
  
  /** P&L realized by this trade (for closing trades) */
  realizedPnl?: number;
}

// =============================================================================
// WEBSOCKET EVENT TYPES
// =============================================================================

/**
 * Base interface for all WebSocket events.
 */
export interface WebSocketEvent {
  /** Event type discriminator */
  type: string;
  
  /** Event timestamp */
  timestamp: number;
  
  /** Market ID (if applicable) */
  marketId?: string;
  
  /** Sequence number for ordering */
  sequence: number;
}

/**
 * Orderbook update event (L2 data).
 * 
 * Sent when bids or asks change.
 */
export interface OrderbookUpdateEvent extends WebSocketEvent {
  type: 'orderbook_update';
  
  /** Market ID */
  marketId: string;
  
  /** Changed bid levels (empty if no bid changes) */
  bids: Level[];
  
  /** Changed ask levels (empty if no ask changes) */
  asks: Level[];
  
  /** Full book snapshot (if true, replace local book; if false, patch) */
  snapshot: boolean;
}

/**
 * Trade/tick event (L1 data).
 * 
 * Sent on each trade execution.
 */
export interface TradeEvent extends WebSocketEvent {
  type: 'trade';
  
  /** Market ID */
  marketId: string;
  
  /** Trade price */
  price: number;
  
  /** Trade size */
  size: number;
  
  /** Trade side (from taker's perspective) */
  side: OrderSide;
  
  /** Trade ID from exchange */
  tradeId: string;
}

/**
 * Price aggregate event (for charting).
 */
export interface PriceUpdateEvent extends WebSocketEvent {
  type: 'price_update';
  
  /** Market ID */
  marketId: string;
  
  /** Best bid */
  bid: number;
  
  /** Best ask */
  ask: number;
  
  /** Last trade price */
  last: number;
  
  /** 24h volume */
  volume24h: number;
}

/**
 * Market status change event.
 */
export interface MarketStatusEvent extends WebSocketEvent {
  type: 'market_status';
  
  /** Market ID */
  marketId: string;
  
  /** New status */
  status: MarketStatus;
  
  /** Previous status */
  previousStatus: MarketStatus;
  
  /** Reason for change (if available) */
  reason?: string;
}

/**
 * Settlement/resolution event.
 */
export interface SettlementEvent extends WebSocketEvent {
  type: 'settlement';
  
  /** Market ID */
  marketId: string;
  
  /** Winning outcome (for categorical) */
  winningOutcome?: string;
  
  /** Settlement price (for scalar) */
  settlementPrice?: number;
  
  /** Settlement timestamp */
  settledAt: number;
}

/**
 * Union type of all market events.
 */
export type MarketEvent =
  | OrderbookUpdateEvent
  | TradeEvent
  | PriceUpdateEvent
  | MarketStatusEvent
  | SettlementEvent;

// =============================================================================
// API REQUEST/RESPONSE TYPES
// =============================================================================

/**
 * Parameters for fetching orderbook.
 */
export interface GetOrderbookParams {
  /** Market ID */
  marketId: string;
  
  /** Market type (determines API endpoint) */
  marketType: MarketType;
  
  /** Depth levels to fetch (default 25) */
  depth?: number;
}

/**
 * Parameters for placing order.
 */
export interface PlaceOrderParams {
  /** Market to trade on */
  market: MarketType;
  
  /** Market node ID (for linking to graph) */
  marketNodeId: string;
  
  /** Buy or sell */
  side: OrderSide;
  
  /** Number of contracts */
  size: number;
  
  /** Order price (omit for market orders) */
  price?: number;
  
  /** Order type */
  orderType: OrderType;
  
  /** Time in force */
  timeInForce: TimeInForce;
  
  /** Expiration timestamp (for GTT) */
  expireAt?: number;
  
  /** Stop trigger price */
  stopPrice?: number;
  
  /** Associated position (for closing orders) */
  closingPositionId?: string;
  
  /** Stop-loss level (attach to new position) */
  stopLoss?: number;
  
  /** Take-profit level (attach to new position) */
  takeProfit?: number;
  
  /** Maximum position size constraint */
  maxPositionSize?: number;
}

/**
 * Market query filters.
 */
export interface MarketFilters {
  /** Filter by market type */
  type?: MarketType;
  
  /** Filter by status */
  status?: MarketStatus;
  
  /** Filter by category */
  category?: MarketCategory;
  
  /** Search query string */
  search?: string;
  
  /** Minimum liquidity threshold */
  minLiquidity?: number;
  
  /** Closing after this timestamp */
  closesAfter?: number;
  
  /** Closing before this timestamp */
  closesBefore?: number;
  
  /** Only markets with open interest */
  hasOpenInterest?: boolean;
}

/**
 * Pagination parameters.
 */
export interface PaginationParams {
  /** Page number (0-indexed) */
  page: number;
  
  /** Items per page */
  limit: number;
  
  /** Sort field */
  sortBy?: 'volume' | 'liquidity' | 'closingSoon' | 'created';
  
  /** Sort direction */
  sortOrder?: 'asc' | 'desc';
}

/**
 * Paginated response wrapper.
 */
export interface PaginatedResponse<T> {
  /** Items for current page */
  items: T[];
  
  /** Total items available */
  total: number;
  
  /** Current page */
  page: number;
  
  /** Items per page */
  limit: number;
  
  /** Has next page */
  hasMore: boolean;
}

// =============================================================================
// UTILITY & HELPER TYPES
// =============================================================================

/**
 * Arbitrage opportunity between two markets.
 */
export interface ArbitrageOpportunity {
  /** Buy market (lower price) */
  buyMarket: MarketType;
  
  /** Sell market (higher price) */
  sellMarket: MarketType;
  
  /** Market ID (same underlying on both markets) */
  marketId: string;
  
  /** Buy price */
  buyPrice: number;
  
  /** Sell price */
  sellPrice: number;
  
  /** Spread percentage */
  spread: number;
  
  /** Maximum profitable size (limited by liquidity) */
  maxSize: number;
  
  /** Expected profit (after fees) */
  expectedProfit: number;
  
  /** Timestamp detected */
  detectedAt: number;
  
  /** Time to live (ms until opportunity likely gone) */
  ttl: number;
}

/**
 * Market comparison data (for correlation analysis).
 */
export interface MarketComparison {
  /** Primary market */
  primary: Market;
  
  /** Comparison market */
  secondary: Market;
  
  /** Price correlation (-1 to 1) */
  priceCorrelation: number;
  
  /** Volume ratio (primary / secondary) */
  volumeRatio: number;
  
  /** Liquidity ratio */
  liquidityRatio: number;
  
  /** Fee-adjusted spread comparison */
  effectiveSpreadDiff: number;
}

/**
 * Implied probability calculation result.
 */
export interface ImpliedProbability {
  /** Raw market price */
  price: number;
  
  /** Implied probability (0-1) */
  probability: number;
  
  /** Adjusted for fees */
  probabilityAfterFees: number;
  
  /** Confidence interval (if available) */
  confidence?: {
    lower: number;
    upper: number;
  };
}

// =============================================================================
// TYPE GUARDS
// =============================================================================

/**
 * Type guard for WebSocket events.
 */
export function isOrderbookUpdate(event: WebSocketEvent): event is OrderbookUpdateEvent {
  return event.type === 'orderbook_update';
}

export function isTradeEvent(event: WebSocketEvent): event is TradeEvent {
  return event.type === 'trade';
}

export function isPriceUpdate(event: WebSocketEvent): event is PriceUpdateEvent {
  return event.type === 'price_update';
}

export function isMarketStatusEvent(event: WebSocketEvent): event is MarketStatusEvent {
  return event.type === 'market_status';
}

export function isSettlementEvent(event: WebSocketEvent): event is SettlementEvent {
  return event.type === 'settlement';
}

/**
 * Type guard for binary markets.
 */
export function isBinaryMarket(market: Market): boolean {
  return market.outcomeType === OutcomeType.Binary;
}

/**
 * Type guard for active (tradable) markets.
 */
export function isActiveMarket(market: Market): boolean {
  return market.status === MarketStatus.Open;
}

// =============================================================================
// CONSTANTS & ENUMERATIONS
// =============================================================================

/** Minimum order size by market type */
export const MIN_ORDER_SIZE: Record<MarketType, number> = {
  [MarketType.Polymarket]: 1,
  [MarketType.Kalshi]: 1,
};

/** Price precision (decimal places) by market type */
export const PRICE_PRECISION: Record<MarketType, number> = {
  [MarketType.Polymarket]: 4, // 0.0001 increments
  [MarketType.Kalshi]: 2,     // 0.01 increments
};

/** Fee rates by market type (as decimal, e.g., 0.02 = 2%) */
export const DEFAULT_FEE_RATES: Record<MarketType, number> = {
  [MarketType.Polymarket]: 0.02, // 2% taker fee
  [MarketType.Kalshi]: 0.05,     // 5% on profits
};

/** WebSocket channel names by market type */
export const WS_CHANNELS: Record<MarketType, string> = {
  [MarketType.Polymarket]: 'wss://ws.polymarket.com',
  [MarketType.Kalshi]: 'wss://trading-api.kalshi.com/trade/ws/v2',
};

// =============================================================================
// DERIVED TYPES (from other slices)
// =============================================================================

// Re-export Position-related types from positions.ts for convenience
export type { Position, ClosedPosition } from './positions';

// =============================================================================
// EXAMPLE USAGE
// =============================================================================
//
// // Creating a new market order
// const order: Order = {
//   id: crypto.randomUUID(),
//   marketId: '0x123...',
//   marketNodeId: 'node-456',
//   market: MarketType.Polymarket,
//   side: OrderSide.Buy,
//   type: OrderType.Market,
//   size: 100,
//   filledSize: 0,
//   remainingSize: 100,
//   timeInForce: TimeInForce.IOC,
//   status: OrderStatus.Pending,
//   createdAt: Date.now(),
//   updatedAt: Date.now(),
//   avgFillPrice: 0,
//   fees: 0,
// };
//
// // Handling WebSocket event
// function handleMarketEvent(event: MarketEvent) {
//   if (isOrderbookUpdate(event)) {
//     updateOrderbook(event.marketId, event.bids, event.asks);
//   } else if (isTradeEvent(event)) {
//     updateLastTrade(event.marketId, event.price, event.size);
//   }
// }
//
// // Calculating spread
// function calculateSpread(orderbook: Orderbook): Spread {
//   const bestBid = orderbook.bids[0]?.price ?? 0;
//   const bestAsk = orderbook.asks[0]?.price ?? 0;
//   const mid = (bestBid + bestAsk) / 2;
//   return {
//     bid: bestBid,
//     ask: bestAsk,
//     absolute: bestAsk - bestBid,
//     relative: (bestAsk - bestBid) / mid,
//     mid,
//     weightedMid: mid, // Simplified - would weight by size
//   };
// }
//
// ============================================================================