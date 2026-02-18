// ============================================================================
// GLOBAL STATE MANAGEMENT (ZUSTAND STORE)
// ============================================================================
//
// Module: store/index.ts
// Purpose: Centralized state management for the prediction market terminal
//
// OVERVIEW:
// This file configures the global Zustand store that manages application-wide
// state. It uses the "slices pattern" to organize state by domain (nodes,
// markets, positions) while providing a unified interface for components.
//
// Architecture Pattern - Slices:
// Rather than a single large state object, we split state into logical slices:
// - nodesSlice: Manages the visual graph (nodes, connections, layout)
// - marketsSlice: Market connections, orderbooks, real-time data
// - positionsSlice: Trading positions, P&L, order history
// 
// Each slice is a function that receives set/get/store and returns its state
// actions. This allows modular development and easier testing.
//
// Why Zustand over Redux/Context:
// - Minimal boilerplate (no actions/reducers separation needed)
// - Excellent TypeScript support (inferred types from slice functions)
// - Middleware ecosystem (persist, subscribe, devtools)
// - No provider wrapper needed (simpler component tree)
// - Selectors prevent unnecessary re-renders (automatic optimization)
//
// PERSISTENCE STRATEGY:
//
// localStorage Persistence:
// - Selected nodes and viewport state (restore selection on reload)
// - User preferences (theme, default markets, API key references)
// - NOT persisted: Real-time data (orderbooks, prices), large arrays
//
// SQLite Backend (Primary):
// - Nodes and connections (source of truth in database)
// - Positions and trade history (financial records)
// - Timeseries data (separate SQLite table, not in Zustand)
//
// Hybrid Approach:
// 1. On app load: Fetch from SQLite via Tauri commands
// 2. Store in Zustand for fast UI access
// 3. Mutations: Update Zustand optimistically, sync to SQLite async
// 4. On refresh: Zustand clears, re-fetched from SQLite
//
// STORE CONFIGURATION:
//
// State Shape:
// {
//   nodes: Node[],           // From nodesSlice
//   connections: Connection[], // From nodesSlice
//   selectedNodeId: string | null, // From nodesSlice
//   markets: MarketConnection[], // From marketsSlice
//   orderbooks: Record<string, Orderbook>, // From marketsSlice
//   positions: Position[],   // From positionsSlice
//   trades: TradeRecord[],   // From positionsSlice
//   ui: {                    // UI state slice (inline)
//     sidebarOpen: boolean,
//     activePanel: 'sources' | 'markets' | 'positions',
//     theme: 'dark' | 'light'
//   }
// }
//
// Middleware Stack:
// 1. persist (localStorage) - Save UI preferences, selections
// 2. devtools (Redux DevTools) - Debug state changes in development
// 3. subscribe (custom) - Log state changes, sync to backend
//
// SLICE RESPONSIBILITIES:
//
// nodesSlice.ts:
// - Actions: addNode, removeNode, updatePosition, selectNode, addConnection
// - State: nodes[], connections[], selectedNodeId
// - Persistence: Positions saved to SQLite, restored on load
//
// marketsSlice.ts:
// - Actions: connectMarket, disconnectMarket, updateOrderbook, setMarketStatus
// - State: markets[], orderbooks{}, marketStatus{}
// - Real-time: WebSocket handlers update this slice directly
//
// positionsSlice.ts:
// - Actions: openPosition, closePosition, updatePnL, recordTrade
// - State: positions[], trades[], dailyPnL, totalPnL
// - Calculated: winRate, sharpeRatio, maxDrawdown (derived in selectors)
//
// uiSlice (inline in this file):
// - Actions: toggleSidebar, setActivePanel, setTheme
// - State: UI layout preferences
// - Persistence: Full persist to localStorage
//
// TYPESCRIPT INTEGRATION:
//
// Store Type Inference:
// type StoreState = ReturnType<typeof createStore>
// This automatically types the entire state object from slice return types.
//
// Slice Types:
// Each slice exports its interface (NodesSlice, MarketsSlice) for type
// safety when composing the store.
//
// Selector Types:
// Typed selectors prevent accessing non-existent properties.
// const useNodes = () => useStore(state => state.nodes) // Type: Node[]
//
// USAGE EXAMPLES:
//
// Basic Read:
// ```typescript
// const nodes = useStore(state => state.nodes)
// // Component re-renders only when nodes array changes
// ```
//
// Shallow Comparison (for arrays/objects):
// ```typescript
// import { useShallow } from 'zustand/shallow'
// const [nodes, connections] = useStore(
//   useShallow(state => [state.nodes, state.connections])
// )
// ```
//
// Actions:
// ```typescript
// const { addNode, updatePosition } = useStore()
// // Or select specific action:
// const addNode = useStore(state => state.addNode)
// ```
//
// Outside React (in hooks/utils):
// ```typescript
// import { store } from './store'
// store.getState().addNode(newNode) // Direct access
// ```
//
// With Persistence:
// ```typescript
// // UI preferences automatically saved
// const setTheme = useStore(state => state.setTheme)
// setTheme('light') // Persists to localStorage
// ```
//
// MIDDLEWARE CONFIGURATION:
//
// Redux DevTools:
// - Enabled in development only (check import.meta.env.DEV)
// - Store name: 'PredictionMarketTerminal'
// - Trace: true (shows action stack traces)
//
// Persist Middleware:
// - Key: 'pmt-storage' (localStorage key)
// - Version: 1 (for migration handling)
// - Partialize: Only persist UI slice, not real-time data
// - Migrate: Handle state migrations between app versions
//
// Custom Middleware - Backend Sync:
// Logs all state changes and syncs critical mutations to SQLite:
// - Node position changes → debounced SQLite update
// - Connection additions → immediate SQLite insert
// - Position updates → immediate SQLite upsert
//
// PERFORMANCE OPTIMIZATIONS:
//
// Selector Memoization:
// Zustand automatically optimizes selectors by reference equality.
// Only re-renders if returned value changes.
//
// Slice Isolation:
// Updating market data doesn't trigger node component re-renders
// because they're separate slices with separate subscriptions.
//
// Batch Updates:
// Multiple set() calls in one event loop are batched automatically
// (React 18 automatic batching compatible).
//
// Shallow Updates:
// For array updates, use spread operator to ensure new reference:
// set({ nodes: [...nodes, newNode] }) // Good
// nodes.push(newNode); set({ nodes }) // Bad (same reference)
//
// TESTING:
//
// Mock Store:
// ```typescript
// import { createStore } from './store'
// const testStore = createStore()
// testStore.getState().addNode({ id: 'test', ... })
// expect(testStore.getState().nodes).toHaveLength(1)
// ```
//
// Reset State:
// ```typescript
// beforeEach(() => {
//   useStore.setState(initialState, true) // Replace entire state
// })
// ```
//
// DEPENDENCIES:
// - zustand (core library)
// - zustand/middleware (devtools, persist, subscribeWithSelector)
// - immer (optional, for mutable-style updates)
// - ../types/* (TypeScript interfaces for all state shapes)
// - ../hooks/useTauriCommand (for backend sync side effects)
//
// FUTURE ENHANCEMENTS:
// - Immer middleware for mutable-style updates (draft => draft.nodes.push())
// - Undo/Redo middleware (history stack for graph operations)
// - Async actions middleware (loading states for async operations)
// - Computed properties middleware (automatic derived state)
// - Multi-tab sync (broadcast channel for cross-tab state)
//
// ============================================================================

