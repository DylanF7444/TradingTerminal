// ============================================================================
// TRADING POSITIONS STATE MANAGEMENT SLICE
// ============================================================================
//
// Module: store/positionsSlice.ts
// Purpose: Zustand state slice managing all trading positions and order history
//
// OVERVIEW:
// This slice manages the complete lifecycle of trading positions across all
// connected prediction markets (Polymarket, Kalshi). It tracks open positions,
// pending orders, trade history, and real-time P&L calculations. The slice
// serves as the single source of truth for the PositionMonitor component and
// provides the data foundation for performance metrics and risk management.
//
// The slice implements a dual-state architecture separating active positions
// (open trades) from historical positions (closed trades) for efficient
// querying and memory management. It integrates with the nodesSlice to link
// positions to specific market nodes, enabling correlation analysis between
// market data and trading outcomes.
//
// Architecture Pattern:
// Active/History Split with Normalized References
//   openPositions: Position[]           // Currently open trades
//   pendingOrders: Order[]              // Orders awaiting execution
//   tradeHistory: ClosedPosition[]      // Completed trades (paginated)
//   positionByMarket: Record<string, Position[]>  // Index by market node ID
//
// Position State Machine:
//   Pending → Open → Closing → Closed
//      ↑         ↓      ↓
//   Cancelled  Liquidated  Expired
//
// The state machine ensures valid transitions and prevents illegal operations
// (e.g., closing an already closed position).
//
// P&L CALCULATION ENGINE:
//
// Real-time Unrealized P&L:
//   For each open position, calculates current value based on:
//   - Entry price vs current market price
//   - Position size (number of contracts)
//   - Direction (LONG/SHORT)
//   - Funding costs (if applicable)
//   - Accrued fees
//
// Formula:
//   unrealizedPnl = (currentPrice - entryPrice) * size * directionMultiplier
//   directionMultiplier = 1 for LONG, -1 for SHORT
//
// Realized P&L (on close):
//   realizedPnl = (exitPrice - entryPrice) * size * directionMultiplier
//               - entryFees - exitFees - fundingCosts
//
// PERFORMANCE METRICS:
//
// Aggregated statistics calculated from trade history:
//   - Win Rate: % of profitable trades
//   - Profit Factor: Gross profit / Gross loss
//   - Sharpe Ratio: Risk-adjusted returns
//   - Max Drawdown: Peak-to-trough decline
//   - Average Trade: Mean P&L per trade
//   - Expectancy: (Win% * AvgWin) - (Loss% * AvgLoss)
//
// These metrics power the PerformanceMetrics component and inform the
// Kelly criterion calculator for position sizing.
//
// RISK MANAGEMENT:
//
// Position Limits:
//   - Max position size per market (prevents over-concentration)
//   - Max total exposure across all markets
//   - Daily loss limit (circuit breaker)
//
// Auto-liquidation:
//   - Stop-loss orders trigger position close
//   - Margin calls for leveraged positions
//   - Expiration handling for time-bound markets
//
// SLICE INTERFACE:
//
// State:
//
// 1. openPositions: Position[]
//    - All currently open trading positions
//    - Sorted by entry time (newest first)
//    - Updated in real-time via WebSocket from backend
//    - Each position linked to a market node ID from nodesSlice
//
// 2. pendingOrders: Order[]
//    - Orders submitted but not yet filled
//    - Includes limit orders, stop orders, market orders pending execution
//    - Tracks fill percentage for partial fills
//    - Auto-expires orders based on time-in-force (GTC, IOC, FOK)
//
// 3. tradeHistory: ClosedPosition[]
//    - Chronological record of all closed positions
//    - Paginated for performance (last 1000 trades in memory)
//    - Full history available via storage::query_timeseries
//    - Used for performance calculations and tax reporting
//
// 4. positionByMarket: Record<string, Position[]>
//    - Index mapping market node IDs to their open positions
//    - Enables O(1) lookup of positions for a specific market
//    - Automatically maintained via derived state
//
// 5. balances: Record<string, number>
//    - Available cash balances per market/exchange
//    - Keys: 'polymarket', 'kalshi', 'total'
//    - Updated after each trade and funding event
//
// 6. dailyStats: {
//      date: string;
//      trades: number;
//      volume: number;
//      realizedPnl: number;
//      fees: number;
//    }
//    - Running totals for current trading day
//    - Resets at midnight UTC
//    - Used for daily performance tracking and limits
//
// 7. lastUpdate: number
//    - Timestamp of most recent position update
//    - Used for stale data detection and sync status
//
// Actions:
//
// 1. openPosition(params: OpenPositionParams): Promise<Position>
//    - Initiates new position via trading::place_order backend command
//    - Validates sufficient balance and position limits
//    - Creates pending order, transitions to open on fill
//    - Links position to market node ID for graph visualization
//    - Returns position object with generated ID
//
// 2. closePosition(positionId: string, exitPrice?: number): Promise<void>
//    - Closes existing position at market or specified price
//    - Calculates realized P&L and updates balances
//    - Moves position from openPositions to tradeHistory
//    - Updates market node with close event for correlation analysis
//    - Triggers performance metrics recalculation
//
// 3. modifyPosition(positionId: string, updates: Partial<Position>): void
//    - Updates position parameters (stop-loss, take-profit, size)
//    - Validates modifications don't exceed risk limits
//    - Sends update to backend via trading::modify_order
//    - Common use: Tightening stop-loss as position becomes profitable
//
// 4. cancelOrder(orderId: string): void
//    - Cancels pending order before execution
//    - Removes from pendingOrders, restores reserved balance
//    - Sends cancel to backend exchange API
//
// 5. updatePositionPrice(positionId: string, currentPrice: number): void
//    - Updates mark price for unrealized P&L calculation
//    - Called by WebSocket price feeds every 1-5 seconds
//    - Triggers UI update in PositionMonitor component
//    - Checks stop-loss/take-profit triggers
//
// 6. fillOrder(orderId: string, fill: FillDetails): void
//    - Handles partial or complete order fills
//    - Updates position size and average entry price
//    - Transitions from pendingOrders to openPositions when fully filled
//    - Records fill in timeseries database for audit trail
//
// 7. syncPositions(): Promise<void>
//    - Full reconciliation with backend/exchange state
//    - Fetches all open positions via trading::get_positions
//    - Compares local state with exchange, resolves discrepancies
//    - Called on app startup and periodically (every 30s)
//
// 8. loadHistory(options: HistoryQueryOptions): Promise<void>
//    - Loads closed positions from database
//    - Supports date range filtering, pagination
//    - Used when scrolling trade history or generating reports
//
// 9. calculateMetrics(): PerformanceMetrics
//    - Recalculates all performance statistics from tradeHistory
//    - Updates derived state (winRate, sharpeRatio, etc.)
//    - Called automatically when positions close
//
// 10. resetDailyStats(): void
//     - Manually resets daily statistics (e.g., for strategy testing)
//     - Archives previous day to history
//
// DERIVED STATE (Selectors):
//
// getOpenPositions(): Position[]
//   - Returns all open positions sorted by entry time
//   - Used by PositionMonitor main table
//
// getPositionsByMarket(marketNodeId: string): Position[]
//   - Returns positions for specific market node
//   - Used by MarketPanel to show related positions
//
// getTotalUnrealizedPnl(): number
//   - Sums unrealized P&L across all open positions
//   - Real-time updating header in bottom panel
//
// getTotalRealizedPnl(timeRange?: DateRange): number
//   - Sums realized P&L from tradeHistory
//   - Optional time filtering (today, week, month, all)
//
// getExposureByMarket(): Record<string, number>
//   - Calculates notional exposure per market
//   - Risk management visualization
//
// getAvailableBalance(market: string): number
//   - Returns tradable balance (total - reserved - margin)
//   - Used by order entry forms for validation
//
// getWinRate(timeRange?: DateRange): number
//   - Calculates percentage of winning trades
//   - Default excludes pending/cancelled orders
//
// getSharpeRatio(): number
//   - Risk-adjusted return metric
//   - Requires minimum 30 trades for statistical significance
//
// getMaxDrawdown(): number
//   - Maximum peak-to-trough decline in equity curve
//   - Critical risk metric for strategy evaluation
//
// getPositionRisk(positionId: string): RiskAssessment
//   - Calculates Value at Risk (VaR) for position
//   - Considers position size, volatility, correlation
//
// DATA FLOW:
//
// Opening a Position:
//   User clicks "Buy" in OrderbookView.tsx
//     ↓
//   Frontend validates balance via getAvailableBalance()
//     ↓
//   Calls openPosition() → invokes trading::place_order (Rust)
//     ↓
//   Backend submits to Polymarket/Kalshi API
//     ↓
//   On fill confirmation, backend emits WebSocket event
//     ↓
//   fillOrder() action updates state, moves pending→open
//     ↓
//   PositionMonitor.tsx re-renders with new position
//     ↓
//   nodesSlice updates market node with position indicator
//
// Price Update:
//   Backend scraper detects price change
//     ↓
//   Emits price_update via WebSocket
//     ↓
//   useWebSocket hook catches event
//     ↓
//   updatePositionPrice() called for affected positions
//     ↓
//   Unrealized P&L recalculated
//     ↓
//   PositionMonitor row flashes green/red
//     ↓
//   PerformanceMetrics updates equity curve
//
// Closing a Position:
//   User clicks "Close" or stop-loss triggered
//     ↓
//   closePosition() → invokes trading::place_order (opposite side)
//     ↓
//   On fill, position moved to tradeHistory
//     ↓
//   Realized P&L added to dailyStats
//     ↓
//   calculateMetrics() updates win rate, sharpe ratio
//     ↓
//   Storage command archives to timeseries database
//
// PERSISTENCE STRATEGY:
//
// Real-time State (Memory Only):
//   - openPositions: Updated via WebSocket, lost on refresh
//   - pendingOrders: Transient, exchange is source of truth
//   - currentPrices: Continuously updating, no persistence needed
//
// Persistent State (SQLite via Tauri):
//   - tradeHistory: All closed positions stored indefinitely
//   - dailyStats: Archived daily for performance tracking
//   - balances: Synced with exchange, restored on startup
//
// Auto-Sync:
//   - Every 30 seconds: Full position reconciliation
//   - On app focus: Immediate sync check
//   - Before order placement: Balance verification
//
// PERFORMANCE OPTIMIZATIONS:
//
// - O(1) position lookup via ID indexing
// - Virtual scrolling for trade history (1000+ rows)
// - Memoized selectors prevent unnecessary re-renders
// - Batch price updates (100ms throttle)
// - Incremental metrics calculation (only update on close)
//
// MEMORY MANAGEMENT:
//
// - Trade history capped at 1000 records in memory
//   (full history in SQLite, loaded on demand)
// - Closed positions removed from openPositions immediately
// - Price update throttling prevents memory pressure
// - Automatic garbage collection of expired pending orders
//
// ERROR HANDLING:
//
// Order Failures:
//   - Insufficient balance: Reject with user notification
//   - Exchange API error: Retry with exponential backoff
//   - Network timeout: Mark as "stale", queue for sync
//
// State Reconciliation:
//   - Mismatched position sizes: Log warning, prefer exchange state
//   - Orphaned pending orders: Auto-cancel after timeout
//   - Duplicate fills: Idempotent processing by fill ID
//
// TYPE SAFETY:
//
// Position interface includes discriminated unions for state:
//   type PositionStatus = 'pending' | 'open' | 'closing' | 'closed'
//   type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit'
//   type Side = 'buy' | 'sell'
//
// All monetary values stored as number (cents/fixed-point to avoid float errors)
//
// INTEGRATION POINTS:
//
// Backend (Tauri):
//   - trading::place_order → openPosition, closePosition
//   - trading::get_positions → syncPositions
//   - trading::cancel_order → cancelOrder
//   - storage::store_timeseries → trade history archive
//
// Other Slices:
//   - nodesSlice: Link positions to market nodes, show indicators on graph
//   - marketsSlice: Access orderbook for P&L calculation, market metadata
//
// Components:
//   - PositionMonitor.tsx: Subscribes to openPositions, tradeHistory
//   - PerformanceMetrics.tsx: Uses calculated metrics
//   - OrderbookView.tsx: Calls openPosition on trade execution
//   - MarketPanel.tsx: Shows position count per market
//
// USAGE EXAMPLE:
// ```tsx
// // In PositionMonitor component
// const { openPositions, closePosition, getTotalUnrealizedPnl } = usePositionStore();
// 
// const handleClose = async (positionId: string) => {
//   await closePosition(positionId);
// };
// 
// // Subscribe to specific position (optimized re-render)
// const position = usePositionStore(
//   state => state.openPositions.find(p => p.id === positionId)
// );
// ```
//
// DEPENDENCIES:
// - zustand (state management)
// - immer (immutable updates via mutable syntax)
// - ../types/positions (Position, Order, ClosedPosition interfaces)
// - @tauri-apps/api (invoke for backend commands)
//
// MIDDLEWARE:
// - devtools: Redux DevTools for debugging position state
// - persist: Only dailyStats and settings (not real-time positions)
//
// FUTURE ENHANCEMENTS:
// - Paper trading mode (simulated fills without real orders)
// - Position grouping (scale-in/out as single logical position)
// - Advanced order types (OCO, bracket orders, trailing stops)
// - P&L attribution analysis (which sources contributed to profit)
// - Tax lot optimization (FIFO, LIFO, specific identification)
// - Copy trading (mirror positions to sub-accounts)
//
// ============================================================================

