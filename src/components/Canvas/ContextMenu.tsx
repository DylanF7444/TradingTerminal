// ============================================================================
// ContextMenu.tsx - Right-click context menu for canvas interactions
// ============================================================================
//
// Provides a floating context menu for node grouping operations.
// Appears on right-click when nodes are selected on the canvas.
//
// Operations:
// - Group selected nodes (creates new NodeGroup)
// - Add selected nodes to existing group
// - Remove selected nodes from group
// - Ungroup (disband the group, keep nodes)
// - Delete selected nodes
// ============================================================================

import { useState, useEffect, useRef } from 'react';
import { FolderPlus, FolderMinus, Trash2, Ungroup, ChevronRight } from 'lucide-react';
import type { Node, NodeGroup } from '../../types/nodes';

export interface ContextMenuProps {
  x: number;
  y: number;
  selectedNodes: Node[];
  groups: NodeGroup[];
  onClose: () => void;
  onCreateGroup: (nodeIds: string[], label: string) => void;
  onAddToGroup: (nodeIds: string[], groupId: string) => void;
  onRemoveFromGroup: (nodeIds: string[], groupId: string) => void;
  onDisbandGroup: (groupId: string) => void;
  onDeleteNodes: (nodeIds: string[]) => void;
}

export default function ContextMenu({
  x,
  y,
  selectedNodes,
  groups,
  onClose,
  onCreateGroup,
  onAddToGroup,
  onRemoveFromGroup,
  onDisbandGroup,
  onDeleteNodes,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [showAddToGroup, setShowAddToGroup] = useState(false);
  const [groupLabelInput, setGroupLabelInput] = useState('');
  const [showLabelInput, setShowLabelInput] = useState(false);

  const selectedIds = selectedNodes.map((n) => n.id);

  // Find if selected nodes belong to a group
  const selectedNodesInGroup = groups.find((g) =>
    selectedIds.some((id) => g.memberIds.includes(id))
  );

  // Check if all selected nodes are in the same group
  const allInSameGroup =
    selectedNodesInGroup &&
    selectedIds.every((id) => selectedNodesInGroup.memberIds.includes(id));

  // Groups that could accept these nodes (excluding the one they're already in)
  const availableGroups = groups.filter(
    (g) => !allInSameGroup || g.id !== selectedNodesInGroup?.id
  );

  // Close menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // Adjust position to keep menu on screen
  const adjustedX = Math.min(x, window.innerWidth - 220);
  const adjustedY = Math.min(y, window.innerHeight - 300);

  const handleCreateGroup = () => {
    if (showLabelInput) {
      const label = groupLabelInput.trim() || `Group ${groups.length + 1}`;
      onCreateGroup(selectedIds, label);
      onClose();
    } else {
      setShowLabelInput(true);
      setGroupLabelInput(`Group ${groups.length + 1}`);
    }
  };

  const handleLabelKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      const label = groupLabelInput.trim() || `Group ${groups.length + 1}`;
      onCreateGroup(selectedIds, label);
      onClose();
    } else if (e.key === 'Escape') {
      setShowLabelInput(false);
    }
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-[100] bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[200px]"
      style={{ left: adjustedX, top: adjustedY }}
    >
      {/* Group selected */}
      {selectedNodes.length >= 2 && !allInSameGroup && (
        <div className="relative">
          {showLabelInput ? (
            <div className="px-3 py-2">
              <input
                type="text"
                value={groupLabelInput}
                onChange={(e) => setGroupLabelInput(e.target.value)}
                onKeyDown={handleLabelKeyDown}
                placeholder="Group name..."
                className="w-full bg-gray-800 border border-gray-600 rounded px-2 py-1 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                autoFocus
              />
              <div className="flex justify-end gap-1 mt-1">
                <button
                  onClick={() => setShowLabelInput(false)}
                  className="px-2 py-0.5 text-xs text-gray-400 hover:text-gray-200"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateGroup}
                  className="px-2 py-0.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-500"
                >
                  Create
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleCreateGroup}
              className="w-full px-3 py-2 flex items-center gap-2 text-sm text-gray-200 hover:bg-gray-800 transition-colors"
            >
              <FolderPlus className="w-4 h-4 text-blue-400" />
              Group selected
              <span className="ml-auto text-xs text-gray-500">
                {selectedNodes.length} nodes
              </span>
            </button>
          )}
        </div>
      )}

      {/* Add to group submenu */}
      {availableGroups.length > 0 && selectedNodes.length >= 1 && (
        <div
          className="relative"
          onMouseEnter={() => setShowAddToGroup(true)}
          onMouseLeave={() => setShowAddToGroup(false)}
        >
          <button className="w-full px-3 py-2 flex items-center gap-2 text-sm text-gray-200 hover:bg-gray-800 transition-colors">
            <FolderPlus className="w-4 h-4 text-emerald-400" />
            Add to group
            <ChevronRight className="w-4 h-4 ml-auto text-gray-500" />
          </button>

          {showAddToGroup && (
            <div className="absolute left-full top-0 ml-1 bg-gray-900 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[160px]">
              {availableGroups.map((group) => (
                <button
                  key={group.id}
                  onClick={() => {
                    onAddToGroup(selectedIds, group.id);
                    onClose();
                  }}
                  className="w-full px-3 py-2 flex items-center gap-2 text-sm text-gray-200 hover:bg-gray-800 transition-colors"
                >
                  <div
                    className="w-3 h-3 rounded"
                    style={{ backgroundColor: group.color }}
                  />
                  <span className="truncate">{group.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Remove from group */}
      {selectedNodesInGroup && (
        <button
          onClick={() => {
            onRemoveFromGroup(selectedIds, selectedNodesInGroup.id);
            onClose();
          }}
          className="w-full px-3 py-2 flex items-center gap-2 text-sm text-gray-200 hover:bg-gray-800 transition-colors"
        >
          <FolderMinus className="w-4 h-4 text-amber-400" />
          Remove from group
        </button>
      )}

      {/* Ungroup (disband entire group) */}
      {allInSameGroup && selectedNodesInGroup && (
        <button
          onClick={() => {
            onDisbandGroup(selectedNodesInGroup.id);
            onClose();
          }}
          className="w-full px-3 py-2 flex items-center gap-2 text-sm text-gray-200 hover:bg-gray-800 transition-colors"
        >
          <Ungroup className="w-4 h-4 text-purple-400" />
          Ungroup all
        </button>
      )}

      {/* Divider */}
      <div className="my-1 border-t border-gray-700" />

      {/* Delete selected */}
      <button
        onClick={() => {
          onDeleteNodes(selectedIds);
          onClose();
        }}
        className="w-full px-3 py-2 flex items-center gap-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
      >
        <Trash2 className="w-4 h-4" />
        Delete selected
        <span className="ml-auto text-xs text-gray-500">
          {selectedNodes.length}
        </span>
      </button>
    </div>
  );
}
