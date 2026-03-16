// ============================================================================
// REMOTE ACCESS HOOK
// ============================================================================
//
// Module: hooks/useRemoteAccess.ts
// Purpose: React hook for managing remote desktop gateway state and operations
//
// OVERVIEW:
// Provides a unified interface for the remote access feature, encapsulating
// Tauri command invocations, event listeners, and local state management.
// Used by the RemoteAccessPanel component to display gateway status and
// allow users to enable/disable remote access, pair devices, and monitor
// active sessions.
//
// ARCHITECTURE:
// This hook coordinates:
//   1. Tauri commands (invoke) for control operations
//   2. Tauri events (listen) for real-time status updates
//   3. React state for UI reactivity
//   4. Polling for periodic status refresh
//
// FEATURES:
//   - Enable/disable remote gateway
//   - Generate device pairing codes
//   - Monitor connected devices and sessions
//   - Revoke paired device access
//   - Configure relay server settings
//   - Real-time status updates via events
//
// USAGE:
//   const {
//     status, isLoading, error,
//     enableRemoteAccess, disableRemoteAccess,
//     generatePairingCode, revokeDevice,
//     pairedDevices, refreshStatus
//   } = useRemoteAccess();
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  RemoteStatus,
  PairedDeviceSummary,
  EnableRemoteRequest,
  PairingCodeEvent,
  DeviceConnectedEvent,
  DeviceDisconnectedEvent,
  PairResultEvent,
} from '../types/remote';

// ============================================================================
// HOOK STATE
// ============================================================================

interface RemoteAccessState {
  /** Current gateway status */
  status: RemoteStatus | null;
  /** List of paired devices */
  pairedDevices: PairedDeviceSummary[];
  /** Active pairing code (from event) */
  pairingCode: string | null;
  /** Pairing code expiration countdown (seconds remaining) */
  pairingCodeExpiry: number | null;
  /** Result of the last pairing code submission */
  pairResult: PairResultEvent | null;
  /** Whether an operation is in progress */
  isLoading: boolean;
  /** Last error message */
  error: string | null;
}

// ============================================================================
// HOOK RETURN TYPE
// ============================================================================

interface UseRemoteAccessReturn extends RemoteAccessState {
  /** Enable remote access with relay configuration */
  enableRemoteAccess: (config: EnableRemoteRequest) => Promise<void>;
  /** Disable remote access and disconnect all remotes */
  disableRemoteAccess: () => Promise<void>;
  /** Generate a new 6-digit pairing code */
  generatePairingCode: () => Promise<void>;
  /** Submit a 6-digit pairing code to connect to a host device */
  submitPairingCode: (code: string, deviceName: string) => Promise<void>;
  /** Revoke a paired device's access */
  revokeDevice: (deviceId: string) => Promise<void>;
  /** Update relay server configuration */
  updateRelayConfig: (config: EnableRemoteRequest) => Promise<void>;
  /** Manually refresh the gateway status */
  refreshStatus: () => Promise<void>;
  /** Clear the current error */
  clearError: () => void;
  /** Clear the pair result */
  clearPairResult: () => void;
}

// ============================================================================
// STATUS POLLING INTERVAL
// ============================================================================

/** How often to poll for gateway status when enabled (ms) */
const STATUS_POLL_INTERVAL = 5000;

// ============================================================================
// HOOK IMPLEMENTATION
// ============================================================================

/**
 * React hook for managing the remote desktop gateway.
 *
 * Handles command invocations, event subscriptions, and periodic status
 * polling. Returns the current state and action functions for the UI.
 */
