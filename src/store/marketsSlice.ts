// ============================================================================
// MARKETS SLICE - PREDICTION MARKET CONNECTIONS & DATA
// ============================================================================
//
// Module: store/marketsSlice.ts
// Purpose: Zustand state slice for managing prediction market connections and real-time data
//
// OVERVIEW:
// This slice manages the complete lifecycle of prediction market connections,
// from initial API authentication through real-time orderbook streaming to
// disconnection and cleanup. It serves as the central hub for all trading
// venue interactions.
//
// Architecture Pattern:
// User adds market (via MarketPanel)
//   → addMarket() action called with credentials
//   → Zustand optimistically adds to markets[] with status 'connecting'
//   → Tauri command 'add_market' invoked via useTauriCommand in component
//   → Backend validates credentials, establishes WebSocket
//   → Backend emits 'market:connected' event via Tauri
//   → useWebSocket hook receives event, slice updates status to 'connected'
//   → Orderbook stream begins, 'orderbook:update' events flow in
//   → updateOrderbook() action merges deltas into orderbooks cache
//   → React components re-render with live data
//
// Connection State Machine:
// 'idle' → 'connecting' → 'connected' → 'disconnected' → 'reconnecting' → 'connected'
//     ↓         ↓            ↓              ↓                ↓              ↓
//  (initial)  (spinner)   (green dot)   (red dot)       (yellow)      (green dot)
//
// Data Flow - Orderbook Updates:
// WebSocket Message (Rust Backend)
//   → deserialize to Orderbook struct
//   → emit('orderbook:update', {market_id, bids, asks, timestamp})
//   → useWebSocket hook in frontend receives payload
//   → calls marketsSlice.updateOrderbook(payload)
//   → update orderbooks[market_id] in state (immutable update)
//   → OrderbookView component selector detects change
//   → React re-renders with new depth data
//   → Canvas draws updated bars (CSS transition smooths change)
//
// STATE STRUCTURE:
//
// markets: Node[]
//   - Array of market nodes currently connected
//   - Same structure as nodes in nodesSlice but filtered to type 'Market'
//   - Maintains position on canvas, metadata (api_key reference, market_id)
//   - Status field tracks connection health
//
// orderbooks: Record<string, Orderbook>
//   - Cache of latest orderbook snapshot per market
//   - Key: market node id (e.g., "market-btc-100k-uuid")
//   - Value: { bids: [price, size][], asks: [price, size][], timestamp }
//   - TTL: No explicit TTL, updated via WebSocket or poller every 500ms
//   - Eviction: Entry removed when market disconnected
//
// marketStatus: Record<string, MarketStatus>
//   - Connection health metadata per market
//   - { connected: boolean, latency: number, lastHeartbeat: Date, errorCount: number }
//   - Updated by WebSocket heartbeat events or connection error handlers
//   - Used for status indicators in MarketPanel (green/red dots)
//
// selectedMarketId: string | null
//   - Currently selected market (for right sidebar detail view)
//   - Separated from nodesSlice selection to allow different selection contexts
//
// isLoading: boolean
//   - Global loading state for async operations (connecting new market)
//   - Individual market statuses track per-market connection state
//
// error: string | null
//   - Last error message from market operations
//   - Cleared on successful operations
//
// ACTIONS:
//
// 1. addMarket(market: Node)
//    - Adds market node to markets array
//    - Initializes empty orderbook placeholder
//    - Sets initial status to 'connecting'
//    - Persists via Tauri (caller provides node from command response)
//
// 2. removeMarket(id: string)
//    - Removes from markets array
//    - Deletes orderbook cache entry
//    - Clears status
//    - Triggers backend cleanup via Tauri command (in component)
//
// 3. updateOrderbook(marketId: string, orderbook: Orderbook)
//    - Merges new orderbook data into cache
//    - Immutable update (new object reference)
//    - Validates price ordering (bids descending, asks ascending)
//    - Updates timestamp for staleness detection
//
// 4. setMarketStatus(id: string, status: Partial<MarketStatus>)
//    - Updates connection health indicators
//    - Triggers UI changes (color-coded status dots)
//    - Auto-reconnect logic hooks into status changes
//
// 5. updateMarketPrice(id: string, price: number)
//    - Updates mid-price or last trade price
//    - Used for PnL calculations in positionsSlice
//    - Triggers price flash animation in UI
//
// 6. reconnectMarket(id: string)
//    - Sets status to 'reconnecting'
//    - Clears error state
//    - Component calls Tauri 'refresh_market_connection'
//
// 7. selectMarket(id: string | null)
//    - Sets selectedMarketId for detail view
//    - Clears other selections (nodesSlice coordination)
//
// CACHING STRATEGY:
//
// Orderbook Cache:
// - In-memory only (volatile)
// - Refreshed via WebSocket (push) or REST fallback (pull on disconnect)
// - Max 50 price levels per side (backend filters deep liquidity)
// - Memory constraint: ~10KB per market (negligible for <20 markets)
//
// Status Cache:
// - Heartbeat every 5 seconds from backend
// - Frontend tracks last heartbeat timestamp
// - If >30 seconds old, marks as stale (yellow indicator)
//
// INTEGRATION WITH OTHER SLICES:
//
// nodesSlice:
//   - Markets ARE nodes, but this slice manages market-specific data
//   - nodesSlice manages position/layout, this slice manages connection/data
//   - Coordinate on add/remove (both slices updated, but nodesSlice persists position)
//
// positionsSlice:
//   - Needs orderbook prices for PnL calculation
//   - Selector: getCurrentPrice(marketId) reads from this slice's orderbooks
//   - Position updates triggered when orderbook.price changes
//
// WebSocket Events Handled:
//
// 'market:connected': { marketId, timestamp }
//   → setMarketStatus(marketId, { connected: true, latency: 0 })
//
// 'market:disconnected': { marketId, reason }
//   → setMarketStatus(marketId, { connected: false, error: reason })
//
// 'orderbook:update': { marketId, bids, asks, timestamp }
//   → updateOrderbook(marketId, { bids, asks, timestamp })
//
// 'market:error': { marketId, error, retryInMs }
//   → setMarketStatus(marketId, { error, connected: false })
//   → Auto-reconnect if retryInMs provided
//
// 'market:latency': { marketId, latencyMs }
//   → setMarketStatus(marketId, { latency: latencyMs })
//   → Updates performance metrics display
//
// ERROR HANDLING:
//
// Connection Failed:
// - Status set to 'error', error message stored
// - Orderbook cleared (show '--' in UI)
// - Auto-reconnect attempts with exponential backoff
// - After 5 failures, stop auto-retry, require manual reconnect
//
// Parse Error:
// - Invalid orderbook payload from backend
// - Log error, skip update, keep previous valid data
// - Alert user if persistent (>3 errors in 1 minute)
//
// Stale Data:
// - Last update >30 seconds ago
// - Background color change in orderbook (subtle yellow tint)
//   "Reconnect" button appears in MarketPanel
//
// PERFORMANCE:
//
// Update Frequency:
// - Orderbook updates: Up to 10/second in volatile markets
// - Zustand batches rapid updates (React 18 automatic batching)
// - OrderbookView uses shallow comparison on bids/asks arrays
//
// Memory Optimization:
// - Orderbooks eviction: Removed when market disconnected
// - Status objects: Lightweight (<100 bytes each)
// - No history maintained (use storageSlice for time-series)
//
// Selector Optimization:
// - createSelector pattern for derived data (spread calculation)
// - useShallow for array returns to prevent re-renders
//
// TESTING:
//
// Mock State:
// ```typescript
// const mockStore = createMarketsSlice(() => {}, () => ({}), {} as any);
// mockStore.addMarket({ id: 'test', node_type: { Market: 'Polymarket' }, ... });
// expect(mockStore.markets).toHaveLength(1);
// ```
//
// Mock Updates:
// ```typescript
// mockStore.updateOrderbook('test', { bids: [[0.5, 100]], asks: [[0.6, 100]], timestamp: Date.now() });
// expect(mockStore.orderbooks['test'].bids[0][0]).toBe(0.5);
// ```
//
// DEPENDENCIES:
// - zustand (State creator type)
// - immer (via middleware in index.ts for mutable-style updates)
// - ../types/nodes (Node, MarketType)
// - ../types/markets (Orderbook, MarketStatus)
// - ../hooks/useWebSocket (for real-time updates, subscribed in component)
//
// FUTURE ENHANCEMENTS:
// - Orderbook aggregation (combine Polymarket + Kalshi for same event)
// - Smart order routing (best price across markets)
// - Market discovery (search/browse available markets)
// - Favorite markets (persist to localStorage)
// - Price alerts (trigger when threshold crossed)
// - Market metadata caching (descriptions, resolution criteria)
//
// ============================================================================

