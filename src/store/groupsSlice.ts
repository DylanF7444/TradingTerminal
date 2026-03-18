// ============================================================================
// NODE GROUPS STATE MANAGEMENT SLICE
// ============================================================================
//
// Manages visual groups (bounding boxes) on the canvas. Groups can be
// created manually by multi-selecting nodes, or automatically when
// adding a series from the sidebar search panel.
//
// Groups are persisted via localStorage (partialize in store/index.ts).
// Each group tracks its member node IDs and optional series origin metadata.
// ============================================================================

import { StateCreator } from 'zustand';
import type { NodeGroup, NodeGroupOrigin } from '../types/nodes';

// =============================================================================
// SLICE STATE INTERFACE
// =============================================================================

export interface GroupsSlice {
  /** Normalized dictionary of all groups by ID */
  groups: Record<string, NodeGroup>;

  /** Add a new group */
  addGroup: (group: NodeGroup) => void;

  /** Remove a group (does NOT delete member nodes) */
  removeGroup: (id: string) => void;

  /** Partially update a group */
  updateGroup: (id: string, updates: Partial<Omit<NodeGroup, 'id'>>) => void;

  /** Append node IDs to a group */
  addNodesToGroup: (groupId: string, nodeIds: string[]) => void;

  /** Remove node IDs from a group */
  removeNodesFromGroup: (groupId: string, nodeIds: string[]) => void;

  /** Remove a node ID from ALL groups (called when a node is deleted) */
  removeNodeFromAllGroups: (nodeId: string) => void;

  /** Get all groups as an array */
  getGroupsArray: () => NodeGroup[];

  /** Get the group a node belongs to (a node belongs to at most one group) */
  getGroupForNode: (nodeId: string) => NodeGroup | undefined;

  /** Get groups with series origin */
  getSeriesGroups: () => NodeGroup[];
}

// =============================================================================
// HELPERS
// =============================================================================

const GROUP_COLORS = [
  '#3b82f6', // blue
  '#8b5cf6', // purple
  '#f59e0b', // amber
  '#10b981', // emerald
  '#ef4444', // red
  '#06b6d4', // cyan
  '#f97316', // orange
  '#ec4899', // pink
];

let colorIndex = 0;

export function nextGroupColor(): string {
  const color = GROUP_COLORS[colorIndex % GROUP_COLORS.length];
  colorIndex++;
  return color;
}

export function createNodeGroup(
  label: string,
  memberIds: string[],
  origin: NodeGroupOrigin = { type: 'manual' },
  color?: string,
): NodeGroup {
  return {
    id: crypto.randomUUID(),
    label,
    memberIds: [...memberIds],
    color: color || nextGroupColor(),
    padding: 40,
    collapsed: false,
    origin,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

// =============================================================================
// SLICE IMPLEMENTATION
// =============================================================================

export const createGroupsSlice: StateCreator<GroupsSlice> = (set, get) => ({
  groups: {},

  addGroup: (group: NodeGroup) => {
    set((state) => {
      if (state.groups[group.id]) {
        console.warn(`Group with ID ${group.id} already exists`);
        return state;
      }
      return {
        groups: {
          ...state.groups,
          [group.id]: group,
        },
      };
    });
  },

  removeGroup: (id: string) => {
    set((state) => {
      const { [id]: _removed, ...remaining } = state.groups;
      return { groups: remaining };
    });
  },

  updateGroup: (id: string, updates: Partial<Omit<NodeGroup, 'id'>>) => {
    set((state) => {
      const group = state.groups[id];
      if (!group) return state;
      return {
        groups: {
          ...state.groups,
          [id]: { ...group, ...updates, updatedAt: Date.now() },
        },
      };
    });
  },

  addNodesToGroup: (groupId: string, nodeIds: string[]) => {
    set((state) => {
      const group = state.groups[groupId];
      if (!group) return state;
      const existing = new Set(group.memberIds);
      const newIds = nodeIds.filter((id) => !existing.has(id));
      if (newIds.length === 0) return state;
      return {
        groups: {
          ...state.groups,
          [groupId]: {
            ...group,
            memberIds: [...group.memberIds, ...newIds],
            updatedAt: Date.now(),
          },
        },
      };
    });
  },

  removeNodesFromGroup: (groupId: string, nodeIds: string[]) => {
    set((state) => {
      const group = state.groups[groupId];
      if (!group) return state;
      const removeSet = new Set(nodeIds);
      const filtered = group.memberIds.filter((id) => !removeSet.has(id));
      // If the group becomes empty, remove it entirely
      if (filtered.length === 0) {
        const { [groupId]: _removed, ...remaining } = state.groups;
        return { groups: remaining };
      }
      return {
        groups: {
          ...state.groups,
          [groupId]: { ...group, memberIds: filtered, updatedAt: Date.now() },
        },
      };
    });
  },

  removeNodeFromAllGroups: (nodeId: string) => {
    set((state) => {
      let changed = false;
      const updated: Record<string, NodeGroup> = {};
      const toRemove: string[] = [];

      for (const [gid, group] of Object.entries(state.groups)) {
        if (group.memberIds.includes(nodeId)) {
          changed = true;
          const filtered = group.memberIds.filter((id) => id !== nodeId);
          if (filtered.length === 0) {
            toRemove.push(gid);
          } else {
            updated[gid] = { ...group, memberIds: filtered, updatedAt: Date.now() };
          }
        } else {
          updated[gid] = group;
        }
      }

      if (!changed) return state;

      for (const gid of toRemove) {
        delete updated[gid];
      }

      return { groups: updated };
    });
  },

  getGroupsArray: () => Object.values(get().groups),

  getGroupForNode: (nodeId: string) => {
    const groups = get().groups;
    for (const group of Object.values(groups)) {
      if (group.memberIds.includes(nodeId)) return group;
    }
    return undefined;
  },

  getSeriesGroups: () =>
    Object.values(get().groups).filter((g) => g.origin.type === 'series'),
});
