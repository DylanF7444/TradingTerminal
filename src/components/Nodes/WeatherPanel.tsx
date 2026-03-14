import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useStore, type StoreState } from '../../store';
import { TimeseriesChart } from './TimeseriesChart';

// ============================================================================
// WEATHER DATA PANEL
// ============================================================================
// Dedicated panel for Weather info source nodes. Displays current conditions,
// 7-day forecast, and metric history charts using data from Open-Meteo.
// ============================================================================

interface WeatherPanelProps {
  nodeId: string;
  nodeName?: string;
  onOpenChartOverlay?: (nodeId: string, nodeName: string, metrics: string[]) => void;
}

interface TimeseriesPoint {
  timestamp: number;
  source_id: string;
  metric: string;
  value: number;
  metadata: Record<string, unknown> | null;
}

interface NodeStoredData {
  timeseries: TimeseriesPoint[];
  websocket_messages: unknown[];
  available_metrics: string[];
  total_points: number;
  oldest_timestamp: number | null;
  newest_timestamp: number | null;
}

// WMO weather code to icon mapping
function getWeatherIcon(code: number): string {
  if (code === 0) return '\u2600\uFE0F'; // sun
  if (code <= 3) return '\u26C5'; // partly cloudy
  if (code <= 48) return '\uD83C\uDF2B\uFE0F'; // fog
  if (code <= 57) return '\uD83C\uDF27\uFE0F'; // drizzle
  if (code <= 67) return '\uD83C\uDF27\uFE0F'; // rain
  if (code <= 77) return '\u2744\uFE0F'; // snow
  if (code <= 82) return '\uD83C\uDF26\uFE0F'; // rain showers
  if (code <= 86) return '\uD83C\uDF28\uFE0F'; // snow showers
  if (code >= 95) return '\u26C8\uFE0F'; // thunderstorm
  return '\u2601\uFE0F'; // cloud fallback
}

function getWeatherDescription(code: number): string {
  const descriptions: Record<number, string> = {
    0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
    45: 'Foggy', 48: 'Rime fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
    55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Dense freezing drizzle',
    61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain',
    66: 'Light freezing rain', 67: 'Heavy freezing rain',
    71: 'Slight snow', 73: 'Moderate snow', 75: 'Heavy snow', 77: 'Snow grains',
    80: 'Slight showers', 81: 'Moderate showers', 82: 'Violent showers',
    85: 'Slight snow showers', 86: 'Heavy snow showers',
    95: 'Thunderstorm', 96: 'Thunderstorm w/ hail', 99: 'Severe thunderstorm',
  };
  return descriptions[code] || 'Unknown';
}

function getUVLabel(uv: number): { label: string; color: string } {
  if (uv <= 2) return { label: 'Low', color: 'text-green-400' };
  if (uv <= 5) return { label: 'Moderate', color: 'text-yellow-400' };
  if (uv <= 7) return { label: 'High', color: 'text-orange-400' };
  if (uv <= 10) return { label: 'Very High', color: 'text-red-400' };
  return { label: 'Extreme', color: 'text-purple-400' };
}

function windDegreesToDirection(degrees: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return dirs[Math.round(degrees / 22.5) % 16];
}