import { create } from 'zustand';
import { 
  devtools, 
  persist, 
  subscribeWithSelector 
} from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { shallow } from 'zustand/shallow';

// Import slice creators
import { createNodesSlice, type NodesSlice } from './nodesSlice';
import { createMarketsSlice, type MarketsSlice } from './marketsSlice';
import { createPositionsSlice, type PositionsSlice } from './positionsSlice';

// UI State (defined inline as it's simple)
export interface UISlice {
  sidebarOpen: boolean;
  activePanel: 'sources' | 'markets' | 'positions' | 'metrics';
  theme: 'dark' | 'light';
  selectedSourceId: string | null;
  selectedNodeId: string | null;
  modalOpen: string | null; // 'add-source' | 'add-market' | null
  
  // Actions
  toggleSidebar: () => void;
  setActivePanel: (panel: UISlice['activePanel']) => void;
  setTheme: (theme: UISlice['theme']) => void;
  setSelectedSourceId: (id: string | null) => void;
  setSelectedNodeId: (id: string | null) => void;
  openModal: (modal: string) => void;
  closeModal: () => void;
}

// Combined Store State
export type StoreState = NodesSlice & MarketsSlice & PositionsSlice & UISlice;

// Type helpers for slice creators - using any for simplicity with zustand middleware chain
type StoreSet = any;
type StoreGet = any;

