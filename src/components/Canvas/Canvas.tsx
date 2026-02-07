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
// 3. onNodeClick: (node: Node) => void
//    - Callback when user clicks a node (selection)
//    - Triggers right sidebar detail panel via App.tsx
//
// 4. onNodeMove: (id: string, position: [number, number]) => void
//    - Callback during node drag operations
//    - Updates node position in global state (Zustand store)
//    - Triggers connection redraw (canvas re-render)
//
// 5. onConnectionClick?: (conn: Connection) => void
//    - Optional callback for edge selection
//    - Used to show correlation details or delete connections
//
// 6. selectedNodeId?: string | null
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
// COORDINATE SYSTEMS:
//
// World Coordinates (Data):
//   - Node positions stored as [x, y] in arbitrary units
//   - Independent of screen resolution or zoom level
//   - Example: [100, 200] means 100 units right, 200 units down from origin
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
// handleMouseMove (Pan/Drag):
//   - If isPanning: Update viewport.x/y based on mouse movement
//   - If draggingNode: Calculate new world position and call onNodeMove
//   - Uses requestAnimationFrame implicitly via React state updates
//
// Global Window Events:
//   - Mouse move/up handlers attached to window during node drag
//   - Ensures drag continues even if cursor leaves canvas bounds
//   - Prevents "stuck" drag state when mouse released outside window
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
//    - Find source/target nodes by ID
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
//
// MEMORY CONSIDERATIONS:
//
// - Canvas context reset between frames prevents state leakage
// - No off-screen canvases or double buffering needed (React handles)
// - Event listeners cleaned up on unmount
//
// USAGE EXAMPLE:
// ```tsx
// <Canvas
//   nodes={store.nodes}
//   connections={store.connections}
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
//
// DEPENDENCIES:
// - React (hooks: useState, useEffect, useRef, useCallback)
// - NodeComponent (child component for individual nodes)
// - ../../types/nodes (TypeScript interfaces)
// - CSS transforms for GPU acceleration
//
// STYLING NOTES:
// - Container: Full size of parent, overflow hidden, dark background
// - Canvas: Pointer-events none (lets clicks pass to nodes)
// - Cursor: Crosshair default, grabbing during pan, grab on node hover
// ============================================================================

import { useState, useEffect, useRef, useCallback, type ReactNode } from "react";
import type { Node } from "../../types/nodes";
import NodeComponent from "./Node";

export interface Connection {
  source: string;
  target: string;
  strength: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasProps {
  nodes: Node[];
  connections: Connection[];
  viewport: Viewport;
  selectedNodeId: string | null;
  onNodeClick: (node: Node) => void;
  onNodeMove: (id: string, position: [number, number]) => void;
  onBackgroundClick: () => void;
  onViewportChange: (viewport: Viewport) => void;
}

export default function Canvas({
  nodes,
  connections,
  viewport,
  selectedNodeId,
  onNodeClick,
  onNodeMove,
  onBackgroundClick,
  onViewportChange,
}: CanvasProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  // Track canvas size for responsive rendering
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
      const sourceNode = nodes.find((n) => n.id === conn.source);
      const targetNode = nodes.find((n) => n.id === conn.target);

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

  // Handle wheel for zoom
  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      const newZoom = Math.max(0.1, Math.min(3, viewport.zoom * zoomFactor));

      // Zoom towards mouse pointer
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const newX = mouseX - (mouseX - viewport.x) * (newZoom / viewport.zoom);
      const newY = mouseY - (mouseY - viewport.y) * (newZoom / viewport.zoom);

      onViewportChange({ x: newX, y: newY, zoom: newZoom });
    },
    [viewport, onViewportChange]
  );

  // Handle mouse down for pan or node drag
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Middle mouse button for pan
      if (e.button === 1) {
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
      if (isPanning) {
        onViewportChange({
          x: e.clientX - dragOffset.x,
          y: e.clientY - dragOffset.y,
          zoom: viewport.zoom,
        });
      }
    },
    [isPanning, dragOffset, viewport.zoom, onViewportChange]
  );

  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
    setDraggingNode(null);
  }, []);

  // Handle node drag start
  const handleNodeDragStart = useCallback(
    (nodeId: string, e: React.MouseEvent) => {
      e.stopPropagation();
      setDraggingNode(nodeId);

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;

      // Calculate drag offset in world coordinates
      const worldX = (e.clientX - viewport.x) / viewport.zoom;
      const worldY = (e.clientY - viewport.y) / viewport.zoom;

      setDragOffset({
        x: worldX - node.position[0],
        y: worldY - node.position[1],
      });
    },
    [nodes, viewport]
  );

  // Handle global mouse move for node dragging
  useEffect(() => {
    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (draggingNode) {
        const worldX = (e.clientX - viewport.x) / viewport.zoom - dragOffset.x;
        const worldY = (e.clientY - viewport.y) / viewport.zoom - dragOffset.y;
        onNodeMove(draggingNode, [worldX, worldY]);
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
  }, [draggingNode, viewport, dragOffset, onNodeMove]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden bg-gray-950 cursor-crosshair"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onClick={onBackgroundClick}
    >
      {/* Canvas for grid and connections */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
      />

      {/* Node layer */}
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
          transformOrigin: "0 0",
        }}
      >
        {nodes.map((node) => (
          <NodeComponent
            key={node.id}
            node={node}
            viewport={viewport}
            isSelected={selectedNodeId === node.id}
            isDragging={draggingNode === node.id}
            onClick={() => onNodeClick(node)}
            onMouseDown={(e) => handleNodeDragStart(node.id, e)}
          />
        ))}
      </div>

      {/* Zoom controls */}
      <div className="absolute bottom-4 right-4 flex flex-col gap-2">
        <button
          onClick={() =>
            onViewportChange({
              ...viewport,
              zoom: Math.min(3, viewport.zoom * 1.2),
            })
          }
          className="w-10 h-10 bg-gray-800 hover:bg-gray-700 rounded-lg flex items-center justify-center text-gray-300 shadow-lg"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
          </svg>
        </button>
        <button
          onClick={() =>
            onViewportChange({
              ...viewport,
              zoom: Math.max(0.1, viewport.zoom / 1.2),
            })
          }
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
    </div>
  );
}
