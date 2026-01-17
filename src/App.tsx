import React, { useState, useEffect } from 'react';
import { Home, Settings, Database, Activity } from 'lucide-react';

// TypeScript Interfaces
interface HomeData {
  message: string;
  version: string;
}

interface SettingsData {
  theme: 'dark' | 'light';
  notifications: boolean;
  autoSave: boolean;
}

interface DatabaseItem {
  id: number;
  name: string;
  status: 'active' | 'pending' | 'complete';
}

interface ActivityLog {
  timestamp: string;
  action: string;
}

interface Tab {
  id: string;
  label: string;
  icon: React.ComponentType<{ size?: number }>;
}

interface SaveSettingsArgs {
  settings: SettingsData;
}

// Simulated Tauri invoke function (replace with actual @tauri-apps/api in real app)
const invoke = async <T,>(cmd: string, args: Record<string, any> = {}): Promise<T> => {
  // Simulate backend responses
  await new Promise(resolve => setTimeout(resolve, 100));
  
  switch(cmd) {
    case 'get_home_data':
      return { message: 'Welcome to the Tauri App!', version: '1.0.0' } as T;
    case 'get_settings':
      return { theme: 'dark', notifications: true, autoSave: false } as T;
    case 'save_settings':
      return { success: true } as T;
    case 'get_database_items':
      return [
        { id: 1, name: 'Item 1', status: 'active' },
        { id: 2, name: 'Item 2', status: 'pending' },
        { id: 3, name: 'Item 3', status: 'complete' }
      ] as T;
    case 'get_activity_log':
      return [
        { timestamp: '2025-01-14 10:30', action: 'User logged in' },
        { timestamp: '2025-01-14 10:35', action: 'Settings updated' },
        { timestamp: '2025-01-14 10:40', action: 'Data synchronized' }
      ] as T;
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
};

// Home Tab Component
const HomeTab: React.FC = () => {
  const [data, setData] = useState<HomeData | null>(null);

  useEffect(() => {
    invoke<HomeData>('get_home_data').then(setData);
  }, []);

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
        <Home size={28} />
        Home
      </h2>
      {data ? (
        <div className="space-y-4">
          <p className="text-lg">{data.message}</p>
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <p className="text-sm text-gray-600">App Version: {data.version}</p>
          </div>
          <div className="mt-6">
            <h3 className="font-semibold mb-2">Quick Stats</h3>
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-white border rounded-lg p-4 text-center">
                <div className="text-3xl font-bold text-blue-600">24</div>
                <div className="text-sm text-gray-600">Total Items</div>
              </div>
              <div className="bg-white border rounded-lg p-4 text-center">
                <div className="text-3xl font-bold text-green-600">18</div>
                <div className="text-sm text-gray-600">Active</div>
              </div>
              <div className="bg-white border rounded-lg p-4 text-center">
                <div className="text-3xl font-bold text-orange-600">6</div>
                <div className="text-sm text-gray-600">Pending</div>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <p>Loading...</p>
      )}
    </div>
  );
};

// Settings Tab Component
const SettingsTab: React.FC = () => {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [saved, setSaved] = useState<boolean>(false);

  useEffect(() => {
    invoke<SettingsData>('get_settings').then(setSettings);
  }, []);

  const handleSave = async (): Promise<void> => {
    if (!settings) return;
    await invoke<{ success: boolean }>('save_settings', { settings });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const toggleSetting = (key: keyof SettingsData): void => {
    setSettings(prev => {
      if (!prev) return null;
      return { ...prev, [key]: !prev[key] };
    });
  };

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
        <Settings size={28} />
        Settings
      </h2>
      {settings ? (
        <div className="space-y-4 max-w-md">
          <div className="bg-white border rounded-lg p-4">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="font-medium">Dark Theme</span>
              <input
                type="checkbox"
                checked={settings.theme === 'dark'}
                onChange={() => setSettings(prev => {
                  if (!prev) return null;
                  return { 
                    ...prev, 
                    theme: prev.theme === 'dark' ? 'light' : 'dark' 
                  };
                })}
                className="w-5 h-5"
              />
            </label>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="font-medium">Enable Notifications</span>
              <input
                type="checkbox"
                checked={settings.notifications}
                onChange={() => toggleSetting('notifications')}
                className="w-5 h-5"
              />
            </label>
          </div>
          <div className="bg-white border rounded-lg p-4">
            <label className="flex items-center justify-between cursor-pointer">
              <span className="font-medium">Auto Save</span>
              <input
                type="checkbox"
                checked={settings.autoSave}
                onChange={() => toggleSetting('autoSave')}
                className="w-5 h-5"
              />
            </label>
          </div>
          <button
            onClick={handleSave}
            className="w-full bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors"
          >
            {saved ? '✓ Saved!' : 'Save Settings'}
          </button>
        </div>
      ) : (
        <p>Loading...</p>
      )}
    </div>
  );
};

// Data Tab Component
const DataTab: React.FC = () => {
  const [items, setItems] = useState<DatabaseItem[]>([]);

  useEffect(() => {
    invoke<DatabaseItem[]>('get_database_items').then(setItems);
  }, []);

  const getStatusColor = (status: DatabaseItem['status']): string => {
    switch(status) {
      case 'active': return 'bg-green-100 text-green-800';
      case 'pending': return 'bg-yellow-100 text-yellow-800';
      case 'complete': return 'bg-blue-100 text-blue-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
        <Database size={28} />
        Database Items
      </h2>
      <div className="space-y-2">
        {items.map(item => (
          <div key={item.id} className="bg-white border rounded-lg p-4 flex items-center justify-between">
            <div>
              <h3 className="font-semibold">{item.name}</h3>
              <p className="text-sm text-gray-500">ID: {item.id}</p>
            </div>
            <span className={`px-3 py-1 rounded-full text-sm font-medium ${getStatusColor(item.status)}`}>
              {item.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Activity Tab Component
const ActivityTab: React.FC = () => {
  const [logs, setLogs] = useState<ActivityLog[]>([]);

  useEffect(() => {
    invoke<ActivityLog[]>('get_activity_log').then(setLogs);
  }, []);

  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4 flex items-center gap-2">
        <Activity size={28} />
        Activity Log
      </h2>
      <div className="space-y-2">
        {logs.map((log, idx) => (
          <div key={idx} className="bg-white border-l-4 border-blue-500 rounded p-4">
            <p className="font-medium">{log.action}</p>
            <p className="text-sm text-gray-500">{log.timestamp}</p>
          </div>
        ))}
      </div>
    </div>
  );
};

// Main App Component
const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>('home');

  const tabs: Tab[] = [
    { id: 'home', label: 'Home', icon: Home },
    { id: 'data', label: 'Data', icon: Database },
    { id: 'settings', label: 'Settings', icon: Settings },
    { id: 'activity', label: 'Activity', icon: Activity }
  ];

  const renderTabContent = (): React.ReactNode => {
    switch(activeTab) {
      case 'home': return <HomeTab />;
      case 'settings': return <SettingsTab />;
      case 'data': return <DataTab />;
      case 'activity': return <ActivityTab />;
      default: return <HomeTab />;
    }
  };

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* Tab Bar */}
      <div className="bg-white border-b shadow-sm">
        <div className="flex">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-2 px-6 py-4 font-medium transition-colors border-b-2 ${
                  activeTab === tab.id
                    ? 'border-blue-600 text-blue-600 bg-blue-50'
                    : 'border-transparent text-gray-600 hover:text-gray-900 hover:bg-gray-50'
                }`}
              >
                <Icon size={20} />
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-auto">
        {renderTabContent()}
      </div>
    </div>
  );
};

export default App;