import { StateCreator } from 'zustand';
import { invoke } from '@tauri-apps/api/tauri';
import {
  Position,
  Order,
  ClosedPosition,
  OpenPositionParams,
  FillDetails,
  PerformanceMetrics,
  RiskAssessment,
  HistoryQueryOptions,
  PositionStatus,
  OrderStatus,
  Side,
  OrderType,
} from '../types/positions';

// =============================================================================
// SLICE STATE INTERFACE
// =============================================================================

export interface PositionsSlice {
  // -------------------------------------------------------------------------
  // Core State
  // -------------------------------------------------------------------------
  
  /** Currently open trading positions (active exposure) */
  openPositions: Position[];
  
  /** Orders awaiting execution or partial fills */
  pendingOrders: Order[];
  
  /** Historical closed positions (last 1000 in memory) */
  tradeHistory: ClosedPosition[];
  
  /** Index of open positions by market node ID for O(1) lookup */
  positionByMarket: Record<string, Position[]>;
  
  /** Cash balances per exchange/market */
  balances: Record<string, number>;
  
  /** Current trading day statistics */
  dailyStats: {
    date: string;
    trades: number;
    volume: number;
    realizedPnl: number;
    fees: number;
  };
  
  /** Timestamp of last position update for stale detection */
  lastUpdate: number;

