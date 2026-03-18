// ============================================================================
// GLOBAL STATE MANAGEMENT (ZUSTAND STORE)
// ============================================================================
//
// Purpose: Centralized state management for the prediction market terminal.
//
// SLICES PATTERN:
// State is split into domain-specific slices, each a function receiving
// set/get/store and returning its state + actions:
//   - nodesSlice:     Visual graph (nodes, connections, layout)
//   - marketsSlice:   Market connections, orderbooks, real-time data
//   - positionsSlice: Trading positions, P&L, order history
//   - uiSlice:        Sidebar, panels, theme (defined inline below)
//
// Each slice is composed into a single Zustand store via the spread
// pattern in create(). Middleware: immer, devtools, persist,
// subscribeWithSelector.
//
// PERSISTENCE STRATEGY:
//
// localStorage (via persist middleware, key: 'pmt-storage'):
//   - UI preferences (theme, sidebar, active panel, selection)
//   - NOT persisted: real-time data, nodes, markets, positions
//
// SQLite (primary source of truth):
//   - Nodes, connections, positions, trade history, timeseries
//   - Fetched on app load via Tauri commands into Zustand
//   - Mutations are optimistic in Zustand, synced to SQLite async
//   - Background subscriptions at the bottom of this file handle
//     debounced position sync and connection removal sync
//
// ============================================================================

import { create } from 'zustand';
import { 
  devtools, 
  persist, 
  subscribeWithSelector 
} from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import { shallow } from 'zustand/shallow';

// Enable MapSet support in Immer for Set<string> selectedIds
enableMapSet();

// Import slice creators
import { createNodesSlice, type NodesSlice } from './nodesSlice';
import { createMarketsSlice, type MarketsSlice } from './marketsSlice';
import { createPositionsSlice, type PositionsSlice } from './positionsSlice';
import { createGroupsSlice, type GroupsSlice } from './groupsSlice';

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
export type StoreState = NodesSlice & MarketsSlice & PositionsSlice & GroupsSlice & UISlice;

// Type helpers for slice creators
// With the immer middleware, `set` receives a draft updater; `replace: true` is disallowed.
type StoreSet = (
  partial: StoreState | Partial<StoreState> | ((state: StoreState) => StoreState | Partial<StoreState> | void),
  replace?: false,
) => void;
type StoreGet = () => StoreState;

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
            ...createGroupsSlice(set as unknown as Parameters<typeof createGroupsSlice>[0], get as unknown as Parameters<typeof createGroupsSlice>[1], api as unknown as Parameters<typeof createGroupsSlice>[2]),
            ...createUISlice(set, get),
          })
        ),
        {
          name: 'pmt-storage', // localStorage key
          version: 2, // Bumped for groups migration

          // Only persist specific parts of state (UI preferences, not real-time data)
          partialize: (state: StoreState) => ({
            // UI State
            sidebarOpen: state.sidebarOpen,
            theme: state.theme,
            activePanel: state.activePanel,
            // Selection state (restore on reload)
            selectedNodeId: state.selectedNodeId,
            // Don't persist: nodes (from DB), markets (reconnect), positions (from DB), groups (now from DB)
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
            if (version === 1) {
              // Migration from version 1 to 2: remove groups from localStorage (now in SQLite)
              const state = { ...(persistedState as Record<string, unknown>) };
              delete state.groups;
              return state as unknown as StoreState;
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

export const useGroups = () => useStore((state: StoreState) => state.groups);
export const useGroupsArray = () => useStore((state: StoreState) => Object.values(state.groups));

export const useGroupActions = () => useStore((state: StoreState) => ({
  addGroup: state.addGroup,
  removeGroup: state.removeGroup,
  updateGroup: state.updateGroup,
  addNodesToGroup: state.addNodesToGroup,
  removeNodesFromGroup: state.removeNodesFromGroup,
  removeNodeFromAllGroups: state.removeNodeFromAllGroups,
  getGroupForNode: state.getGroupForNode,
  getSeriesGroups: state.getSeriesGroups,
}));

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
            
            // Also sync node size
            if (node.size) {
              void invoke('update_node_size_cmd', {
                id: node.id,
                size: [node.size.width, node.size.height ?? null],
              }).catch(console.error);
            }
          });
        });
      }, 500);
    },
    { equalityFn: shallow }
  );

  // Track previous connections to detect removals
  let previousConnections: StoreState['connections'] = [];
  
  useStore.subscribe(
    (state: StoreState) => state.connections,
    (connections) => {
      // Detect removed connections and sync deletion to backend
      const removedConnections = previousConnections.filter(
        (prev) => !connections.some((curr) => curr.source === prev.source && curr.target === prev.target)
      );
      
      if (removedConnections.length > 0) {
        void import('@tauri-apps/api/core').then(({ invoke }) => {
          removedConnections.forEach((conn) => {
            void invoke('remove_connection_cmd', {
              source: conn.source,
              target: conn.target,
            }).catch(console.error);
          });
        });
      }
      
      previousConnections = connections;
    },
  );

  // Track previous groups to detect changes
  let previousGroups: StoreState['groups'] = {};
  let groupSyncTimeout: ReturnType<typeof setTimeout>;

  useStore.subscribe(
    (state: StoreState) => state.groups,
    (groups) => {
      // Debounce group sync (300ms)
      clearTimeout(groupSyncTimeout);
      groupSyncTimeout = setTimeout(() => {
        void import('@tauri-apps/api/core').then(({ invoke }) => {
          const currentIds = new Set(Object.keys(groups));
          const previousIds = new Set(Object.keys(previousGroups));

          // Detect added groups
          for (const id of currentIds) {
            if (!previousIds.has(id)) {
              const group = groups[id];
              void invoke('add_node_group_cmd', {
                id: group.id,
                label: group.label,
                color: group.color,
                padding: group.padding,
                originType: group.origin.type,
                originData: group.origin.type === 'series' ? group.origin : null,
                memberIds: group.memberIds,
              }).catch(console.error);
            }
          }

          // Detect removed groups
          for (const id of previousIds) {
            if (!currentIds.has(id)) {
              void invoke('remove_node_group_cmd', {
                groupId: id,
              }).catch(console.error);
            }
          }

          // Detect updated groups (existing groups with changes)
          for (const id of currentIds) {
            if (previousIds.has(id)) {
              const current = groups[id];
              const previous = previousGroups[id];

              // Check if group metadata changed
              const metadataChanged =
                current.label !== previous.label ||
                current.color !== previous.color ||
                current.padding !== previous.padding;

              if (metadataChanged) {
                void invoke('update_node_group_cmd', {
                  id: current.id,
                  label: current.label,
                  color: current.color,
                  padding: current.padding,
                  originType: current.origin.type,
                  originData: current.origin.type === 'series' ? current.origin : null,
                }).catch(console.error);
              }

              // Check if members changed
              const currentMembers = new Set(current.memberIds);
              const previousMembers = new Set(previous.memberIds);

              const added = current.memberIds.filter((id) => !previousMembers.has(id));
              const removed = previous.memberIds.filter((id) => !currentMembers.has(id));

              if (added.length > 0) {
                void invoke('add_nodes_to_group_cmd', {
                  groupId: current.id,
                  nodeIds: added,
                }).catch(console.error);
              }

              if (removed.length > 0) {
                void invoke('remove_nodes_from_group_cmd', {
                  groupId: current.id,
                  nodeIds: removed,
                }).catch(console.error);
              }
            }
          }

          previousGroups = { ...groups };
        });
      }, 300);
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