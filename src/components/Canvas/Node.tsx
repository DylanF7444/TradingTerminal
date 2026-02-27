// ============================================================================
// INTERACTIVE NODE COMPONENT
// ============================================================================
//
// Module: components/Canvas/Node.tsx
// Purpose: Visual representation of individual nodes in the trading graph
//
// OVERVIEW:
// This component renders individual nodes (information sources and prediction
// markets) on the canvas as rectangular cards. Each node displays:
// - Source type with icon
// - Node name/label
// - Key metrics (price, volume, status, etc.)
// - Connection status indicator
//
// Node Types:
// - Info Sources (Blue): Crypto prices, news feeds, weather, etc.
// - Markets (Green): Polymarket, Kalshi prediction markets
//
// ARCHITECTURE:
// Viewport Transform (parent calc)
//   → Screen Positioning (absolute CSS)
//   → Visual Rendering (rectangular cards with metrics)
//   → Interaction Layer (click, drag, hover handlers)
//   → Status Overlays (connection status, data pulses)
//
// ============================================================================

import React, { useState, useRef, useMemo } from 'react';
import type { Node, InfoSourceMetadata, MarketMetadata } from "../../types/nodes";
import { InfoSourceType } from "../../types/nodes";

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
  /** Callback for node resize */
  onResize?: (id: string, size: { width: number; height: number | null }) => void;
}

// Icon components for different source types
const SourceIcon: React.FC<{ type: string; className?: string }> = ({ type, className = "w-4 h-4" }) => {
  switch (type) {
    case 'CryptoPrices':
    case InfoSourceType.CryptoPrices:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M9 8h4.5a2.5 2.5 0 0 1 0 5H9V8z" />
          <path d="M9 13h5a2.5 2.5 0 0 1 0 5H9v-5z" />
          <path d="M12 6v2m0 10v2" />
        </svg>
      );
    case 'FinancialPrices':
    case InfoSourceType.FinancialPrices:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M3 3v18h18" />
          <path d="M7 16l4-4 4 4 5-6" />
        </svg>
      );
    case 'NewsSource':
    case InfoSourceType.NewsSource:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
          <path d="M22 6l-10 7L2 6" />
        </svg>
      );
    case 'SocialMedia':
    case InfoSourceType.SocialMedia:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 0 0-6-6 6 6 0 0 0-6 6c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
      );
    case 'Weather':
    case InfoSourceType.Weather:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z" />
        </svg>
      );
    case 'EconomicIndicators':
    case InfoSourceType.EconomicIndicators:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="2" y="7" width="4" height="14" rx="1" />
          <rect x="10" y="3" width="4" height="18" rx="1" />
          <rect x="18" y="11" width="4" height="10" rx="1" />
        </svg>
      );
    case 'OnChainData':
    case InfoSourceType.OnChainData:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M3 9h18M9 21V9" />
        </svg>
      );
    default:
      return (
        <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4M12 8h.01" />
        </svg>
      );
  }
};

// Market icon component
const MarketIcon: React.FC<{ platform: string; className?: string }> = ({ platform, className = "w-4 h-4" }) => {
  const isPolymarket = platform.toLowerCase().includes('polymarket');
  const isKalshi = platform.toLowerCase().includes('kalshi');
  
  if (isPolymarket) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5 12 2" />
        <line x1="12" y1="22" x2="12" y2="15.5" />
        <polyline points="22 8.5 12 15.5 2 8.5" />
      </svg>
    );
  }
  
  if (isKalshi) {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    );
  }
  
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" />
      <path d="M8 12h8M12 8v8" />
    </svg>
  );
};

// Format number for display
const formatNumber = (num: number | undefined, decimals: number = 2): string => {
  if (num === undefined || num === null || isNaN(num)) return '--';
  if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
  return num.toFixed(decimals);
};

// Format price with appropriate decimals
const formatPrice = (price: number | undefined): string => {
  if (price === undefined || price === null || isNaN(price)) return '--';
  if (price < 0.01) return price.toFixed(6);
  if (price < 1) return price.toFixed(4);
  if (price < 100) return price.toFixed(2);
  return price.toFixed(2);
};

