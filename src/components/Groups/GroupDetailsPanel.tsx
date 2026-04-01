import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Connection, Node, NodeGroup } from '../../types/nodes';
import { getNodeDisplayName } from '../../utils/nodeHelpers';
import { invokeCommand } from '../../utils/api';

interface GroupDetailsPanelProps {
  group: NodeGroup;
  nodes: Record<string, Node>;
  connections: Connection[];
}

interface NodeStorageUsageResponse {
  node_id: string;
  timeseries_rows: number;
  websocket_message_rows: number;
  timeseries_estimated_bytes?: number;
  estimated_bytes: number;
  data_rate_bytes_per_sec: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function estimateInMemoryNodeBytes(node: Node): number {
  return new TextEncoder().encode(JSON.stringify(node)).length;
}

export function GroupDetailsPanel({
  group,
  nodes,
  connections,
}: GroupDetailsPanelProps): ReactNode {
  const nodesRef = useRef(nodes);
  const [storage, setStorage] = useState<{
    loading: boolean;
    inMemoryBytes: number;
    historicalBytes: number;
    totalRows: number;
  }>({
    loading: true,
    inMemoryBytes: 0,
    historicalBytes: 0,
    totalRows: 0,
  });

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  const memberNodes = useMemo(
    () => group.memberIds.map((id) => nodes[id]).filter((node): node is Node => Boolean(node)),
    [group.memberIds, nodes],
  );

  const memberIdSet = useMemo(() => new Set(memberNodes.map((node) => node.id)), [memberNodes]);

  const incomingConnections = useMemo(
    () => connections.filter((conn) => memberIdSet.has(conn.target) && !memberIdSet.has(conn.source)),
    [connections, memberIdSet],
  );

  const outgoingConnections = useMemo(
    () => connections.filter((conn) => memberIdSet.has(conn.source) && !memberIdSet.has(conn.target)),
    [connections, memberIdSet],
  );

  useEffect(() => {
    let cancelled = false;

    const fetchStorage = async () => {
      const currentNodes = nodesRef.current;
      const memberIds = group.memberIds.filter((id) => Boolean(currentNodes[id]));
      const inMemoryBytes = memberIds.reduce((sum, id) => sum + estimateInMemoryNodeBytes(currentNodes[id]), 0);

      if (memberIds.length === 0) {
        if (!cancelled) {
          setStorage({
            loading: false,
            inMemoryBytes,
            historicalBytes: 0,
            totalRows: 0,
          });
        }
        return;
      }

      const usageResults = await Promise.all(
        memberIds.map((nodeId) =>
          invokeCommand<NodeStorageUsageResponse>(
            'get_node_storage_usage_cmd',
            { nodeId },
            { logCall: false, timeoutMs: 10000, retries: 1 },
          ),
        ),
      );

      let historicalBytes = 0;
      let totalRows = 0;
      usageResults.forEach((result, idx) => {
        if (!result.ok) {
          console.error(
            `[GroupDetailsPanel] Failed to fetch storage usage for node ${memberIds[idx]}: ${result.error.message}`,
          );
          return;
        }
        historicalBytes += result.value.timeseries_estimated_bytes ?? result.value.estimated_bytes;
        totalRows += result.value.timeseries_rows + result.value.websocket_message_rows;
      });

      if (!cancelled) {
        setStorage({
          loading: false,
          inMemoryBytes,
          historicalBytes,
          totalRows,
        });
      }
    };

    setStorage((prev) => ({ ...prev, loading: true }));
    void fetchStorage();
    const timer = setInterval(() => {
      void fetchStorage();
    }, 10000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [group.id, group.updatedAt, group.memberIds]);

  const getNodeName = (nodeId: string): string => {
    const node = nodes[nodeId];
    return node ? getNodeDisplayName(node) : nodeId.slice(0, 8);
  };

  const totalStorageBytes = storage.inMemoryBytes + storage.historicalBytes;

  return (
    <div className="text-gray-300 text-sm space-y-4">
      <div className="pb-3 border-b border-gray-700">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: group.color }} />
          <span className="font-semibold text-white">{group.label}</span>
        </div>
        <p className="text-xs text-gray-500">
          Group ID: <span className="font-mono">{group.id}</span>
        </p>
      </div>

      <div className="bg-gray-800/50 rounded-lg p-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Overview</h3>
        <div className="space-y-1 text-xs">
          <div className="flex justify-between">
            <span className="text-gray-500">Nodes</span>
            <span className="text-gray-200">{memberNodes.length}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Incoming Connections</span>
            <span className="text-blue-300">{incomingConnections.length}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Outgoing Connections</span>
            <span className="text-emerald-300">{outgoingConnections.length}</span>
          </div>
        </div>
      </div>

      <div className="bg-gray-800/50 rounded-lg p-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Storage Usage</h3>
        {storage.loading ? (
          <p className="text-xs text-gray-500">Loading storage metrics...</p>
        ) : (
          <div className="space-y-1 text-xs">
            <div className="flex justify-between">
              <span className="text-gray-500">Total (Memory + Historical)</span>
              <span className="text-gray-200">{formatBytes(totalStorageBytes)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Node Data in Memory</span>
              <span className="text-cyan-300">{formatBytes(storage.inMemoryBytes)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Historical Time Series Data</span>
              <span className="text-amber-300">{formatBytes(storage.historicalBytes)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-500">Stored Rows</span>
              <span className="text-gray-300">{storage.totalRows.toLocaleString()}</span>
            </div>
          </div>
        )}
      </div>

      <div className="bg-gray-800/50 rounded-lg p-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Connections</h3>
        {incomingConnections.length === 0 && outgoingConnections.length === 0 ? (
          <p className="text-xs text-gray-500">No external connections</p>
        ) : (
          <div className="space-y-3">
            {incomingConnections.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1">Receiving from:</p>
                <div className="space-y-1">
                  {incomingConnections.slice(0, 12).map((conn, idx) => (
                    <div key={`${conn.source}-${conn.target}-${idx}`} className="flex items-center gap-2 text-xs">
                      <div className="w-2 h-2 rounded-full bg-blue-500" />
                      <span className="text-blue-300">{getNodeName(conn.source)}</span>
                      <span className="text-gray-600">→</span>
                      <span className="text-gray-400">{getNodeName(conn.target)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {outgoingConnections.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1">Sending to:</p>
                <div className="space-y-1">
                  {outgoingConnections.slice(0, 12).map((conn, idx) => (
                    <div key={`${conn.source}-${conn.target}-${idx}`} className="flex items-center gap-2 text-xs">
                      <div className="w-2 h-2 rounded-full bg-emerald-500" />
                      <span className="text-emerald-300">{getNodeName(conn.source)}</span>
                      <span className="text-gray-600">→</span>
                      <span className="text-gray-400">{getNodeName(conn.target)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="bg-gray-800/30 rounded-lg p-3">
        <h3 className="text-xs font-semibold text-gray-400 uppercase mb-2">Members</h3>
        {memberNodes.length === 0 ? (
          <p className="text-xs text-gray-500">No nodes in this group</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {memberNodes.map((node) => (
              <span
                key={node.id}
                className="px-2 py-1 rounded text-xs font-medium bg-gray-700/70 text-gray-200 border border-gray-600"
              >
                {getNodeDisplayName(node)}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default GroupDetailsPanel;
