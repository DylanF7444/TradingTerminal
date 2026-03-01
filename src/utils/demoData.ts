// ============================================================================
// DEMO NODE DATA
// ============================================================================
//
// Module: utils/demoData.ts
// Purpose: Creates demonstration nodes for first-time users who have no
//          existing nodes in the backend database.
//
// Extracted from App.tsx to separate data seeding logic from the UI layer.
// ============================================================================

import { invoke } from '@tauri-apps/api/core';
import { useStore } from '../store';
import type { NodeId, NodeType } from '../types/nodes';
import { InfoSourceType, MarketType } from '../types/nodes';

/**
 * Creates a set of demo nodes to showcase the trading terminal's capabilities.
 *
 * Nodes created:
 * 1. Crypto Prices source (InfoSource/CryptoPrices) — BTC, ETH, SOL
 * 2. Polymarket market node (Market/Polymarket)
 * 3. News source (InfoSource/NewsSource)
 *
 * Connections:
 * - CryptoSource → Polymarket (strength 0.8)
 * - NewsSource → Polymarket (strength 0.6)
 *
 * Each node is persisted to the backend database via `add_node_cmd`, with
 * graceful fallback if the command isn't available.
 */
export async function createDemoNodes(): Promise<void> {
  const { addNode, addConnection } = useStore.getState();
  const now = Date.now();

  // --- 1. Crypto Price Source ---
  const cryptoSourceId = 'demo-crypto-source' as NodeId;
  const cryptoMetadata = {
    symbols: ['BTC', 'ETH', 'SOL'],
    updateIntervalSeconds: 5,
    exchange: 'binance',
  };
  const cryptoNode = {
    id: cryptoSourceId,
    node_type: { InfoSource: InfoSourceType.CryptoPrices } as NodeType,
    position: [150, 200] as [number, number],
    connections: [],
    metadata: cryptoMetadata,
    createdAt: now,
    updatedAt: now,
  };

  await persistNode(cryptoSourceId, 'InfoSource', 'CryptoPrices', 150, 200, cryptoMetadata);
  addNode(cryptoNode);

  // --- 2. Polymarket Market Node ---
  const polymarketId = 'demo-polymarket' as NodeId;
  const polyMetadata = { autoTrade: false };
  const polymarketNode = {
    id: polymarketId,
    node_type: { Market: MarketType.Polymarket } as NodeType,
    position: [450, 200] as [number, number],
    connections: [],
    metadata: polyMetadata,
    createdAt: now,
    updatedAt: now,
  };

  await persistNode(polymarketId, 'Market', 'Polymarket', 450, 200, polyMetadata);
  addNode(polymarketNode);

  // Connection: Crypto → Polymarket
  addConnection({ source: cryptoSourceId, target: polymarketId, strength: 0.8 });

  // --- 3. News Source ---
  const newsSourceId = 'demo-news-source' as NodeId;
  const newsMetadata = {
    feeds: ['reuters', 'ap'],
    keywords: ['election', 'bitcoin', 'crypto'],
  };
  const newsNode = {
    id: newsSourceId,
    node_type: { InfoSource: InfoSourceType.NewsSource } as NodeType,
    position: [150, 400] as [number, number],
    connections: [],
    metadata: newsMetadata,
    createdAt: now,
    updatedAt: now,
  };

  await persistNode(newsSourceId, 'InfoSource', 'NewsSource', 150, 400, newsMetadata);
  addNode(newsNode);

  // Connection: News → Polymarket
  addConnection({ source: newsSourceId, target: polymarketId, strength: 0.6 });

  // Log created node coordinates
  const { nodes } = useStore.getState();
  console.log(
    'Node coordinates on startup:',
    Object.values(nodes).map((n) => ({ id: n.id, position: n.position, type: n.node_type })),
  );
  console.log('Demo nodes created successfully');
}

// =============================================================================
// INTERNAL HELPER
// =============================================================================

/**
 * Persists a node to the backend database. Silently logs a warning if the
 * backend command is unavailable (e.g., during early development).
 */
async function persistNode(
  nodeId: string,
  nodeType: string,
  nodeSubtype: string,
  positionX: number,
  positionY: number,
  metadata: object,
): Promise<void> {
  try {
    await invoke('add_node_cmd', {
      nodeId,
      nodeType,
      nodeSubtype,
      positionX,
      positionY,
      metadata: JSON.stringify(metadata),
    });
  } catch (e) {
    console.warn(`Could not persist ${nodeType}/${nodeSubtype} node (backend may not have command):`, e);
  }
}