export function WeatherPanel({ nodeId, nodeName, onOpenChartOverlay }: WeatherPanelProps) {
  const nodeMetadata = useStore((state: StoreState) => {
    const node = state.nodes[nodeId];
    return node ? (node.metadata as Record<string, any>) : null;
  });
  const [storedData, setStoredData] = useState<NodeStoredData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'current' | 'forecast' | 'history'>('current');

  const lastData = nodeMetadata?.lastData as Record<string, any> | undefined;
  const conditions = lastData?.conditions as Record<string, { value: number; unit: string; extra?: Record<string, unknown> }> | undefined;
  const forecast = lastData?.forecast as Record<string, unknown> | undefined;

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const result = await invoke<NodeStoredData>('get_node_stored_data_cmd', { nodeId, limit: 200 });
        if (mounted) setStoredData(result);
      } catch (err) {
        console.error('Failed to load weather history:', err);
      } finally {
        if (mounted) setLoading(false);
      }
    };
    load();
    const timer = setInterval(load, 30000);
    return () => { mounted = false; clearInterval(timer); };
  }, [nodeId]);

  const weatherCode = (lastData?.weatherCode as number) ?? 0;
  const locationName = (lastData?.location as string) || nodeMetadata?.location || 'Unknown';
  const country = (lastData?.country as string) || '';

  // Tab navigation
  const tabs = [
    { id: 'current' as const, label: 'Current' },
    { id: 'forecast' as const, label: 'Forecast' },
    { id: 'history' as const, label: 'Charts' },
  ];

  if (!lastData && !storedData && !loading) {
    return (
      <div className="bg-gray-800/50 border border-gray-600 rounded-lg p-4">
        <p className="text-gray-400 text-sm">No weather data received yet.</p>
        <p className="text-gray-500 text-xs mt-2">
          Weather updates will appear here once the scraper fetches data from Open-Meteo.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 bg-gray-800 border-b border-gray-700">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-2xl">{getWeatherIcon(weatherCode)}</span>
            <div>
              <h3 className="text-sm font-medium text-gray-200">
                {locationName}{country ? `, ${country}` : ''}
              </h3>
              <p className="text-xs text-gray-500">
                {getWeatherDescription(weatherCode)}
                {lastData?.timestamp && (
                  <span> &middot; Updated {new Date(lastData.timestamp * 1000).toLocaleTimeString()}</span>
                )}
              </p>
            </div>
          </div>
          {conditions?.temperature && (
            <div className="text-right">
              <span className="text-3xl font-light text-white">
                {Math.round(conditions.temperature.value)}
              </span>
              <span className="text-sm text-gray-400">{conditions.temperature.unit}</span>
            </div>
          )}
        </div>
      </div>

      {/* Tab Bar */}
      <div className="flex border-b border-gray-700">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 px-4 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.id
                ? 'text-cyan-400 border-b-2 border-cyan-400 bg-gray-800/50'
                : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="p-4">
        {activeTab === 'current' && conditions && (
          <CurrentConditions conditions={conditions} weatherCode={weatherCode} />
        )}
        {activeTab === 'current' && !conditions && (
          <div className="text-center py-8">
            {loading ? (
              <div className="flex items-center justify-center gap-2">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-cyan-500 border-t-transparent" />
                <span className="text-gray-400 text-sm">Waiting for weather data...</span>
              </div>
            ) : (
              <p className="text-gray-500 text-sm">No current conditions available</p>
            )}
          </div>
        )}

        {activeTab === 'forecast' && (
          <ForecastView forecast={forecast} />
        )}

        {activeTab === 'history' && (
          <HistoryCharts
            storedData={storedData}
            loading={loading}
            nodeId={nodeId}
            nodeName={nodeName}
            onOpenChartOverlay={onOpenChartOverlay}
          />
        )}
      </div>
    </div>
  );
}

/** Current weather conditions grid */
function CurrentConditions({
  conditions,
  weatherCode,
}: {
  conditions: Record<string, { value: number; unit: string; extra?: Record<string, unknown> }>;
  weatherCode: number;
}) {
  const temp = conditions.temperature;
  const feelsLike = conditions.feels_like;
  const humidity = conditions.humidity;
  const wind = conditions.wind_speed;
  const precip = conditions.precipitation;
  const pressure = conditions.pressure;
  const uv = conditions.uv_index;

  const windDir = wind?.extra?.direction as number | undefined;

  return (
    <div className="space-y-3">
      {/* Primary: Temperature + Feels Like */}
      {(temp || feelsLike) && (
        <div className="bg-gray-800/50 rounded-lg p-3 flex items-center justify-between">
          <div>
            <span className="text-xs text-gray-500 uppercase">Temperature</span>
            {temp && (
              <div className="text-2xl font-light text-white">
                {temp.value.toFixed(1)}{temp.unit}
              </div>
            )}
          </div>
          {feelsLike && (
            <div className="text-right">
              <span className="text-xs text-gray-500">Feels like</span>
              <div className="text-lg text-gray-300">{feelsLike.value.toFixed(1)}{feelsLike.unit}</div>
            </div>
          )}
        </div>
      )}

      {/* Metric Grid */}
      <div className="grid grid-cols-2 gap-2">
        {humidity && (
          <MetricCard label="Humidity" value={`${humidity.value.toFixed(0)}%`} icon="\uD83D\uDCA7" />
        )}
        {wind && (
          <MetricCard
            label="Wind"
            value={`${wind.value.toFixed(1)} ${wind.unit}`}
            subtitle={windDir !== undefined ? windDegreesToDirection(windDir) : undefined}
            icon="\uD83D\uDCA8"
          />
        )}
        {precip && (
          <MetricCard label="Precipitation" value={`${precip.value.toFixed(1)} mm`} icon="\uD83C\uDF27\uFE0F" />
        )}
        {pressure && (
          <MetricCard label="Pressure" value={`${pressure.value.toFixed(0)} hPa`} icon="\uD83C\uDF21\uFE0F" />
        )}
        {uv && (
          <MetricCard
            label="UV Index"
            value={uv.value.toFixed(1)}
            subtitle={getUVLabel(uv.value).label}
            subtitleColor={getUVLabel(uv.value).color}
            icon="\u2600\uFE0F"
          />
        )}
        <MetricCard
          label="Conditions"
          value={getWeatherDescription(weatherCode)}
          icon={getWeatherIcon(weatherCode)}
        />
      </div>
    </div>
  );
}

/** Single metric card */
function MetricCard({
  label,
  value,
  subtitle,
  subtitleColor,
  icon,
}: {
  label: string;
  value: string;
  subtitle?: string;
  subtitleColor?: string;
  icon?: string;
}) {
  return (
    <div className="bg-gray-800/50 rounded-lg p-3">
      <div className="flex items-center gap-1.5 mb-1">
        {icon && <span className="text-sm">{icon}</span>}
        <span className="text-xs text-gray-500 uppercase">{label}</span>
      </div>
      <div className="text-sm font-medium text-gray-200">{value}</div>
      {subtitle && (
        <div className={`text-xs mt-0.5 ${subtitleColor || 'text-gray-500'}`}>{subtitle}</div>
      )}
    </div>
  );
}

