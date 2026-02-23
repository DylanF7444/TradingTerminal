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
// ORDERBOOK INTEGRATION:
// Market nodes can trigger a global orderbook overlay when double-clicked.
// The overlay shows real-time bid/ask data from the exchange WebSocket:
//   - Uses GlobalOrderbookOverlay component for rendering
//   - Subscribes to live data via useOrderbook hook
//   - Platform (Polymarket/Kalshi) detected from node_type
//   - Market ID extracted from metadata.marketId
//   - Triggered by onOpenOrderbook callback prop
//
// ARCHITECTURE:
// Viewport Transform (parent calc)
//   → Screen Positioning (absolute CSS)
//   → Visual Rendering (type-specific shapes/colors)
//   → Interaction Layer (click, drag, hover handlers)
//   → Status Overlays (connection status, data pulses)
//
// ============================================================================

import React, { useState, useMemo } from 'react';
import type { Node } from "../../types/nodes";

export interface NodeComponentProps {
  node: Node;
  viewport: { x: number; y: number; zoom: number };
  isSelected: boolean;
  isDragging: boolean;
  onClick: () => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onDelete: () => void;
  /** Callback to open orderbook overlay for market nodes */
  onOpenOrderbook?: (marketId: string, platform: 'polymarket' | 'kalshi', marketQuestion?: string) => void;
}

export default function NodeComponent({ 
  node, 
  viewport, 
  isSelected, 
  isDragging,
  onClick, 
  onMouseDown,
  onDelete,
  onOpenOrderbook,
}: NodeComponentProps) {
  const [isHovered, setIsHovered] = useState(false);
  
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
  const isMarket = node.node_type && 'Market' in node.node_type;
  const baseColor = isInfoSource ? "bg-blue-500" : "bg-emerald-500";
  const glowColor = isInfoSource ? "shadow-blue-500/50" : "shadow-emerald-500/50";

  // Extract market info for orderbook overlay
  const marketInfo = useMemo(() => {
    if (!isMarket || !node.node_type) return null;
    
    const marketType = node.node_type as { Market: string };
    const typeStr = marketType.Market.toLowerCase();
    const platform = typeStr.includes('polymarket') ? 'polymarket' as const :
                     typeStr.includes('kalshi') ? 'kalshi' as const : null;
    
    // Get market ID from metadata - check both camelCase and snake_case formats
    // Backend stores as market_id (snake_case), but some places use marketId (camelCase)
    const metadata = node.metadata as { marketId?: string; market_id?: string; question?: string; marketQuestion?: string } | undefined;
    const marketId = metadata?.marketId || metadata?.market_id || node.id;
    const marketQuestion = metadata?.question || metadata?.marketQuestion;
    
    return platform ? { platform, marketId, marketQuestion } : null;
  }, [isMarket, node.node_type, node.metadata, node.id]);

  // Handle click with propagation stop to prevent background click clearing selection
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick();
  };

  // Handle double-click to open orderbook overlay for market nodes
  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isMarket && marketInfo && onOpenOrderbook) {
      onOpenOrderbook(marketInfo.marketId, marketInfo.platform, marketInfo.marketQuestion);
    }
  };

  // Handle delete with propagation stop
  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onDelete();
  };

  // Show delete button when hovered or selected
  const showDeleteButton = isHovered || isSelected;

  return (
    <div
      className="absolute pointer-events-auto"
      style={{
        left: screenX,
        top: screenY,
        transform: `translate(-50%, -50%) scale(${nodeScale})`,
        zIndex: isSelected ? 50 : 10,
      }}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseDown={onMouseDown}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        className={`
          w-12 h-12 rounded-full ${baseColor} 
          border-2 ${isSelected ? "border-yellow-400" : "border-white/20"}
          ${isDragging ? "cursor-grabbing" : "cursor-grab"}
          ${isDragging ? "scale-110" : "hover:scale-105"}
          transition-transform duration-150 origin-center
          shadow-lg ${glowColor}
          flex items-center justify-center
          select-none relative
        `}
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
        
        {/* Live indicator for market nodes */}
        {isMarket && (
          <div className="absolute -top-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-gray-900 animate-pulse" />
        )}
      </div>
      
      {/* Delete button - appears on hover or selection */}
      {showDeleteButton && (
        <button
          onClick={handleDelete}
          className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center shadow-lg transition-colors duration-150 z-50"
          title="Delete node"
        >
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
      
      {/* Market indicator tooltip on hover */}
      {isMarket && isHovered && marketInfo && (
        <div className="absolute -bottom-8 left-1/2 transform -translate-x-1/2 whitespace-nowrap">
          <span className="text-[10px] text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
            Double-click for orderbook
          </span>
        </div>
      )}
    </div>
  );
}