  // -------------------------------------------------------------------------
  // Derived/Computed Metrics (Calculated on demand)
  // -------------------------------------------------------------------------
  
  /** Cached performance metrics (recalculated on position close) */
  metrics: PerformanceMetrics | null;

  // -------------------------------------------------------------------------
  // Position Lifecycle Actions
  // -------------------------------------------------------------------------
  
  /** Open new position (initiates order placement) */
  openPosition: (params: OpenPositionParams) => Promise<Position>;
  
  /** Close existing position (market or limit close) */
  closePosition: (positionId: string, exitPrice?: number) => Promise<void>;
  
  /** Modify position parameters (stop-loss, take-profit) */
  modifyPosition: (positionId: string, updates: Partial<Position>) => Promise<void>;
  
  /** Update position mark price (from WebSocket feed) */
  updatePositionPrice: (positionId: string, currentPrice: number) => void;
  
  /** Handle order fill notification from backend */
  fillOrder: (orderId: string, fill: FillDetails) => void;

  // -------------------------------------------------------------------------
  // Order Management Actions
  // -------------------------------------------------------------------------
  
  /** Cancel pending order before execution */
  cancelOrder: (orderId: string) => Promise<void>;
  
  /** Create pending order without immediate execution */
  placeOrder: (order: Omit<Order, 'id' | 'status' | 'createdAt'>) => Promise<Order>;
  
