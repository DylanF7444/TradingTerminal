// ============================================================================
// INTERACTIVE GRAPH CANVAS COMPONENT
// ============================================================================
//
// Module: components/Canvas/Canvas.tsx
// Purpose: Main visualization surface for the prediction market node graph
//
// OVERVIEW:
// This component serves as the primary visual workspace of the trading terminal,
// rendering the interactive network graph that connects information sources to
// prediction markets. It implements a hybrid rendering approach using HTML5
// Canvas for connections (performance) and React DOM for nodes (interactivity).
//
// The canvas implements a viewport-based coordinate system supporting infinite
// pan and zoom, allowing users to navigate complex trading strategies with
// dozens of connected nodes. It handles real-time visualization of connection
// strengths (correlations) through dynamic line rendering.
//
// DIMENSION BOUNDS:
// The canvas supports configurable dimension bounds that constrain both node
// positions and viewport panning within a defined rectangular region. This
// prevents nodes from being dragged off-screen and ensures users don't get
// lost in infinite canvas space.
//
// Bounds Configuration:
//   - bounds.minX: Minimum X coordinate (left edge of workspace)
//   - bounds.maxX: Maximum X coordinate (right edge of workspace)
//   - bounds.minY: Minimum Y coordinate (top edge of workspace)
//   - bounds.maxY: Maximum Y coordinate (bottom edge of workspace)
//
// Default bounds are set to -10000 to 10000 on both axes, providing a large
// working area while preventing nodes from being positioned at extreme
// coordinates that could cause rendering or navigation issues.
//
// Bounds Behavior:
//   - Node dragging: Position is clamped to bounds when mouse is released
//   - Viewport panning: Optional clamping to keep viewport within bounds
//   - Zoom: Works independently of bounds (zoom can exceed visible area)
//
// Architecture Pattern:
// React State (viewport, nodes) 
//   → Canvas API (background grid, bezier curves, arrow heads)
//   → DOM Overlay (interactive nodes with event handlers)
//   → CSS Transforms (viewport pan/zoom applied to node layer)
//
// RENDERING STRATEGY:
// Canvas Layer (Bottom):
//   - Grid background (adaptive density based on zoom)
//   - Connection lines (bezier curves with strength-based opacity)
//   - Direction arrows (midpoint indicators)
//   - Glow effects for high-correlation edges
//
// DOM Layer (Top):
//   - Draggable node components (absolute positioning)
//   - Event handling (click, drag, hover)
//   - Status indicators and animations
//   - Tooltip/label overlays
//   - Coordinate display (shows world coordinates on hover)
//
// PROPS:
//
// 1. nodes: Node[]
//    - Array of all nodes in the graph (sources and markets)
//    - Used for coordinate lookups when drawing connections
//    - Passed to child NodeComponents for rendering
//
// 2. connections: Connection[]
//    - Array of edges between nodes with strength metadata
//    - strength: 0.0-1.0 determines line thickness and opacity
//    - Rendered as bezier curves with directional arrows
//
// 3. bounds?: CanvasBounds
//    - Optional dimension bounds for the canvas workspace
//    - Constrains node positions and optionally viewport panning
//    - Format: { minX, maxX, minY, maxY } in world coordinates
//    - Default: { minX: -10000, maxX: 10000, minY: -10000, maxY: 10000 }
//
// 4. clampViewportToBounds?: boolean
//    - When true, viewport panning is constrained to bounds
//    - Default: false (allows free panning)
//
// 5. onNodeClick: (node: Node) => void
//    - Callback when user clicks a node (selection)
//    - Triggers right sidebar detail panel via App.tsx
//
// 6. onNodeMove: (id: string, position: [number, number]) => void
//    - Callback during node drag operations
//    - Updates node position in global state (Zustand store)
//    - Triggers connection redraw (canvas re-render)
//
// 7. onConnectionClick?: (conn: Connection) => void
//    - Optional callback for edge selection
//    - Used to show correlation details or delete connections
//
// 8. selectedNodeId?: string | null
//    - Highlights selected node with ring indicator
//    - Filters connections to show only relevant edges
//
// STATE MANAGEMENT:
//
// viewport: { x, y, zoom }
//   - Transforms world coordinates (node positions) to screen coordinates
//   - x, y: Pan offset in pixels
//   - zoom: Scale factor (0.1 = 10%, 3.0 = 300%)
//   - Applied to both canvas context and node container via CSS
//
// bounds: CanvasBounds
//   - Defines the rectangular workspace boundaries
//   - Clamped to default values if not provided
//   - Applied to node positions during drag operations
//
// isPanning: boolean
//   - Active while user is middle-click dragging or holding Space
//   - Changes cursor to grabbing hand
//   - Temporarily disables node interaction
//
// draggingNode: string | null
//   - ID of node currently being dragged
//   - Separated from isPanning to distinguish node drag from canvas pan
//   - Enables global mouse move handling (handles fast mouse movements)
//
// dragOffset: { x, y }
//   - Cursor offset from node center during drag (maintains grab point)
//   - Calculated in world coordinates, applied on each mouse move
//
// canvasSize: { width, height }
//   - Tracks container dimensions for responsive canvas sizing
//   - Updates on window resize
//   - Used for DPR (device pixel ratio) scaling for Retina displays
//
// mousePosition: { x, y } | null
//   - Current mouse position in world coordinates
//   - Converted from screen coordinates: world = (screen - viewportOffset) / zoom
//   - null when mouse is outside canvas bounds
//   - Displayed in coordinate overlay for user reference
//
// COORDINATE SYSTEMS:
//
// World Coordinates (Data):
//   - Node positions stored as [x, y] in arbitrary units
//   - Independent of screen resolution or zoom level
//   - Example: [100, 200] means 100 units right, 200 units down from origin
//   - Constrained by bounds.minX/maxX and bounds.minY/maxY
//
// Screen Coordinates (Display):
//   - Actual pixels on the monitor
//   - Calculated: screen = world * zoom + viewportOffset
//   - Used for DOM node positioning and mouse events
//
// Canvas Coordinates (Rendering):
//   - Matches screen coordinates but multiplied by DPR
//   - Ensures crisp lines on high-DPI displays
//   - Canvas API uses this, CSS uses screen coordinates
//
// INTERACTION HANDLERS:
//
// handleWheel (Zoom):
//   - Prevent default to stop page scrolling
//   - Calculate zoom factor (0.9 for out, 1.1 for in)
//   - Clamp zoom between 10% and 300%
//   - Zoom towards mouse pointer (not center) for better UX
//   - Formula: newOffset = mouse - (mouse - oldOffset) * (newZoom / oldZoom)
//
// handleMouseDown (Pan Start):
//   - Middle mouse button (button === 1) initiates canvas pan
//   - Space key + left click also initiates pan (not shown in snippet)
//   - Records dragOffset = mouse - viewport (to maintain relative position)
//
// handleMouseMove (Pan/Drag/Coordinates):
//   - If isPanning: Update viewport.x/y based on mouse movement
//   - If draggingNode: Calculate new world position and call onNodeMove
//   - Always: Update mousePosition with current world coordinates
//   - Uses requestAnimationFrame implicitly via React state updates
//   - Position clamped to bounds if bounds are defined
//
// handleMouseEnter:
//   - Initializes coordinate display when mouse enters canvas
//   - Converts initial position to world coordinates
//   - Enables coordinate overlay visibility
//
// handleMouseLeave:
//   - Hides coordinate display when mouse leaves canvas
//   - Sets mousePosition to null
//
// Global Window Events:
//   - Mouse move/up handlers attached to window during node drag
//   - Ensures drag continues even if cursor leaves canvas bounds
//   - Prevents "stuck" drag state when mouse released outside window
//   - Final position clamped to canvas bounds on mouseup
//
// RENDERING PIPELINE:
//
// 1. Setup Canvas:
//    - Resize to match container (accounting for DPR)
//    - Clear previous frame
//
// 2. Draw Grid (Background):
//    - Dynamic grid size: 50px * zoom
//    - Modulo arithmetic for infinite scrolling effect
//    - Low opacity gray for subtle appearance
//
// 3. Apply Transformations:
//    - ctx.translate(viewport.x, viewport.y)
//    - ctx.scale(viewport.zoom, viewport.zoom)
//    - All subsequent drawing uses world coordinates
//
// 4. Draw Connections:
//    - Look up source/target nodes via nodeMap (O(1) Map lookup)
//    - Calculate control points for bezier curves
//    - Style based on strength (width 1-4px, opacity 0.2-1.0)
//    - Add shadow blur for "glow" effect on strong connections
//    - Draw direction arrow at midpoint
//
// 5. Restore Context:
//    - Reset transformations for next frame
//
// 6. Render Nodes (React):
//    - Map nodes to NodeComponent
//    - Pass screen coordinates (calculated from viewport)
//    - Pass interaction handlers
//
// PERFORMANCE OPTIMIZATIONS:
//
// - Canvas uses requestAnimationFrame implicitly via React effect
// - DPR scaling ensures crisp rendering without excessive pixel processing
// - Grid calculated mathematically (no DOM elements)
// - Bezier curves hardware accelerated via Canvas API
// - Node dragging uses CSS transforms (GPU accelerated)
// - Only re-renders when nodes/connections/viewport change
// - Bounds clamping adds minimal overhead (simple math operations)
// - nodeMap (useMemo'd Map) provides O(1) node lookups for connection
//   rendering and drag handling, replacing prior O(n) find() calls
//
// MEMORY CONSIDERATIONS:
//
// - Canvas context reset between frames prevents state leakage
// - No off-screen canvases or double buffering needed (React handles)
// - Event listeners cleaned up on unmount
// - Bounds state stored in component (not duplicated)
//
// USAGE EXAMPLE:
// ```tsx
// <Canvas
//   nodes={store.nodes}
//   connections={store.connections}
//   bounds={{ minX: -5000, maxX: 5000, minY: -3000, maxY: 3000 }}
//   clampViewportToBounds={true}
//   onNodeClick={(node) => setSelectedNode(node)}
//   onNodeMove={(id, pos) => store.updateNodePosition(id, pos)}
//   selectedNodeId={selectedNode?.id}
// />
// ```
//
// FUTURE ENHANCEMENTS:
// - Mini-map for navigation with many nodes (50+)
// - Connection labels showing correlation coefficient
// - Animated data flow along connection lines
// - Lasso selection for multi-node operations
// - Touch gesture support for tablets (pinch zoom, two-finger pan)
// - WebGL rendering for 500+ nodes (switch from Canvas 2D)
// - Snap-to-grid alignment assistance
// - Connection routing around obstacles (force-directed)
// - Dynamic bounds (expand as nodes are added near edges)
// - Bounds visualization (show boundary lines on canvas)
//
// DEPENDENCIES:
// - React (hooks: useState, useEffect, useRef, useCallback, useMemo)
// - NodeComponent (child component for individual nodes)
// - ../../types/nodes (TypeScript interfaces)
// - CSS transforms for GPU acceleration
//
// STYLING NOTES:
// - Container: Full size of parent, overflow hidden, dark background
// - Canvas: Pointer-events none (lets clicks pass to nodes)
// - Cursor: Crosshair default, grabbing during pan, grab on node hover
// - Bounds: Visual indicators could be added (dashed border at boundaries)
// - Coordinate Display: Top-left overlay showing X/Y in world units
// ============================================================================

