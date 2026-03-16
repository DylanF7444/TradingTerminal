// ============================================================================
// REMOTE ACCESS PANEL COMPONENT
// ============================================================================
//
// Module: components/Remote/RemoteAccessPanel.tsx
// Purpose: UI panel for managing remote desktop gateway connections
//
// OVERVIEW:
// Provides a settings panel within the SettingsModal for enabling/disabling
// remote access to the trading terminal. Users can configure a relay server
// URL, generate pairing codes for device enrollment, monitor connected
// devices, and revoke access to paired devices.
//
// ARCHITECTURE:
//   Uses the useRemoteAccess() hook for all state and operations.
//   Integrates into the existing SettingsModal alongside ApiKeySettings.
//
// FEATURES:
//   - Toggle remote access on/off
//   - Configure relay server URL
//   - Generate and display 6-digit pairing codes
//   - List paired devices with revoke capability
//   - Monitor active sessions and transfer stats
//   - Connection status indicator (relay connected/disconnected)
//
// UI SECTIONS:
//   1. Gateway Toggle (enable/disable with relay URL input)
//   2. Pairing Code Display (large digits, countdown timer)
//   3. Connected Devices List (with revoke buttons)
//   4. Session Statistics (bytes transferred, uptime)
// ============================================================================

import { useState } from 'react';
import { useRemoteAccess } from '../../hooks/useRemoteAccess';
import type { EnableRemoteRequest } from '../../types/remote';

// ============================================================================
// COMPONENT
// ============================================================================

/**
 * Remote access management panel.
 *
 * Designed to be rendered inside the SettingsModal alongside other settings
 * panels (like ApiKeySettings). Provides full control over the remote
 * desktop gateway feature.
 */