// ============================================================================
// SLICE IMPLEMENTATIONS
// ============================================================================

const createUISlice = (set: StoreSet, _get: StoreGet): UISlice => ({
  sidebarOpen: true,
  activePanel: 'sources',
  theme: 'dark',
  selectedSourceId: null,
  selectedNodeId: null,
  modalOpen: null,

  toggleSidebar: () => set((state: StoreState) => ({ 
    sidebarOpen: !state.sidebarOpen 
  })),
  
  setActivePanel: (panel) => set(() => ({ activePanel: panel })),
  
  setTheme: (theme) => set(() => ({ theme })),
  
  setSelectedSourceId: (id) => set(() => ({ selectedSourceId: id })),
  
  setSelectedNodeId: (id) => set(() => ({ selectedNodeId: id })),
  
  openModal: (modal) => set(() => ({ modalOpen: modal })),
  
  closeModal: () => set(() => ({ modalOpen: null })),
});

// ============================================================================
// STORE CREATION
// ============================================================================

export const useStore = create<StoreState>()(
  // Immer middleware (allows mutable-style updates)
  immer(
    // DevTools middleware (Redux DevTools integration)
    devtools(
      // Persist middleware (localStorage)
      persist(
        subscribeWithSelector(
          (set, get, api) => ({
            // Combine all slices
            ...createNodesSlice(set as unknown as Parameters<typeof createNodesSlice>[0], get as unknown as Parameters<typeof createNodesSlice>[1], api as unknown as Parameters<typeof createNodesSlice>[2]),
            ...createMarketsSlice(set as unknown as Parameters<typeof createMarketsSlice>[0], get as unknown as Parameters<typeof createMarketsSlice>[1], api as unknown as Parameters<typeof createMarketsSlice>[2]),
            ...createPositionsSlice(set as unknown as Parameters<typeof createPositionsSlice>[0], get as unknown as Parameters<typeof createPositionsSlice>[1], api as unknown as Parameters<typeof createPositionsSlice>[2]),
            ...createUISlice(set, get),
          })
        ),
        {
          name: 'pmt-storage', // localStorage key
          version: 1, // For state migrations
          
          // Only persist specific parts of state (UI preferences, not real-time data)
          partialize: (state: StoreState) => ({
            // UI State
            sidebarOpen: state.sidebarOpen,
            theme: state.theme,
            activePanel: state.activePanel,
            // Selection state (restore on reload)
            selectedNodeId: state.selectedNodeId,
            // Don't persist: nodes (from DB), markets (reconnect), positions (from DB)
          }),
          
          // Migration handling (when version changes)
          migrate: (persistedState: unknown, version: number) => {
            if (version === 0) {
              // Migration from version 0 to 1
              return {
                ...(persistedState as Record<string, unknown>),
                selectedSourceId: null, // New field in v1
              } as StoreState;
            }
            return persistedState as StoreState;
          },
        }
      ),
      {
        name: 'PredictionMarketTerminal',
        enabled: true,
      }
    )
  )
);

