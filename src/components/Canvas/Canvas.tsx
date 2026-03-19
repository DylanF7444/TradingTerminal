// ============================================================================
// Canvas.tsx - Interactive graph canvas for the node-based trading terminal
// ============================================================================
//
// Primary visual workspace that renders the network graph connecting
// information sources to prediction markets. Uses a hybrid approach:
// HTML5 Canvas for grid/connections (performance) and React DOM for
// interactive nodes.
//
// Supports infinite pan and zoom via a viewport coordinate system,
// configurable dimension bounds, node dragging with bounds clamping,
// connection rendering as bezier curves, connection mode for creating
// new edges, and keyboard-based node deletion.
//
// Coordinate systems: world (node positions), screen (pixels),
// and canvas (screen * DPR for Retina displays).
//
// Key props: nodes, connections, bounds, viewport, onViewportChange,
// onNodeClick, onNodeMove, onNodeDelete, onBackgroundClick,
// onOpenOrderbook, connectionMode, onCreateConnection, onConnectionDelete.
//
// Uses a memoized nodeMap (Map) for O(1) node lookups during
// connection rendering and drag handling.
//
// ============================================================================

import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from "react";
import type { Node, NodeGroup } from "../../types/nodes";
import NodeComponent from "./Node";
import ContextMenu from "./ContextMenu";

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
  groups?: NodeGroup[];
  bounds?: CanvasBounds;
  clampViewportToBounds?: boolean;
  viewport: Viewport;
  selectedNodeId: string | null;
  selectedIds?: Set<string>;
  onNodeClick: (node: Node) => void;
  onNodeMove: (id: string, position: [number, number]) => void;
  onNodesMove?: (positions: Record<string, [number, number]>) => void;
  onNodeDelete: (id: string) => void;
  onBackgroundClick: () => void;
  onViewportChange: (viewport: Viewport) => void;
  /** Callback to open orderbook overlay for market nodes */
  onOpenOrderbook?: (marketId: string, platform: 'polymarket' | 'kalshi', marketQuestion?: string, tokenIds?: string[]) => void;
  /** Callback to resize a node */
  onNodeResize?: (id: string, size: { width: number; height: number | null }) => void;
  /** Connection mode state */
  connectionMode?: boolean;
  /** Callback when a new connection is created */
  onCreateConnection?: (sourceId: string, targetId: string) => void;
  /** Callback when a connection is deleted */
  onConnectionDelete?: (source: string, target: string) => void;
  /** Callback when multiple nodes are selected via rubber-band */
  onSelectNodes?: (nodeIds: string[]) => void;
  /** Callback to create a new group */
  onCreateGroup?: (nodeIds: string[], label: string) => void;
  /** Callback to add nodes to existing group */
  onAddToGroup?: (nodeIds: string[], groupId: string) => void;
  /** Callback to remove nodes from group */
  onRemoveFromGroup?: (nodeIds: string[], groupId: string) => void;
  /** Callback to disband a group */
  onDisbandGroup?: (groupId: string) => void;
}