import { StateCreator } from 'zustand';
import { Node, MarketType } from '../types/nodes';
import { Orderbook } from '../types/markets';

// Market connection status interface
interface MarketConnectionStatus {
  connected: boolean;
  connecting: boolean;
  latency: number;
  lastHeartbeat: Date;
  errorCount: number;
  errorMessage: string | null;
}

// ============================================================================
// SLICE STATE INTERFACE
// ============================================================================

export interface MarketsSlice {
  // State
  markets: Node[];
  orderbooks: Record<string, Orderbook>;
  marketStatus: Record<string, MarketConnectionStatus>;
  selectedMarketId: string | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  addMarket: (market: Node) => void;
  removeMarket: (id: string) => void;
  updateMarket: (id: string, updates: Partial<Node>) => void;
  
  // Data updates
  updateOrderbook: (marketId: string, orderbook: Orderbook) => void;
  setMarketStatus: (id: string, status: Partial<MarketConnectionStatus>) => void;
  updateMarketPrice: (id: string, midPrice: number, spread: number) => void;
  clearOrderbook: (id: string) => void;
  
  // Selection & UI
  selectMarket: (id: string | null) => void;
  setMarketLoading: (loading: boolean) => void;
  setMarketError: (error: string | null) => void;
  clearMarketError: () => void;
  