// ============================================================================
// SELECTORS & UTILITIES
// ============================================================================

// Typed selector hook for multiple selections with shallow comparison
export { shallow };

// Direct store access (for outside React)
export const getState = useStore.getState;
export const setState = useStore.setState;
export const subscribe = useStore.subscribe;

// Specific selectors for better performance
export const useNodes = () => useStore((state: StoreState) => state.nodes);
export const useConnections = () => useStore((state: StoreState) => state.connections);
export const useSelectedNode = () => useStore((state: StoreState) => {
  const nodesArray = Object.values(state.nodes);
  return nodesArray.find((n) => n.id === state.selectedNodeId);
});

export const useMarkets = () => useStore((state: StoreState) => state.markets);
export const useOrderbook = (marketId: string) => 
  useStore((state: StoreState) => state.orderbooks[marketId]);

export const usePositions = () => useStore((state: StoreState) => state.openPositions);
export const useDailyPnL = () => useStore((state: StoreState) => state.dailyStats.realizedPnl);

export const useUI = () => useStore((state: StoreState) => ({
  sidebarOpen: state.sidebarOpen,
  activePanel: state.activePanel,
  theme: state.theme,
  modalOpen: state.modalOpen,
}));

// Actions selectors (dispatchers)
export const useNodeActions = () => useStore((state: StoreState) => ({
  addNode: state.addNode,
  removeNode: state.removeNode,
  updateNodePosition: state.updateNodePosition,
  selectNode: state.selectNode,
  addConnection: state.addConnection,
  removeConnection: state.removeConnection,
}));

export const useMarketActions = () => useStore((state: StoreState) => ({
  addMarket: state.addMarket,
  removeMarket: state.removeMarket,
  updateOrderbook: state.updateOrderbook,
  setMarketStatus: state.setMarketStatus,
}));

export const usePositionActions = () => useStore((state: StoreState) => ({
  openPosition: state.openPosition,
  closePosition: state.closePosition,
  updatePositionPrice: state.updatePositionPrice,
}));

export const useUIActions = () => useStore((state: StoreState) => ({
  toggleSidebar: state.toggleSidebar,
  setActivePanel: state.setActivePanel,
  setTheme: state.setTheme,
  openModal: state.openModal,
  closeModal: state.closeModal,
}));

// ============================================================================
// BACKGROUND SYNC SUBSCRIPTION
// ============================================================================

// Subscribe to specific state changes and sync to backend
if (typeof window !== 'undefined') {
  // Debounced node position sync
  let positionTimeout: ReturnType<typeof setTimeout>;
  
  useStore.subscribe(
    (state: StoreState) => state.nodes,
    (nodes) => {
      // Clear existing timeout
      clearTimeout(positionTimeout);
      
      // Debounce position updates (500ms after drag ends)
      positionTimeout = setTimeout(() => {
        // Sync to SQLite via Tauri - lazy import
        void import('@tauri-apps/api/core').then(({ invoke }) => {
          Object.values(nodes).forEach((node) => {
            // Skip nodes without valid id or position
            if (!node?.id || !node?.position || !Array.isArray(node.position) || node.position.length < 2) {
              return;
            }
            void invoke('update_node_position_cmd', {
              id: node.id,
              position: node.position,
            }).catch(console.error);
          });
        });
      }, 500);
    },
    { equalityFn: shallow }
  );

  // Log state changes in development
  if (typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV) {
    useStore.subscribe((state: StoreState) => {
      console.log('[Store]', {
        nodes: Object.keys(state.nodes).length,
        connections: state.connections.length,
        markets: state.markets.length,
        positions: state.openPositions.length,
      });
    });
  }
}

export default useStore;