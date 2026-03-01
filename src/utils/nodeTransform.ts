// ============================================================================
// NODE DATA TRANSFORMATION UTILITIES
// ============================================================================
//
// Module: utils/nodeTransform.ts
// Purpose: Transform node data between backend (Rust) and frontend (TypeScript) formats
//
// The Rust backend serializes node_type as { type: "InfoSource", subtype: "CryptoPrices" }
// while the frontend uses discriminated unions: { InfoSource: "CryptoPrices" }.
// This module bridges that gap with type-safe transformation functions.
// ============================================================================

import type { Node, NodeType } from '../types/nodes';

/**
 * Transforms a node received from the Rust backend into the frontend format.
 *
 * Handles three key transformations:
 * 1. node_type: `{ type, subtype }` → `{ [type]: subtype }` discriminated union
 * 2. position: Ensures valid `[x, y]` tuple with fallback defaults
 * 3. size: Converts `[width, height]` array to `{ width, height }` object
 *
 * @param backendNode - Raw node object from Tauri invoke response
 * @returns Transformed node compatible with frontend types
 */
export function transformNodeFromBackend(backendNode: Record<string, unknown>): Node {
  // --- Transform node_type ---
  let nodeType = backendNode.node_type as NodeType | { type: string; subtype: string };

  if (
    nodeType &&
    typeof nodeType === 'object' &&
    'type' in nodeType &&
    'subtype' in nodeType
  ) {
    const { type, subtype } = nodeType as { type: string; subtype: string };
    nodeType = { [type]: subtype } as unknown as NodeType;
  }

  // --- Transform position ---
  let position = backendNode.position as [number, number] | unknown;
  if (Array.isArray(position) && position.length >= 2) {
    position = [position[0], position[1]] as [number, number];
  } else {
    position = [100, 100] as [number, number];
  }

  // --- Transform size ---
  let size = backendNode.size as { width: number; height: number | null } | number[] | undefined;
  if (Array.isArray(size) && size.length >= 1) {
    size = { width: size[0], height: size[1] ?? null };
  }

  return {
    ...backendNode,
    node_type: nodeType as NodeType,
    position: position as [number, number],
    size: size as { width: number; height: number | null } | undefined,
    connections: (backendNode.connections as string[]) || [],
    createdAt: (backendNode.createdAt as number) || Date.now(),
    updatedAt: (backendNode.updatedAt as number) || Date.now(),
  } as Node;
}
