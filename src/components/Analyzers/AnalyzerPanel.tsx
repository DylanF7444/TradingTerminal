import { useState, useCallback } from 'react';
import { 
  Activity,
  Plus,
  X,
  CheckCircle2,
  AlertCircle,
  TrendingUp,
  BarChart3,
  Zap,
  Gauge,
  GitBranch,
  Calculator,
  Waves,
  Cloud,
  Target,
  LineChart,
  Hash,
  Scale,
  DollarSign,
  Coins,
  ArrowLeftRight,
  Trash2
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { AnalyzerType, Node, NodeId, NodeType } from '../../types/nodes';
import { useStore } from '../../store';

interface AnalyzerPanelProps {
  onAddAnalyzer?: (node: Node) => void;
  existingAnalyzers?: Node[];
  className?: string;
}

const ANALYZER_TYPE_METADATA: Record<AnalyzerType, {
  label: string;
  icon: React.ElementType;
  description: string;
  color: string;
  defaultConfig: Record<string, unknown>;
}> = {
  [AnalyzerType.Correlation]: {
    label: 'Correlation',
    icon: GitBranch,
    description: 'Calculate correlation between multiple data sources',
    color: 'text-blue-400',
    defaultConfig: { targetNodeIds: [], windowSize: 24, minThreshold: 0.5 }
  },
  [AnalyzerType.Momentum]: {
    label: 'Momentum',
    icon: TrendingUp,
    description: 'Detect trend momentum using EMA crossover',
    color: 'text-green-400',
    defaultConfig: { shortPeriod: 12, longPeriod: 26, threshold: 0.02 }
  },
  [AnalyzerType.Sentiment]: {
    label: 'Sentiment',
    icon: Activity,
    description: 'Analyze sentiment from news and social media',
    color: 'text-purple-400',
    defaultConfig: { keywords: [], weight: 1.0, decayFactor: 0.9, threshold: 0.6 }
  },
  [AnalyzerType.Arbitrage]: {
    label: 'Arbitrage',
    icon: Zap,
    description: 'Detect arbitrage opportunities between markets',
    color: 'text-yellow-400',
    defaultConfig: { marketPairs: [], minProfitMargin: 0.01, includeFees: true, feeRate: 0.002 }
  },
  [AnalyzerType.RSI]: {
    label: 'RSI',
    icon: Gauge,
    description: 'Relative Strength Index indicator',
    color: 'text-red-400',
    defaultConfig: { period: 14, overbought: 70, oversold: 30 }
  },
  [AnalyzerType.Volatility]: {
    label: 'Volatility',
    icon: BarChart3,
    description: 'Measure price volatility over time',
    color: 'text-orange-400',
    defaultConfig: { windowSize: 20, annualize: true, highThreshold: 0.03, lowThreshold: 0.01 }
  },
  [AnalyzerType.Custom]: {
    label: 'Custom',
    icon: Calculator,
    description: 'Create custom analysis formula',
    color: 'text-gray-400',
    defaultConfig: { formula: '', inputs: [] }
  },
  [AnalyzerType.WhaleActivity]: {
    label: 'Whale Activity',
    icon: Waves,
    description: 'Detect large trades and trade spikes',
    color: 'text-violet-400',
    defaultConfig: { threshold: 10000, windowSize: 60, sensitivity: 0.5, minTrades: 10 }
  },
  [AnalyzerType.EnsembleProbability]: {
    label: 'Ensemble Probability',
    icon: Cloud,
    description: 'Convert weather ensemble forecasts to probability distributions',
    color: 'text-cyan-400',
    defaultConfig: { ensembleCount: 31, bucketMin: 75, bucketMax: 80, minEdgeThreshold: 0.08 }
  },
  [AnalyzerType.BiasCorrection]: {
    label: 'Bias Correction',
    icon: Target,
    description: 'Apply historical bias corrections to forecasts',
    color: 'text-teal-400',
    defaultConfig: { mode: 'additive', cityCorrections: {}, lookbackDays: 30 }
  },
  [AnalyzerType.BlackScholes]: {
    label: 'Black-Scholes',
    icon: LineChart,
    description: 'Options-implied probability via N(d2) calculation',
    color: 'text-emerald-400',
    defaultConfig: { riskFreeRate: 0.05, useImpliedVol: true, volLookbackDays: 30, minEdgeThreshold: 0.05 }
  },
  [AnalyzerType.Poisson]: {
    label: 'Poisson',
    icon: Hash,
    description: 'Count process modeling for events (tweets, transactions)',
    color: 'text-pink-400',
    defaultConfig: { lambda: 50, bucketMin: 45, bucketMax: 55, decayFactor: 0.3 }
  },
  [AnalyzerType.NowcastDeviation]: {
    label: 'Nowcast Deviation',
    icon: Scale,
    description: 'Compare economic nowcasts to market expectations',
    color: 'text-amber-400',
    defaultConfig: { nowcastSource: 'ClevelandFed', assumedStd: 0.1, minDeviation: 0.05 }
  },
  [AnalyzerType.FedSentiment]: {
    label: 'Fed Sentiment',
    icon: DollarSign,
    description: 'Classify Fed speeches as hawkish or dovish',
    color: 'text-rose-400',
    defaultConfig: { hawkishKeywords: ['inflation', 'tightening'], dovishKeywords: ['employment', 'accommodative'], decayHalfLife: 72, minSignalThreshold: 0.3 }
  },
  [AnalyzerType.FundingRegime]: {
    label: 'Funding Regime',
    icon: Coins,
    description: 'Detect extreme funding rate regimes in crypto perpetuals',
    color: 'text-lime-400',
    defaultConfig: { extremePositive: 0.55, extremeNegative: -0.30, probabilityAdjustment: 0.05, assets: ['BTC', 'ETH'] }
  },
  [AnalyzerType.SpreadScanner]: {
    label: 'Spread Scanner',
    icon: ArrowLeftRight,
    description: 'Scan for cross-platform arbitrage spreads',
    color: 'text-fuchsia-400',
    defaultConfig: { polymarketFee: 0, kalshiFee: 0.07, minSpread: 0.02, marketPairs: [] }
  }
};

export default function AnalyzerPanel({ 
  onAddAnalyzer, 
  existingAnalyzers = [],
  className = '' 
}: AnalyzerPanelProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedType, setSelectedType] = useState<AnalyzerType | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [localError, setLocalError] = useState<string | null>(null);
  
  const addNode = useStore((state) => state.addNode);
  const selectNode = useStore((state) => state.selectNode);
  const removeNode = useStore((state) => state.removeNode);

  const handleRemove = useCallback(async (nodeId: string) => {
    if (!confirm('Are you sure you want to remove this analyzer?')) return;
    removeNode(nodeId);
  }, [removeNode]);

  const handleTypeSelect = useCallback((type: AnalyzerType) => {
    setSelectedType(type);
    setConfig(ANALYZER_TYPE_METADATA[type].defaultConfig);
  }, []);

  const handleConfigChange = useCallback((key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!selectedType) return;

    try {
      const nodeId = `analyzer-${Date.now()}` as NodeId;
      const now = Date.now();
      
      const nodesArray = Object.values(useStore.getState().nodes);
      const lastNode = nodesArray[nodesArray.length - 1];
      const position: [number, number] = lastNode 
        ? [lastNode.position[0] + 50, lastNode.position[1] + 50]
        : [300, 200];

      const analyzerNode: Node = {
        id: nodeId,
        node_type: { Analyzer: selectedType } as NodeType,
        position,
        connections: [],
        metadata: {
          analyzerType: selectedType,
          inputs: [],
          formula: config.formula || '',
          output: {
            interval: 60,
            threshold: config.threshold || 0.5,
            history: []
          }
        },
        name: `${ANALYZER_TYPE_METADATA[selectedType].label} Analyzer`,
        createdAt: now,
        updatedAt: now,
      };

      try {
        await invoke('add_node_cmd', {
          nodeId,
          nodeType: 'Analyzer',
          nodeSubtype: selectedType,
          positionX: position[0],
          positionY: position[1],
          metadata: JSON.stringify(analyzerNode.metadata),
        });
      } catch (e) {
        console.warn('Could not persist analyzer node to backend:', e);
      }

      addNode(analyzerNode);
      selectNode(nodeId, false);
      onAddAnalyzer?.(analyzerNode);
      setIsModalOpen(false);
      setSelectedType(null);
      setConfig({});
    } catch (err) {
      console.error('Failed to add analyzer:', err);
      setLocalError(err instanceof Error ? err.message : 'Failed to add analyzer');
    }
  }, [selectedType, config, addNode, selectNode, onAddAnalyzer]);

  const renderConfigForm = () => {
    if (!selectedType) return null;

    const commonInputClass = "w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-gray-100 focus:outline-none focus:border-purple-500 transition-colors";
    const labelClass = "block text-sm font-medium text-gray-400 mb-1";

    switch (selectedType) {
      case AnalyzerType.Correlation:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Window Size (hours)</label>
              <input
                type="number"
                value={config.windowSize as number || 24}
                onChange={(e) => handleConfigChange('windowSize', parseInt(e.target.value))}
                min={1}
                max={168}
                className={commonInputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Minimum Threshold (0-1)</label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={config.minThreshold as number || 0.5}
                onChange={(e) => handleConfigChange('minThreshold', parseFloat(e.target.value))}
                className="w-full"
              />
              <span className="text-sm text-gray-500">{(config.minThreshold as number || 0.5).toFixed(1)}</span>
            </div>
          </div>
        );

      case AnalyzerType.Momentum:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Short Period</label>
              <input
                type="number"
                value={config.shortPeriod as number || 12}
                onChange={(e) => handleConfigChange('shortPeriod', parseInt(e.target.value))}
                min={1}
                max={100}
                className={commonInputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Long Period</label>
              <input
                type="number"
                value={config.longPeriod as number || 26}
                onChange={(e) => handleConfigChange('longPeriod', parseInt(e.target.value))}
                min={1}
                max={200}
                className={commonInputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Threshold (%)</label>
              <input
                type="range"
                min="0"
                max="10"
                step="0.5"
                value={(config.threshold as number || 2) * 100}
                onChange={(e) => handleConfigChange('threshold', parseFloat(e.target.value) / 100)}
                className="w-full"
              />
              <span className="text-sm text-gray-500">{((config.threshold as number || 0.02) * 100).toFixed(1)}%</span>
            </div>
          </div>
        );

      case AnalyzerType.RSI:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Period</label>
              <input
                type="number"
                value={config.period as number || 14}
                onChange={(e) => handleConfigChange('period', parseInt(e.target.value))}
                min={1}
                max={100}
                className={commonInputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Overbought Level</label>
              <input
                type="number"
                value={config.overbought as number || 70}
                onChange={(e) => handleConfigChange('overbought', parseInt(e.target.value))}
                min={50}
                max={100}
                className={commonInputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Oversold Level</label>
              <input
                type="number"
                value={config.oversold as number || 30}
                onChange={(e) => handleConfigChange('oversold', parseInt(e.target.value))}
                min={0}
                max={50}
                className={commonInputClass}
              />
            </div>
          </div>
        );

      case AnalyzerType.Volatility:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Window Size</label>
              <input
                type="number"
                value={config.windowSize as number || 20}
                onChange={(e) => handleConfigChange('windowSize', parseInt(e.target.value))}
                min={2}
                max={100}
                className={commonInputClass}
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="annualize"
                checked={config.annualize as boolean ?? true}
                onChange={(e) => handleConfigChange('annualize', e.target.checked)}
                className="rounded bg-gray-800 border-gray-700 text-purple-500"
              />
              <label htmlFor="annualize" className="text-sm text-gray-300">Annualize volatility</label>
            </div>
            <div>
              <label className={labelClass}>High Threshold</label>
              <input
                type="number"
                value={config.highThreshold as number || 0.03}
                onChange={(e) => handleConfigChange('highThreshold', parseFloat(e.target.value))}
                step="0.01"
                min="0"
                max="1"
                className={commonInputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Low Threshold</label>
              <input
                type="number"
                value={config.lowThreshold as number || 0.01}
                onChange={(e) => handleConfigChange('lowThreshold', parseFloat(e.target.value))}
                step="0.01"
                min="0"
                max="1"
                className={commonInputClass}
              />
            </div>
          </div>
        );

      case AnalyzerType.Sentiment:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Keywords (comma-separated)</label>
              <input
                type="text"
                value={(config.keywords as string[] || []).join(', ')}
                onChange={(e) => handleConfigChange('keywords', e.target.value.split(',').map(s => s.trim()))}
                placeholder="bitcoin, ethereum, crypto"
                className={commonInputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Weight</label>
              <input
                type="range"
                min="0.1"
                max="2"
                step="0.1"
                value={config.weight as number || 1.0}
                onChange={(e) => handleConfigChange('weight', parseFloat(e.target.value))}
                className="w-full"
              />
              <span className="text-sm text-gray-500">{(config.weight as number || 1.0).toFixed(1)}</span>
            </div>
            <div>
              <label className={labelClass}>Threshold</label>
              <input
                type="range"
                min="0"
                max="1"
                step="0.1"
                value={config.threshold as number || 0.6}
                onChange={(e) => handleConfigChange('threshold', parseFloat(e.target.value))}
                className="w-full"
              />
              <span className="text-sm text-gray-500">{(config.threshold as number || 0.6).toFixed(1)}</span>
            </div>
          </div>
        );

      case AnalyzerType.Custom:
        return (
          <div className="space-y-4">
            <div>
              <label className={labelClass}>Formula</label>
              <textarea
                value={config.formula as string || ''}
                onChange={(e) => handleConfigChange('formula', e.target.value)}
                placeholder="e.g., correlation(input0, input1) > 0.7"
                className={`${commonInputClass} font-mono text-sm h-24`}
              />
            </div>
          </div>
        );

      default:
        return (
          <div className="text-gray-500 text-sm">
            No configuration needed for this analyzer type.
          </div>
        );
    }
  };

  return (
    <div className={`bg-gray-900 rounded-lg border border-gray-800 overflow-hidden ${className}`}>
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
          <Activity className="w-4 h-4 text-purple-400" />
          Analyzers
        </h3>
        <span className="text-xs text-gray-500 bg-gray-800 px-2 py-1 rounded-full">
          {existingAnalyzers.length} active
        </span>
      </div>

      <div className="max-h-64 overflow-y-auto">
        {existingAnalyzers.length === 0 ? (
          <div className="px-4 py-8 text-center text-gray-500 text-sm">
            <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
            No analyzers configured
          </div>
        ) : (
          <div className="divide-y divide-gray-800">
            {existingAnalyzers.map((analyzer) => {
              let analyzerType: AnalyzerType | null = null;
              if ('Analyzer' in analyzer.node_type) {
                analyzerType = analyzer.node_type.Analyzer;
              }
              const meta = analyzerType ? ANALYZER_TYPE_METADATA[analyzerType] : null;
              const Icon = meta?.icon || Activity;

              return (
                <div 
                  key={analyzer.id} 
                  className="px-4 py-3 flex items-center justify-between hover:bg-gray-800/50 transition-colors group"
                >
                  <div className="flex items-center gap-3">
                    <div className={`p-2 rounded-lg bg-gray-800 ${meta?.color || 'text-gray-400'}`}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-200">
                        {analyzer.name || meta?.label || 'Unknown'}
                      </div>
                      <div className="text-xs text-gray-500 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-purple-500" />
                        {meta?.label || 'Analyzer'}
                    </div>
                    <button
                      onClick={() => handleRemove(analyzer.id)}
                      className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-500 hover:text-red-400 hover:bg-red-400/10 rounded transition-all"
                      title="Remove analyzer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="p-4 border-t border-gray-800">
        <button
          onClick={() => setIsModalOpen(true)}
          className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          Add Analyzer
        </button>
      </div>

      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-gray-900 rounded-xl border border-gray-800 shadow-2xl w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-800 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-white">
                {selectedType ? 'Configure Analyzer' : 'Select Analyzer Type'}
              </h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6">
              {(!selectedType) ? (
                <div className="grid grid-cols-2 gap-3">
                  {Object.entries(ANALYZER_TYPE_METADATA).map(([type, meta]) => (
                    <button
                      key={type}
                      onClick={() => handleTypeSelect(type as AnalyzerType)}
                      className="p-4 rounded-lg border border-gray-800 hover:border-gray-600 hover:bg-gray-800/50 transition-all text-left group"
                    >
                      <div className={`p-2 w-fit rounded-lg bg-gray-800 mb-3 group-hover:scale-110 transition-transform ${meta.color}`}>
                        <meta.icon className="w-5 h-5" />
                      </div>
                      <div className="font-medium text-gray-200 mb-1">{meta.label}</div>
                      <div className="text-xs text-gray-500 leading-relaxed">
                        {meta.description}
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="flex items-center gap-3 pb-4 border-b border-gray-800">
                    <button
                      onClick={() => setSelectedType(null)}
                      className="text-sm text-gray-500 hover:text-gray-300"
                    >
                      ← Back
                    </button>
                    <div className={`p-2 rounded-lg bg-gray-800 ${ANALYZER_TYPE_METADATA[selectedType].color}`}>
                      {(() => {
                        const Icon = ANALYZER_TYPE_METADATA[selectedType].icon;
                        return <Icon className="w-5 h-5" />;
                      })()}
                    </div>
                    <div>
                      <div className="font-medium text-white">{ANALYZER_TYPE_METADATA[selectedType].label}</div>
                      <div className="text-xs text-gray-500">Configure analyzer settings</div>
                    </div>
                  </div>

                  {renderConfigForm()}

                  {localError && (
                    <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                      <AlertCircle className="w-4 h-4 flex-shrink-0" />
                      {localError}
                    </div>
                  )}
                </div>
              )}
            </div>

            {selectedType && (
              <div className="px-6 py-4 border-t border-gray-800 flex items-center justify-end gap-3">
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="px-4 py-2 text-gray-400 hover:text-white transition-colors text-sm"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSubmit}
                  className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white rounded-lg transition-colors text-sm font-medium"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  Add Analyzer
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
