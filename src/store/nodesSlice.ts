// ============================================================================
// NODE GRAPH STATE MANAGEMENT SLICE
// ============================================================================
//
// Zustand slice managing the interactive node graph for prediction markets.
// Handles InfoSource nodes (crypto, news, weather) and Market nodes
// (Polymarket, Kalshi), their spatial positions, and connection topology.
//
// State Shape (normalized for O(1) lookups):
//   nodes: Record<string, Node>          - All graph nodes keyed by ID
//   connections: Connection[]             - Edges with source/target IDs and strength
//   selectedIds: Set<string>              - Multi-selection support
//   viewport: { x, y, zoom }             - Canvas pan/zoom transform
//   lastInteraction: number               - Timestamp for auto-save debouncing
//   rawDataStreams: Record<string, RawStreamEntry[]> - Debug data per node
//
// Actions: addNode, removeNode, updateNodePosition, updateNodeSize,
//   updateNodeMetadata, updateNodes, addConnection, removeConnection,
//   updateConnectionStrength, clearNodeConnections, selectNode, clearSelection,
//   selectNodes, setViewport, centerOnNode, fitToView, autoLayout,
//   importGraph, exportGraph, resetGraph, appendRawDataEntry,
//   clearRawDataStream, clearAllRawDataStreams
//
// Key Design Decisions:
//   - Normalized dict (not array) for nodes enables O(1) lookup/update
//   - Connections store only IDs; coordinates resolved at render time
//   - Raw data streams capped at 50 entries per node to bound memory
//   - Inter-slice: marketsSlice reacts to market node adds,
//     positionsSlice links positions to market node IDs
// ============================================================================

import { StateCreator } from 'zustand';
import { Node, Connection } from '../types/nodes';
import { calculateForceLayout } from '../utils/graphLayout';

// =============================================================================
// RAW INPUT STREAM TYPES
// =============================================================================

/**
 * Raw input stream entry representing a single data point received by a node.
 * Used for debugging connection status and verifying data flow.
 */
export interface RawStreamEntry {
  /** Timestamp when the data was received */
  timestamp: number;
  /** Raw data payload (can be any JSON-serializable value) */
  data: unknown;
  /** Source of the data (e.g., 'websocket', 'polling', 'user') */
  source?: string;
  /** Optional status indicator (e.g., 'success', 'error') */
  status?: 'success' | 'error' | 'pending';
}

/**
 * Maximum number of entries to keep per node's raw input stream history.
 * Prevents memory exhaustion from high-frequency data streams.
 */
const MAX_STREAM_ENTRIES_PER_NODE = 50;

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
  
  /** 
   * Raw input stream data per node for debugging connection status.
   * Key: node ID, Value: array of recent raw data entries.
   */
  rawDataStreams: Record<string, RawStreamEntry[]>;

  // -------------------------------------------------------------------------
  // Node Lifecycle Actions
  // -------------------------------------------------------------------------
  
  /** Add a new node to the graph */
  addNode: (node: Node) => void;
  
  /** Remove a node and all its connections */
  removeNode: (id: string) => void;
  
  /** Update node position during drag operations */
  updateNodePosition: (id: string, position: [number, number]) => void;
  
  /** Update node size during resize operations */
  updateNodeSize: (id: string, size: { width: number; height: number | null }) => void;
  
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

  // -------------------------------------------------------------------------
  // Raw Data Stream Actions
  // -------------------------------------------------------------------------
  
  /** Add a raw data entry to a node's input stream history */
  appendRawDataEntry: (nodeId: string, entry: Omit<RawStreamEntry, 'timestamp'>) => void;
  
  /** Get raw data stream for a specific node */
  getRawDataStream: (nodeId: string) => RawStreamEntry[];
  
  /** Clear raw data stream history for a specific node */
  clearRawDataStream: (nodeId: string) => void;
  
  /** Clear all raw data streams */
  clearAllRawDataStreams: () => void;
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
  rawDataStreams: {},

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

  updateNodeSize: (id: string, size: { width: number; height: number | null }) => {
    set((state) => {
      const node = state.nodes[id];
      if (!node) return state;
      
      return {
        nodes: {
          ...state.nodes,
          [id]: {
            ...node,
            size,
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

  // -------------------------------------------------------------------------
  // Raw Data Stream Implementation
  // -------------------------------------------------------------------------
  
  appendRawDataEntry: (nodeId: string, entry: Omit<RawStreamEntry, 'timestamp'>) => {
    set((state) => {
      const currentStream = state.rawDataStreams[nodeId] || [];
      const newEntry: RawStreamEntry = {
        ...entry,
        timestamp: Date.now(),
      };
      
      // Keep only the last N entries to prevent memory issues
      const newStream = [newEntry, ...currentStream].slice(0, MAX_STREAM_ENTRIES_PER_NODE);
      
      return {
        rawDataStreams: {
          ...state.rawDataStreams,
          [nodeId]: newStream,
        },
      };
    });
  },
  
  getRawDataStream: (nodeId: string) => {
    return get().rawDataStreams[nodeId] || [];
  },
  
  clearRawDataStream: (nodeId: string) => {
    set((state) => {
      const { [nodeId]: _, ...remaining } = state.rawDataStreams;
      return { rawDataStreams: remaining };
    });
  },
  
  clearAllRawDataStreams: () => {
    set({ rawDataStreams: {} });
  },
});