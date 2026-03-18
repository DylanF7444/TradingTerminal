// ============================================================================
// MARKET DATA TYPE DEFINITIONS
// ============================================================================
//
// Module: types/markets.ts
// Purpose: Core TypeScript interfaces for prediction market data structures
//
// Defines types for orderbooks, market metadata, trade execution, and
// WebSocket event payloads. Mirrors Rust structs in src-tauri/src/models/market.rs
// with Tauri IPC bridge serialization compatibility.
//
// Architecture: Domain-Driven Types with Discriminated Unions
//   Market <-> Orderbook <-> Order <-> Trade (entity relationships)
//   WebSocketEvent = PriceUpdate | OrderbookUpdate | TradeUpdate (union types)
//
// Key notes:
//   - All types must be JSON-serializable (Tauri IPC constraint)
//   - Timestamps use number (ms since epoch)
//   - MarketType imported from types/nodes.ts (single source of truth)
//   - Prediction market prices are 0.00-1.00; use toFixed(4) for display
//
// ============================================================================

import { MarketType } from './nodes';

// =============================================================================
// CORE MARKET TYPES
// =============================================================================

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
 * 
 * Mirrors Rust Orderbook struct in src-tauri/src/models/market.rs
 * Fields: liquidity, spread added to match Rust implementation.
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
  
  /** Total liquidity in market (sum of bid/ask value) */
  liquidity: number;
  
  /** Bid-ask spread (best_ask - best_bid) */
  spread: number;
  
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
  position?: Position;
  
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
// MULTI-LEG / MULTI-OUTCOME MARKET TYPES
// =============================================================================
//
// These types support multi-outcome (categorical) markets and multi-leg
// order structures. Multi-outcome markets allow betting on specific
// individuals or outcomes (e.g., "Who will be the Republican nominee?")
// rather than binary YES/NO. Multi-leg orders allow executing coordinated
// trades across multiple outcomes or markets simultaneously.
//
// Order Types:
//   - single: Standard single-market order (backwards compatible)
//   - oco: One-Cancels-Other (first fill cancels remaining legs)
//   - bracket: Entry + stop-loss + take-profit as atomic unit
//   - spread: Simultaneous buy/sell across related outcomes
//
// Position Tracking:
//   - MultiLegPosition groups individual PositionLegs under a strategy
//   - Combined P&L calculated as sum of all leg P&Ls minus total fees
//   - Hedge ratio tracks net directional exposure across legs
//
// =============================================================================

/**
 * Multi-leg order type determines execution behavior across legs.
 */
export enum MultiLegOrderType {
  /** Standard single-market order (backwards compatible) */
  Single = 'single',

  /** One-Cancels-Other: first leg fill cancels remaining legs */
  OCO = 'oco',

  /** Bracket: entry + stop-loss + take-profit as atomic unit */
  Bracket = 'bracket',

  /** Spread: simultaneous buy/sell across related outcomes */
  Spread = 'spread',
}

/**
 * Single leg within a multi-leg order.
 *
 * Each leg targets a specific market and outcome, with its own
 * side, size, and optional price. The ratio field supports
 * proportional sizing (e.g., 2:1 leg ratios for hedged positions).
 */
export interface OrderLeg {
  /** Target market ID for this leg */
  marketId: string;

  /** Outcome ID for categorical markets (omit for binary) */
  outcomeId?: string;

  /** Buy or sell direction for this leg */
  side: OrderSide;

  /** Relative sizing ratio (e.g., 2 in a 2:1 spread) */
  ratio: number;

  /** Absolute contract size for this leg */
  size: number;

  /** Limit price for this leg (omit for market orders) */
  price?: number;

  /** Reference to node graph node for this leg's market */
  marketNodeId?: string;
}

/**
 * Multi-leg order structure for coordinated execution.
 *
 * Wraps multiple OrderLeg entries with shared execution parameters.
 * The executor processes legs according to the orderType strategy
 * (parallel for spreads, sequential with cancellation for OCO).
 */
export interface MultiLegOrder {
  /** Unique order ID */
  id: string;

  /** Array of order legs to execute */
  legs: OrderLeg[];

  /** Execution strategy for the legs */
  orderType: MultiLegOrderType;

  /** Time in force applies to all legs */
  timeInForce: TimeInForce;

  /** Current status of the multi-leg order */
  status: OrderStatus;

  /** Creation timestamp */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;