  // Connection management
  reconnectMarket: (id: string) => void;
  disconnectMarket: (id: string) => void;
  
  // Queries (selectors)
  getMarketOrderbook: (id: string) => Orderbook | undefined;
  getMarketStatus: (id: string) => MarketConnectionStatus | undefined;
  getConnectedMarkets: () => Node[];
  getSelectedMarket: () => Node | undefined;
}

// ============================================================================
// SLICE IMPLEMENTATION
// ============================================================================

export const createMarketsSlice: StateCreator<MarketsSlice, [], [], MarketsSlice> = (set, get) => ({
  // -------------------------------------------------------------------------
  // Initial State
  // -------------------------------------------------------------------------
  markets: [],
  orderbooks: {},
  marketStatus: {},
  selectedMarketId: null,
  isLoading: false,
  error: null,

  // -------------------------------------------------------------------------
  // Market Lifecycle Actions
  // -------------------------------------------------------------------------
  
  addMarket: (market: Node) => {
    set((state) => {
      // Prevent duplicates
      if (state.markets.find(m => m.id === market.id)) {
        console.warn(`Market ${market.id} already exists`);
        return state;
      }

      // Initialize status
      const newStatus: MarketConnectionStatus = {
        connected: false,
        connecting: true,
        latency: 0,
        lastHeartbeat: new Date(),
        errorCount: 0,
        errorMessage: null
      };

      return {
        markets: [...state.markets, market],
        marketStatus: {
          ...state.marketStatus,
          [market.id]: newStatus
        },
        // Initialize empty orderbook placeholder
        orderbooks: {
          ...state.orderbooks,
          [market.id]: { marketId: market.id, bids: [], asks: [], timestamp: Date.now(), sequence: 0, liquidity: 0 }
        }
      };
    });
  },

  removeMarket: (id: string) => {
    set((state) => {
      const { [id]: removedMarket, ...remainingMarkets } = state.orderbooks;
      const { [id]: removedStatus, ...remainingStatus } = state.marketStatus;
      
      return {
        markets: state.markets.filter(m => m.id !== id),
        orderbooks: remainingMarkets,
        marketStatus: remainingStatus,
        selectedMarketId: state.selectedMarketId === id ? null : state.selectedMarketId
      };
    });
  },

  updateMarket: (id: string, updates: Partial<Node>) => {
    set((state) => ({
      markets: state.markets.map(market =>
        market.id === id ? { ...market, ...updates } : market
      )
    }));
  },

  // -------------------------------------------------------------------------
  // Real-Time Data Actions
  // -------------------------------------------------------------------------
  
  updateOrderbook: (marketId: string, orderbook: Orderbook) => {
    set((state) => {
      // Validation: Ensure prices are properly sorted
      const sortedBids = [...orderbook.bids].sort((a, b) => b.price - a.price); // Descending
      const sortedAsks = [...orderbook.asks].sort((a, b) => a.price - b.price); // Ascending
      
      // Calculate total liquidity
      const liquidity = sortedBids.reduce((sum, level) => sum + level.size, 0) +
                       sortedAsks.reduce((sum, level) => sum + level.size, 0);

      return {
        orderbooks: {
          ...state.orderbooks,
          [marketId]: {
            ...orderbook,
            bids: sortedBids,
            asks: sortedAsks,
            liquidity,
            lastUpdate: Date.now()
          }
        }
      };
    });
  },

  setMarketStatus: (id: string, status: Partial<MarketConnectionStatus>) => {
    set((state) => ({
      marketStatus: {
        ...state.marketStatus,
        [id]: {
          ...state.marketStatus[id],
          ...status,
          lastHeartbeat: new Date()
        }
      }
    }));
  },

  updateMarketPrice: (id: string, midPrice: number, spread: number) => {
    set((state) => {
      const current = state.orderbooks[id];
      if (!current) return state;

      return {
        orderbooks: {
          ...state.orderbooks,
          [id]: {
            ...current,
            midPrice,
            spread,
            lastPriceUpdate: new Date()
          }
        }
      };
    });
  },

  clearOrderbook: (id: string) => {
    set((state) => {
      const { [id]: _, ...remaining } = state.orderbooks;
      return { orderbooks: remaining };
    });
  },

  // -------------------------------------------------------------------------
  // UI & Selection Actions
  // -------------------------------------------------------------------------
  
  selectMarket: (id: string | null) => {
    set((state) => ({
      selectedMarketId: id,
      // Clear global error when selecting different market
      error: id !== state.selectedMarketId ? null : state.error
    }));
  },

  setMarketLoading: (loading: boolean) => {
    set({ isLoading: loading });
  },

  setMarketError: (error: string | null) => {
    set({ error });
  },

  clearMarketError: () => {
    set({ error: null });
  },

  // -------------------------------------------------------------------------
  // Connection Management
  // -------------------------------------------------------------------------
  
  reconnectMarket: (id: string) => {
    set((state) => ({
      marketStatus: {
        ...state.marketStatus,
        [id]: {
          ...state.marketStatus[id],
          connected: false,
          connecting: true,
          errorMessage: null
        }
      }
    }));
    
    // Note: Actual reconnection command triggered by component via Tauri
  },

  disconnectMarket: (id: string) => {
    set((state) => ({
      marketStatus: {
        ...state.marketStatus,
        [id]: {
          ...state.marketStatus[id],
          connected: false,
          connecting: false
        }
      }
    }));
  },

  // -------------------------------------------------------------------------
  // Selectors (Derived State)
  // -------------------------------------------------------------------------
  
  getMarketOrderbook: (id: string) => {
    return get().orderbooks[id];
  },

  getMarketStatus: (id: string) => {
    return get().marketStatus[id];
  },

  getConnectedMarkets: () => {
    return get().markets.filter(market => {
      const status = get().marketStatus[market.id];
      return status?.connected && !status?.connecting;
    });
  },

  getSelectedMarket: () => {
    const { selectedMarketId, markets } = get();
    if (!selectedMarketId) return undefined;
    return markets.find(m => m.id === selectedMarketId);
  }
});