/** 7-day forecast view */
function ForecastView({ forecast }: { forecast: Record<string, unknown> | undefined }) {
  if (!forecast) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-500 text-sm">No forecast data available yet</p>
      </div>
    );
  }

  const times = (forecast.time as string[]) || [];
  const tempMax = (forecast.temperature_2m_max as number[]) || [];
  const tempMin = (forecast.temperature_2m_min as number[]) || [];
  const codes = (forecast.weather_code as number[]) || [];
  const precipProb = (forecast.precipitation_probability_max as number[]) || [];
  const precipSum = (forecast.precipitation_sum as number[]) || [];

  if (times.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-500 text-sm">No forecast data available</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {times.map((date, i) => {
        const dayName = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });
        const dateStr = new Date(date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const code = codes[i] ?? 0;
        const isToday = i === 0;

        return (
          <div
            key={date}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors ${
              isToday ? 'bg-cyan-900/20 border border-cyan-800/30' : 'bg-gray-800/50 hover:bg-gray-800/70'
            }`}
          >
            {/* Day */}
            <div className="w-16">
              <div className={`text-xs font-medium ${isToday ? 'text-cyan-400' : 'text-gray-300'}`}>
                {isToday ? 'Today' : dayName}
              </div>
              <div className="text-xs text-gray-500">{dateStr}</div>
            </div>

            {/* Weather Icon + Description */}
            <div className="flex items-center gap-1.5 w-28">
              <span className="text-lg">{getWeatherIcon(code)}</span>
              <span className="text-xs text-gray-400 truncate">{getWeatherDescription(code)}</span>
            </div>

            {/* Precipitation */}
            <div className="w-14 text-right">
              {precipProb[i] != null && (
                <span className={`text-xs ${precipProb[i] > 50 ? 'text-blue-400' : 'text-gray-500'}`}>
                  {precipProb[i]}%
                </span>
              )}
              {precipSum[i] != null && precipSum[i] > 0 && (
                <div className="text-xs text-blue-300">{precipSum[i].toFixed(1)}mm</div>
              )}
            </div>

            {/* Temp Range */}
            <div className="flex-1 flex items-center justify-end gap-2">
              {tempMin[i] != null && (
                <span className="text-xs text-blue-300">{Math.round(tempMin[i])}&deg;</span>
              )}
              {tempMax[i] != null && tempMin[i] != null && (
                <div className="w-16 h-1.5 rounded-full bg-gray-700 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-400 to-orange-400"
                    style={{ width: '100%' }}
                  />
                </div>
              )}
              {tempMax[i] != null && (
                <span className="text-xs text-orange-300 font-medium">{Math.round(tempMax[i])}&deg;</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Historical metric charts from stored timeseries data */
function HistoryCharts({
  storedData,
  loading,
  nodeId,
  nodeName,
  onOpenChartOverlay,
}: {
  storedData: NodeStoredData | null;
  loading: boolean;
  nodeId: string;
  nodeName?: string;
  onOpenChartOverlay?: (nodeId: string, nodeName: string, metrics: string[]) => void;
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 gap-2">
        <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-cyan-500 border-t-transparent" />
        <span className="text-gray-400 text-sm">Loading history...</span>
      </div>
    );
  }

  if (!storedData || storedData.timeseries.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-gray-500 text-sm">No historical data stored yet</p>
        <p className="text-gray-600 text-xs mt-1">Charts will appear as weather data accumulates</p>
      </div>
    );
  }

  // Group timeseries by metric
  const metricGroups: Record<string, TimeseriesPoint[]> = {};
  for (const point of storedData.timeseries) {
    if (!metricGroups[point.metric]) metricGroups[point.metric] = [];
    metricGroups[point.metric].push(point);
  }

  const metricLabels: Record<string, string> = {
    temperature: 'Temperature',
    feels_like: 'Feels Like',
    humidity: 'Humidity (%)',
    wind_speed: 'Wind Speed',
    precipitation: 'Precipitation (mm)',
    pressure: 'Pressure (hPa)',
    uv_index: 'UV Index',
  };

  return (
    <div className="space-y-4">
      {onOpenChartOverlay && storedData.available_metrics.length > 0 && (
        <button
          onClick={() => onOpenChartOverlay(nodeId, nodeName || nodeId, storedData.available_metrics)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
          Expand Charts
        </button>
      )}
      {Object.entries(metricGroups).map(([metric, points]) => (
        <div key={metric}>
          <div className="text-xs font-medium text-gray-400 mb-1 px-1">
            {metricLabels[metric] || metric}
          </div>
          <TimeseriesChart data={points} metric={metric} />
        </div>
      ))}
    </div>
  );
}
