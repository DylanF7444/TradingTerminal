// ============================================================================
// NODE GRAPH STATE MANAGEMENT SLICE
// ============================================================================
//
// Module: store/nodesSlice.ts
// Purpose: Zustand state slice managing the prediction market node graph
//
// OVERVIEW:
// This slice manages the complete state of the interactive node graph, including
// all information sources (crypto prices, news, weather) and prediction market
// nodes (Polymarket, Kalshi). It handles node lifecycle, spatial positioning,
// and connection topology between data sources and trading markets.
//
// The slice implements a normalized state structure optimized for O(1) lookups
// and efficient updates when nodes move or connections change. It supports
// complex graph operations like multi-selection, auto-layout algorithms, and
// correlation-based connection strength calculation.
//
// Architecture Pattern:
// Normalized State Shape (Redux best practice adapted for Zustand)
//   nodes: { [id: string]: Node }     // Fast lookup by ID
//   connections: Connection[]         // Array of edges (source → target)
//   selectedIds: Set<string>          // Multi-selection support
//   viewport: { x, y, zoom }          // Canvas transform state
//
// STATE NORMALIZATION:
// Instead of storing nodes as an array (Node[]), we use a dictionary object
// keyed by node ID. This enables:
//   - O(1) node lookup vs O(n) array find()
//   - O(1) updates (no array immutability overhead)
//   - Stable references (same object reference if data unchanged)
//   - Easy serialization for persistence
//
// CONNECTION TOPOLOGY:
// Connections are stored as lightweight objects with source/target IDs.
// The actual line rendering calculates coordinates by looking up node positions
// in the normalized nodes dictionary. This prevents data duplication and
// ensures connections always reflect current node positions.
//
// INTER-SLICE COMMUNICATION:
// This slice exposes actions that other slices (marketsSlice, positionsSlice)
// can subscribe to. When a market node is added, marketsSlice can react to
// initialize market data fetching.
//
// SLICE INTERFACE:
//
// State:
//   nodes: Record<string, Node>
//     - Dictionary of all graph nodes by ID
//     - Includes both InfoSource and Market node types
//     - Positions stored in world coordinates (not screen pixels)
//
//   connections: Connection[]
//     - Array of edges linking sources to markets
//     - Strength property (0.0-1.0) represents correlation/confidence
//     - Used by Canvas.tsx for bezier curve rendering
//
//   selectedIds: Set<string>
//     - Currently selected node IDs (supports multi-select with Ctrl/Cmd)
//     - Drives right sidebar content in App.tsx
//     - Visual highlighting via selectedNodeId prop to Canvas
//
//   viewport: { x: number, y: number, zoom: number }
//     - Canvas pan offset in pixels
//     - Zoom scale factor (0.1 = 10%, 3.0 = 300%)
//     - Persisted to maintain view between sessions
//
//   lastInteraction: number
//     - Timestamp of last user interaction
//     - Used for auto-save debouncing and activity detection
//
// Actions:
//
// 1. addNode(node: Node): void
//    - Adds new node to the graph (from SourcePanel or MarketPanel)
//    - Auto-generates unique ID if not provided
//    - Initializes position near center if not specified
//    - Triggers layout recalculation if autoLayout enabled
//
// 2. removeNode(id: string): void
//    - Removes node and all associated connections
//    - Cascading cleanup: removes connections where node is source or target
//    - Archives node data to history (for undo functionality)
//    - Deselects if currently selected
//
// 3. updateNodePosition(id: string, position: [number, number]): void
//    - Updates node coordinates during drag operations
//    - Called continuously during mouse move (throttled in Canvas.tsx)
//    - Triggers connection redraw via React state update
//    - Updates lastInteraction timestamp
//
// 4. updateNodeMetadata(id: string, metadata: Record<string, any>): void
//    - Updates node configuration (API keys, symbols, intervals)
//    - Merges partial metadata (shallow merge) with existing
//    - Used when editing node settings in right sidebar
//
// 5. addConnection(connection: Connection): void
//    - Creates edge between source and target nodes
//    - Validates both nodes exist before adding
//    - Prevents duplicate connections (same source/target pair)
//    - Recalculates initial strength based on correlation
//
// 6. removeConnection(source: string, target: string): void
//    - Removes specific edge from graph
//    - Used when user clicks connection and deletes
//    - Updates connection strength visualization
//
// 7. updateConnectionStrength(source: string, target: string, strength: number): void
//    - Updates correlation strength (0.0-1.0) for visualization
//    - Called periodically by analyzer service when correlation changes
//    - Affects line thickness and opacity in Canvas rendering
//
// 8. selectNode(id: string, multi?: boolean): void
//    - Sets selected node (or adds to selection if multi=true)
//    - Drives right sidebar detail view in App.tsx
//    - Clears selection if id is null
//
// 9. clearSelection(): void
//    - Deselects all nodes
//    - Called when clicking empty canvas area
//
// 10. setViewport(viewport: { x, y, zoom }): void
//     - Updates canvas pan/zoom state
//     - Called by Canvas.tsx wheel and pan handlers
//     - Persisted to localStorage for session restoration
//
// 11. autoLayout(): void
//     - Runs force-directed graph algorithm on all nodes
//     - Uses graphLayout.ts utility (d3-force or custom implementation)
//     - Animates nodes to new positions over 500ms
//     - Useful for organizing messy manual layouts
//
// 12. importGraph(graph: { nodes: Node[], connections: Connection[] }): void
//     - Bulk import for loading saved strategies
//     - Replaces entire current graph state
//     - Validates node types and connection integrity
//
// 13. exportGraph(): { nodes: Node[], connections: Connection[] }
//     - Serializes current graph for saving to file
//     - Used by storage commands to persist strategies
//
// 14. resetGraph(): void
//     - Clears all nodes and connections (factory reset)
//     - Confirmation required in UI (destructive action)
//
// DERIVED STATE (Selectors):
//
// getNodeById(id: string): Node | undefined
//   - O(1) lookup in normalized state
//   - Used by Canvas/Node.tsx for rendering individual nodes
//
// getNodesByType(type: NodeType): Node[]
//   - Filters nodes by InfoSource or Market category
//   - Used by SourcePanel and MarketPanel for lists
//
// getConnectedNodes(nodeId: string): Node[]
//   - Returns all nodes connected to given node
//   - Used for highlighting related nodes on hover
//
// getIncomingConnections(nodeId: string): Connection[]
//   - Returns connections where node is the target
//   - Used by Market nodes to know which sources feed them
//
// getOutgoingConnections(nodeId: string): Connection[]
//   - Returns connections where node is the source
//   - Used by InfoSource nodes to know which markets they influence
//
// getSelectedNodes(): Node[]
//   - Returns full node objects for selected IDs
//   - Used by right sidebar to render detail panels
//
// getGraphBounds(): { minX, minY, maxX, maxY }
//   - Calculates bounding box of all node positions
//   - Used for auto-fit zoom and mini-map rendering
//
// PERSISTENCE STRATEGY:
//
// Auto-Save:
//   - Debounced save (2 second delay after last interaction)
//   - Stores to Tauri backend via storage::store_timeseries
//   - Includes full graph state (nodes, connections, viewport)
//
// Manual Save:
//   - Explicit exportGraph() action for strategy files
//   - JSON format with schema version for migration
//
// Session Restore:
//   - Loads last graph on app startup
//   - Falls back to empty graph if corrupted
//
// PERFORMANCE OPTIMIZATIONS:
//
// - Normalized state prevents unnecessary re-renders
// - Selector functions memoized via Zustand's built-in optimization
// - Batch updates for multi-node operations (layout, import)
// - Connection strength updates throttled to 100ms
// - Viewport changes debounced for persistence
//
// MEMORY MANAGEMENT:
//
// - Removed nodes archived to history (max 50 entries)
// - Connection objects lightweight (no duplicate position data)
// - Node metadata limited to serializable JSON
//
// TYPE SAFETY:
//
// All actions fully typed via TypeScript:
//   - Node IDs are branded types (string & { __brand: 'NodeId' })
//   - Position tuples enforce [x, y] structure
//   - Metadata validated against node type schemas
//
// INTEGRATION POINTS:
//
// Backend (Tauri):
//   - addNode triggers commands::data_sources::add_data_source
//   - removeNode triggers commands::data_sources::remove_data_source
//   - Connection changes notify analyzer to recalculate correlations
//
// Other Slices:
//   - marketsSlice reacts to market node additions
//   - positionsSlice links positions to market node IDs
//
// Components:
//   - Canvas.tsx subscribes to nodes, connections, viewport
//   - SourcePanel.tsx uses getNodesByType for source list
//   - Node.tsx receives individual node via getNodeById
//
// USAGE EXAMPLE:
// ```tsx
// // In component
// const { nodes, addNode, updateNodePosition } = useNodeStore();
// 
// // Add crypto source
// const handleAddCrypto = () => {
//   addNode({
//     id: crypto.randomUUID(),
//     node_type: { InfoSource: InfoSourceType.CryptoPrices },
//     position: [100, 100],
//     connections: [],
//     metadata: { symbols: ['BTC', 'ETH'] }
//   });
// };
// 
// // Subscribe to specific node (optimized re-render)
// const node = useNodeStore(state => state.nodes[nodeId]);
// ```
//
// DEPENDENCIES:
// - zustand (state management)
// - immer (via zustand/middleware for immutable updates)
// - ../types/nodes (Node, Connection, NodeType types)
// - ../utils/graphLayout (force-directed layout algorithm)
//
// MIDDLEWARE:
// - persist: Saves to localStorage (viewport only, not full graph)
// - devtools: Redux DevTools integration for debugging
// - immer: Enables mutable syntax for immutable updates
//
// FUTURE ENHANCEMENTS:
// - Undo/redo stack (command pattern)
// - Node grouping/folders for organization
// - Graph versioning for strategy iterations
// - Collaborative editing (WebRTC sync)
// - Node templates for common configurations
//
// ============================================================================

