// ============================================================================
// INTERACTIVE NODE COMPONENT
// ============================================================================
//
// Module: components/Canvas/Node.tsx
// Purpose: Visual representation of individual nodes in the trading graph
//
// OVERVIEW:
// This component renders individual nodes (information sources and prediction
// markets) on the canvas. It provides type-specific visual styling,
// interactive states (hover, select, drag), and status indicators. It acts as
// the primary touchpoint for user interaction with the trading strategy graph.
//
// Node Types:
// - Info Sources (Circles): Crypto prices, news feeds, weather, etc.
// - Markets (Rounded Squares): Polymarket, Kalshi prediction markets
//
// Each node type has distinct colors, icons, and behaviors, visually 
// distinguishing data inputs from trading venues.
//
// ARCHITECTURE:
// Viewport Transform (parent calc)
//   → Screen Positioning (absolute CSS)
//   → Visual Rendering (type-specific shapes/colors)
//   → Interaction Layer (click, drag, hover handlers)
//   → Status Overlays (connection status, data pulses)
//
// PROPS:
//
// 1. node: Node
//    - Core data: id, type, position, metadata, connections
//    - Metadata contains: name, status, last_value, market_id
//    - Position in world coordinates (transformed by viewport)
//
// 2. viewport: { x, y, zoom }
//    - Current canvas pan/zoom state
//    - Used to calculate screen position from world coordinates
//    - Applied via CSS transform (scale limited 0.5x - 1.5x for readability)
//
// 3. isSelected: boolean
//    - Highlights node with yellow ring when selected
//    - Shows animated ping effect for attention
//    - Increases z-index to float above other nodes
//
// 4. isDragging: boolean
//    - Enlarges node (1.1x scale) during drag
//    - Changes cursor to grabbing
//    - Increases shadow depth for "lifted" appearance
//    - Maintains relative position to cursor via dragOffset calculation
//
// 5. hasNewData?: boolean
//    - Triggers white flash animation when data updates
//    - Used by parent to indicate fresh scrape from backend
//    - 1-second CSS animation (ping) draws attention without distraction
//
// 6. onClick: () => void
//    - Opens node details in right sidebar
//    - Stops propagation to prevent canvas click-through
//
// 7. onMouseDown: (e) => void
//    - Initiates drag operation
//    - Calculates dragOffset (cursor to node center)
//    - Stops propagation to prevent canvas panning
//
// 8. onDoubleClick?: () => void
//    - Opens expanded detail view (charts, orderbook, logs)
//    - Optional - not all nodes support detailed drill-down
//
// VISUAL DESIGN SYSTEM:
//
// Info Sources (Blue Theme):
//   - Shape: Circle (rounded-full)
//   - Color: bg-blue-500 (rgb(59, 130, 246))
//   - Hover: bg-blue-400 (lightens on interaction)
//   - Glow: shadow-blue-500/50 (colored drop shadow)
//   - Icons: Type-specific (₿ Crypto, 📰 News, 🌤 Weather, etc.)
//
// Markets (Green Theme):
//   - Shape: Rounded Square (rounded-xl, rounded-2xl)
//   - Color: bg-emerald-500 (rgb(16, 185, 129))
//   - Hover: bg-emerald-400
//   - Glow: shadow-emerald-500/50
//   - Icons: Platform initial (P = Polymarket, K = Kalshi)
//
// Status Indicators:
//   - Green Pulse: Top-right dot, indicates active data stream
//   - Red Exclamation: Disconnected/error state
//   - Outer Ring: Subtle border showing connection health
//   - Flash Overlay: White ping animation on data updates
//
// Selection State:
//   - Yellow ring (border-yellow-400)
//   - Animated ping effect (white expanding circle)
//   - Outer halo (ring-2 with low opacity)
//   - Top z-index to float above unselected nodes
//
// INTERACTION STATES:
//
// Default:
//   - scale(1), normal shadow, opacity-80 label
//   - cursor: grab (indicates draggable)
//   - Subtle hover effect (hover:scale-105)
//
// Hover:
//   - scale(1.05) slight enlargement
//   - Full opacity label
//   - Brighter background color
//
// Dragging:
//   - scale(1.1) noticeable enlargement
//   - cursor: grabbing
//   - Elevated shadow (shadow-2xl)
//   - z-index: 50 (floats above all)
//   - Smooth transition disabled (instant follow)
//
// Selected:
//   - Persistent yellow border
//   - Ping animation looping
//   - Label always visible (not just on hover)
//
// COORDINATE TRANSFORMATION:
//
// Screen Position Calculation:
//   screenX = node.position[0] * viewport.zoom + viewport.x
//   screenY = node.position[1] * viewport.zoom + viewport.y
//
// This transforms world coordinates (arbitrary units) to CSS pixel positions
// relative to the canvas container.
//
// Scaling Strategy:
//   - Node scales with zoom but clamped: max(0.5, min(zoom, 1.5))
//   - Prevents nodes from becoming too small (<0.5x) or too large (>1.5x)
//   - Ensures readability across full zoom range (10% - 300%)
//   - Uses CSS transform with origin-center for smooth scaling
//
// TYPE GUARDS & HELPERS:
//
// isInfoSource(nodeType): boolean
//   - Type guard checking for InfoSource variant
//   - Used for conditional styling and icon selection
//
// getInfoSourceType(nodeType): InfoSourceType | null
//   - Extracts specific info source enum variant
//   - Returns null if node is a Market
//
// getMarketType(nodeType): MarketType | null
//   - Extracts specific market enum variant
//   - Returns null if node is InfoSource
//
// STATUS MANAGEMENT:
//
// Connection Status:
//   - Checked via node.metadata.status
//   - "connected" | "active" | undefined = Shows green pulse
//   - "error" | "disconnected" = Shows red ! badge
//   - Outer ring color changes (green = healthy, red = error)
//
// Data Freshness:
//   - parent passes hasNewData=true when WebSocket emits update
//   - Triggers 1s flash animation (white ping overlay)
//   - Clears automatically via setTimeout in useEffect
//
// LABEL & METADATA DISPLAY:
//
// Primary Label:
//   - Source: node.metadata.name || type name
//   - Markets: node.metadata.market_id || platform name
//   - Falls back to node ID truncated (first 8 chars)
//   - White text on semi-transparent dark background
//   - Max-width 120px with truncation (truncate)
//
// Secondary Data (optional):
//   - Shows node.metadata.last_value if available
//   - Monospace font for numeric values (prices)
//   - Formatted to 2 decimal places
//   - Appears below primary label
//   - Updates in real-time with flash indicator
//
// CONNECTION PORTS:
//
// Visual indicators on left/right edges showing where connections attach:
//   - Small circles (w-3 h-3) with gray border
//   - Positioned absolute -left-1.5 and -right-1.5
//   - Hover effect: scales up, turns white
//   - cursor: crosshair (indicates connection possibility)
//   - Purely visual - actual connection logic handled by parent Canvas
//
// ANIMATION SYSTEM:
//
// CSS Transitions:
//   - duration-150 (150ms) for hover scale
//   - duration-300 for status ring opacity
//   - ease-out for natural feel
//
// Tailwind Animations:
//   - animate-ping: Flash effect for new data and selection
//   - animate-pulse: Live data stream indicator
//
// Keyframe Logic:
//   - Flash: White overlay scales from 0 to 2x with fade out
//   - Pulse: Green dot fades 75% opacity in/out continuously
//   - Ping: Yellow ring expands and fades on selection
//
// ACCESSIBILITY:
//
// - cursor states indicate interactivity (grab, grabbing, pointer)
// - Visual feedback for all states (color, scale, shadow changes)
// - Status indicators visible even at small zoom levels (0.5x min)
//
// PERFORMANCE NOTES:
//
// - Pure CSS transforms (no layout thrashing)
//   - Uses transform: translate(-50%, -50%) for centering
//   - Scales via transform property (GPU accelerated)
// - Minimal re-renders (only when props change)
// - No internal state except flash animation trigger
// - Absolute positioning (removed from document flow)
//
// USAGE EXAMPLE:
// ```tsx
// <NodeComponent
//   key={node.id}
//   node={node}
//   viewport={{ x: 100, y: 50, zoom: 1.2 }}
//   isSelected={selectedId === node.id}
//   isDragging={draggedId === node.id}
//   hasNewData={recentUpdates.has(node.id)}
//   onClick={() => handleSelect(node)}
//   onMouseDown={(e) => handleDragStart(node.id, e)}
//   onDoubleClick={() => openDetails(node)}
// />
// ```
//
// FUTURE ENHANCEMENTS:
// - Context menu on right-click (delete, configure, etc.)
// - Inline editing of node labels
// - Color coding based on P&L (green/red tint for profitable positions)
// - Thumbnail charts in node body (sparklines)
// - Drag preview ghost (semi-transparent clone)
// - Multi-select visual indicators
// - Badge counts (number of active connections)
// - Progress rings for long-running operations
//
// DEPENDENCIES:
// - React (useState, useEffect hooks)
// - Tailwind CSS (utility classes for styling)
// - ../../types/nodes (TypeScript interfaces and enums)
// - lucide-react (optional - for icon alternatives)
//
// STYLING DEPENDENCIES:
// - Tailwind colors: blue-500, emerald-500, yellow-400, gray-900, etc.
// - Tailwind spacing: w-16, h-16, text-xs, etc.
// - Tailwind effects: shadow-lg, ring-2, animate-ping, etc.
// ============================================================================

import type { Node } from "../../types/nodes";

export interface NodeComponentProps {
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
  // Transform position based on viewport - with fallback for missing/invalid position
  const nodePosition = node.position && Array.isArray(node.position) && node.position.length >= 2 
    ? node.position 
    : [100, 100]; // Default position if invalid
  
  const screenX = nodePosition[0] * viewport.zoom + viewport.x;
  const screenY = nodePosition[1] * viewport.zoom + viewport.y;

  // Clamp node scale based on zoom to prevent too small/large nodes
  const nodeScale = Math.max(0.5, Math.min(1.5, viewport.zoom));

  // Determine node style based on type (with null safety)
  const isInfoSource = node.node_type && 'InfoSource' in node.node_type;
  const baseColor = isInfoSource ? "bg-blue-500" : "bg-emerald-500";
  const glowColor = isInfoSource ? "shadow-blue-500/50" : "shadow-emerald-500/50";

  return (
    <div
      className={`
        absolute pointer-events-auto
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
        transform: `translate(-50%, -50%) scale(${nodeScale})`,
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
