// ============================================================================
// PerformanceMetrics.tsx - System health and trading performance dashboard
// ============================================================================
//
// Renders a real-time metrics dashboard displaying system health (CPU,
// memory, latency, network I/O), trading performance (PnL, win rate,
// Sharpe ratio, exposure), and operational stats (trades, connections).
//
// Supports two layout modes: compact (single-row for bottom panel) and
// expanded (grid with sparkline charts for sidebar). Polls the Rust
// backend every 2s via getSystemInfo/getNetworkMetrics.
//
// Includes threshold-based alerting with configurable warning/critical
// levels and an aggregate health score (0-100).
//
// Key props: metrics, compact, alertThresholds, onAlert, className.
//
// Sub-components: Sparkline (SVG mini chart), MetricCard (stat display
// with delta indicator and optional sparkline).
//
// ============================================================================

import { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Activity, 
  TrendingUp, 
  TrendingDown, 
  Cpu, 
  HardDrive, 
  Zap,
  AlertTriangle,
  Clock,
  BarChart3,
  Wifi,
  Server,
  Network
} from 'lucide-react';
import { getSystemInfo, getNetworkMetrics, type SystemInfo } from '../../utils/api';
import { invoke } from '@tauri-apps/api/core';
import type { NetworkMetrics } from '../../types/markets';

// Date formatting utility (replaces date-fns for smaller bundle)
function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', { 
    hour12: false, 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit' 
  });
}

// Metric data interfaces
interface MetricValue {
  current: number;
  previous: number;
  history: number[]; // Last 60 values for sparkline
  unit: string;
  timestamp: Date;
}

interface PerformanceMetricsData {
  system: {
    cpu: MetricValue;
    memory: MetricValue; // MB
    diskWrites: MetricValue; // ops/sec
  };
  trading: {
    dailyPnl: MetricValue; // USD
    totalPnl: MetricValue;
    winRate: MetricValue; // percentage
    sharpeRatio: number;
    maxDrawdown: number; // percentage
    currentExposure: number; // USD at risk
  };
  latency: {
    endToEnd: MetricValue; // ms
    api: MetricValue; // ms
    websocket: MetricValue; // ms since last heartbeat
  };
  operational: {
    tradesExecuted: number;
    dataPointsCollected: number;
    activeConnections: number;
    errorRate: MetricValue; // errors/min
  };
}

interface AlertThresholds {
  latency: number; // ms
  cpu: number; // percentage
  memory: number; // MB
  errorRate: number; // errors/min
}

interface MetricAlert {
  metric: string;
  value: number;
  threshold: number;
  severity: 'warning' | 'critical';
  message: string;
  timestamp: Date;
}

interface PerformanceMetricsProps {
  metrics?: PerformanceMetricsData;
  compact?: boolean;
  alertThresholds?: Partial<AlertThresholds>;
  onAlert?: (alert: MetricAlert) => void;
  className?: string;
}

// Default thresholds
const DEFAULT_THRESHOLDS: AlertThresholds = {
  latency: 100,      // 100ms warning
  cpu: 80,           // 80% warning
  memory: 1024,      // 1GB warning
  errorRate: 10      // 10 errors/min warning
};

// Sparkline component for mini charts
interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color: string;
  fillOpacity?: number;
}

