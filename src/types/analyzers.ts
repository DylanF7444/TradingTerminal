// ============================================================================
// ANALYZER NODE TYPE DEFINITIONS
// ============================================================================
//
// Module: types/analyzers.ts
// Purpose: TypeScript interfaces for the analyzer nodes system
//
// Backend Mapping: src-tauri/src/models/analyzer_node.rs
// Commands: src-tauri/src/commands/analyzers.rs
//
// These types map 1:1 with Rust serde serialization and are used for
// Tauri IPC invocations from the frontend.
// ============================================================================

import { invoke } from '@tauri-apps/api/core';

// Re-export for convenience
export { AnalyzerType } from './nodes';

import type { AnalyzerType } from './nodes';

// ============================================================================
// CORE TYPES
// ============================================================================

/** An analyzer node attached to a graph node */
export interface AnalyzerNode {
  id: string;
  node_id: string;
  analyzer_type: AnalyzerType;
  config: Record<string, unknown>;
  enabled: boolean;
  name: string;
  created_at: number;
  updated_at: number;
}

/** Result produced by an analyzer */
export interface AnalyzerResult {
  id: string;
  analyzer_id: string;
  timestamp: number;
  value: number;
  signal_strength: number;
  metadata: Record<string, unknown>;
}

/** Chain connecting two analyzers (output of source → input of target) */
export interface AnalyzerChain {
  id: string;
  source_analyzer_id: string;
  target_analyzer_id: string;
  transform: string | null;
  enabled: boolean;
  created_at: number;
}

// ============================================================================
// CONFIG TYPES (match Rust config structs)
// ============================================================================

export interface CorrelationConfig {
  target_node_ids: string[];
  window_size: number;
  min_threshold: number;
}

export interface MomentumConfig {
  short_period: number;
  long_period: number;
  threshold: number;
}

export interface ArbitrageConfig {
  market_pairs: [string, string][];
  min_profit_margin: number;
  include_fees: boolean;
  fee_rate: number;
}

export interface SentimentConfig {
  keywords: string[];
  weight: number;
  decay_factor: number;
  threshold: number;
}

export interface RSIConfig {
  period: number;
  overbought: number;
  oversold: number;
}

export interface VolatilityConfig {
  window_size: number;
  annualize: boolean;
  high_threshold: number;
  low_threshold: number;
}

export type AnalyzerConfig =
  | CorrelationConfig
  | MomentumConfig
  | ArbitrageConfig
  | SentimentConfig
  | RSIConfig
  | VolatilityConfig
  | Record<string, unknown>;

// ============================================================================
// REQUEST / RESPONSE TYPES
// ============================================================================

export interface CreateAnalyzerRequest {
  node_id: string;
  analyzer_type: string;
  name: string;
  config?: Record<string, unknown>;
}

export interface UpdateAnalyzerRequest {
  analyzer_id: string;
  config: Record<string, unknown>;
}

export interface CreateChainRequest {
  source_analyzer_id: string;
  target_analyzer_id: string;
  transform?: string;
}

export interface AnalyzerTypeInfo {
  type: string;
  default_config: Record<string, unknown>;
  description: string;
}

// ============================================================================
// TAURI COMMAND WRAPPERS
// ============================================================================

/** Create and attach an analyzer to a graph node */
export async function createAnalyzer(request: CreateAnalyzerRequest): Promise<AnalyzerNode> {
  return invoke<AnalyzerNode>('create_analyzer_cmd', { request });
}

/** Update an analyzer's configuration */
export async function updateAnalyzer(request: UpdateAnalyzerRequest): Promise<void> {
  return invoke<void>('update_analyzer_cmd', { request });
}

/** Delete an analyzer */
export async function deleteAnalyzer(analyzerId: string): Promise<void> {
  return invoke<void>('delete_analyzer_cmd', { analyzerId });
}

/** Get all analyzers for a node */
export async function getNodeAnalyzers(nodeId: string): Promise<AnalyzerNode[]> {
  return invoke<AnalyzerNode[]>('get_node_analyzers_cmd', { nodeId });
}

/** Get a single analyzer by ID */
export async function getAnalyzer(analyzerId: string): Promise<AnalyzerNode | null> {
  return invoke<AnalyzerNode | null>('get_analyzer_cmd', { analyzerId });
}

/** Get analyzer results within a time range */
export async function getAnalyzerResults(
  analyzerId: string,
  startTime?: number,
  endTime?: number,
  limit?: number,
): Promise<AnalyzerResult[]> {
  return invoke<AnalyzerResult[]>('get_analyzer_results_cmd', {
    analyzerId,
    startTime: startTime ?? null,
    endTime: endTime ?? null,
    limit: limit ?? null,
  });
}

/** Toggle analyzer enabled/disabled */
export async function toggleAnalyzer(analyzerId: string, enabled: boolean): Promise<void> {
  return invoke<void>('toggle_analyzer_cmd', { analyzerId, enabled });
}

/** Create a chain between two analyzers */
export async function createChain(request: CreateChainRequest): Promise<AnalyzerChain> {
  return invoke<AnalyzerChain>('create_chain_cmd', { request });
}

/** Delete an analyzer chain */
export async function deleteChain(chainId: string): Promise<void> {
  return invoke<void>('delete_chain_cmd', { chainId });
}

/** Get all chains for a node */
export async function getNodeChains(nodeId: string): Promise<AnalyzerChain[]> {
  return invoke<AnalyzerChain[]>('get_node_chains_cmd', { nodeId });
}

/** Get available analyzer types with default configs */
export async function getAnalyzerTypes(): Promise<AnalyzerTypeInfo[]> {
  return invoke<AnalyzerTypeInfo[]>('get_analyzer_types_cmd');
}
