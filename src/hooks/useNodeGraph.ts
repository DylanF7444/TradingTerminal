// ============================================================================
// NODE GRAPH COMPOSABLE HOOK
// ============================================================================
//
// Module: hooks/useNodeGraph.ts
// Purpose: High-level React hook for node graph operations with layout integration
//
// OVERVIEW:
// This hook provides a convenient interface for components to interact with the
// node graph system. It combines store access with graph layout algorithms,
// offering both low-level node operations and high-level graph management.
//
// Features:
// - Direct access to all node store actions and state
// - Integrated layout calculation and application
// - Animation support for smooth transitions
// - Graph validation and utility functions
// - Optimized selectors to minimize re-renders
//
// USAGE:
// ```tsx
// function Canvas() {
//   const { 
//     nodes, 
//     connections, 
//     addNode, 
//     applyLayout,
//     selectedNode 
//   } = useNodeGraph();
//   
//   return (
//     <div>
//       {Object.values(nodes).map(node => (
//         <NodeComponent key={node.id} node={node} />
//       ))}
//       <button onClick={() => applyLayout('force')}>
//         Auto Layout
//       </button>
//     </div>
//   );
// }
// ```
//
// ============================================================================

import { useCallback, useMemo } from 'react';
import { useStore } from '../store';
import type { StoreState } from '../store';
import type { 
  Node, 
  Connection, 
  Position,
} from '../types/nodes';
import { 
  calculateForceLayout,
  calculateHierarchicalLayout,
  calculateCircularLayout,
  calculateGridLayout,
  calculateOptimalLayout,
  animateLayout,
  layoutEngine,
  type LayoutType,
  type LayoutOptions 
} from '../utils/graphLayout';

// =============================================================================
// HOOK INTERFACE
// =============================================================================

export interface UseNodeGraphReturn {
  // -------------------------------------------------------------------------
  // State (from store)
  // -------------------------------------------------------------------------
  
  /** All nodes in the graph (normalized dictionary) */
  nodes: Record<string, Node>;
  
  /** All connections between nodes */
  connections: Connection[];
  
  /** Currently selected node IDs */
  selectedIds: Set<string>;
  
  /** Currently selected nodes as array */
  selectedNodes: Node[];
  
  /** Single selected node (first if multiple) or null */
  selectedNode: Node | null;
  
  /** Canvas viewport state */
  viewport: { x: number; y: number; zoom: number };
  
  /** Array of all nodes for iteration */
  nodesArray: Node[];
  
  /** Number of nodes in the graph */
  nodeCount: number;
  
  /** Number of connections in the graph */
  connectionCount: number;

  // -------------------------------------------------------------------------
  // Node Actions
  // -------------------------------------------------------------------------
  
  /** Add a new node to the graph */
  addNode: (node: Node) => void;
  
  /** Remove a node and all its connections */
  removeNode: (id: string) => void;
  
  /** Update node position during drag operations */
  updateNodePosition: (id: string, position: [number, number]) => void;
  
  /** Update node configuration metadata */
  updateNodeMetadata: (id: string, metadata: Record<string, any>) => void;
  
  /** Get a node by ID */
  getNode: (id: string) => Node | undefined;
  
  /** Check if a node exists */
  hasNode: (id: string) => boolean;

  // -------------------------------------------------------------------------
  // Connection Actions
  // -------------------------------------------------------------------------
  
  /** Create connection between two nodes */
  addConnection: (connection: Connection) => void;
  
  /** Remove specific connection */
  removeConnection: (source: string, target: string) => void;
  
  /** Update connection correlation strength (0.0-1.0) */
  updateConnectionStrength: (source: string, target: string, strength: number) => void;
  
  /** Get all connections for a node */
  getNodeConnections: (nodeId: string) => { incoming: Connection[]; outgoing: Connection[] };
  
  /** Check if two nodes are connected */
  areConnected: (source: string, target: string) => boolean;

  // -------------------------------------------------------------------------
  // Selection Actions
  // -------------------------------------------------------------------------
  
  /** Select a single node (or add to multi-selection) */
  selectNode: (id: string | null, multi?: boolean) => void;
  
  /** Clear all selections */
  clearSelection: () => void;
  
  /** Check if a node is selected */
  isSelected: (id: string) => boolean;

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
  // Layout Operations
  // -------------------------------------------------------------------------
  
  /** 
   * Apply a layout algorithm to the graph.
   * Calculates new positions and updates nodes.
   */
  applyLayout: (
    type: LayoutType | 'optimal',
    options?: LayoutOptions & { animate?: boolean; duration?: number }
  ) => Promise<void>;
  
  /** 
   * Calculate layout without applying it.
   * Returns positions for preview or custom application.
   */
  calculateLayout: (
    type: LayoutType | 'optimal',
    options?: LayoutOptions
  ) => Map<string, Position>;
  
  /** Get recommended layout type for current graph structure */
  getRecommendedLayout: () => LayoutType;

  // -------------------------------------------------------------------------
  // Graph Operations
  // -------------------------------------------------------------------------
  