import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import type { Node } from "../../types/nodes";
import NodeComponent from "./Node";

export interface Connection {
  source: string;
  target: string;
  strength: number;
}

export interface CanvasBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasProps {
  nodes: Node[];
  connections: Connection[];
  bounds?: CanvasBounds;
  clampViewportToBounds?: boolean;
  viewport: Viewport;
  selectedNodeId: string | null;
  onNodeClick: (node: Node) => void;
  onNodeMove: (id: string, position: [number, number]) => void;
  onNodeDelete: (id: string) => void;
  onBackgroundClick: () => void;
  onViewportChange: (viewport: Viewport) => void;
  /** Callback to open orderbook overlay for market nodes */
  onOpenOrderbook?: (marketId: string, platform: 'polymarket' | 'kalshi', marketQuestion?: string) => void;
  /** Callback to resize a node */
  onNodeResize?: (id: string, size: { width: number; height: number | null }) => void;
  /** Connection mode state */
  connectionMode?: boolean;
  /** Callback when a new connection is created */
  onCreateConnection?: (sourceId: string, targetId: string) => void;
  /** Callback when a connection is deleted */
  onConnectionDelete?: (source: string, target: string) => void;
}

export default function Canvas({
  nodes,
  connections,
  bounds,
  clampViewportToBounds = true,
  viewport,
  selectedNodeId,
  onNodeClick,
  onNodeMove,
  onNodeDelete,
  onBackgroundClick,
  onViewportChange,
  onOpenOrderbook,
  onNodeResize,
  connectionMode = false,
  onCreateConnection,
  onConnectionDelete,
}: CanvasProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const didPanRef = useRef(false);
  const [mousePosition, setMousePosition] = useState<{ x: number; y: number } | null>(null);
  
  // Connection mode state
  const [connectionSource, setConnectionSource] = useState<string | null>(null);
  // Hovered connection for delete button
  const [hoveredConnection, setHoveredConnection] = useState<Connection | null>(null);

  // Default bounds if not provided (large canvas area)
  const defaultBounds: CanvasBounds = {
    minX: -10000,
    maxX: 10000,
    minY: -10000,
    maxY: 10000,
  };

  // Use provided bounds or default
  const effectiveBounds = bounds ?? defaultBounds;

  // Helper function to clamp position within bounds
  const clampToBounds = useCallback(
    (x: number, y: number): [number, number] => {
      return [
        Math.max(effectiveBounds.minX, Math.min(effectiveBounds.maxX, x)),
        Math.max(effectiveBounds.minY, Math.min(effectiveBounds.maxY, y)),
      ];
    },
    [effectiveBounds]
  );

  // Calculate visible nodes based on viewport (culling optimization)
  const visibleNodes = useMemo(() => {
    // Always return all nodes when canvas size is 0 to ensure initial render
    if (canvasSize.width === 0 || canvasSize.height === 0 || !nodes.length) {
      return nodes.filter((node) => node?.id); // Filter out nodes without id
    }
    
    // Add padding to ensure nodes near edges are not prematurely hidden
    const padding = 100;
    const minX = Math.max(effectiveBounds.minX, -viewport.x / viewport.zoom - padding);
    const maxX = Math.min(effectiveBounds.maxX, (canvasSize.width - viewport.x) / viewport.zoom + padding);
    const minY = Math.max(effectiveBounds.minY, -viewport.y / viewport.zoom - padding);
    const maxY = Math.min(effectiveBounds.maxY, (canvasSize.height - viewport.y) / viewport.zoom + padding);
    
    return nodes.filter((node) => {
      // Skip nodes without valid id (React key requirement)
      if (!node?.id) {
        return false;
      }
      // Ensure node has valid position
      if (!node.position || !Array.isArray(node.position) || node.position.length < 2) {
        return true; // Include nodes without position (will use default)
      }
      const [x, y] = node.position;
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    });
  }, [nodes, viewport, canvasSize, effectiveBounds]);

  // O(1) node lookup map — eliminates O(n) find() in connection rendering & drag handling
  const nodeMap = useMemo(() => {
    const map = new Map<string, (typeof nodes)[number]>();
    for (const node of nodes) {
      if (node?.id) map.set(node.id, node);
    }
    return map;
  }, [nodes]);
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        setCanvasSize({ width, height });
      }
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, []);

  // Draw grid and connections on canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Handle high-DPI displays
    const dpr = window.devicePixelRatio || 1;
    canvas.width = canvasSize.width * dpr;
    canvas.height = canvasSize.height * dpr;
    canvas.style.width = `${canvasSize.width}px`;
    canvas.style.height = `${canvasSize.height}px`;
    ctx.scale(dpr, dpr);

    // Clear canvas
    ctx.clearRect(0, 0, canvasSize.width, canvasSize.height);

    // Draw grid
    const gridSize = 50 * viewport.zoom;
    const gridOffsetX = viewport.x % gridSize;
    const gridOffsetY = viewport.y % gridSize;

    ctx.strokeStyle = "rgba(75, 85, 99, 0.3)";
    ctx.lineWidth = 1;

    // Vertical grid lines
    for (let x = gridOffsetX; x < canvasSize.width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvasSize.height);
      ctx.stroke();
    }

    // Horizontal grid lines
    for (let y = gridOffsetY; y < canvasSize.height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(canvasSize.width, y);
      ctx.stroke();
    }

    // Draw connections
    ctx.save();
    ctx.translate(viewport.x, viewport.y);
    ctx.scale(viewport.zoom, viewport.zoom);

    connections.forEach((conn) => {
      const sourceNode = nodeMap.get(conn.source);
      const targetNode = nodeMap.get(conn.target);

      if (!sourceNode || !targetNode) return;

      const [x1, y1] = sourceNode.position;
      const [x2, y2] = targetNode.position;

      // Calculate control points for bezier curve
      const midX = (x1 + x2) / 2;
      const cp1x = midX;
      const cp1y = y1;
      const cp2x = midX;
      const cp2y = y2;

      // Draw connection line
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x2, y2);

      // Style based on strength
      const opacity = Math.max(0.2, conn.strength);
      const lineWidth = 1 + conn.strength * 3;
      ctx.strokeStyle = `rgba(59, 130, 246, ${opacity})`;
      ctx.lineWidth = lineWidth;
      ctx.stroke();

      // Draw arrow at midpoint
      const t = 0.5;
      const arrowX = (1 - t) * (1 - t) * (1 - t) * x1 +
        3 * (1 - t) * (1 - t) * t * cp1x +
        3 * (1 - t) * t * t * cp2x +
        t * t * t * x2;
      const arrowY = (1 - t) * (1 - t) * (1 - t) * y1 +
        3 * (1 - t) * (1 - t) * t * cp1y +
        3 * (1 - t) * t * t * cp2y +
        t * t * t * y2;

      // Calculate angle for arrow
      const dx = x2 - x1;
      const dy = y2 - y1;
      const angle = Math.atan2(dy, dx);

      ctx.save();
      ctx.translate(arrowX, arrowY);
      ctx.rotate(angle);
      ctx.fillStyle = `rgba(59, 130, 246, ${opacity})`;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-8, -4);
      ctx.lineTo(-8, 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    });

    ctx.restore();
  }, [nodes, connections, viewport, canvasSize]);

  // Calculate zoom limits based on canvas size and bounds
  const zoomLimits = useMemo(() => {
    if (canvasSize.width === 0 || canvasSize.height === 0) {
      return { minZoom: 0.1, maxZoom: 3 };
    }
    
    // Calculate the minimum zoom needed to fit the entire bounds in view
    const boundsWidth = effectiveBounds.maxX - effectiveBounds.minX;
    const boundsHeight = effectiveBounds.maxY - effectiveBounds.minY;
    
    // Add some padding (10%) so bounds aren't flush with edges
    const minZoomX = canvasSize.width / boundsWidth / 1.1;
    const minZoomY = canvasSize.height / boundsHeight / 1.1;
    
    // Minimum zoom should fit the larger dimension, with a reasonable minimum
    const minZoom = Math.max(0.05, Math.min(minZoomX, minZoomY));
    
    // Maximum zoom prevents losing context (300% is reasonable)
    const maxZoom = 3;
    
    return { minZoom, maxZoom };
  }, [canvasSize, effectiveBounds]);

  // Handle wheel for zoom
  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(zoomLimits.minZoom, Math.min(zoomLimits.maxZoom, viewport.zoom * zoomFactor));

      // Zoom towards mouse pointer
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const newX = mouseX - (mouseX - viewport.x) * (newZoom / viewport.zoom);
      const newY = mouseY - (mouseY - viewport.y) * (newZoom / viewport.zoom);

      // Clamp viewport position to bounds after zoom
      let clampedX = newX;
      let clampedY = newY;
      if (clampViewportToBounds && canvasSize.width > 0 && canvasSize.height > 0) {
        const minViewportX = canvasSize.width - effectiveBounds.maxX * newZoom;
        const maxViewportX = -effectiveBounds.minX * newZoom;
        clampedX = Math.max(minViewportX, Math.min(maxViewportX, newX));
        
        const minViewportY = canvasSize.height - effectiveBounds.maxY * newZoom;
        const maxViewportY = -effectiveBounds.minY * newZoom;
        clampedY = Math.max(minViewportY, Math.min(maxViewportY, newY));
      }

      onViewportChange({ x: clampedX, y: clampedY, zoom: newZoom });
    },
    [viewport, onViewportChange, zoomLimits, clampViewportToBounds, canvasSize, effectiveBounds]
  );

  // Attach wheel event listener with passive: false to allow preventDefault
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener("wheel", handleWheel, { passive: false });

    return () => {
      container.removeEventListener("wheel", handleWheel);
    };
  }, [handleWheel]);

  // Handle mouse down for pan or node drag
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Left click (button 0) or middle mouse (button 1) for pan
      if (e.button === 0 || e.button === 1) {
        didPanRef.current = false;
        setIsPanning(true);
        setDragOffset({
          x: e.clientX - viewport.x,
          y: e.clientY - viewport.y,
        });
      }
    },
    [viewport]
  );

  // Handle mouse move for pan or drag
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      // Update mouse position for coordinate display
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        // Convert screen coordinates to world coordinates
        const worldX = Math.round((screenX - viewport.x) / viewport.zoom);
        const worldY = Math.round((screenY - viewport.y) / viewport.zoom);
        setMousePosition({ x: worldX, y: worldY });

        // Find hovered connection (near midpoint)
        const hoverThreshold = 30 / viewport.zoom; // 30px threshold in screen space
        let nearestConn: Connection | null = null;
        let nearestDist = Infinity;

        for (const conn of connections) {
          const sourceNode = nodeMap.get(conn.source);
          const targetNode = nodeMap.get(conn.target);
          if (!sourceNode || !targetNode) continue;

          const [x1, y1] = sourceNode.position;
          const [x2, y2] = targetNode.position;
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;

          const dist = Math.sqrt((worldX - midX) ** 2 + (worldY - midY) ** 2);
          if (dist < hoverThreshold && dist < nearestDist) {
            nearestDist = dist;
            nearestConn = conn;
          }
        }
        setHoveredConnection(nearestConn);
      }

      if (isPanning) {
        didPanRef.current = true;
        
        let newX = e.clientX - dragOffset.x;
        let newY = e.clientY - dragOffset.y;
        
        // Optionally clamp viewport to bounds
        if (clampViewportToBounds && canvasSize.width > 0 && canvasSize.height > 0) {
          // Clamp X: viewport can show from bounds.minX to bounds.maxX
          const minViewportX = canvasSize.width - effectiveBounds.maxX * viewport.zoom;
          const maxViewportX = -effectiveBounds.minX * viewport.zoom;
          newX = Math.max(minViewportX, Math.min(maxViewportX, newX));
          
          // Clamp Y: viewport can show from bounds.minY to bounds.maxY
          const minViewportY = canvasSize.height - effectiveBounds.maxY * viewport.zoom;
          const maxViewportY = -effectiveBounds.minY * viewport.zoom;
          newY = Math.max(minViewportY, Math.min(maxViewportY, newY));
        }
        
        onViewportChange({
          x: newX,
          y: newY,
          zoom: viewport.zoom,
        });
      }
    },
    [isPanning, dragOffset, viewport.zoom, onViewportChange, clampViewportToBounds, canvasSize, effectiveBounds, nodeMap, connections]
  );

  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    setDraggingNode(null);
  }, []);

  // Handle mouse leave - hide coordinates
  const handleMouseLeave = useCallback(() => {
    setMousePosition(null);
    setHoveredConnection(null);
  }, []);

  // Handle mouse enter - initialize coordinates
  const handleMouseEnter = useCallback(
    (e: React.MouseEvent) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;
        const worldX = Math.round((screenX - viewport.x) / viewport.zoom);
        const worldY = Math.round((screenY - viewport.y) / viewport.zoom);
        setMousePosition({ x: worldX, y: worldY });
      }
    },
    [viewport]
  );

  // Handle click - prevent background click if we were panning, cancel connection mode
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Cancel connection mode when clicking on background
      if (connectionSource) {
        setConnectionSource(null);
        return;
      }
      
      if (didPanRef.current) {
        e.preventDefault();
        e.stopPropagation();
        didPanRef.current = false;
        return;
      }
      onBackgroundClick();
    },
    [onBackgroundClick, connectionSource]
  );

  // Handle node drag start
  const handleNodeDragStart = useCallback(
    (nodeId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setDraggingNode(nodeId);

      const node = nodeMap.get(nodeId);
      if (!node) return;

      // Calculate drag offset in world coordinates
      const worldX = (e.clientX - viewport.x) / viewport.zoom;
      const worldY = (e.clientY - viewport.y) / viewport.zoom;

      setDragOffset({
        x: worldX - node.position[0],
        y: worldY - node.position[1],
      });
    },
    [nodeMap, viewport]
  );

  // Handle global mouse move for node dragging
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (draggingNode) {
        const rawX = (e.clientX - viewport.x) / viewport.zoom - dragOffset.x;
        const rawY = (e.clientY - viewport.y) / viewport.zoom - dragOffset.y;
        
        // Clamp position to bounds
        const [clampedX, clampedY] = clampToBounds(rawX, rawY);
        onNodeMove(draggingNode, [clampedX, clampedY]);
      }
    };

    const handleGlobalMouseUp = () => {
      setDraggingNode(null);
    };

    if (draggingNode) {
      window.addEventListener("mousemove", handleGlobalMouseMove);
      window.addEventListener("mouseup", handleGlobalMouseUp);
    }

    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [draggingNode, viewport, dragOffset, onNodeMove, clampToBounds]);

  // Handle keyboard delete for selected node and Escape for connection mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape key - cancel connection mode
      if (e.key === 'Escape' && connectionSource) {
        setConnectionSource(null);
        return;
      }
      
      // Delete or Backspace key
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNodeId) {
        // Prevent default browser behavior (like going back in history)
        e.preventDefault();
        // Only delete if we're not editing an input field
        const activeElement = document.activeElement;
        const isEditing = activeElement && (
          activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA' ||
          (activeElement as HTMLElement).isContentEditable
        );
        if (!isEditing) {
          onNodeDelete(selectedNodeId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNodeId, onNodeDelete, connectionSource]);

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 overflow-hidden bg-gray-950 ${
        isPanning ? "cursor-grabbing" : "cursor-crosshair"
      }`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Canvas for grid and connections */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
      />

      {/* Node layer - positions handled individually by each NodeComponent */}
      <div className="absolute inset-0 pointer-events-none z-10">
        {visibleNodes.map((node) => {
          // Determine if this node is highlighted for connection mode
          const isConnectionSource = connectionMode && connectionSource === node.id;
          const isValidTarget = !!(connectionMode && connectionSource && connectionSource !== node.id);
          
          return (
            <NodeComponent
              key={node.id}
              node={node}
              viewport={viewport}
              isSelected={selectedNodeId === node.id}
              isDragging={draggingNode === node.id}
              isConnectionSource={isConnectionSource}
              isValidConnectionTarget={isValidTarget}
              onClick={() => {
                if (connectionMode) {
                  // Connection mode: handle connection creation
                  if (!connectionSource) {
                    // First click: set source node
                    setConnectionSource(node.id);
                  } else if (connectionSource !== node.id) {
                    // Second click: create connection
                    onCreateConnection?.(connectionSource, node.id);
                    // Reset connection mode
                    setConnectionSource(null);
                  }
                } else {
                  // Normal mode: select node
                  onNodeClick(node);
                }
              }}
              onMouseDown={(e) => handleNodeDragStart(node.id, e)}
              onDelete={() => onNodeDelete(node.id)}
              onOpenOrderbook={onOpenOrderbook}
              onResize={onNodeResize ? (id, size) => onNodeResize(id, size) : undefined}
            />
          );
        })}
      </div>

      {/* Connection delete button */}
      {hoveredConnection && (() => {
        const sourceNode = nodeMap.get(hoveredConnection.source);
        const targetNode = nodeMap.get(hoveredConnection.target);
        if (!sourceNode || !targetNode) return null;

        const [x1, y1] = sourceNode.position;
        const [x2, y2] = targetNode.position;
        const midX = (x1 + x2) / 2;
        const midY = (y1 + y2) / 2;

        const screenX = midX * viewport.zoom + viewport.x;
        const screenY = midY * viewport.zoom + viewport.y;

        return (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onConnectionDelete?.(hoveredConnection.source, hoveredConnection.target);
              setHoveredConnection(null);
            }}
            className="absolute w-6 h-6 bg-red-600 hover:bg-red-500 rounded-full flex items-center justify-center text-white text-sm font-bold shadow-lg z-20 transition-transform hover:scale-110"
            style={{
              left: screenX - 12,
              top: screenY - 12,
            }}
          >
            ×
          </button>
        );
      })()}

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-2">
        <button
          onClick={() => {
            const newZoom = Math.min(zoomLimits.maxZoom, viewport.zoom * 1.2);
            // Clamp viewport position to bounds after zoom
            let clampedX = viewport.x;
            let clampedY = viewport.y;
            if (clampViewportToBounds && canvasSize.width > 0 && canvasSize.height > 0) {
              const minViewportX = canvasSize.width - effectiveBounds.maxX * newZoom;
              const maxViewportX = -effectiveBounds.minX * newZoom;
              clampedX = Math.max(minViewportX, Math.min(maxViewportX, viewport.x));
              
              const minViewportY = canvasSize.height - effectiveBounds.maxY * newZoom;
              const maxViewportY = -effectiveBounds.minY * newZoom;
              clampedY = Math.max(minViewportY, Math.min(maxViewportY, viewport.y));
            }
            onViewportChange({ x: clampedX, y: clampedY, zoom: newZoom });
          }}
          className="w-10 h-10 bg-gray-800 hover:bg-gray-700 rounded-lg flex items-center justify-center text-gray-300 shadow-lg"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
        </button>
        <button
          onClick={() => {
            const newZoom = Math.max(zoomLimits.minZoom, viewport.zoom / 1.2);
            // Clamp viewport position to bounds after zoom
            let clampedX = viewport.x;
            let clampedY = viewport.y;
            if (clampViewportToBounds && canvasSize.width > 0 && canvasSize.height > 0) {
              const minViewportX = canvasSize.width - effectiveBounds.maxX * newZoom;
              const maxViewportX = -effectiveBounds.minX * newZoom;
              clampedX = Math.max(minViewportX, Math.min(maxViewportX, viewport.x));
              
              const minViewportY = canvasSize.height - effectiveBounds.maxY * newZoom;
              const maxViewportY = -effectiveBounds.minY * newZoom;
              clampedY = Math.max(minViewportY, Math.min(maxViewportY, viewport.y));
            }
            onViewportChange({ x: clampedX, y: clampedY, zoom: newZoom });
          }}
          className="w-10 h-10 bg-gray-800 hover:bg-gray-700 rounded-lg flex items-center justify-center text-gray-300 shadow-lg"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
        <div className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center text-gray-400 text-xs font-medium shadow-lg">
          {Math.round(viewport.zoom * 100)}%
        </div>
      </div>

      {/* Coordinate display */}
      {mousePosition && (
        <div className="absolute top-4 left-4 flex gap-4 bg-gray-900/90 backdrop-blur-sm px-3 py-2 rounded-lg shadow-lg border border-gray-700">
          <div className="flex items-center gap-2">
            <span className="text-gray-400 text-xs">X:</span>
            <span className="text-cyan-400 font-mono text-sm font-medium">
              {mousePosition.x}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-400 text-xs">Y:</span>
            <span className="text-cyan-400 font-mono text-sm font-medium">
              {mousePosition.y}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