export default function Canvas({
  nodes,
  connections,
  groups = [],
  bounds,
  clampViewportToBounds = true,
  viewport,
  selectedNodeId,
  selectedIds = new Set(),
  onNodeClick,
  onNodeMove,
  onNodesMove,
  onNodeDelete,
  onBackgroundClick,
  onViewportChange,
  onOpenOrderbook,
  onNodeResize,
  connectionMode = false,
  onCreateConnection,
  onConnectionDelete,
  onSelectNodes,
  onCreateGroup,
  onAddToGroup,
  onRemoveFromGroup,
  onDisbandGroup,
}: CanvasProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPanning, setIsPanning] = useState(false);
  const [draggingNode, setDraggingNode] = useState<string | null>(null);
  const [draggingGroupId, setDraggingGroupId] = useState<string | null>(null);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const didPanRef = useRef(false);
  const [mousePosition, setMousePosition] = useState<{ x: number; y: number } | null>(null);

  // Rubber-band selection state (triggered by right-click drag)
  const [selectionRect, setSelectionRect] = useState<{
    startX: number; startY: number; endX: number; endY: number;
  } | null>(null);
  // Track if right mouse button is down (for selection box vs context menu)
  const [isRightMouseDown, setIsRightMouseDown] = useState(false);
  const rightClickStartRef = useRef<{ x: number; y: number } | null>(null);
  const didRightDragRef = useRef(false);
  const groupDragStartRef = useRef<{
    mouseX: number;
    mouseY: number;
    initialPositions: Record<string, [number, number]>;
  } | null>(null);

  // Connection mode state
  const [connectionSource, setConnectionSource] = useState<string | null>(null);
  // Hovered connection for delete button
  const [hoveredConnection, setHoveredConnection] = useState<Connection | null>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

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
  const groupRenderData = useMemo(() => {
    const NODE_WIDTH = 192;
    const NODE_HEIGHT = 120;
    const labelPadX = 8;
    const labelPadY = 4;
    const fontSize = 12;
    const font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
    const measureCanvas = document.createElement('canvas');
    const measureCtx = measureCanvas.getContext('2d');
    if (measureCtx) measureCtx.font = font;

    return groups
      .map((group) => {
        if (group.memberIds.length === 0) return null;

        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;
        let visibleCount = 0;
        const memberPositions: Record<string, [number, number]> = {};

        for (const nodeId of group.memberIds) {
          const node = nodeMap.get(nodeId);
          if (!node?.position) continue;
          visibleCount++;
          const [nx, ny] = node.position;
          memberPositions[nodeId] = [nx, ny];
          const nw = node.size?.width || NODE_WIDTH;
          const nh = node.size?.height || NODE_HEIGHT;
          minX = Math.min(minX, nx - nw / 2);
          minY = Math.min(minY, ny - nh / 2);
          maxX = Math.max(maxX, nx + nw / 2);
          maxY = Math.max(maxY, ny + nh / 2);
        }

        if (visibleCount === 0) return null;

        const pad = group.padding || 40;
        minX -= pad;
        minY -= pad;
        maxX += pad;
        maxY += pad;

        const labelTextWidth = measureCtx
          ? measureCtx.measureText(group.label).width
          : group.label.length * 7;
        const labelWidth = labelTextWidth + labelPadX * 2;
        const labelHeight = fontSize + labelPadY * 2;
        const labelX = minX;
        const labelY = minY - labelHeight - 4;

        return {
          group,
          minX,
          minY,
          boxWidth: maxX - minX,
          boxHeight: maxY - minY,
          labelX,
          labelY,
          labelWidth,
          labelHeight,
          memberPositions,
          fontSize,
          labelPadX,
        };
      })
      .filter((g): g is NonNullable<typeof g> => g !== null);
  }, [groups, nodeMap]);
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

    // Draw group bounding boxes
    groupRenderData.forEach((groupData) => {
      // Draw filled background
      ctx.fillStyle = `${groupData.group.color}10`; // 10 = ~6% opacity
      ctx.beginPath();
      ctx.roundRect(groupData.minX, groupData.minY, groupData.boxWidth, groupData.boxHeight, 12);
      ctx.fill();

      // Draw dashed border
      ctx.strokeStyle = groupData.group.color;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.roundRect(groupData.minX, groupData.minY, groupData.boxWidth, groupData.boxHeight, 12);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw label background
      ctx.font = `600 ${groupData.fontSize}px Inter, system-ui, sans-serif`;

      ctx.fillStyle = groupData.group.color;
      ctx.beginPath();
      ctx.roundRect(groupData.labelX, groupData.labelY, groupData.labelWidth, groupData.labelHeight, 6);
      ctx.fill();

      // Draw label text
      ctx.fillStyle = '#ffffff';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        groupData.group.label,
        groupData.labelX + groupData.labelPadX,
        groupData.labelY + groupData.labelHeight / 2,
      );
    });

    // Draw rubber-band selection rect
    if (selectionRect) {
      const minX = Math.min(selectionRect.startX, selectionRect.endX);
      const maxX = Math.max(selectionRect.startX, selectionRect.endX);
      const minY = Math.min(selectionRect.startY, selectionRect.endY);
      const maxY = Math.max(selectionRect.startY, selectionRect.endY);
      const width = maxX - minX;
      const height = maxY - minY;

      ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
      ctx.fillRect(minX, minY, width, height);
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.8)';
      ctx.lineWidth = 1 / viewport.zoom;
      ctx.setLineDash([4 / viewport.zoom, 4 / viewport.zoom]);
      ctx.strokeRect(minX, minY, width, height);
      ctx.setLineDash([]);
    }

    ctx.restore();
  }, [nodes, connections, viewport, canvasSize, selectionRect, groupRenderData]);

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
      // Right-click (button 2) starts rubber-band selection
      if (e.button === 2) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const screenX = e.clientX - rect.left;
          const screenY = e.clientY - rect.top;
          rightClickStartRef.current = { x: screenX, y: screenY };
          didRightDragRef.current = false;
          setIsRightMouseDown(true);
          // Don't start selection rect immediately - wait for drag
        }
        return;
      }

      // Left click (button 0) or middle mouse (button 1)
      if (e.button === 0 || e.button === 1) {
        if (e.button === 0 && onNodesMove) {
          const rect = containerRef.current?.getBoundingClientRect();
          if (rect) {
            const worldX = (e.clientX - rect.left - viewport.x) / viewport.zoom;
            const worldY = (e.clientY - rect.top - viewport.y) / viewport.zoom;
            for (let i = groupRenderData.length - 1; i >= 0; i--) {
              const groupData = groupRenderData[i];
              const inLabelX = worldX >= groupData.labelX && worldX <= groupData.labelX + groupData.labelWidth;
              const inLabelY = worldY >= groupData.labelY && worldY <= groupData.labelY + groupData.labelHeight;
              if (inLabelX && inLabelY) {
                e.preventDefault();
                e.stopPropagation();
                setDraggingGroupId(groupData.group.id);
                groupDragStartRef.current = {
                  mouseX: worldX,
                  mouseY: worldY,
                  initialPositions: { ...groupData.memberPositions },
                };
                return;
              }
            }
          }
        }
        didPanRef.current = false;
        setIsPanning(true);
        setDragOffset({
          x: e.clientX - viewport.x,
          y: e.clientY - viewport.y,
        });
      }
    },
    [viewport, groupRenderData, onNodesMove]
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

        // Handle right-click drag for rubber-band selection
        if (isRightMouseDown && rightClickStartRef.current) {
          const dragDistX = Math.abs(screenX - rightClickStartRef.current.x);
          const dragDistY = Math.abs(screenY - rightClickStartRef.current.y);
          // Start selection rect only after dragging at least 5 pixels
          if (dragDistX > 5 || dragDistY > 5) {
            didRightDragRef.current = true;
            if (!selectionRect) {
              // Start the selection rect from the initial click position
              const startWorldX = (rightClickStartRef.current.x - viewport.x) / viewport.zoom;
              const startWorldY = (rightClickStartRef.current.y - viewport.y) / viewport.zoom;
              setSelectionRect({ startX: startWorldX, startY: startWorldY, endX: worldX, endY: worldY });
            } else {
              // Update the selection rect end position
              setSelectionRect({ ...selectionRect, endX: worldX, endY: worldY });
            }
          }
        } else if (selectionRect) {
          // Update rubber-band selection rect (legacy path)
          setSelectionRect({ ...selectionRect, endX: worldX, endY: worldY });
        }
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
    [isPanning, dragOffset, viewport, onViewportChange, clampViewportToBounds, canvasSize, effectiveBounds, nodeMap, connections, selectionRect, isRightMouseDown]
  );

  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    // Finalize rubber-band selection (from right-click drag)
    if (selectionRect && onSelectNodes) {
      const minX = Math.min(selectionRect.startX, selectionRect.endX);
      const maxX = Math.max(selectionRect.startX, selectionRect.endX);
      const minY = Math.min(selectionRect.startY, selectionRect.endY);
      const maxY = Math.max(selectionRect.startY, selectionRect.endY);

      const selectedNodeIds: string[] = [];
      for (const node of nodes) {
        if (!node?.position) continue;
        const [nx, ny] = node.position;
        // Check if node center is within selection rect
        if (nx >= minX && nx <= maxX && ny >= minY && ny <= maxY) {
          selectedNodeIds.push(node.id);
        }
      }

      if (selectedNodeIds.length > 0) {
        onSelectNodes(selectedNodeIds);
      }
    }

    // Reset right-click state
    setIsRightMouseDown(false);
    rightClickStartRef.current = null;

    setSelectionRect(null);
    setIsPanning(false);
    setDraggingNode(null);
    setDraggingGroupId(null);
    groupDragStartRef.current = null;
  }, [selectionRect, onSelectNodes, nodes]);

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
      } else if (draggingGroupId && groupDragStartRef.current && onNodesMove) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const worldX = (e.clientX - rect.left - viewport.x) / viewport.zoom;
        const worldY = (e.clientY - rect.top - viewport.y) / viewport.zoom;
        const deltaX = worldX - groupDragStartRef.current.mouseX;
        const deltaY = worldY - groupDragStartRef.current.mouseY;

        if (deltaX !== 0 || deltaY !== 0) {
          didPanRef.current = true;
        }

        const updates: Record<string, [number, number]> = {};
        Object.entries(groupDragStartRef.current.initialPositions).forEach(([nodeId, [startX, startY]]) => {
          updates[nodeId] = clampToBounds(startX + deltaX, startY + deltaY);
        });
        onNodesMove(updates);
      }
    };

    const handleGlobalMouseUp = () => {
      setDraggingNode(null);
      setDraggingGroupId(null);
      groupDragStartRef.current = null;
    };

    if (draggingNode || draggingGroupId) {
      window.addEventListener("mousemove", handleGlobalMouseMove);
      window.addEventListener("mouseup", handleGlobalMouseUp);
    }

    return () => {
      window.removeEventListener("mousemove", handleGlobalMouseMove);
      window.removeEventListener("mouseup", handleGlobalMouseUp);
    };
  }, [draggingNode, draggingGroupId, viewport, dragOffset, onNodeMove, onNodesMove, clampToBounds]);

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
        // Only delete if we're not editing an input field
        const activeElement = document.activeElement;
        const isEditing = activeElement && (
          activeElement.tagName === 'INPUT' ||
          activeElement.tagName === 'TEXTAREA' ||
          (activeElement as HTMLElement).isContentEditable
        );
        if (!isEditing) {
          // Prevent default browser behavior (like going back in history)
          e.preventDefault();
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
        (isPanning || draggingGroupId) ? "cursor-grabbing" : "cursor-crosshair"
      }`}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onContextMenu={(e) => {
        e.preventDefault();
        // Only show context menu if we didn't drag (i.e., it's a simple right-click)
        // Context menu is shown when: nodes are selected AND we didn't drag
        if (!didRightDragRef.current && selectedIds.size > 0) {
          setContextMenu({ x: e.clientX, y: e.clientY });
        }
        // Reset drag tracking
        didRightDragRef.current = false;
      }}
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
              isSelected={selectedIds.has(node.id) || selectedNodeId === node.id}
              isDragging={draggingNode === node.id}
              isConnectionSource={isConnectionSource}
              isValidConnectionTarget={isValidTarget}
              onClick={(e) => {
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
                } else if (e.shiftKey && onSelectNodes) {
                  // Shift+click: toggle multi-select
                  const currentSelected = Array.from(selectedIds);
                  if (selectedIds.has(node.id)) {
                    // Already selected - deselect (toggle off)
                    onSelectNodes(currentSelected.filter(id => id !== node.id));
                  } else {
                    // Not selected - add to selection
                    onSelectNodes([...currentSelected, node.id]);
                  }
                } else {
                  // Normal mode: select node (single selection)
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

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          selectedNodes={nodes.filter((n) => selectedIds.has(n.id))}
          groups={groups}
          onClose={() => setContextMenu(null)}
          onCreateGroup={(nodeIds, label) => {
            onCreateGroup?.(nodeIds, label);
            setContextMenu(null);
          }}
          onAddToGroup={(nodeIds, groupId) => {
            onAddToGroup?.(nodeIds, groupId);
            setContextMenu(null);
          }}
          onRemoveFromGroup={(nodeIds, groupId) => {
            onRemoveFromGroup?.(nodeIds, groupId);
            setContextMenu(null);
          }}
          onDisbandGroup={(groupId) => {
            onDisbandGroup?.(groupId);
            setContextMenu(null);
          }}
          onDeleteNodes={(nodeIds) => {
            nodeIds.forEach((id) => onNodeDelete(id));
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
}