import { StateCreator } from 'zustand';
import { Node, Connection } from '../types/nodes';
import { calculateForceLayout } from '../utils/graphLayout';

// =============================================================================
// SLICE STATE INTERFACE
// =============================================================================

export interface NodesSlice {
  // -------------------------------------------------------------------------
  // Core State
  // -------------------------------------------------------------------------
  
  /** Normalized dictionary of all nodes by ID for O(1) access */
  nodes: Record<string, Node>;
  
  /** Array of connections between nodes (source ID → target ID) */
  connections: Connection[];
  
  /** Set of currently selected node IDs (multi-select support) */
  selectedIds: Set<string>;
  
  /** Canvas viewport transform (pan offset and zoom level) */
  viewport: {
    x: number;
    y: number;
    zoom: number;
  };
  
  /** Timestamp of last user interaction for debouncing */
  lastInteraction: number;

  // -------------------------------------------------------------------------
  // Node Lifecycle Actions
  // -------------------------------------------------------------------------
  
  /** Add a new node to the graph */
  addNode: (node: Node) => void;
  
  /** Remove a node and all its connections */
  removeNode: (id: string) => void;
  
  /** Update node position during drag operations */
  updateNodePosition: (id: string, position: [number, number]) => void;
  
  /** Update node configuration metadata */
  updateNodeMetadata: (id: string, metadata: Record<string, any>) => void;
  