  /** Import complete graph (for loading saved strategies) */
  importGraph: (graph: { nodes: Node[]; connections: Connection[] }) => void;
  
  /** Export current graph state */
  exportGraph: () => { nodes: Node[]; connections: Connection[] };
  
  /** Clear all nodes and connections */
  resetGraph: () => void;
  
  /** Get graph bounds (bounding box of all nodes) */
  getGraphBounds: () => { minX: number; minY: number; maxX: number; maxY: number } | null;

  // -------------------------------------------------------------------------
  // Utility Functions
  // -------------------------------------------------------------------------
  
  /** Filter nodes by type */
  getNodesByType: (type: 'InfoSource' | 'Market') => Node[];
  
  /** Get connected neighbor nodes */
  getConnectedNodes: (nodeId: string) => Node[];
  
  /** Validate graph integrity */
  validateGraph: () => { valid: boolean; errors: string[] };
}

// =============================================================================
// HOOK IMPLEMENTATION
// =============================================================================

export function useNodeGraph(): UseNodeGraphReturn {
  // -------------------------------------------------------------------------
  // Store Access
  // -------------------------------------------------------------------------
  
  // Use typed selectors for proper type inference
  const nodes = useStore((state: StoreState) => state.nodes);
  const connections = useStore((state: StoreState) => state.connections);
  const selectedIds = useStore((state: StoreState) => state.selectedIds);
  const viewport = useStore((state: StoreState) => state.viewport);
  
  // Actions
  const addNode = useStore((state: StoreState) => state.addNode);
  const removeNode = useStore((state: StoreState) => state.removeNode);
  const updateNodePosition = useStore((state: StoreState) => state.updateNodePosition);
  const updateNodeMetadata = useStore((state: StoreState) => state.updateNodeMetadata);
  const addConnection = useStore((state: StoreState) => state.addConnection);
  const removeConnection = useStore((state: StoreState) => state.removeConnection);
  const updateConnectionStrength = useStore((state: StoreState) => state.updateConnectionStrength);
  const selectNode = useStore((state: StoreState) => state.selectNode);
  const clearSelection = useStore((state: StoreState) => state.clearSelection);
  const isSelectedFn = useStore((state: StoreState) => state.isSelected);
  const setViewport = useStore((state: StoreState) => state.setViewport);
  const centerOnNode = useStore((state: StoreState) => state.centerOnNode);
  const fitToView = useStore((state: StoreState) => state.fitToView);
  const importGraph = useStore((state: StoreState) => state.importGraph);
  const exportGraph = useStore((state: StoreState) => state.exportGraph);
  const resetGraph = useStore((state: StoreState) => state.resetGraph);
  const getGraphBounds = useStore((state: StoreState) => state.getGraphBounds);
  const getNodeById = useStore((state: StoreState) => state.getNodeById);
  const getNodesByType = useStore((state: StoreState) => state.getNodesByType);
  const getConnectedNodes = useStore((state: StoreState) => state.getConnectedNodes);
  const getIncomingConnections = useStore((state: StoreState) => state.getIncomingConnections);
  const getOutgoingConnections = useStore((state: StoreState) => state.getOutgoingConnections);
  const updateNodes = useStore((state: StoreState) => state.updateNodes);

  // -------------------------------------------------------------------------
  // Derived State
  // -------------------------------------------------------------------------
  
  const nodesArray: Node[] = useMemo(() => Object.values(nodes), [nodes]);
  const nodeCount = nodesArray.length;
  const connectionCount = connections.length;
  
  const selectedNodes = useMemo(() => {
    return Array.from(selectedIds)
      .map((id) => nodes[id])
      .filter((n): n is Node => Boolean(n));
  }, [selectedIds, nodes]);
  
  const selectedNode = selectedNodes.length > 0 ? selectedNodes[0] : null;

  // -------------------------------------------------------------------------
  // Wrapped Actions
  // -------------------------------------------------------------------------
  
  const getNode = useCallback((id: string) => getNodeById(id), [getNodeById]);
  
  const hasNode = useCallback((id: string) => id in nodes, [nodes]);
  
  const isSelected = useCallback((id: string) => isSelectedFn(id), [isSelectedFn]);
  
  const getNodeConnections = useCallback((nodeId: string) => {
    return {
      incoming: getIncomingConnections(nodeId),
      outgoing: getOutgoingConnections(nodeId),
    };
  }, [getIncomingConnections, getOutgoingConnections]);
  
  const areConnected = useCallback((source: string, target: string) => {
    return connections.some(
      (conn: Connection) => conn.source === source && conn.target === target
    );
  }, [connections]);

  // -------------------------------------------------------------------------
  // Layout Operations
  // -------------------------------------------------------------------------
  
  const calculateLayout = useCallback((
    type: LayoutType | 'optimal',
    options?: LayoutOptions
  ): Map<string, Position> => {
    const nodesList: Node[] = Object.values(nodes);
    
    if (nodesList.length === 0) {
      return new Map();
    }
    
    let result;
    if (type === 'optimal') {
      const optimalResult = calculateOptimalLayout(nodesList, connections, options);
      return optimalResult.result.positions;
    }
    
    switch (type) {
      case 'force':
        result = calculateForceLayout(nodesList, connections, {}, options);
        break;
      case 'hierarchical':
        result = calculateHierarchicalLayout(nodesList, connections, {}, options);
        break;
      case 'circular':
        result = calculateCircularLayout(nodesList, connections, {}, options);
        break;
      case 'grid':
        result = calculateGridLayout(nodesList, connections, {}, options);
        break;
      default:
        result = calculateForceLayout(nodesList, connections, {}, options);
    }
    
    return result.positions;
  }, [nodes, connections]);
  
  const applyLayout = useCallback(async (
    type: LayoutType | 'optimal',
    options?: LayoutOptions & { animate?: boolean; duration?: number }
  ): Promise<void> => {
    const nodesList: Node[] = Object.values(nodes);
    if (nodesList.length === 0) return;
    
    const animate = options?.animate ?? true;
    const duration = options?.duration ?? 500;
    
    // Calculate new positions
    const newPositions = calculateLayout(type, options);
    
    if (newPositions.size === 0) return;
    
    if (animate) {
      // Get current positions
      const startPositions = new Map<string, Position>();
      for (const node of nodesList) {
        startPositions.set(node.id, node.position);
      }
      
      // Animate transition
      const animation = animateLayout(startPositions, newPositions, duration);
      
      for (const framePositions of animation) {
        const updates: Record<string, Partial<Node>> = {};
        for (const [id, position] of framePositions) {
          updates[id] = { position };
        }
        updateNodes(updates);
        
        // Yield to browser for rendering
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    } else {
      // Apply immediately
      const updates: Record<string, Partial<Node>> = {};
      for (const [id, position] of newPositions) {
        updates[id] = { position };
      }
      updateNodes(updates);
    }
  }, [nodes, calculateLayout, updateNodes]);
  
  const getRecommendedLayout = useCallback((): LayoutType => {
    const nodesList: Node[] = Object.values(nodes);
    return layoutEngine.recommendAlgorithm(nodesList, connections);
  }, [nodes, connections]);

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------
  
  const validateGraph = useCallback(() => {
    const errors: string[] = [];
    
    // Check for orphaned connections
    for (const conn of connections) {
      if (!nodes[conn.source]) {
        errors.push(`Connection references non-existent source: ${conn.source}`);
      }
      if (!nodes[conn.target]) {
        errors.push(`Connection references non-existent target: ${conn.target}`);
      }
    }
    
    // Check for self-connections
    for (const conn of connections) {
      if (conn.source === conn.target) {
        errors.push(`Self-connection detected: ${conn.source}`);
      }
    }
    
    // Check for duplicate connections
    const seen = new Set<string>();
    for (const conn of connections) {
      const key = `${conn.source}->${conn.target}`;
      if (seen.has(key)) {
        errors.push(`Duplicate connection: ${key}`);
      }
      seen.add(key);
    }
    
    // Check for invalid positions
    for (const node of Object.values(nodes) as Node[]) {
      if (!Array.isArray(node.position) || node.position.length !== 2) {
        errors.push(`Invalid position for node ${node.id}`);
      } else if (
        typeof node.position[0] !== 'number' ||
        typeof node.position[1] !== 'number' ||
        !isFinite(node.position[0]) ||
        !isFinite(node.position[1])
      ) {
        errors.push(`Non-finite position for node ${node.id}`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
    };
  }, [nodes, connections]);

  // -------------------------------------------------------------------------
  // Return Interface
  // -------------------------------------------------------------------------
  
  return {
    // State
    nodes,
    connections,
    selectedIds,
    selectedNodes,
    selectedNode,
    viewport,
    nodesArray,
    nodeCount,
    connectionCount,
    
    // Node Actions
    addNode,
    removeNode,
    updateNodePosition,
    updateNodeMetadata,
    getNode,
    hasNode,
    
    // Connection Actions
    addConnection,
    removeConnection,
    updateConnectionStrength,
    getNodeConnections,
    areConnected,
    
    // Selection Actions
    selectNode,
    clearSelection,
    isSelected,
    
    // Viewport Actions
    setViewport,
    centerOnNode,
    fitToView,
    
    // Layout Operations
    applyLayout,
    calculateLayout,
    getRecommendedLayout,
    
    // Graph Operations
    importGraph,
    exportGraph,
    resetGraph,
    getGraphBounds,
    
    // Utility Functions
    getNodesByType,
    getConnectedNodes,
    validateGraph,
  };
}

// =============================================================================
// CONVENIENCE EXPORTS
// =============================================================================

export type { LayoutType, LayoutOptions };
export { 
  calculateForceLayout,
  calculateHierarchicalLayout,
  calculateCircularLayout,
  calculateGridLayout,
  calculateOptimalLayout,
  animateLayout 
};

// =============================================================================
// DEFAULT EXPORT
// =============================================================================

export default useNodeGraph;