// ============================================================================
// SELECTOR UTILITIES
// ============================================================================

// Memoized selector for orderbook with spread calculation
export const selectOrderbookWithSpread = (state: MarketsSlice, marketId: string) => {
  const ob = state.orderbooks[marketId];
  if (!ob || !ob.bids.length || !ob.asks.length) return null;
  
  const bestBid = ob.bids[0].price;
  const bestAsk = ob.asks[0].price;
  const spread = bestAsk - bestBid;
  const spreadPercent = (spread / ((bestAsk + bestBid) / 2)) * 100;
  
  return {
    ...ob,
    bestBid,
    bestAsk,
    spread,
    spreadPercent
  };
};

// Selector for markets by type (Polymarket vs Kalshi)
export const selectMarketsByType = (state: MarketsSlice, type: MarketType) => {
  return state.markets.filter(m => 
    'Market' in m.node_type && m.node_type.Market === type
  );
};

// Selector for healthy markets (connected + recent heartbeat)
export const selectHealthyMarkets = (state: MarketsSlice) => {
  const now = Date.now();
  return state.markets.filter(m => {
    const status = state.marketStatus[m.id];
    if (!status?.connected) return false;
    
    // Check heartbeat within last 30 seconds
    const lastHeartbeat = new Date(status.lastHeartbeat).getTime();
    return (now - lastHeartbeat) < 30000;
  });
};