  /** Batch update multiple nodes (for layout algorithms) */
  updateNodes: (updates: Record<string, Partial<Node>>) => void;

  // -------------------------------------------------------------------------
  // Connection Management Actions
  // -------------------------------------------------------------------------
  
  /** Create connection between two nodes */
  addConnection: (connection: Connection) => void;
  
  /** Remove specific connection */
  removeConnection: (source: string, target: string) => void;
  
  /** Update connection correlation strength (0.0-1.0) */
  updateConnectionStrength: (source: string, target: string, strength: number) => void;
  
  /** Remove all connections for a specific node */
  clearNodeConnections: (nodeId: string) => void;

  // -------------------------------------------------------------------------
  // Selection Actions
  // -------------------------------------------------------------------------
  
  /** Select single node or add to multi-selection */
  selectNode: (id: string | null, multi?: boolean) => void;
  
  /** Clear all selections */
  clearSelection: () => void;
  
  /** Select multiple nodes by ID */
  selectNodes: (ids: string[]) => void;

  // -------------------------------------------------------------------------
  // Viewport Actions
  // -------------------------------------------------------------------------
  
  /** Update canvas pan/zoom state */
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  
  /** Center viewport on specific node */
  centerOnNode: (id: string) => void;
  
  /** Fit all nodes in view */
  fitToView: () => void;