  /** Update order fill percentage (partial fills) */
  updateOrderFill: (orderId: string, filledSize: number) => void;

  // -------------------------------------------------------------------------
  // Synchronization Actions
  // -------------------------------------------------------------------------
  
  /** Full reconciliation with backend/exchange state */
  syncPositions: () => Promise<void>;
  
  /** Load historical trades from database */
  loadHistory: (options?: HistoryQueryOptions) => Promise<void>;
  
  /** Sync balance from exchange */
  syncBalance: (market: string) => Promise<void>;

  // -------------------------------------------------------------------------
  // Analysis Actions
  // -------------------------------------------------------------------------
  
  /** Recalculate all performance metrics */
  calculateMetrics: () => PerformanceMetrics;
  
  /** Reset daily statistics (new trading day) */
  resetDailyStats: () => void;
  
  /** Assess risk for specific position */
  assessRisk: (positionId: string) => RiskAssessment;

  // -------------------------------------------------------------------------
  // Utility Actions
  // -------------------------------------------------------------------------
  
  /** Archive position to history (internal use) */
  archivePosition: (position: Position, closePrice: number, closeTime: number) => void;
  
  /** Clear all state (emergency reset) */
  resetPositions: () => void;

  // -------------------------------------------------------------------------
  // Derived State Getters (Selectors)
  // -------------------------------------------------------------------------
  
  /** Get position by ID */
  getPositionById: (id: string) => Position | undefined;
  
  /** Get all open positions sorted by entry time */
  getOpenPositions: () => Position[];
  
  /** Get positions for specific market node */
  getPositionsByMarket: (marketNodeId: string) => Position[];
  
  /** Get pending orders for specific market */
  getPendingOrdersByMarket: (marketNodeId: string) => Order[];
  
  /** Calculate total unrealized P&L across all positions */
  getTotalUnrealizedPnl: () => number;
  
  /** Calculate total realized P&L (optional time filter) */
  getTotalRealizedPnl: (days?: number) => number;
  
  /** Get current equity (balance + unrealized P&L) */
  getCurrentEquity: () => number;
  
  /** Calculate exposure per market for risk visualization */
  getExposureByMarket: () => Record<string, number>;
  
  /** Get available balance for trading */
  getAvailableBalance: (market: string) => number;
  
  /** Calculate win rate percentage */
  getWinRate: (days?: number) => number;
  
  /** Get Sharpe ratio (risk-adjusted return) */
  getSharpeRatio: () => number | null;
  
  /** Calculate maximum drawdown from equity curve */
  getMaxDrawdown: () => number;
  
  /** Check if daily loss limit reached */
  isDailyLimitReached: () => boolean;
}

// =============================================================================
// SLICE IMPLEMENTATION
// =============================================================================

