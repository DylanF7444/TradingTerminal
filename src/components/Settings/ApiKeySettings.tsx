// ============================================================================
// API KEY SETTINGS COMPONENT
// ============================================================================
//
// Module: components/Settings/ApiKeySettings.tsx
// Purpose: UI for managing stored API keys for trading platforms
//
// OVERVIEW:
// This component provides a settings interface for storing and managing
// API credentials for Polymarket and Kalshi. Keys are stored securely in
// the backend database and can be reused when adding new markets.
//
// FEATURES:
// - View which platforms have stored credentials
// - Add/update API keys for each platform
// - Delete stored credentials
// - Platform-specific forms (different fields for Polymarket vs Kalshi)
// - Secure password input with visibility toggle
//
// SECURITY:
// - Keys are only transmitted over Tauri IPC (secure)
// - Keys are never stored in localStorage or React state after submit
// - Input fields use type="password" by default
// - Keys are cleared from form after successful save
//
// ============================================================================

import { useState, useEffect } from 'react';
import { 
  Key, 
  Eye, 
  EyeOff, 
  Save, 
  Trash2, 
  Plus, 
  CheckCircle2, 
  AlertCircle, 
  Loader2,
  Shield,
  Wallet,
  TrendingUp
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';

// ============================================================================
// TYPES
// ============================================================================

interface ApiKeySummary {
  platform: string;
  has_key: boolean;
  has_api_key: boolean;
  has_api_secret: boolean;
  has_private_key: boolean;
  environment: string;
  created_at: number;
  updated_at: number;
}

interface ApiKeyResponse {
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

interface SaveApiKeyRequest {
  platform: string;
  api_key: string;
  api_secret: string | null;
  private_key: string | null;
  environment: string | null;
  additional_config: Record<string, unknown> | null;
}

interface PlatformConfig {
  name: string;
  color: string;
  bgColor: string;
  icon: React.ElementType;
  description: string;
  fields: Array<{
    key: string;
    label: string;
    placeholder: string;
    required: boolean;
    helpText: string;
  }>;
}

// ============================================================================
// PLATFORM CONFIGURATIONS
// ============================================================================

const PLATFORM_CONFIGS: Record<string, PlatformConfig> = {
  Polymarket: {
    name: 'Polymarket',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500',
    icon: Wallet,
    description: 'Polygon-based prediction market. Trade on crypto, politics, sports outcomes.',
    fields: [
      {
        key: 'api_key',
        label: 'API Key',
        placeholder: 'pm_...',
        required: true,
        helpText: 'From Polymarket API settings page'
      },
      {
        key: 'private_key',
        label: 'Proxy Wallet Private Key',
        placeholder: '0x...',
        required: false,
        helpText: 'Optional. Required for signing transactions on-chain'
      }
    ]
  },
  Kalshi: {
    name: 'Kalshi',
    color: 'text-emerald-400',
    bgColor: 'bg-emerald-500',
    icon: TrendingUp,
    description: 'Regulated US exchange for event contracts. Financial and political markets.',
    fields: [
      {
        key: 'api_key',
        label: 'API Key ID',
        placeholder: 'your-api-key-id',
        required: true,
        helpText: 'From Kalshi API dashboard (Key ID)'
      },
      {
        key: 'private_key',
        label: 'RSA Private Key (PEM)',
        placeholder: '-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----',
        required: true,
        helpText: 'Private key for RSA-PSS signing. Keep this secure!'
      }
    ]
  }
};

// ============================================================================
// COMPONENT
// ============================================================================

export default function ApiKeySettings() {
  // State
  const [apiKeys, setApiKeys] = useState<ApiKeySummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  
  // Form state
  const [editingPlatform, setEditingPlatform] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [environment, setEnvironment] = useState<'demo' | 'production'>('demo');
  const [showPasswords, setShowPasswords] = useState<Record<string, boolean>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Load API keys on mount
  useEffect(() => {
    loadApiKeys();
  }, []);

  // Auto-clear messages after 5 seconds
  useEffect(() => {
    if (error || success) {
      const timer = setTimeout(() => {
        setError(null);
        setSuccess(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [error, success]);

  // Load all API keys
  const loadApiKeys = async () => {
    setIsLoading(true);
    setError(null);
    
    try {
      const keys = await invoke<ApiKeySummary[]>('get_all_api_keys_cmd');
      setApiKeys(keys);
    } catch (err) {
      console.error('Failed to load API keys:', err);
      setError('Failed to load API keys. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  // Start editing a platform
  const handleEdit = async (platform: string) => {
    setEditingPlatform(platform);
    setError(null);
    setSuccess(null);
    
    // Load existing credentials if available
    try {
      const keyResponse = await invoke<ApiKeyResponse>('get_api_key_cmd', { platform });
      
      if (keyResponse.has_key) {
        setCredentials({
          api_key: keyResponse.api_key || '',
          api_secret: keyResponse.api_secret || '',
          private_key: keyResponse.private_key || ''
        });
        setEnvironment((keyResponse.environment as 'demo' | 'production') || 'demo');
      } else {
        // Clear form for new entry
        const config = PLATFORM_CONFIGS[platform];
        const emptyCreds: Record<string, string> = {};
        config.fields.forEach(f => {
          emptyCreds[f.key] = '';
        });
        setCredentials(emptyCreds);
        setEnvironment('demo');
      }
    } catch (err) {
      console.error('Failed to load API key:', err);
      // Initialize with empty form
      const config = PLATFORM_CONFIGS[platform];
      const emptyCreds: Record<string, string> = {};
      config.fields.forEach(f => {
        emptyCreds[f.key] = '';
      });
      setCredentials(emptyCreds);
      setEnvironment('demo');
    }
  };

  // Cancel editing
  const handleCancel = () => {
    setEditingPlatform(null);
    setCredentials({});
    setShowPasswords({});
    setDeleteConfirm(null);
  };

  // Toggle password visibility
  const togglePasswordVisibility = (fieldKey: string) => {
    setShowPasswords(prev => ({ ...prev, [fieldKey]: !prev[fieldKey] }));
  };

  // Handle credential input change
  const handleCredentialChange = (key: string, value: string) => {
    setCredentials(prev => ({ ...prev, [key]: value }));
    setError(null);
  };

  // Save API key
  const handleSave = async () => {
    if (!editingPlatform) return;
    
    const config = PLATFORM_CONFIGS[editingPlatform];
    
    // Validate required fields
    for (const field of config.fields) {
      if (field.required && !credentials[field.key]?.trim()) {
        setError(`${field.label} is required`);
        return;
      }
    }
    
    setIsSaving(true);
    setError(null);
    
    try {
      const request: SaveApiKeyRequest = {
        platform: editingPlatform,
        api_key: credentials.api_key || '',
        api_secret: credentials.api_secret || null,
        private_key: credentials.private_key || null,
        environment: environment,
        additional_config: null
      };
      
      await invoke('save_api_key_cmd', { request });
      
      setSuccess(`${config.name} API key saved successfully`);
      setEditingPlatform(null);
      setCredentials({});
      setShowPasswords({});
      
      // Reload list
      await loadApiKeys();
    } catch (err) {
      console.error('Failed to save API key:', err);
      setError(String(err) || 'Failed to save API key');
    } finally {
      setIsSaving(false);
    }
  };

  // Delete API key
  const handleDelete = async (platform: string) => {
    if (deleteConfirm !== platform) {
      setDeleteConfirm(platform);
      return;
    }
    
    setIsSaving(true);
    setError(null);
    
    try {
      await invoke('delete_api_key_cmd', { platform });
      setSuccess(`${PLATFORM_CONFIGS[platform].name} API key deleted`);
      setDeleteConfirm(null);
      
      // Reload list
      await loadApiKeys();
    } catch (err) {
      console.error('Failed to delete API key:', err);
      setError('Failed to delete API key');
    } finally {
      setIsSaving(false);
    }
  };

  // Get stored key info
  const getStoredKeyInfo = (platform: string): ApiKeySummary | undefined => {
    return apiKeys.find(k => k.platform === platform);
  };

  // Format timestamp
  const formatTimestamp = (timestamp: number): string => {
    return new Date(timestamp * 1000).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  // Loading state
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
        <span className="ml-2 text-gray-400">Loading API keys...</span>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Shield className="w-5 h-5 text-blue-400" />
        <h2 className="text-lg font-semibold text-white">API Keys</h2>
      </div>

      {/* Description */}
      <p className="text-sm text-gray-400">
        Store your API credentials securely for quick access when adding markets.
        Keys are encrypted and stored locally on your device.
      </p>

      {/* Error/Success Messages */}
      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
          <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
          <span className="text-sm text-red-400">{error}</span>
        </div>
      )}

      {success && (
        <div className="flex items-center gap-2 p-3 bg-green-500/10 border border-green-500/30 rounded-lg">
          <CheckCircle2 className="w-4 h-4 text-green-400 flex-shrink-0" />
          <span className="text-sm text-green-400">{success}</span>
        </div>
      )}

      {/* Platform Cards */}
      <div className="space-y-4">
        {Object.entries(PLATFORM_CONFIGS).map(([platformKey, config]) => {
          const storedKey = getStoredKeyInfo(platformKey);
          const isEditing = editingPlatform === platformKey;
          const Icon = config.icon;

          return (
            <div
              key={platformKey}
              className="bg-gray-800/50 border border-gray-700 rounded-lg overflow-hidden"
            >
              {/* Platform Header */}
              <div className="flex items-center justify-between p-4 border-b border-gray-700">
                <div className="flex items-center gap-3">
                  <div className={`p-2 rounded-lg ${config.bgColor}/20`}>
                    <Icon className={`w-5 h-5 ${config.color}`} />
                  </div>
                  <div>
                    <h3 className="font-medium text-white">{config.name}</h3>
                    <p className="text-xs text-gray-500">{config.description}</p>
                  </div>
                </div>

                {/* Status & Actions */}
                <div className="flex items-center gap-3">
                  {storedKey ? (
                    <>
                      <div className="flex items-center gap-2 text-sm">
                        <CheckCircle2 className="w-4 h-4 text-green-400" />
                        <span className="text-gray-400">
                          {config.name === 'Kalshi' ? (
                            <span className="capitalize">{storedKey.environment}</span>
                          ) : (
                            'Configured'
                          )}
                        </span>
                        <span className="text-gray-600">•</span>
                        <span className="text-gray-500">
                          Updated {formatTimestamp(storedKey.updated_at)}
                        </span>
                      </div>
                      <button
                        onClick={() => handleEdit(platformKey)}
                        className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
                        title="Edit credentials"
                      >
                        <Key className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(platformKey)}
                        className={`p-2 rounded-lg transition-colors ${
                          deleteConfirm === platformKey
                            ? 'text-red-400 bg-red-500/20 hover:bg-red-500/30'
                            : 'text-gray-400 hover:text-red-400 hover:bg-gray-700'
                        }`}
                        title={deleteConfirm === platformKey ? 'Click again to confirm' : 'Delete credentials'}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => handleEdit(platformKey)}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      Add Credentials
                    </button>
                  )}
                </div>
              </div>

              {/* Edit Form */}
              {isEditing && (
                <div className="p-4 space-y-4 bg-gray-900/50">
                  <div className="grid gap-4">
                    {config.fields.map((field) => (
                      <div key={field.key}>
                        <label className="block text-sm font-medium text-gray-300 mb-1">
                          {field.label}
                          {field.required && <span className="text-red-400 ml-1">*</span>}
                        </label>
                        <div className="relative">
                          <input
                            type={showPasswords[field.key] ? 'text' : 'password'}
                            value={credentials[field.key] || ''}
                            onChange={(e) => handleCredentialChange(field.key, e.target.value)}
                            placeholder={field.placeholder}
                            className="w-full px-3 py-2 pr-10 bg-gray-800 border border-gray-600 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                          />
                          <button
                            type="button"
                            onClick={() => togglePasswordVisibility(field.key)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-white"
                          >
                            {showPasswords[field.key] ? (
                              <EyeOff className="w-4 h-4" />
                            ) : (
                              <Eye className="w-4 h-4" />
                            )}
                          </button>
                        </div>
                        <p className="mt-1 text-xs text-gray-500">{field.helpText}</p>
                      </div>
                    ))}

                    {/* Environment selector for Kalshi */}
                    {platformKey === 'Kalshi' && (
                      <div>
                        <label className="block text-sm font-medium text-gray-300 mb-1">
                          Environment
                        </label>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setEnvironment('demo')}
                            className={`flex-1 px-3 py-2 text-sm rounded-lg transition-colors ${
                              environment === 'demo'
                                ? 'bg-blue-500 text-white'
                                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                            }`}
                          >
                            Demo (Paper Trading)
                          </button>
                          <button
                            type="button"
                            onClick={() => setEnvironment('production')}
                            className={`flex-1 px-3 py-2 text-sm rounded-lg transition-colors ${
                              environment === 'production'
                                ? 'bg-red-500 text-white'
                                : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                            }`}
                          >
                            Production (Real Money)
                          </button>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Form Actions */}
                  <div className="flex justify-end gap-2 pt-2 border-t border-gray-700">
                    <button
                      onClick={handleCancel}
                      className="px-4 py-2 text-sm text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSave}
                      disabled={isSaving}
                      className="flex items-center gap-2 px-4 py-2 text-sm text-white bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
                    >
                      {isSaving ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Save className="w-4 h-4" />
                      )}
                      Save Credentials
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Security Notice */}
      <div className="flex items-start gap-2 p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
        <Shield className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
        <div className="text-sm text-blue-300">
          <p className="font-medium">Security Notice</p>
          <p className="text-blue-400/80 mt-1">
            API keys are stored locally on your device and encrypted. Never share your credentials
            or commit them to version control.
          </p>
        </div>
      </div>
    </div>
  );
}