function Sparkline({ 
  data, 
  width = 60, 
  height = 20, 
  color, 
  fillOpacity = 0.2 
}: SparklineProps) {
  if (!data || data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  // Generate SVG path
  const points = data.map((value, index) => {
    const x = (index / (data.length - 1)) * width;
    const y = height - ((value - min) / range) * height;
    return `${x},${y}`;
  });

  const pathD = `M ${points.join(' L ')}`;
  const areaD = `${pathD} L ${width},${height} L 0,${height} Z`;

  return (
    <svg width={width} height={height} className="overflow-visible">
      <defs>
        <linearGradient id={`gradient-${color}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={color} stopOpacity={fillOpacity} />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path
        d={areaD}
        fill={`url(#gradient-${color})`}
      />
      <path
        d={pathD}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="transition-all duration-300 ease-out"
      />
    </svg>
  );
}

// Individual metric card component
interface MetricCardProps {
  label: string;
  value: number;
  previousValue?: number;
  unit: string;
  sparklineData?: number[];
  color?: string;
  icon?: React.ElementType;
  compact?: boolean;
  onClick?: () => void;
  alertSeverity?: 'warning' | 'critical' | null;
}

function MetricCard({
  label,
  value,
  previousValue,
  unit,
  sparklineData,
  color = 'text-gray-200',
  icon: Icon,
  compact = false,
  onClick,
  alertSeverity
}: MetricCardProps) {
  const [showTooltip, setShowTooltip] = useState(false);
  
  // Calculate delta
  const delta = previousValue !== undefined ? value - previousValue : 0;
  const deltaPercent = previousValue ? ((delta / previousValue) * 100).toFixed(1) : '0.0';
  const isPositive = delta >= 0;
  
  // Format value
  const formatValue = (val: number): string => {
    if (Math.abs(val) >= 1000000) return (val / 1000000).toFixed(1) + 'M';
    if (Math.abs(val) >= 1000) return (val / 1000).toFixed(1) + 'K';
    if (unit === '$') return val.toFixed(2);
    if (unit === '%') return val.toFixed(1);
    return val.toFixed(0);
  };

  const displayValue = formatValue(value);
  const displayDelta = `${isPositive ? '+' : ''}${formatValue(delta)}`;

  // Determine colors based on metric type and values
  const getValueColor = () => {
    if (alertSeverity === 'critical') return 'text-rose-400';
    if (alertSeverity === 'warning') return 'text-amber-400';
    if (unit === '$') return value >= 0 ? 'text-emerald-400' : 'text-rose-400';
    return color;
  };

  if (compact) {
    return (
      <div 
        className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-800/50 rounded cursor-pointer transition-colors relative"
        onClick={onClick}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
      >
        {Icon && <Icon className={`w-4 h-4 ${getValueColor()}`} />}
        <span className="text-xs text-gray-400">{label}:</span>
        <span className={`text-sm font-mono font-medium ${getValueColor()} tabular-nums`}>
          {unit === '$' && '$'}{displayValue}{unit && unit !== '$' && unit}
        </span>
        {previousValue !== undefined && (
          <span className={`text-[10px] ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
            {displayDelta}
          </span>
        )}
        
        {/* Tooltip */}
        {showTooltip && (
          <div className="absolute bottom-full left-0 mb-2 px-2 py-1 bg-gray-800 text-xs text-gray-300 rounded shadow-lg whitespace-nowrap z-50">
            {label}: {displayValue}{unit} ({delta > 0 ? '↑' : '↓'} {Math.abs(Number(deltaPercent))}%)
          </div>
        )}
      </div>
    );
  }

  return (
    <div 
      className={`
        p-3 rounded-lg bg-gray-800/50 border border-gray-700/50
        hover:bg-gray-800 hover:border-gray-600 transition-all cursor-pointer
        ${alertSeverity === 'critical' ? 'ring-1 ring-rose-500/50 bg-rose-950/10' : ''}
      `}
      onClick={onClick}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          {Icon && <Icon className={`w-4 h-4 ${getValueColor()}`} />}
          <span className="text-xs text-gray-400 uppercase tracking-wider">{label}</span>
        </div>
        {alertSeverity && (
          <AlertTriangle className={`w-3 h-3 ${alertSeverity === 'critical' ? 'text-rose-400' : 'text-amber-400'}`} />
        )}
      </div>
      
      <div className="flex items-end justify-between">
        <div>
          <div className={`text-2xl font-mono font-bold ${getValueColor()} tabular-nums`}>
            {unit === '$' && '$'}{displayValue}
            {unit && unit !== '$' && <span className="text-sm ml-1">{unit}</span>}
          </div>
          {previousValue !== undefined && (
            <div className={`text-xs flex items-center gap-1 ${isPositive ? 'text-emerald-400' : 'text-rose-400'}`}>
              {isPositive ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {displayDelta} ({deltaPercent}%)
            </div>
          )}
        </div>
        
        {sparklineData && (
          <Sparkline 
            data={sparklineData} 
            color={alertSeverity ? '#f87171' : unit === '$' && value < 0 ? '#f87171' : '#34d399'}
            width={60}
            height={30}
          />
        )}
      </div>
    </div>
  );
}

// Main component
export default function PerformanceMetrics({
  metrics,
  compact = false,
  alertThresholds: customThresholds,
  onAlert,
  className = ''
}: PerformanceMetricsProps) {
  const [activeAlerts, setActiveAlerts] = useState<MetricAlert[]>([]);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [networkMetrics, setNetworkMetrics] = useState<NetworkMetrics | null>(null);
  const [storageStats, setStorageStats] = useState<{
    total_estimated_bytes: number;
    aggregate_data_rate_bytes_per_sec: number;
    db_size_bytes: number;
  } | null>(null);
  
  // Memoize thresholds to prevent unnecessary re-renders
  const thresholds = useMemo(
    () => ({ ...DEFAULT_THRESHOLDS, ...customThresholds }),
    [customThresholds]
  );

  // Fetch system info from backend
  useEffect(() => {
    let mounted = true;
    let intervalId: ReturnType<typeof setInterval>;
    
    const fetchSystemInfo = async () => {
      const result = await getSystemInfo();
      if (result.ok && mounted) {
        setSystemInfo(result.value);
        setLastUpdate(new Date());
      }
    };
    
    const fetchNetworkMetrics = async () => {
      const result = await getNetworkMetrics();
      if (result.ok && mounted) {
        setNetworkMetrics(result.value);
      }
    };
    
    // Initial fetch
    fetchSystemInfo();
    fetchNetworkMetrics();

    // Fetch storage stats (less frequently - every 10s)
    const fetchStorageStats = async () => {
      try {
        const result = await invoke<{
          total_timeseries_rows: number;
          total_ws_message_rows: number;
          total_estimated_bytes: number;
          aggregate_data_rate_bytes_per_sec: number;
          db_size_bytes: number;
        }>('get_aggregate_storage_stats_cmd');
        if (mounted) setStorageStats(result);
      } catch {
        // Silently ignore - storage stats are non-critical
      }
    };
    fetchStorageStats();
    const storageIntervalId = setInterval(fetchStorageStats, 10000);

    // Poll every 2 seconds
    intervalId = setInterval(() => {
      fetchSystemInfo();
      fetchNetworkMetrics();
    }, 2000);

    return () => {
      mounted = false;
      clearInterval(intervalId);
      clearInterval(storageIntervalId);
    };
  }, []);

  // Use provided metrics or build minimal display from system info
  // Memoize to prevent creating new object references on every render
  const displayMetrics = useMemo(() => {
    if (metrics) return metrics;
    if (!systemInfo) return null;
    return {
      system: { 
        cpu: { 
          current: systemInfo.cpu_usage, 
          previous: 0,
          history: [] as number[],
          unit: '%',
          timestamp: new Date()
        },
        memory: { 
          current: systemInfo.memory_used / (1024 * 1024), 
          previous: 0,
          history: [] as number[],
          unit: 'MB',
          timestamp: new Date()
        },
        diskWrites: { current: 0, previous: 0, history: [], unit: 'ops/s', timestamp: new Date() }
      },
      trading: { dailyPnl: null, totalPnl: null, winRate: null, sharpeRatio: 0, maxDrawdown: 0, currentExposure: 0 },
      latency: { endToEnd: null, api: null, websocket: null },
      operational: { tradesExecuted: 0, dataPointsCollected: 0, activeConnections: 0, errorRate: null }
    };
  }, [metrics, systemInfo]);

  // Memoize CPU and memory values to prevent unnecessary recalculations
  const cpuValue = useMemo(() => 
    displayMetrics?.system?.cpu?.current ?? 0, 
  [displayMetrics?.system?.cpu?.current]);
  
  const memoryValue = useMemo(() => 
    displayMetrics?.system?.memory?.current ?? 0, 
  [displayMetrics?.system?.memory?.current]);
  
  const latencyValue = useMemo(() => 
    displayMetrics?.latency?.endToEnd?.current ?? 0,
  [displayMetrics?.latency?.endToEnd?.current]);

  // Store onAlert in ref to prevent infinite loop from prop changes
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;

  // Track previous alerts to avoid unnecessary updates
  const prevAlertsRef = useRef<string>('');

  // Check thresholds and trigger alerts - only when alerts actually change
  useEffect(() => {
    const newAlerts: MetricAlert[] = [];
    
    // Latency check
    if (latencyValue > 0) {
      if (latencyValue > thresholds.latency * 2) {
        newAlerts.push({
          metric: 'latency',
          value: latencyValue,
          threshold: thresholds.latency * 2,
          severity: 'critical',
          message: `Critical latency: ${latencyValue.toFixed(0)}ms`,
          timestamp: new Date()
        });
      } else if (latencyValue > thresholds.latency) {
        newAlerts.push({
          metric: 'latency',
          value: latencyValue,
          threshold: thresholds.latency,
          severity: 'warning',
          message: `High latency: ${latencyValue.toFixed(0)}ms`,
          timestamp: new Date()
        });
      }
    }
    
    // CPU check
    if (cpuValue > thresholds.cpu) {
      newAlerts.push({
        metric: 'cpu',
        value: cpuValue,
        threshold: thresholds.cpu,
        severity: cpuValue > 95 ? 'critical' : 'warning',
        message: `High CPU usage: ${cpuValue.toFixed(1)}%`,
        timestamp: new Date()
      });
    }
    
    // Create a string signature of alerts to compare
    const alertSignature = newAlerts.map(a => `${a.metric}:${a.severity}:${a.value.toFixed(1)}`).join('|');
    
    // Only update if alerts have actually changed
    if (prevAlertsRef.current !== alertSignature) {
      prevAlertsRef.current = alertSignature;
      setActiveAlerts(newAlerts);
      newAlerts.forEach(alert => onAlertRef.current?.(alert));
      setLastUpdate(new Date());
    }
  }, [cpuValue, memoryValue, latencyValue, thresholds]);

  // Calculate system health score
  const healthScore = useMemo(() => {
    const cpuScore = Math.max(0, 100 - cpuValue);
    const memoryScore = Math.max(0, 100 - (memoryValue / thresholds.memory) * 100);
    const latencyValue = displayMetrics?.latency?.endToEnd?.current ?? 0;
    const latencyScore = Math.max(0, 100 - (latencyValue / thresholds.latency) * 100);
    const errorValue = displayMetrics?.operational?.errorRate?.current ?? 0;
    const errorScore = Math.max(0, 100 - (errorValue / thresholds.errorRate) * 100);
    
    return Math.round((cpuScore * 30 + memoryScore * 25 + latencyScore * 25 + errorScore * 20) / 100);
  }, [displayMetrics, cpuValue, memoryValue, thresholds]);

  // Stale data detection
  const isStale = useMemo(() => {
    return Date.now() - lastUpdate.getTime() > 5000;
  }, [lastUpdate]);

  // Loading state - show when no metrics prop and no systemInfo available
  const isLoading = !metrics && !systemInfo;
  
  if (isLoading) {
    return (
      <div className={`${compact ? 'flex items-center gap-4' : 'p-4'} ${className}`}>
        <div className="animate-pulse flex items-center gap-2">
          <Activity className="w-4 h-4 text-gray-600" />
          <span className="text-sm text-gray-500">Loading metrics...</span>
        </div>
      </div>
    );
  }

  // Handle case where displayMetrics is null even after loading
  if (!displayMetrics) {
    return (
      <div className={`${compact ? 'flex items-center gap-4' : 'p-4'} ${className}`}>
        <div className="flex items-center gap-2">
          <Activity className="w-4 h-4 text-gray-600" />
          <span className="text-sm text-gray-500">No metrics available</span>
        </div>
      </div>
    );
  }

  // Compact horizontal layout
  if (compact) {
    return (
      <div className={`flex items-center justify-between bg-gray-900/50 ${className}`}>
        {/* Health Score */}
        <div className="flex items-center gap-2 px-4 border-r border-gray-800">
          <div className={`text-sm font-medium ${
            healthScore > 80 ? 'text-emerald-400' : healthScore > 50 ? 'text-amber-400' : 'text-rose-400'
          }`}>
            {healthScore}
          </div>
          <div className="text-xs text-gray-500">Health</div>
        </div>

        {/* Key Metrics Row */}
        <div className="flex items-center divide-x divide-gray-800">
          <MetricCard
            label="Latency"
            value={displayMetrics?.latency?.endToEnd?.current ?? 0}
            previousValue={displayMetrics?.latency?.endToEnd?.previous}
            unit="ms"
            compact
            icon={Zap}
            alertSeverity={
              (displayMetrics?.latency?.endToEnd?.current ?? 0) > thresholds.latency * 2 ? 'critical' :
              (displayMetrics?.latency?.endToEnd?.current ?? 0) > thresholds.latency ? 'warning' : null
            }
          />
          
          <MetricCard
            label="PnL"
            value={displayMetrics?.trading?.dailyPnl?.current ?? 0}
            previousValue={displayMetrics?.trading?.dailyPnl?.previous}
            unit="$"
            compact
            icon={BarChart3}
          />
          
          <MetricCard
            label="CPU"
            value={cpuValue}
            unit="%"
            compact
            icon={Cpu}
            alertSeverity={cpuValue > thresholds.cpu ? 'warning' : null}
          />
          
          <MetricCard
            label="Trades"
            value={displayMetrics?.operational?.tradesExecuted ?? 0}
            unit=""
            compact
            icon={Activity}
          />
          
          <MetricCard
            label="Net ↓"
            value={networkMetrics ? networkMetrics.bytes_received : 0}
            unit=""
            compact
            icon={Activity}
          />
          
          <MetricCard
            label="Net ↑"
            value={networkMetrics ? networkMetrics.bytes_sent : 0}
            unit=""
            compact
            icon={Network}
          />

          <MetricCard
            label="DB Rate"
            value={storageStats ? storageStats.aggregate_data_rate_bytes_per_sec : 0}
            unit="B/s"
            compact
            icon={HardDrive}
            color="text-purple-400"
          />
        </div>

        {/* Last Update */}
        <div className={`px-4 text-xs ${isStale ? 'text-amber-500' : 'text-gray-600'}`}>
          {isStale ? 'Stale' : formatTime(lastUpdate)}
        </div>
      </div>
    );
  }

  // Full expanded layout
  return (
    <div className={`p-4 space-y-4 ${className}`}>
      {/* Alerts Banner */}
      {activeAlerts.length > 0 && (
        <div className="space-y-2">
          {activeAlerts.map((alert, idx) => (
            <div 
              key={idx}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
                alert.severity === 'critical' 
                  ? 'bg-rose-950/30 border border-rose-500/30 text-rose-300' 
                  : 'bg-amber-950/30 border border-amber-500/30 text-amber-300'
              }`}
            >
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <span>{alert.message}</span>
            </div>
          ))}
        </div>
      )}

      {/* System Health Section */}
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
          <Server className="w-3 h-3" />
          System Health
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <MetricCard
            label="CPU Usage"
            value={cpuValue}
            previousValue={displayMetrics?.system?.cpu?.previous}
            unit="%"
            icon={Cpu}
            sparklineData={displayMetrics?.system?.cpu?.history}
            alertSeverity={cpuValue > thresholds.cpu ? 'warning' : null}
          />
          
          <MetricCard
            label="Memory"
            value={memoryValue}
            previousValue={displayMetrics?.system?.memory?.previous}
            unit="MB"
            icon={HardDrive}
            sparklineData={displayMetrics?.system?.memory?.history}
          />
          
          <MetricCard
            label="Latency"
            value={displayMetrics?.latency?.endToEnd?.current ?? 0}
            previousValue={displayMetrics?.latency?.endToEnd?.previous}
            unit="ms"
            icon={Zap}
            sparklineData={displayMetrics?.latency?.endToEnd?.history}
            alertSeverity={
              (displayMetrics?.latency?.endToEnd?.current ?? 0) > thresholds.latency * 2 ? 'critical' :
              (displayMetrics?.latency?.endToEnd?.current ?? 0) > thresholds.latency ? 'warning' : null
            }
          />
          
          <MetricCard
            label="WebSocket"
            value={displayMetrics?.latency?.websocket?.current ?? 0}
            unit="ms"
            icon={Wifi}
            sparklineData={displayMetrics?.latency?.websocket?.history}
          />
          
          <MetricCard
            label="Received"
            value={networkMetrics ? networkMetrics.bytes_received : 0}
            unit="B"
            icon={Wifi}
            color="text-green-400"
          />
          
          <MetricCard
            label="Sent"
            value={networkMetrics ? networkMetrics.bytes_sent : 0}
            unit="B"
            icon={Network}
            color="text-blue-400"
          />

          <MetricCard
            label="DB Write Rate"
            value={storageStats ? storageStats.aggregate_data_rate_bytes_per_sec : 0}
            unit="B/s"
            icon={HardDrive}
            color="text-purple-400"
          />

          <MetricCard
            label="DB Size"
            value={storageStats ? storageStats.db_size_bytes / (1024 * 1024) : 0}
            unit="MB"
            icon={HardDrive}
            color="text-purple-400"
          />
        </div>
      </div>

      {/* Trading Performance Section */}
      <div>
        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-2">
          <TrendingUp className="w-3 h-3" />
          Trading Performance
        </h4>
        <div className="grid grid-cols-2 gap-2">
          <MetricCard
            label="Daily P&L"
            value={displayMetrics?.trading?.dailyPnl?.current ?? 0}
            previousValue={displayMetrics?.trading?.dailyPnl?.previous}
            unit="$"
            icon={(displayMetrics?.trading?.dailyPnl?.current ?? 0) >= 0 ? TrendingUp : TrendingDown}
            sparklineData={displayMetrics?.trading?.dailyPnl?.history}
            color={(displayMetrics?.trading?.dailyPnl?.current ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}
          />
          
          <MetricCard
            label="Win Rate"
            value={displayMetrics?.trading?.winRate?.current ?? 0}
            unit="%"
            icon={Activity}
          />
          
          <MetricCard
            label="Sharpe Ratio"
            value={displayMetrics?.trading?.sharpeRatio ?? 0}
            unit=""
            icon={BarChart3}
            color={(displayMetrics?.trading?.sharpeRatio ?? 0) >= 1 ? 'text-emerald-400' : 'text-amber-400'}
          />
          
          <MetricCard
            label="Exposure"
            value={displayMetrics?.trading?.currentExposure ?? 0}
            unit="$"
            icon={HardDrive}
          />
        </div>
      </div>

      {/* Operational Stats */}
      <div className="pt-2 border-t border-gray-800">
        <div className="flex items-center justify-between text-xs text-gray-500">
          <div className="flex items-center gap-4">
            <span>Trades: <span className="text-gray-300">{displayMetrics?.operational?.tradesExecuted ?? 0}</span></span>
            <span>Connections: <span className="text-gray-300">{displayMetrics?.operational?.activeConnections ?? 0}</span></span>
            <span>Data Points: <span className="text-gray-300">{(displayMetrics?.operational?.dataPointsCollected ?? 0).toLocaleString()}</span></span>
          </div>
          <div className="flex items-center gap-1" title={`Last updated: ${lastUpdate.toISOString()}`}>
            <Clock className="w-3 h-3" />
            <span className={isStale ? 'text-amber-500' : ''}>
              {isStale ? 'Stale' : formatTime(lastUpdate)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}