export default function NodeComponent({ 
  node, 
  viewport, 
  isSelected, 
  isDragging,
  onClick, 
  onMouseDown,
  onDelete,
  onOpenOrderbook,
  onResize,
}: NodeComponentProps) {
  const [isHovered, setIsHovered] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ width: number; height: number; mouseX: number; mouseY: number } | null>(null);
  
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
  
  // Get the source type string
  const sourceType = isInfoSource 
    ? (node.node_type as { InfoSource: string }).InfoSource 
    : isMarket 
      ? (node.node_type as { Market: string }).Market 
      : 'Unknown';
  
  // Color scheme based on type
  const colorScheme = isInfoSource 
    ? { 
        bg: 'bg-slate-800/95', 
        border: isSelected ? 'border-blue-400' : 'border-slate-600',
        header: 'bg-blue-600',
        accent: 'text-blue-400',
        glow: 'shadow-blue-500/20'
      }
    : { 
        bg: 'bg-slate-800/95', 
        border: isSelected ? 'border-emerald-400' : 'border-slate-600',
        header: 'bg-emerald-600',
        accent: 'text-emerald-400',
        glow: 'shadow-emerald-500/20'
      };

  // Extract metadata
  const metadata = node.metadata as InfoSourceMetadata | MarketMetadata | undefined;
  
  // Get display name
  const displayName = node.name || (isInfoSource ? sourceType : sourceType);
  
  // Extract metrics based on node type
  const metrics = useMemo(() => {
    if (isInfoSource) {
      const infoMeta = metadata as InfoSourceMetadata | undefined;
      const lastData = infoMeta?.lastData as { timestamp?: number; value?: number | string | Record<string, any>; symbolValues?: Record<string, { price?: number; bid?: number; ask?: number; timestamp?: number }> } | undefined;
      const quality = infoMeta?.quality;
      const configSymbols = infoMeta?.symbols || [];
      
      // Get all symbol values from data
      const symbolValues = lastData?.symbolValues || {};
      const dataSymbols = Object.keys(symbolValues);
      
      // Build ticker displays for each symbol from price data
      const tickerDisplays = dataSymbols.map(symbol => {
        const data = symbolValues[symbol];
        return data?.price !== undefined 
          ? `${symbol}: ${formatPrice(data.price)}`
          : null;
      }).filter(Boolean);
      
      // If we have ticker data, use it. Otherwise use metadata symbols.
      const hasTickerData = tickerDisplays.length > 0;
      
      // Primary: show first symbol's price
      const primaryValue = hasTickerData
        ? tickerDisplays[0]?.replace(/^[^:]+: /, '')
        : (lastData?.value !== undefined 
            ? (typeof lastData.value === 'number' ? formatPrice(lastData.value) : String(lastData.value))
            : '--');
      
      // Secondary: show ALL ticker prices or fallback to config symbols
      const secondaryValue = hasTickerData
        ? tickerDisplays.join(' | ')
        : (configSymbols.length > 0 ? configSymbols.slice(0, 3).join(', ') : '--');
      
      return {
        primary: primaryValue,
        secondary: secondaryValue,
        status: quality?.successRate !== undefined 
          ? `${(quality.successRate * 100).toFixed(0)}% uptime`
          : 'Connecting...',
        latency: quality?.avgLatency !== undefined 
          ? `${quality.avgLatency.toFixed(0)}ms`
          : '--',
        hasError: quality?.lastError !== undefined,
      };
    }
    
    if (isMarket) {
      const marketMeta = metadata as MarketMetadata | undefined;
      const marketState = marketMeta?.marketState;
      const trading = marketMeta?.trading;
      
      return {
        primary: marketState?.lastPrice !== undefined 
          ? formatPrice(marketState.lastPrice)
          : '--',
        secondary: marketState?.volume24h !== undefined 
          ? `Vol: ${formatNumber(marketState.volume24h)}`
          : '--',
        status: marketState?.status || 'Unknown',
        bid: marketState?.bestBid !== undefined ? formatPrice(marketState.bestBid) : '--',
        ask: marketState?.bestAsk !== undefined ? formatPrice(marketState.bestAsk) : '--',
        autoTrade: trading?.autoTrade || false,
      };
    }
    
    return { primary: '--', secondary: '--', status: 'Unknown' };
  }, [isInfoSource, isMarket, metadata]);

  // Extract market info for orderbook overlay
  const marketInfo = useMemo(() => {
    if (!isMarket || !node.node_type) return null;
    
    const marketType = node.node_type as { Market: string };
    const typeStr = marketType.Market.toLowerCase();
    const platform = typeStr.includes('polymarket') ? 'polymarket' as const :
                     typeStr.includes('kalshi') ? 'kalshi' as const : null;
    
    // Get market ID from metadata - check both camelCase and snake_case formats
    const meta = node.metadata as { marketId?: string; market_id?: string; question?: string; marketQuestion?: string } | undefined;
    const marketId = meta?.marketId || meta?.market_id || node.id;
    const marketQuestion = meta?.question || meta?.marketQuestion;
    
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

  // Get node size - use stored size or default (192px = w-48)
  const nodeWidth = node.size?.width || 192;
  const nodeHeight = node.size?.height;

  // Handle resize start
  const handleResizeStart = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setIsResizing(true);
    resizeStartRef.current = {
      width: nodeWidth,
      height: nodeHeight || 0,
      mouseX: e.clientX,
      mouseY: e.clientY,
    };
    
    // Add global mouse move and up listeners
    const handleResizeMove = (moveEvent: MouseEvent) => {
      if (!resizeStartRef.current || !onResize) return;
      
      const dx = moveEvent.clientX - resizeStartRef.current.mouseX;
      const dy = moveEvent.clientY - resizeStartRef.current.mouseY;
      
      const newWidth = Math.max(128, resizeStartRef.current.width + dx); // Minimum 128px
      const newHeight = nodeHeight !== null ? Math.max(80, resizeStartRef.current.height + dy) : null;
      
      onResize(node.id, { width: newWidth, height: newHeight });
    };
    
    const handleResizeEnd = () => {
      setIsResizing(false);
      resizeStartRef.current = null;
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
    };
    
    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);
  };

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
      {/* Main Node Card */}
      <div
        className={`
          rounded-lg overflow-hidden
          ${colorScheme.bg} border-2 ${colorScheme.border}
          ${isDragging ? "cursor-grabbing" : "cursor-grab"}
          transition-all duration-150 origin-center
          shadow-lg ${isSelected ? colorScheme.glow : ''}
          ${isDragging ? "scale-105 shadow-xl" : "hover:shadow-xl"}
          select-none relative
        `}
        style={{
          width: nodeWidth,
          minHeight: nodeHeight !== null ? nodeHeight : undefined,
        }}
      >
        {/* Header Section */}
        <div className={`${colorScheme.header} px-3 py-2 flex items-center gap-2`}>
          {/* Icon */}
          <div className="flex-shrink-0">
            {isInfoSource ? (
              <SourceIcon type={sourceType} className="w-4 h-4 text-white" />
            ) : (
              <MarketIcon platform={sourceType} className="w-4 h-4 text-white" />
            )}
          </div>
          
          {/* Source Type Label */}
          <div className="flex-1 min-w-0">
            <div className="text-white text-xs font-semibold truncate">
              {sourceType}
            </div>
          </div>
          
          {/* Live indicator for market nodes */}
          {isMarket && (
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse flex-shrink-0" />
          )}
        </div>
        
        {/* Content Section */}
        <div className="px-3 py-2 space-y-2">
          {/* Node Name */}
          <div className="text-white text-sm font-medium truncate" title={displayName}>
            {displayName}
          </div>
          
          {/* Primary Metric */}
          <div className="flex items-baseline gap-2">
            <span className="text-white text-lg font-bold">
              {metrics.primary}
            </span>
            {isMarket && metrics.bid && metrics.ask && (
              <span className="text-gray-400 text-xs">
                Bid: {metrics.bid} / Ask: {metrics.ask}
              </span>
            )}
          </div>
          
          {/* Secondary Info */}
          <div className="text-gray-400 text-xs truncate">
            {metrics.secondary}
          </div>
          
          {/* Status Bar */}
          <div className="flex items-center justify-between pt-1 border-t border-slate-700">
            <div className="flex items-center gap-1">
              {/* Status indicator dot */}
              <div className={`w-1.5 h-1.5 rounded-full ${
                metrics.hasError ? 'bg-red-400' : 
                metrics.status === 'open' || metrics.status.includes('%') ? 'bg-green-400' : 
                'bg-yellow-400'
              }`} />
              <span className="text-gray-400 text-[10px]">
                {metrics.status}
              </span>
            </div>
            
            {/* Latency or Auto-trade indicator */}
            {isInfoSource && 'latency' in metrics && (
              <span className="text-gray-500 text-[10px]">{metrics.latency}</span>
            )}
            {isMarket && 'autoTrade' in metrics && metrics.autoTrade && (
              <span className={`${colorScheme.accent} text-[10px] font-medium`}>AUTO</span>
            )}
          </div>
        </div>
        
        {/* Connection Ports (visual only) */}
        <div className="absolute right-0 top-1/2 w-2 h-2 bg-slate-500 rounded-full transform -translate-y-1/2 translate-x-1/2 border border-slate-600" />
        <div className="absolute left-0 top-1/2 w-2 h-2 bg-slate-500 rounded-full transform -translate-y-1/2 -translate-x-1/2 border border-slate-600" />
        
        {/* Selection indicator ring */}
        {isSelected && (
          <div className="absolute inset-0 rounded-lg border-2 border-yellow-400 animate-pulse opacity-30 pointer-events-none" />
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
      
      {/* Resize handle - appears on hover or selection */}
      {(showDeleteButton || isResizing) && onResize && (
        <div
          onMouseDown={handleResizeStart}
          className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize z-40"
          title="Resize node"
        >
          <svg 
            className={`w-3 h-3 text-gray-400 hover:text-white transition-colors ${isResizing ? 'text-white' : ''}`} 
            viewBox="0 0 24 24" 
            fill="currentColor"
          >
            <path d="M22 22H20V20H22V22ZM22 18H20V16H22V18ZM18 22H16V20H18V22ZM22 14H20V12H22V14ZM18 18H16V16H18V18ZM14 22H12V20H14V22Z" />
          </svg>
        </div>
      )}
      
      {/* Market indicator tooltip on hover */}
      {isMarket && isHovered && marketInfo && (
        <div className="absolute -bottom-6 left-1/2 transform -translate-x-1/2 whitespace-nowrap">
          <span className="text-[10px] text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
            Double-click for orderbook
          </span>
        </div>
      )}
    </div>
  );
}