  /** Strategy label for grouping (user-defined) */
  strategyLabel?: string;

  /** Total fees paid across all legs */
  totalFees: number;

  /** Associated strategy/position group ID */
  strategyId?: string;
}

/**
 * Individual leg within a multi-leg position.
 *
 * Tracks the realized position state for one leg of a multi-leg
 * strategy including its own P&L, fill price, and current value.
 */
export interface PositionLeg {
  /** Leg identifier (unique within position) */
  legId: string;

  /** Market ID this leg is positioned in */
  marketId: string;

  /** Outcome ID for categorical markets */
  outcomeId?: string;

  /** Position direction */
  side: 'buy' | 'sell';

  /** Number of contracts held on this leg */
  size: number;

  /** Average entry price for this leg */
  entryPrice: number;

  /** Current market price for this leg */
  currentPrice: number;

  /** Unrealized P&L for this leg */
  unrealizedPnl: number;

  /** Realized P&L for this leg (if partially/fully closed) */
  realizedPnl: number;

  /** Fees paid for this specific leg */
  fees: number;

  /** Leg status */
  status: PositionStatus;

  /** Reference to node graph node */
  marketNodeId?: string;
}

/**
 * Multi-leg position groups individual legs under a strategy.
 *
 * Provides aggregate P&L, hedge ratio, and combined value metrics
 * across all legs. Used for portfolio-level risk tracking and
 * combined position views in the UI.
 */
export interface MultiLegPosition {
  /** Unique position group ID */
  id: string;

  /** Strategy identifier for grouping related positions */
  strategyId: string;

  /** Individual position legs */
  legs: PositionLeg[];

  /** Strategy type classification */
  strategyType: 'single' | 'multi-leg' | 'arbitrage';

  /** User-defined strategy label */
  strategyLabel?: string;

  /** Combined entry value across all legs */
  combinedEntryValue: number;

  /** Combined current value across all legs */
  combinedCurrentValue: number;

  /** Aggregate unrealized P&L: sum(leg.unrealizedPnl) */
  unrealizedPnl: number;

  /** Aggregate realized P&L: sum(leg.realizedPnl) */
  realizedPnl: number;

  /** Total fees across all legs */
  totalFees: number;

  /**
   * Hedge ratio: net directional exposure.
   * 0.0 = fully hedged (delta-neutral)
   * 1.0 = fully directional (single leg)
   * Between 0-1 = partially hedged
   */
  hedgeRatio: number;

  /** Position status (derived from leg statuses) */
  status: PositionStatus;

  /** Position creation timestamp */
  openedAt: number;

  /** Position close timestamp (if fully closed) */
  closedAt?: number;
}

/**
 * Parameters for placing a multi-leg order.
 */
export interface PlaceMultiLegOrderParams {
  /** Array of legs defining the multi-leg order */
  legs: OrderLeg[];

  /** Multi-leg execution strategy */
  orderType: MultiLegOrderType;

  /** Time in force for all legs */
  timeInForce: TimeInForce;

  /** User-defined strategy label */
  strategyLabel?: string;

  /** Maximum total position size across all legs */
  maxTotalSize?: number;
}

/**
 * Outcome selector for categorical market order entry.
 *
 * Used by the UI to present available outcomes and let users
 * build multi-leg orders by selecting individual outcomes.
 */
export interface OutcomeSelection {
  /** Outcome definition from the market */
  outcome: Outcome;

  /** Whether this outcome is selected for ordering */
  selected: boolean;

  /** Order side for this outcome (if selected) */
  side?: OrderSide;

  /** Number of contracts for this outcome (if selected) */
  size?: number;

  /** Limit price for this outcome (if selected) */
  price?: number;
}

// =============================================================================
// EVENT SEARCH TYPES (grouped markets by event)
// =============================================================================

/**
 * A single market within an event search result.
 * Mirrors Rust EventMarketItem in src-tauri/src/commands/markets.rs
 */
export interface EventMarketItem {
  /** Market identifier (CLOB token ID for Polymarket, ticker for Kalshi) */
  id: string;
  /** Human-readable market title */
  title: string;
  /** Short description or subtitle */
  description: string;
  /** Current YES price (probability 0.0 - 1.0) */
  yes_price: number | null;
  /** Current NO price */
  no_price: number | null;
  /** Trading volume */
  volume: number | null;
  /** Liquidity / open interest */
  liquidity: number | null;
  /** Market status */
  status: string;
  /** End date / close time */
  end_date: string | null;
  /** URL-friendly slug or ticker */
  slug: string;
  /** CLOB token IDs for Polymarket */
  token_ids: string[];
  /** Condition ID for Polymarket */
  condition_id: string | null;
}