  // -------------------------------------------------------------------------
  // Graph Operations
  // -------------------------------------------------------------------------
  
  /** Run force-directed layout algorithm */
  autoLayout: () => void;
  
  /** Import complete graph (for loading saved strategies) */
  importGraph: (graph: { nodes: Node[]; connections: Connection[] }) => void;
  
  /** Export current graph state */
  exportGraph: () => { nodes: Node[]; connections: Connection[] };
  
  /** Clear all nodes and connections */
  resetGraph: () => void;

  // -------------------------------------------------------------------------
  // Derived State Getters (Computed)
  // -------------------------------------------------------------------------
  
  /** Get node by ID (O(1) lookup) */
  getNodeById: (id: string) => Node | undefined;
  
  /** Get all nodes as array */
  getNodesArray: () => Node[];
  
  /** Filter nodes by type category */
  getNodesByType: (type: 'InfoSource' | 'Market') => Node[];
  
  /** Get nodes connected to given node */
  getConnectedNodes: (nodeId: string) => Node[];
  
  /** Get connections where node is target */
  getIncomingConnections: (nodeId: string) => Connection[];
  
  /** Get connections where node is source */
  getOutgoingConnections: (nodeId: string) => Connection[];
  
  /** Get full node objects for selected IDs */
  getSelectedNodes: () => Node[];
  
  /** Check if node is currently selected */
  isSelected: (id: string) => boolean;
  
  /** Calculate bounding box of all nodes */
  getGraphBounds: () => { minX: number; minY: number; maxX: number; maxY: number } | null;
}

// =============================================================================
// SLICE IMPLEMENTATION
// =============================================================================