export function useRemoteAccess(): UseRemoteAccessReturn {
  const [state, setState] = useState<RemoteAccessState>({
    status: null,
    pairedDevices: [],
    pairingCode: null,
    pairingCodeExpiry: null,
    pairResult: null,
    isLoading: false,
    error: null,
  });

  const pairingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // --------------------------------------------------------------------------
  // Status Refresh
  // --------------------------------------------------------------------------

  const refreshStatus = useCallback(async () => {
    try {
      const status = await invoke<RemoteStatus>('get_remote_status_cmd');
      const devices = await invoke<PairedDeviceSummary[]>('get_paired_devices_cmd');

      setState((prev) => ({
        ...prev,
        status,
        pairedDevices: devices,
        error: null,
      }));
    } catch (err) {
      // Don't overwrite state on polling errors, just log
      console.warn('[RemoteAccess] Status refresh failed:', err);
    }
  }, []);

  // --------------------------------------------------------------------------
  // Enable Remote Access
  // --------------------------------------------------------------------------

  const enableRemoteAccess = useCallback(
    async (config: EnableRemoteRequest) => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));
      try {
        const status = await invoke<RemoteStatus>('enable_remote_access_cmd', {
          request: config,
        });
        setState((prev) => ({
          ...prev,
          status,
          isLoading: false,
        }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: String(err),
        }));
      }
    },
    [],
  );

  // --------------------------------------------------------------------------
  // Disable Remote Access
  // --------------------------------------------------------------------------

  const disableRemoteAccess = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      await invoke('disable_remote_access_cmd');
      setState((prev) => ({
        ...prev,
        status: prev.status ? { ...prev.status, enabled: false, relayConnected: false, activeConnections: 0, sessions: [] } : null,
        pairingCode: null,
        pairingCodeExpiry: null,
        isLoading: false,
      }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: String(err),
      }));
    }
  }, []);

  // --------------------------------------------------------------------------
  // Generate Pairing Code
  // --------------------------------------------------------------------------

  const generatePairingCode = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      await invoke('generate_pairing_code_cmd');
      // Code will arrive via event, so just clear loading
      setState((prev) => ({ ...prev, isLoading: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: String(err),
      }));
    }
  }, []);

  // --------------------------------------------------------------------------
  // Submit Pairing Code (connect to host)
  // --------------------------------------------------------------------------

  const submitPairingCode = useCallback(
    async (code: string, deviceName: string) => {
      setState((prev) => ({ ...prev, isLoading: true, error: null, pairResult: null }));
      try {
        await invoke('submit_pairing_code_cmd', { code, deviceName });
        // Result will arrive via remote:pair_result event
        setState((prev) => ({ ...prev, isLoading: false }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: String(err),
        }));
      }
    },
    [],
  );

  // --------------------------------------------------------------------------
  // Revoke Device
  // --------------------------------------------------------------------------

  const revokeDevice = useCallback(
    async (deviceId: string) => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));
      try {
        await invoke('revoke_remote_device_cmd', { deviceId });
        // Refresh device list
        const devices = await invoke<PairedDeviceSummary[]>('get_paired_devices_cmd');
        setState((prev) => ({
          ...prev,
          pairedDevices: devices,
          isLoading: false,
        }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: String(err),
        }));
      }
    },
    [],
  );

  // --------------------------------------------------------------------------
  // Update Relay Config
  // --------------------------------------------------------------------------

  const updateRelayConfig = useCallback(
    async (config: EnableRemoteRequest) => {
      setState((prev) => ({ ...prev, isLoading: true, error: null }));
      try {
        const status = await invoke<RemoteStatus>('update_relay_config_cmd', {
          request: config,
        });
        setState((prev) => ({
          ...prev,
          status,
          isLoading: false,
        }));
      } catch (err) {
        setState((prev) => ({
          ...prev,
          isLoading: false,
          error: String(err),
        }));
      }
    },
    [],
  );

  // --------------------------------------------------------------------------
  // Clear Error
  // --------------------------------------------------------------------------

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  const clearPairResult = useCallback(() => {
    setState((prev) => ({ ...prev, pairResult: null }));
  }, []);

  // --------------------------------------------------------------------------
  // Event Listeners
  // --------------------------------------------------------------------------

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    // Listen for status updates from gateway
    listen<RemoteStatus>('remote:status_update', (event) => {
      setState((prev) => ({ ...prev, status: event.payload }));
    }).then((unlisten) => unlisteners.push(unlisten));

    // Listen for pairing codes
    listen<PairingCodeEvent>('remote:pairing_code', (event) => {
      setState((prev) => ({
        ...prev,
        pairingCode: event.payload.code,
        pairingCodeExpiry: event.payload.expiresInSeconds,
      }));

      // Start countdown timer
      if (pairingTimerRef.current) clearInterval(pairingTimerRef.current);
      pairingTimerRef.current = setInterval(() => {
        setState((prev) => {
          if (prev.pairingCodeExpiry === null || prev.pairingCodeExpiry <= 1) {
            if (pairingTimerRef.current) clearInterval(pairingTimerRef.current);
            return { ...prev, pairingCode: null, pairingCodeExpiry: null };
          }
          return { ...prev, pairingCodeExpiry: prev.pairingCodeExpiry - 1 };
        });
      }, 1000);
    }).then((unlisten) => unlisteners.push(unlisten));

    // Listen for device connections
    listen<DeviceConnectedEvent>('remote:device_connected', () => {
      refreshStatus();
    }).then((unlisten) => unlisteners.push(unlisten));

    // Listen for device disconnections
    listen<DeviceDisconnectedEvent>('remote:device_disconnected', () => {
      refreshStatus();
    }).then((unlisten) => unlisteners.push(unlisten));

    // Listen for relay connection state changes
    listen('remote:relay_connected', () => {
      refreshStatus();
    }).then((unlisten) => unlisteners.push(unlisten));

    listen('remote:relay_disconnected', () => {
      setState((prev) => ({
        ...prev,
        status: prev.status ? { ...prev.status, relayConnected: false } : null,
      }));
    }).then((unlisten) => unlisteners.push(unlisten));

    // Listen for pair result (response after submitting a pairing code)
    listen<PairResultEvent>('remote:pair_result', (event) => {
      setState((prev) => ({
        ...prev,
        pairResult: event.payload,
      }));
      if (event.payload.success) {
        refreshStatus();
      }
    }).then((unlisten) => unlisteners.push(unlisten));

    // Initial status fetch
    refreshStatus();

    return () => {
      unlisteners.forEach((unlisten) => unlisten());
      if (pairingTimerRef.current) clearInterval(pairingTimerRef.current);
    };
  }, [refreshStatus]);

  // --------------------------------------------------------------------------
  // Polling (when enabled)
  // --------------------------------------------------------------------------

  useEffect(() => {
    if (state.status?.enabled) {
      pollTimerRef.current = setInterval(refreshStatus, STATUS_POLL_INTERVAL);
    } else {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    }

    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [state.status?.enabled, refreshStatus]);

  // --------------------------------------------------------------------------
  // Return
  // --------------------------------------------------------------------------

  return {
    ...state,
    enableRemoteAccess,
    disableRemoteAccess,
    generatePairingCode,
    submitPairingCode,
    revokeDevice,
    updateRelayConfig,
    refreshStatus,
    clearError,
    clearPairResult,
  };
}
