// ============================================================================
// MARKETS SLICE - PREDICTION MARKET CONNECTIONS & DATA
// ============================================================================
//
// Zustand slice managing prediction market connections, real-time orderbook
// streaming, and connection health. Central hub for trading venue interactions.
//
// State Shape:
//   markets: Node[]                                - Connected market nodes
//   orderbooks: Record<string, Orderbook>          - Latest orderbook per market
//   marketStatus: Record<string, MarketConnectionStatus> - Connection health
//   selectedMarketId: string | null                 - Active detail view
//   isLoading: boolean                              - Global async loading flag
//   error: string | null                            - Last error message
//
// Actions: addMarket, removeMarket, updateMarket, updateOrderbook,
//   setMarketStatus, updateMarketPrice, clearOrderbook, selectMarket,
//   setMarketLoading, setMarketError, clearMarketError,
//   reconnectMarket, disconnectMarket
//
// Selectors: getMarketOrderbook, getMarketStatus, getConnectedMarkets,
//   getSelectedMarket, selectOrderbookWithSpread, selectMarketsByType,
//   selectHealthyMarkets
//
// Key Design Decisions:
//   - Connection state machine: idle -> connecting -> connected -> disconnected
//   - Orderbooks are in-memory only (volatile); evicted on disconnect
//   - Markets are also nodes in nodesSlice; this slice owns market-specific
//     data (orderbooks, status) while nodesSlice owns layout/position
//   - positionsSlice reads orderbook prices for P&L calculation
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
          [market.id]: { marketId: market.id, bids: [], asks: [], timestamp: Date.now(), sequence: 0, liquidity: 0, spread: 0 }
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

// Selector: get all markets sharing the same event group ID
export const selectMarketsByEventGroup = (state: MarketsSlice, eventGroupId: string) => {
  return state.markets.filter(m => {
    const metadata = m.metadata as Record<string, any>;
    return metadata?.event_group_id === eventGroupId;
  });
};

// Selector: group all markets by their event_group_id
export const selectMarketGroups = (state: MarketsSlice): Record<string, Node[]> => {
  const groups: Record<string, Node[]> = {};
  for (const market of state.markets) {
    const metadata = market.metadata as Record<string, any>;
    const groupId = metadata?.event_group_id;
    if (groupId) {
      if (!groups[groupId]) groups[groupId] = [];
      groups[groupId].push(market);
    }
  }
  return groups;
};