/**
 * An event search result containing nested markets.
 * Mirrors Rust EventSearchResult in src-tauri/src/commands/markets.rs
 */
export interface EventSearchResult {
  /** Event identifier */
  id: string;
  /** Event title */
  title: string;
  /** Event description */
  description: string;
  /** Event image URL */
  image_url: string | null;
  /** Event category */
  category: string | null;
  /** Platform name */
  platform: string;
  /** Event slug */
  slug: string;
  /** Markets within this event */
  markets: EventMarketItem[];
  /** Number of markets in this event */
  market_count: number;
  /** Creation date */
  created_at: string | null;
}

/**
 * Paginated event search response.
 * Mirrors Rust EventSearchResponse in src-tauri/src/commands/markets.rs
 */
export interface EventSearchResponse {
  /** Event results for this page */
  results: EventSearchResult[];
  /** Whether more results may be available */
  has_more: boolean;
  /** Opaque cursor for next page */
  next_cursor: string | null;
  /** Page size used */
  page_size: number;
}

/**
 * A market selected by the user from an event.
 * Used by MarketBrowser -> MarketPanel to pass selected markets.
 */
export interface SelectedEventMarket {
  /** Market ID */
  id: string;
  /** Market title */
  title: string;
  /** CLOB token IDs for Polymarket */
  tokenIds: string[];
  /** Static details from search result */
  details: {
    description?: string;
    image_url?: string;
    category?: string;
    end_date?: string;
    status?: string;
    slug?: string;
    condition_id?: string;
  };
}

// =============================================================================
// SERIES NODE TYPES
// =============================================================================

/**
 * A single market entry stored within a series node's metadata.
 * Contains a snapshot of the market's current state from the last refresh.
 */
export interface SeriesChildMarket {
  /** Market ID (same as EventMarketItem.id) */
  id: string;
  /** Market title/question */
  title: string;
  /** CLOB token IDs (Polymarket) */
  token_ids: string[];
  /** Current YES price (0.0 - 1.0), null if unavailable */
  yes_price: number | null;
  /** Current NO price, null if unavailable */
  no_price: number | null;
  /** Trading volume */
  volume: number | null;
  /** Liquidity / open interest */
  liquidity: number | null;
  /** Market status string (e.g., "active", "resolved", "closed") */
  status: string;
  /** End date / close time */
  end_date: string | null;
  /** URL-friendly slug or ticker */
  slug: string;
  /** Condition ID for Polymarket */
  condition_id: string | null;
  /** Whether this market has been resolved */
  is_resolved: boolean;
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

// Position-related types (defined inline since positions.ts doesn't exist)
export interface Position {
  id: string;
  marketNodeId: string;
  market: string;
  side: 'buy' | 'sell';
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  fees: number;
  status: PositionStatus;
  openedAt: number;
  orderId: string;
  stopLoss?: number;
  takeProfit?: number;
}

export interface ClosedPosition extends Position {
  exitPrice: number;
  closedAt: number;
  holdingPeriod: number;
}

export interface OpenPositionParams {
  market: string;
  marketNodeId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  orderType?: string;
  timeInForce?: string;
  stopLoss?: number;
  takeProfit?: number;
  leverage?: number;
  maxPositionSize?: number;
}

export interface FillDetails {
  size: number;
  price: number;
}

export interface PerformanceMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  sharpeRatio: number | null;
  maxDrawdown: number;
  averageWin: number;
  averageLoss: number;
  expectancy: number;
  totalReturn: number;
}

/**
 * Network bandwidth metrics from WebSocket connections
 */
export interface NetworkMetrics {
  bytes_received: number;
  bytes_sent: number;
  messages_received: number;
  messages_sent: number;
}

export interface RiskAssessment {
  positionId: string;
  var95: number;
  var99: number;
  expectedShortfall: number;
  marginRequirement: number;
  liquidationPrice: number | null;
  riskLevel: 'low' | 'medium' | 'high' | 'unknown';
}

export interface HistoryQueryOptions {
  startTime?: number;
  endTime?: number;
  limit?: number;
  offset?: number;
}

export type PositionStatus = 'pending' | 'open' | 'closing' | 'closed';