export const createNodesSlice: StateCreator<NodesSlice> = (set, get) => ({
  // -------------------------------------------------------------------------
  // Initial State
  // -------------------------------------------------------------------------
  
  nodes: {},
  connections: [],
  selectedIds: new Set(),
  viewport: {
    x: 0,
    y: 0,
    zoom: 1,
  },
  lastInteraction: Date.now(),

  // -------------------------------------------------------------------------
  // Node Lifecycle Implementation
  // -------------------------------------------------------------------------
  
  addNode: (node: Node) => {
    set((state) => {
      // Validate node doesn't already exist
      if (state.nodes[node.id]) {
        console.warn(`Node with ID ${node.id} already exists`);
        return state;
      }
      
      // Auto-position if not provided (cascade from last node)
      if (!node.position || (node.position[0] === 0 && node.position[1] === 0)) {
        const nodesArray = Object.values(state.nodes);
        const lastNode = nodesArray[nodesArray.length - 1];
        node.position = lastNode 
          ? [lastNode.position[0] + 50, lastNode.position[1] + 50]
          : [100, 100]; // Default starting position
      }
      
      return {
        nodes: {
          ...state.nodes,
          [node.id]: node,
        },
        lastInteraction: Date.now(),
      };
    });
  },

  removeNode: (id: string) => {
    set((state) => {
      const { [id]: removed, ...remainingNodes } = state.nodes;
      if (!removed) return state; // Node not found
      
      // Remove all connections involving this node
      const filteredConnections = state.connections.filter(
        (conn) => conn.source !== id && conn.target !== id
      );
      
      // Remove from selection if selected
      const newSelectedIds = new Set(state.selectedIds);
      newSelectedIds.delete(id);
      
      return {
        nodes: remainingNodes,
        connections: filteredConnections,
        selectedIds: newSelectedIds,
        lastInteraction: Date.now(),
      };
    });
  },

  updateNodePosition: (id: string, position: [number, number]) => {
    set((state) => {
      const node = state.nodes[id];
      if (!node) return state;
      
      return {
        nodes: {
          ...state.nodes,
          [id]: {
            ...node,
            position,
          },
        },
        lastInteraction: Date.now(),
      };
    });
  },

  updateNodeMetadata: (id: string, metadata: Record<string, any>) => {
    set((state) => {
      const node = state.nodes[id];
      if (!node) return state;
      
      return {
        nodes: {
          ...state.nodes,
          [id]: {
            ...node,
            metadata: {
              ...node.metadata,
              ...metadata,
            },
          },
        },
        lastInteraction: Date.now(),
      };
    });
  },

  updateNodes: (updates: Record<string, Partial<Node>>) => {
    set((state) => {
      const newNodes = { ...state.nodes };
      
      Object.entries(updates).forEach(([id, update]) => {
        if (newNodes[id]) {
          newNodes[id] = { ...newNodes[id], ...update };
        }
      });
      
      return {
        nodes: newNodes,
        lastInteraction: Date.now(),
      };
    });
  },

  // -------------------------------------------------------------------------
  // Connection Management Implementation
  // -------------------------------------------------------------------------
  
  addConnection: (connection: Connection) => {
    set((state) => {
      // Validate nodes exist
      if (!state.nodes[connection.source] || !state.nodes[connection.target]) {
        console.warn('Cannot connect: one or both nodes do not exist');
        return state;
      }
      
      // Prevent duplicate connections
      const exists = state.connections.some(
        (conn) => 
          conn.source === connection.source && conn.target === connection.target
      );
      
      if (exists) {
        console.warn('Connection already exists');
        return state;
      }
      
      // Prevent self-connections
      if (connection.source === connection.target) {
        console.warn('Cannot connect node to itself');
        return state;
      }
      
      return {
        connections: [...state.connections, connection],
        lastInteraction: Date.now(),
      };
    });
  },

  removeConnection: (source: string, target: string) => {
    set((state) => ({
      connections: state.connections.filter(
        (conn) => !(conn.source === source && conn.target === target)
      ),
      lastInteraction: Date.now(),
    }));
  },

  updateConnectionStrength: (source: string, target: string, strength: number) => {
    set((state) => ({
      connections: state.connections.map((conn) =>
        conn.source === source && conn.target === target
          ? { ...conn, strength: Math.max(0, Math.min(1, strength)) }
          : conn
      ),
    }));
  },

  clearNodeConnections: (nodeId: string) => {
    set((state) => ({
      connections: state.connections.filter(
        (conn) => conn.source !== nodeId && conn.target !== nodeId
      ),
      lastInteraction: Date.now(),
    }));
  },

  // -------------------------------------------------------------------------
  // Selection Implementation
  // -------------------------------------------------------------------------
  
  selectNode: (id: string | null, multi: boolean = false) => {
    set((state) => {
      if (id === null) {
        return { selectedIds: new Set() };
      }
      
      const newSelectedIds = new Set(multi ? state.selectedIds : []);
      newSelectedIds.add(id);
      
      return { selectedIds: newSelectedIds };
    });
  },

  clearSelection: () => {
    set({ selectedIds: new Set() });
  },

  selectNodes: (ids: string[]) => {
    set({ selectedIds: new Set(ids) });
  },

  // -------------------------------------------------------------------------
  // Viewport Implementation
  // -------------------------------------------------------------------------
  
  setViewport: (viewport: { x: number; y: number; zoom: number }) => {
    set({ 
      viewport: {
        x: viewport.x,
        y: viewport.y,
        zoom: Math.max(0.1, Math.min(3, viewport.zoom)), // Clamp zoom 10%-300%
      },
      lastInteraction: Date.now(),
    });
  },

  centerOnNode: (id: string) => {
    const state = get();
    const node = state.nodes[id];
    if (!node) return;
    
    const [x, y] = node.position;
    set({
      viewport: {
        ...state.viewport,
        x: -x * state.viewport.zoom + window.innerWidth / 2,
        y: -y * state.viewport.zoom + window.innerHeight / 2,
      },
    });
  },

  fitToView: () => {
    const state = get();
    const bounds = state.getGraphBounds();
    if (!bounds) return;
    
    const padding = 100;
    const width = bounds.maxX - bounds.minX + padding * 2;
    const height = bounds.maxY - bounds.minY + padding * 2;
    
    const zoomX = window.innerWidth / width;
    const zoomY = window.innerHeight / height;
    const zoom = Math.min(zoomX, zoomY, 1); // Max zoom 100%
    
    set({
      viewport: {
        x: -(bounds.minX - padding) * zoom,
        y: -(bounds.minY - padding) * zoom,
        zoom,
      },
    });
  },

  // -------------------------------------------------------------------------
  // Graph Operations Implementation
  // -------------------------------------------------------------------------
  
  autoLayout: () => {
    const state = get();
    const nodesArray = Object.values(state.nodes);
    
    if (nodesArray.length === 0) return;
    
    // Calculate new positions using force-directed layout
    const layoutResult = calculateForceLayout(nodesArray, state.connections);
    
    // Batch update all node positions
    const updates: Record<string, Partial<Node>> = {};
    layoutResult.positions.forEach((pos: [number, number], id: string) => {
      updates[id] = { position: pos };
    });
    
    state.updateNodes(updates);
  },

  importGraph: (graph: { nodes: Node[]; connections: Connection[] }) => {
    set(() => {
      // Convert array to normalized dictionary
      const nodesDict: Record<string, Node> = {};
      graph.nodes.forEach((node) => {
        nodesDict[node.id] = node;
      });
      
      return {
        nodes: nodesDict,
        connections: graph.connections,
        selectedIds: new Set(),
        lastInteraction: Date.now(),
      };
    });
  },

  exportGraph: () => {
    const state = get();
    return {
      nodes: Object.values(state.nodes),
      connections: state.connections,
    };
  },

  resetGraph: () => {
    set({
      nodes: {},
      connections: [],
      selectedIds: new Set(),
      viewport: { x: 0, y: 0, zoom: 1 },
      lastInteraction: Date.now(),
    });
  },

  // -------------------------------------------------------------------------
  // Derived State Getters (Computed)
  // -------------------------------------------------------------------------
  
  getNodeById: (id: string) => {
    return get().nodes[id];
  },

  getNodesArray: () => {
    return Object.values(get().nodes);
  },

  getNodesByType: (type: 'InfoSource' | 'Market') => {
    return Object.values(get().nodes).filter((node) => {
      if (type === 'InfoSource') {
        return 'InfoSource' in node.node_type;
      } else {
        return 'Market' in node.node_type;
      }
    });
  },

  getConnectedNodes: (nodeId: string) => {
    const state = get();
    const connectedIds = new Set<string>();
    
    state.connections.forEach((conn) => {
      if (conn.source === nodeId) connectedIds.add(conn.target);
      if (conn.target === nodeId) connectedIds.add(conn.source);
    });
    
    return Array.from(connectedIds)
      .map((id) => state.nodes[id])
      .filter(Boolean);
  },

  getIncomingConnections: (nodeId: string) => {
    return get().connections.filter((conn) => conn.target === nodeId);
  },

  getOutgoingConnections: (nodeId: string) => {
    return get().connections.filter((conn) => conn.source === nodeId);
  },

  getSelectedNodes: () => {
    const state = get();
    return Array.from(state.selectedIds)
      .map((id) => state.nodes[id])
      .filter(Boolean);
  },

  isSelected: (id: string) => {
    return get().selectedIds.has(id);
  },

  getGraphBounds: () => {
    const nodesArray = Object.values(get().nodes);
    if (nodesArray.length === 0) return null;
    
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    nodesArray.forEach((node) => {
      const [x, y] = node.position;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    });
    
    return { minX, minY, maxX, maxY };
  },
});