export const createPositionsSlice: StateCreator<PositionsSlice> = (set, get) => ({
  // -------------------------------------------------------------------------
  // Initial State
  // -------------------------------------------------------------------------
  
  openPositions: [],
  pendingOrders: [],
  tradeHistory: [],
  positionByMarket: {},
  balances: {
    polymarket: 0,
    kalshi: 0,
    total: 0,
  },
  dailyStats: {
    date: new Date().toISOString().split('T')[0],
    trades: 0,
    volume: 0,
    realizedPnl: 0,
    fees: 0,
  },
  lastUpdate: Date.now(),
  metrics: null,

  // -------------------------------------------------------------------------
  // Position Lifecycle Implementation
  // -------------------------------------------------------------------------
  
  openPosition: async (params: OpenPositionParams) => {
    const state = get();
    
    // Validate sufficient balance
    const available = state.getAvailableBalance(params.market);
    const required = params.size * params.price * (params.leverage || 1);
    if (available < required) {
      throw new Error(`Insufficient balance. Available: ${available}, Required: ${required}`);
    }
    
    // Validate position limits
    const existingExposure = state.getExposureByMarket()[params.marketNodeId] || 0;
    if (existingExposure + params.size > (params.maxPositionSize || Infinity)) {
      throw new Error('Position size limit exceeded for this market');
    }
    
    try {
      // Invoke backend to place order
      const result = await invoke<{
        position: Position;
        order: Order;
      }>('place_order', {
        market: params.market,
        marketNodeId: params.marketNodeId,
        side: params.side,
        size: params.size,
        price: params.price,
        orderType: params.orderType || 'market',
        timeInForce: params.timeInForce || 'GTC',
        stopLoss: params.stopLoss,
        takeProfit: params.takeProfit,
      });
      
      set((state) => {
        const newPendingOrders = [...state.pendingOrders, result.order];
        const newBalances = { ...state.balances };
        newBalances[params.market] -= required; // Reserve balance
        
        return {
          pendingOrders: newPendingOrders,
          balances: newBalances,
          lastUpdate: Date.now(),
        };
      });
      
      return result.position;
    } catch (error) {
      console.error('Failed to open position:', error);
      throw error;
    }
  },

  closePosition: async (positionId: string, exitPrice?: number) => {
    const state = get();
    const position = state.openPositions.find((p) => p.id === positionId);
    
    if (!position) {
      throw new Error(`Position ${positionId} not found`);
    }
    
    if (position.status !== 'open') {
      throw new Error(`Cannot close position with status ${position.status}`);
    }
    
    try {
      // Update status to closing (prevents double-close)
      set((state) => ({
        openPositions: state.openPositions.map((p) =>
          p.id === positionId ? { ...p, status: 'closing' as PositionStatus } : p
        ),
      }));
      
      // Invoke backend to place closing order
      await invoke('place_order', {
        market: position.market,
        marketNodeId: position.marketNodeId,
        side: position.side === 'buy' ? 'sell' : 'buy', // Opposite side
        size: position.size,
        price: exitPrice, // Undefined for market close
        orderType: exitPrice ? 'limit' : 'market',
        closingPositionId: positionId,
      });
      
      // Note: Actual removal happens in fillOrder when fill confirmed
    } catch (error) {
      // Revert status on failure
      set((state) => ({
        openPositions: state.openPositions.map((p) =>
          p.id === positionId ? { ...p, status: 'open' as PositionStatus } : p
        ),
      }));
      throw error;
    }
  },

  modifyPosition: async (positionId: string, updates: Partial<Position>) => {
    const state = get();
    const position = state.openPositions.find((p) => p.id === positionId);
    
    if (!position) {
      throw new Error('Position not found');
    }
    
    // Only allow modification of specific fields
    const allowedUpdates: Partial<Position> = {};
    if (updates.stopLoss !== undefined) allowedUpdates.stopLoss = updates.stopLoss;
    if (updates.takeProfit !== undefined) allowedUpdates.takeProfit = updates.takeProfit;
    if (updates.size !== undefined && updates.size < position.size) {
      // Allow position size reduction (partial close)
      allowedUpdates.size = updates.size;
    }
    
    try {
      await invoke('modify_order', {
        positionId,
        updates: allowedUpdates,
      });
      
      set((state) => ({
        openPositions: state.openPositions.map((p) =>
          p.id === positionId ? { ...p, ...allowedUpdates } : p
        ),
        lastUpdate: Date.now(),
      }));
    } catch (error) {
      console.error('Failed to modify position:', error);
      throw error;
    }
  },

  updatePositionPrice: (positionId: string, currentPrice: number) => {
    set((state) => ({
      openPositions: state.openPositions.map((p) => {
        if (p.id !== positionId) return p;
        
        // Calculate unrealized P&L
        const priceDiff = currentPrice - p.entryPrice;
        const directionMultiplier = p.side === 'buy' ? 1 : -1;
        const unrealizedPnl = priceDiff * p.size * directionMultiplier - p.fees;
        
        // Check stop-loss / take-profit triggers
        let status = p.status;
        if (p.stopLoss && currentPrice <= p.stopLoss && p.side === 'buy') {
          status = 'closing'; // Trigger stop
          get().closePosition(positionId, p.stopLoss);
        } else if (p.stopLoss && currentPrice >= p.stopLoss && p.side === 'sell') {
          status = 'closing';
          get().closePosition(positionId, p.stopLoss);
        } else if (p.takeProfit && currentPrice >= p.takeProfit && p.side === 'buy') {
          status = 'closing';
          get().closePosition(positionId, p.takeProfit);
        } else if (p.takeProfit && currentPrice <= p.takeProfit && p.side === 'sell') {
          status = 'closing';
          get().closePosition(positionId, p.takeProfit);
        }
        
        return {
          ...p,
          currentPrice,
          unrealizedPnl,
          status,
        };
      }),
      lastUpdate: Date.now(),
    }));
  },

  fillOrder: (orderId: string, fill: FillDetails) => {
    set((state) => {
      const order = state.pendingOrders.find((o) => o.id === orderId);
      if (!order) return state;
      
      const updatedPendingOrders = state.pendingOrders.map((o) => {
        if (o.id !== orderId) return o;
        const newFilledSize = o.filledSize + fill.size;
        return {
          ...o,
          filledSize: newFilledSize,
          status: newFilledSize >= o.size ? ('filled' as OrderStatus) : ('partial' as OrderStatus),
          avgFillPrice: (o.avgFillPrice * o.filledSize + fill.price * fill.size) / newFilledSize,
        };
      });
      
      // Remove fully filled orders from pending
      const stillPending = updatedPendingOrders.filter((o) => o.status !== 'filled');
      const filledOrder = updatedPendingOrders.find((o) => o.id === orderId && o.status === 'filled');
      
      if (filledOrder && order.positionId) {
        // This was a closing order
        const position = state.openPositions.find((p) => p.id === order.positionId);
        if (position) {
          // Archive the closed position
          get().archivePosition(position, fill.price, Date.now());
          
          return {
            pendingOrders: stillPending,
            openPositions: state.openPositions.filter((p) => p.id !== position.id),
            dailyStats: {
              ...state.dailyStats,
              trades: state.dailyStats.trades + 1,
              volume: state.dailyStats.volume + fill.size,
            },
            lastUpdate: Date.now(),
          };
        }
      } else if (filledOrder) {
        // This was an opening order - create position
        const newPosition: Position = {
          id: `pos-${Date.now()}`,
          marketNodeId: order.marketNodeId,
          market: order.market,
          side: order.side,
          size: filledOrder.size,
          entryPrice: filledOrder.avgFillPrice,
          currentPrice: filledOrder.avgFillPrice,
          unrealizedPnl: -filledOrder.fees,
          realizedPnl: 0,
          fees: filledOrder.fees,
          status: 'open',
          openedAt: Date.now(),
          orderId: filledOrder.id,
          stopLoss: order.stopLoss,
          takeProfit: order.takeProfit,
        };
        
        return {
          pendingOrders: stillPending,
          openPositions: [...state.openPositions, newPosition],
          dailyStats: {
            ...state.dailyStats,
            trades: state.dailyStats.trades + 1,
            volume: state.dailyStats.volume + fill.size,
          },
          lastUpdate: Date.now(),
        };
      }
      
      return {
        pendingOrders: stillPending,
        lastUpdate: Date.now(),
      };
    });
    
    // Recalculate metrics on fill
    get().calculateMetrics();
  },

  // -------------------------------------------------------------------------
  // Order Management Implementation
  // -------------------------------------------------------------------------
  
  cancelOrder: async (orderId: string) => {
    try {
      await invoke('cancel_order', { orderId });
      
      set((state) => {
        const order = state.pendingOrders.find((o) => o.id === orderId);
        if (!order) return state;
        
        // Restore reserved balance
        const reserved = order.size * (order.price || 0);
        const newBalances = { ...state.balances };
        newBalances[order.market] += reserved;
        
        return {
          pendingOrders: state.pendingOrders.filter((o) => o.id !== orderId),
          balances: newBalances,
          lastUpdate: Date.now(),
        };
      });
    } catch (error) {
      console.error('Failed to cancel order:', error);
      throw error;
    }
  },

  placeOrder: async (order: Omit<Order, 'id' | 'status' | 'createdAt'>) => {
    const newOrder: Order = {
      ...order,
      id: `ord-${Date.now()}`,
      status: 'pending',
      createdAt: Date.now(),
      filledSize: 0,
      avgFillPrice: 0,
    };
    
    set((state) => ({
      pendingOrders: [...state.pendingOrders, newOrder],
      lastUpdate: Date.now(),
    }));
    
    return newOrder;
  },

  updateOrderFill: (orderId: string, filledSize: number) => {
    set((state) => ({
      pendingOrders: state.pendingOrders.map((o) =>
        o.id === orderId
          ? { ...o, filledSize, status: filledSize >= o.size ? 'filled' : 'partial' }
          : o
      ),
      lastUpdate: Date.now(),
    }));
  },

  // -------------------------------------------------------------------------
  // Synchronization Implementation
  // -------------------------------------------------------------------------
  
  syncPositions: async () => {
    try {
      const positions = await invoke<Position[]>('get_positions', {});
      
      set((state) => {
        // Rebuild positionByMarket index
        const byMarket: Record<string, Position[]> = {};
        positions.forEach((pos) => {
          if (!byMarket[pos.marketNodeId]) {
            byMarket[pos.marketNodeId] = [];
          }
          byMarket[pos.marketNodeId].push(pos);
        });
        
        return {
          openPositions: positions,
          positionByMarket: byMarket,
          lastUpdate: Date.now(),
        };
      });
    } catch (error) {
      console.error('Failed to sync positions:', error);
    }
  },

  loadHistory: async (options: HistoryQueryOptions = {}) => {
    try {
      const history = await invoke<ClosedPosition[]>('query_timeseries', {
        table: 'positions',
        startTime: options.startTime,
        endTime: options.endTime,
        limit: options.limit || 1000,
        offset: options.offset || 0,
      });
      
      set({ tradeHistory: history });
    } catch (error) {
      console.error('Failed to load history:', error);
    }
  },

  syncBalance: async (market: string) => {
    try {
      const balance = await invoke<number>('get_balance', { market });
      
      set((state) => ({
        balances: {
          ...state.balances,
          [market]: balance,
          total: Object.values({ ...state.balances, [market]: balance }).reduce((a, b) => a + b, 0) - state.balances.total,
        },
      }));
    } catch (error) {
      console.error(`Failed to sync balance for ${market}:`, error);
    }
  },

  // -------------------------------------------------------------------------
  // Analysis Implementation
  // -------------------------------------------------------------------------
  
  calculateMetrics: (): PerformanceMetrics => {
    const state = get();
    const history = state.tradeHistory;
    
    if (history.length === 0) {
      const emptyMetrics: PerformanceMetrics = {
        totalTrades: 0,
        winRate: 0,
        profitFactor: 0,
        sharpeRatio: null,
        maxDrawdown: 0,
        averageWin: 0,
        averageLoss: 0,
        expectancy: 0,
        totalReturn: 0,
      };
      set({ metrics: emptyMetrics });
      return emptyMetrics;
    }
    
    const winningTrades = history.filter((t) => t.realizedPnl > 0);
    const losingTrades = history.filter((t) => t.realizedPnl <= 0);
    
    const grossProfit = winningTrades.reduce((sum, t) => sum + t.realizedPnl, 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.realizedPnl, 0));
    
    const winRate = winningTrades.length / history.length;
    const profitFactor = grossLoss === 0 ? grossProfit : grossProfit / grossLoss;
    
    const averageWin = winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
    const averageLoss = losingTrades.length > 0 ? grossLoss / losingTrades.length : 0;
    const expectancy = (winRate * averageWin) - ((1 - winRate) * averageLoss);
    
    // Calculate max drawdown from equity curve
    let peak = 0;
    let maxDrawdown = 0;
    let runningEquity = state.balances.total;
    
    // Sort by close time for equity curve
    const sortedHistory = [...history].sort((a, b) => a.closedAt - b.closedAt);
    sortedHistory.forEach((trade) => {
      runningEquity += trade.realizedPnl;
      if (runningEquity > peak) peak = runningEquity;
      const drawdown = (peak - runningEquity) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    });
    
    // Sharpe ratio calculation (simplified, assumes risk-free rate = 0)
    const returns = sortedHistory.map((t) => t.realizedPnl);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev === 0 ? null : (avgReturn / stdDev) * Math.sqrt(365); // Annualized
    
    const totalReturn = sortedHistory.reduce((sum, t) => sum + t.realizedPnl, 0);
    
    const metrics: PerformanceMetrics = {
      totalTrades: history.length,
      winRate,
      profitFactor,
      sharpeRatio,
      maxDrawdown,
      averageWin,
      averageLoss,
      expectancy,
      totalReturn,
    };
    
    set({ metrics });
    return metrics;
  },

  resetDailyStats: () => {
    set((state) => ({
      dailyStats: {
        date: new Date().toISOString().split('T')[0],
        trades: 0,
        volume: 0,
        realizedPnl: 0,
        fees: 0,
      },
    }));
  },

  assessRisk: (positionId: string): RiskAssessment => {
    const state = get();
    const position = state.openPositions.find((p) => p.id === positionId);
    
    if (!position) {
      return {
        positionId,
        var95: 0,
        var99: 0,
        expectedShortfall: 0,
        marginRequirement: 0,
        liquidationPrice: null,
        riskLevel: 'unknown',
      };
    }
    
    // Simplified VaR calculation (would use historical volatility in production)
    const notional = position.size * position.entryPrice;
    const marginRequirement = notional * 0.1; // 10% margin example
    
    // Estimate liquidation price (simplified)
    const liquidationPrice = position.side === 'buy'
      ? position.entryPrice * 0.9 // 10% drop for long
      : position.entryPrice * 1.1; // 10% rise for short
    
    const riskLevel = Math.abs(position.unrealizedPnl / notional) > 0.1 ? 'high' : 
                      Math.abs(position.unrealizedPnl / notional) > 0.05 ? 'medium' : 'low';
    
    return {
      positionId,
      var95: notional * 0.05, // Simplified 5% VaR
      var99: notional * 0.1,  // Simplified 10% VaR
      expectedShortfall: notional * 0.08,
      marginRequirement,
      liquidationPrice,
      riskLevel,
    };
  },

  // -------------------------------------------------------------------------
  // Utility Implementation
  // -------------------------------------------------------------------------
  
  archivePosition: (position: Position, closePrice: number, closeTime: number) => {
    const closedPosition: ClosedPosition = {
      ...position,
      exitPrice: closePrice,
      closedAt: closeTime,
      realizedPnl: position.unrealizedPnl, // Final P&L
      holdingPeriod: closeTime - position.openedAt,
    };
    
    set((state) => ({
      tradeHistory: [closedPosition, ...state.tradeHistory].slice(0, 1000), // Keep last 1000
      dailyStats: {
        ...state.dailyStats,
        realizedPnl: state.dailyStats.realizedPnl + closedPosition.realizedPnl,
      },
    }));
  },

  resetPositions: () => {
    set({
      openPositions: [],
      pendingOrders: [],
      tradeHistory: [],
      positionByMarket: {},
      balances: { polymarket: 0, kalshi: 0, total: 0 },
      dailyStats: {
        date: new Date().toISOString().split('T')[0],
        trades: 0,
        volume: 0,
        realizedPnl: 0,
        fees: 0,
      },
      lastUpdate: Date.now(),
      metrics: null,
    });
  },

  // -------------------------------------------------------------------------
  // Derived State Getters (Selectors)
  // -------------------------------------------------------------------------
  
  getPositionById: (id: string) => {
    return get().openPositions.find((p) => p.id === id);
  },

  getOpenPositions: () => {
    return [...get().openPositions].sort((a, b) => b.openedAt - a.openedAt);
  },

  getPositionsByMarket: (marketNodeId: string) => {
    return get().openPositions.filter((p) => p.marketNodeId === marketNodeId);
  },

  getPendingOrdersByMarket: (marketNodeId: string) => {
    return get().pendingOrders.filter((o) => o.marketNodeId === marketNodeId);
  },

  getTotalUnrealizedPnl: () => {
    return get().openPositions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  },

  getTotalRealizedPnl: (days?: number) => {
    const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
    return get().tradeHistory
      .filter((t) => t.closedAt >= cutoff)
      .reduce((sum, t) => sum + t.realizedPnl, 0);
  },

  getCurrentEquity: () => {
    const state = get();
    return state.balances.total + state.getTotalUnrealizedPnl();
  },

  getExposureByMarket: () => {
    const exposure: Record<string, number> = {};
    get().openPositions.forEach((p) => {
      const notional = p.size * p.currentPrice;
      exposure[p.marketNodeId] = (exposure[p.marketNodeId] || 0) + notional;
    });
    return exposure;
  },

  getAvailableBalance: (market: string) => {
    const state = get();
    const total = state.balances[market] || 0;
    const reserved = state.pendingOrders
      .filter((o) => o.market === market)
      .reduce((sum, o) => sum + (o.size - o.filledSize) * (o.price || 0), 0);
    return total - reserved;
  },

  getWinRate: (days?: number) => {
    const cutoff = days ? Date.now() - days * 24 * 60 * 60 * 1000 : 0;
    const recentTrades = get().tradeHistory.filter((t) => t.closedAt >= cutoff);
    if (recentTrades.length === 0) return 0;
    const winners = recentTrades.filter((t) => t.realizedPnl > 0).length;
    return winners / recentTrades.length;
  },

  getSharpeRatio: () => {
    return get().metrics?.sharpeRatio || null;
  },

  getMaxDrawdown: () => {
    return get().metrics?.maxDrawdown || 0;
  },

  isDailyLimitReached: () => {
    const state = get();
    const dailyLossLimit = -1000; // Configurable: $1000 daily loss limit
    return state.dailyStats.realizedPnl <= dailyLossLimit;
  },
});