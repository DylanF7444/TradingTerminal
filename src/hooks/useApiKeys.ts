// ============================================================================
// API KEY MANAGEMENT HOOK
// ============================================================================
//
// Module: hooks/useApiKeys.ts
// Purpose: React hook for managing stored API keys
//
// OVERVIEW:
// This hook provides a convenient interface for components to interact with
// the stored API keys. It wraps the Tauri commands and provides loading state,
// error handling, and automatic refresh.
//
// USAGE:
// ```tsx
// const { 
//   apiKeys, 
//   hasKey, 
//   getKey, 
//   saveKey, 
//   deleteKey, 
//   loading, 
//   error 
// } = useApiKeys();
//
// // Check if key exists
// const hasPolymarket = await hasKey('Polymarket');
//
// // Get stored key
// const key = await getKey('Polymarket');
//
// // Save new key
// await saveKey({
//   platform: 'Polymarket',
//   api_key: 'xxx',
//   api_secret: null,
//   private_key: '0x...',
//   environment: 'demo',
//   additional_config: null
// });
// ```
//
// ============================================================================

import { useState, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// TYPES
// ============================================================================

export interface ApiKeySummary {
  platform: string;
  has_key: boolean;
  has_api_key: boolean;
  has_api_secret: boolean;
  has_private_key: boolean;
  environment: string;
  created_at: number;
  updated_at: number;
}

export interface ApiKeyResponse {
  platform: string;
  has_key: boolean;
  api_key: string | null;
  api_secret: string | null;
  private_key: string | null;
  environment: string | null;
  additional_config: Record<string, unknown> | null;
  created_at: number | null;
  updated_at: number | null;
}

export interface SaveApiKeyRequest {
  platform: string;
  api_key: string;
  api_secret: string | null;
  private_key: string | null;
  environment: string | null;
  additional_config: Record<string, unknown> | null;
}

// ============================================================================
// HOOK
// ============================================================================

export function useApiKeys() {
  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load all API keys on mount
  const loadKeys = useCallback(async () => {
    setLoading(true);
    setError(null);
    
    try {
      const keys = await invoke<ApiKeySummary[]>('get_all_api_keys_cmd');
      setApiKeys(keys);
    } catch (err) {
      console.error('Failed to load API keys:', err);
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  // Check if a key exists for a platform
  const hasKey = useCallback(async (platform: string): Promise<boolean> => {
    try {
      return await invoke<boolean>('has_api_key_cmd', { platform });
    } catch (err) {
      console.error('Failed to check API key:', err);
      return false;
    }
  }, []);

  // Get API key for a platform
  const getKey = useCallback(async (platform: string): Promise<ApiKeyResponse | null> => {
    try {
      return await invoke<ApiKeyResponse>('get_api_key_cmd', { platform });
    } catch (err) {
      console.error('Failed to get API key:', err);
      return null;
    }
  }, []);

  // Save API key
  const saveKey = useCallback(async (request: SaveApiKeyRequest): Promise<boolean> => {
    setError(null);
    
    try {
      await invoke('save_api_key_cmd', { request });
      await loadKeys(); // Refresh list
      return true;
    } catch (err) {
      console.error('Failed to save API key:', err);
      setError(String(err));
      return false;
    }
  }, [loadKeys]);

  // Delete API key
  const deleteKey = useCallback(async (platform: string): Promise<boolean> => {
    setError(null);
    
    try {
      const deleted = await invoke<boolean>('delete_api_key_cmd', { platform });
      await loadKeys(); // Refresh list
      return deleted;
    } catch (err) {
      console.error('Failed to delete API key:', err);
      setError(String(err));
      return false;
    }
  }, [loadKeys]);

  // Get list of configured platforms
  const getConfiguredPlatforms = useCallback(async (): Promise<string[]> => {
    try {
      return await invoke<string[]>('get_configured_platforms_cmd');
    } catch (err) {
      console.error('Failed to get configured platforms:', err);
      return [];
    }
  }, []);

  return {
    apiKeys,
    loading,
    error,
    hasKey,
    getKey,
    saveKey,
    deleteKey,
    getConfiguredPlatforms,
    refresh: loadKeys,
  };
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get the platform name from MarketType enum
 */
export function getPlatformName(marketType: 'Polymarket' | 'Kalshi'): string {
  return marketType;
}

/**
 * Check if credentials are complete for a platform
 */
export function areCredentialsComplete(
  platform: string,
  keyResponse: ApiKeyResponse | null
): boolean {
  if (!keyResponse || !keyResponse.has_key) return false;
  
  if (platform === 'Polymarket') {
    // Polymarket requires at least API key
    return !!keyResponse.api_key;
  }
  
  if (platform === 'Kalshi') {
    // Kalshi requires API key and private key for RSA-PSS signing
    return !!keyResponse.api_key && !!keyResponse.private_key;
  }
  
  return false;
}