export function RemoteAccessPanel() {
  const {
    status,
    pairedDevices,
    pairingCode,
    pairingCodeExpiry,
    pairResult,
    relayError,
    isLoading,
    error,
    enableRemoteAccess,
    disableRemoteAccess,
    generatePairingCode,
    submitPairingCode,
    revokeDevice,
    clearError,
    clearPairResult,
  } = useRemoteAccess();

  const [relayUrl, setRelayUrl] = useState('wss://localhost:9090/ws');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [heartbeatSecs, setHeartbeatSecs] = useState(30);
  const [sessionTimeoutSecs, setSessionTimeoutSecs] = useState(300);
  const [joinCode, setJoinCode] = useState('');
  const [joinDeviceName, setJoinDeviceName] = useState('');

  // --------------------------------------------------------------------------
  // Handlers
  // --------------------------------------------------------------------------

  const handleToggle = async () => {
    if (status?.enabled) {
      await disableRemoteAccess();
    } else {
      const config: EnableRemoteRequest = {
        relayUrl,
        heartbeatIntervalSecs: heartbeatSecs,
        sessionTimeoutSecs,
      };
      await enableRemoteAccess(config);
    }
  };

  const handleGeneratePairingCode = async () => {
    await generatePairingCode();
  };

  const handleRevokeDevice = async (deviceId: string) => {
    if (confirm('Revoke access for this device? It will need to re-pair.')) {
      await revokeDevice(deviceId);
    }
  };

  const handleSubmitJoinCode = async () => {
    if (joinCode.length !== 6) return;
    const name = joinDeviceName.trim() || 'Remote Device';
    await submitPairingCode(joinCode, name);
    setJoinCode('');
  };

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  /** Format bytes into human-readable string */
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  };

  /** Format seconds into human-readable uptime string */
  const formatUptime = (seconds: number): string => {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  /** Format timestamp to relative time */
  const formatRelativeTime = (timestamp: number): string => {
    const diff = Date.now() - timestamp;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  const isEnabled = status?.enabled ?? false;
  const isRelayConnected = status?.relayConnected ?? false;

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Section Header */}
      <div>
        <h3 className="text-sm font-semibold text-gray-200 uppercase tracking-wider mb-1">
          Remote Access
        </h3>
        <p className="text-xs text-gray-500">
          Access your trading terminal from remote devices via a WebSocket relay.
        </p>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="bg-red-900/30 border border-red-800 rounded-lg px-4 py-3 flex items-start gap-3">
          <svg className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <div className="flex-1">
            <p className="text-sm text-red-300">{error}</p>
          </div>
          <button onClick={clearError} className="text-red-400 hover:text-red-300">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Gateway Toggle Section */}
      <div className="bg-gray-800/50 rounded-lg p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Connection Status Indicator */}
            <div
              className={`w-3 h-3 rounded-full ${
                isEnabled && isRelayConnected
                  ? 'bg-green-400 shadow-lg shadow-green-400/30'
                  : isEnabled && relayError
                  ? 'bg-red-400'
                  : isEnabled
                  ? 'bg-yellow-400 animate-pulse'
                  : 'bg-gray-600'
              }`}
            />
            <div>
              <h4 className="text-sm font-medium text-gray-200">Remote Gateway</h4>
              <p className="text-xs text-gray-500">
                {isEnabled && isRelayConnected
                  ? 'Connected to relay'
                  : isEnabled && relayError
                  ? 'Connection failed'
                  : isEnabled
                  ? 'Connecting...'
                  : 'Disabled'}
              </p>
            </div>
          </div>

          {/* Toggle Button */}
          <button
            onClick={handleToggle}
            disabled={isLoading}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-gray-900 ${
              isEnabled ? 'bg-blue-600' : 'bg-gray-600'
            } ${isLoading ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                isEnabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        {/* Relay URL Input */}
        {!isEnabled && (
          <div>
            <label className="block text-xs text-gray-400 mb-1.5">Relay Server URL</label>
            <input
              type="text"
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
              placeholder="wss://relay.example.com/ws"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            />
          </div>
        )}

        {/* Advanced Settings Toggle */}
        {!isEnabled && (
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1"
          >
            <svg
              className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
            Advanced Settings
          </button>
        )}

        {/* Advanced Settings */}
        {!isEnabled && showAdvanced && (
          <div className="space-y-3 pl-4 border-l-2 border-gray-700">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Heartbeat Interval (seconds)</label>
              <input
                type="number"
                value={heartbeatSecs}
                onChange={(e) => setHeartbeatSecs(Number(e.target.value))}
                min={5}
                max={120}
                className="w-24 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Session Timeout (seconds)</label>
              <input
                type="number"
                value={sessionTimeoutSecs}
                onChange={(e) => setSessionTimeoutSecs(Number(e.target.value))}
                min={60}
                max={3600}
                className="w-24 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>
        )}
      </div>

      {/* Relay Connection Error */}
      {isEnabled && relayError && (
        <div className="bg-red-900/20 border border-red-800/50 rounded-lg px-4 py-3">
          <p className="text-xs text-red-400 font-medium mb-1">Relay Connection Error</p>
          <p className="text-xs text-red-300/80">{relayError}</p>
          <p className="text-xs text-gray-500 mt-2">
            The relay server may not be running. Reconnection will be attempted automatically.
          </p>
        </div>
      )}

      {/* Device ID Display (when enabled) */}
      {isEnabled && status && (
        <div className="bg-gray-800/50 rounded-lg p-4">
          <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-2">Device ID</h4>
          <div className="flex items-center gap-2">
            <code className="text-xs text-blue-400 bg-gray-900 px-2 py-1 rounded font-mono flex-1 truncate">
              {status.deviceId}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(status.deviceId)}
              className="p-1 hover:bg-gray-700 rounded text-gray-400 hover:text-gray-200"
              title="Copy device ID"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Pairing Code Section */}
      {isEnabled && (
        <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
              Device Pairing
            </h4>
            <button
              onClick={handleGeneratePairingCode}
              disabled={isLoading || !!pairingCode}
              className="text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white px-3 py-1 rounded-lg transition-colors"
            >
              {pairingCode ? 'Code Active' : 'Generate Code'}
            </button>
          </div>

          {pairingCode && (
            <div className="text-center py-4">
              <div className="text-4xl font-mono font-bold text-white tracking-[0.5em] mb-2">
                {pairingCode}
              </div>
              <p className="text-xs text-gray-500">
                {pairingCodeExpiry !== null
                  ? `Expires in ${Math.floor(pairingCodeExpiry / 60)}:${String(pairingCodeExpiry % 60).padStart(2, '0')}`
                  : 'Enter this code on your remote device'}
              </p>
            </div>
          )}

          {!pairingCode && (
            <p className="text-xs text-gray-500">
              Generate a 6-digit code to pair a new remote device. The code is valid for 5 minutes.
            </p>
          )}
        </div>
      )}

      {/* Connect to Host Device Section */}
      {isEnabled && (
        <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
          <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
            Connect to Host
          </h4>
          <p className="text-xs text-gray-500">
            Enter the 6-digit code displayed on the host device to connect.
          </p>

          <div className="space-y-2">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Device Name</label>
              <input
                type="text"
                value={joinDeviceName}
                onChange={(e) => setJoinDeviceName(e.target.value)}
                placeholder="My Device"
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Pairing Code</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={joinCode}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setJoinCode(val);
                  }}
                  placeholder="000000"
                  maxLength={6}
                  className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-lg font-mono text-center text-gray-200 placeholder-gray-600 tracking-[0.3em] focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                />
                <button
                  onClick={handleSubmitJoinCode}
                  disabled={isLoading || joinCode.length !== 6}
                  className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                >
                  Connect
                </button>
              </div>
            </div>
          </div>

          {/* Pair Result Feedback */}
          {pairResult && (
            <div className={`rounded-lg px-3 py-2 flex items-center justify-between ${
              pairResult.success
                ? 'bg-green-900/30 border border-green-800'
                : 'bg-red-900/30 border border-red-800'
            }`}>
              <p className={`text-xs ${pairResult.success ? 'text-green-300' : 'text-red-300'}`}>
                {pairResult.success
                  ? 'Successfully paired with host device!'
                  : pairResult.error || 'Pairing failed. Check the code and try again.'}
              </p>
              <button onClick={clearPairResult} className="text-gray-400 hover:text-gray-200 ml-2">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Connected Devices / Sessions */}
      {isEnabled && status && (
        <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
          <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
            Connected Devices ({status.activeConnections})
          </h4>

          {status.sessions.length === 0 ? (
            <p className="text-xs text-gray-600 italic">No devices connected</p>
          ) : (
            <div className="space-y-2">
              {status.sessions.map((session) => (
                <div
                  key={session.id}
                  className="flex items-center justify-between bg-gray-900 rounded-lg px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2 h-2 rounded-full ${
                        session.status === 'connected'
                          ? 'bg-green-400'
                          : session.status === 'connecting'
                          ? 'bg-yellow-400 animate-pulse'
                          : 'bg-red-400'
                      }`}
                    />
                    <div>
                      <p className="text-sm text-gray-200">{session.deviceName}</p>
                      <p className="text-xs text-gray-500">
                        {formatRelativeTime(session.connectedAt)} · {formatBytes(session.bytesTransferred)}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Paired Devices List */}
      {pairedDevices.length > 0 && (
        <div className="bg-gray-800/50 rounded-lg p-4 space-y-3">
          <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider">
            Paired Devices ({pairedDevices.length})
          </h4>
          <div className="space-y-2">
            {pairedDevices.map((device) => (
              <div
                key={device.deviceId}
                className="flex items-center justify-between bg-gray-900 rounded-lg px-3 py-2"
              >
                <div>
                  <p className="text-sm text-gray-200">{device.deviceName}</p>
                  <p className="text-xs text-gray-500">
                    Paired {formatRelativeTime(device.pairedAt)}
                    {device.lastAuthAt && ` · Last seen ${formatRelativeTime(device.lastAuthAt)}`}
                  </p>
                </div>
                <button
                  onClick={() => handleRevokeDevice(device.deviceId)}
                  className="text-xs text-red-400 hover:text-red-300 hover:bg-red-900/20 px-2 py-1 rounded"
                  title="Revoke device access"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Statistics (when enabled) */}
      {isEnabled && status && (
        <div className="bg-gray-800/50 rounded-lg p-4">
          <h4 className="text-xs font-medium text-gray-400 uppercase tracking-wider mb-3">
            Gateway Statistics
          </h4>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-gray-500">Uptime</p>
              <p className="text-sm text-gray-200 font-mono">{formatUptime(status.uptimeSeconds)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Data Transferred</p>
              <p className="text-sm text-gray-200 font-mono">{formatBytes(status.totalBytesTransferred)}</p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Relay Server</p>
              <p className="text-sm text-gray-200 font-mono truncate" title={status.relayUrl}>
                {status.relayUrl ? new URL(status.relayUrl).hostname : 'N/A'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Active Sessions</p>
              <p className="text-sm text-gray-200 font-mono">{status.activeConnections}</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default RemoteAccessPanel;
