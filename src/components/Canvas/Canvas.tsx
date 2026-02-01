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

import { Node } from "../../types/nodes";

interface NodeComponentProps {
  node: Node;
  viewport: { x: number; y: number; zoom: number };
  isSelected: boolean;
  isDragging: boolean;
  onClick: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
}

export default function NodeComponent({ 
  node, 
  viewport, 
  isSelected, 
  isDragging,
  onClick, 
  onMouseDown 
}: NodeComponentProps) {
  // Transform position based on viewport
  const screenX = node.position[0] * viewport.zoom + viewport.x;
  const screenY = node.position[1] * viewport.zoom + viewport.y;

  // Determine node style based on type
  const isInfoSource = 'InfoSource' in node.node_type;
  const baseColor = isInfoSource ? "bg-blue-500" : "bg-emerald-500";
  const glowColor = isInfoSource ? "shadow-blue-500/50" : "shadow-emerald-500/50";

  return (
    <div
      className={`
        absolute transform -translate-x-1/2 -translate-y-1/2 
        w-12 h-12 rounded-full ${baseColor} 
        border-2 ${isSelected ? "border-yellow-400" : "border-white/20"}
        ${isDragging ? "cursor-grabbing" : "cursor-grab"}
        ${isDragging ? "scale-110" : "hover:scale-105"}
        transition-transform duration-150
        shadow-lg ${glowColor}
        flex items-center justify-center
        select-none z-10
      `}
      style={{
        left: screenX,
        top: screenY,
      }}
      onClick={onClick}
      onMouseDown={onMouseDown}
    >
      {/* Node Icon/Label */}
      <span className="text-white text-xs font-bold">
        {isInfoSource ? "I" : "M"}
      </span>
      
      {/* Selection indicator ring */}
      {isSelected && (
        <div className="absolute inset-0 rounded-full border-2 border-yellow-400 animate-ping opacity-20" />
      )}
      
      {/* Connection ports (visual only) */}
      <div className="absolute -right-1 top-1/2 w-2 h-2 bg-white rounded-full transform -translate-y-1/2" />
      <div className="absolute -left-1 top-1/2 w-2 h-2 bg-white rounded-full transform -translate-y-1/2" />
    </div>
  );
}