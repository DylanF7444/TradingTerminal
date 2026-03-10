import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';

const SESSION_START = Date.now();

interface Session {
  id: string;
  started_at: number;
  ended_at: number | null;
}

type Period = 7 | 14 | 30;

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days > 0) {
    return `${days}d ${pad(remainingHours)}:${pad(minutes)}:${pad(seconds)}`;
  }
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function formatElapsedLong(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

function formatStartTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function formatDateShort(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

// ============================================================================
// SESSION TIMELINE GRAPH
// ============================================================================

const GRAPH_WIDTH = 340;
const GRAPH_HEIGHT = 48;
const LABEL_HEIGHT = 16;

function SessionTimeline({ sessions, period, currentSessionId }: {
  sessions: Session[];
  period: Period;
  currentSessionId: string | null;
}): ReactNode {
  const now = Date.now();
  const rangeStart = now - period * 86400 * 1000;

  // Compute total uptime within the period
  const totalUptimeMs = useMemo(() => {
    let total = 0;
    for (const s of sessions) {
      const start = Math.max(s.started_at * 1000, rangeStart);
      const end = s.ended_at ? Math.min(s.ended_at * 1000, now) : now;
      if (end > start) total += end - start;
    }
    return total;
  }, [sessions, rangeStart, now]);

  const totalPeriodMs = period * 86400 * 1000;
  const uptimePercent = totalPeriodMs > 0 ? ((totalUptimeMs / totalPeriodMs) * 100).toFixed(1) : '0.0';

  // Generate date labels
  const labels: { x: number; text: string }[] = [];
  const labelCount = Math.min(period, 6);
  for (let i = 0; i <= labelCount; i++) {
    const t = rangeStart + (totalPeriodMs / labelCount) * i;
    const x = (i / labelCount) * GRAPH_WIDTH;
    labels.push({ x, text: formatDateShort(new Date(t)) });
  }

  // Render session bars
  const bars = sessions.map((s) => {
    const startMs = Math.max(s.started_at * 1000, rangeStart);
    const endMs = s.ended_at ? Math.min(s.ended_at * 1000, now) : now;
    if (endMs <= startMs) return null;

    const x = ((startMs - rangeStart) / totalPeriodMs) * GRAPH_WIDTH;
    const w = Math.max(1, ((endMs - startMs) / totalPeriodMs) * GRAPH_WIDTH);
    const isCurrent = s.id === currentSessionId;

    return (
      <rect
        key={s.id}
        x={x}
        y={0}
        width={w}
        height={GRAPH_HEIGHT}
        rx={1}
        fill={isCurrent ? '#3b82f6' : '#22c55e'}
        opacity={isCurrent ? 0.9 : 0.6}
      >
        <title>
          {formatStartTime(s.started_at * 1000)}
          {s.ended_at ? ` — ${formatStartTime(s.ended_at * 1000)}` : ' — now'}
        </title>
      </rect>
    );
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] uppercase tracking-wider text-gray-500">Activity Timeline</div>
        <div className="text-[10px] text-gray-400">{uptimePercent}% uptime</div>
      </div>
      <svg
        width={GRAPH_WIDTH}
        height={GRAPH_HEIGHT + LABEL_HEIGHT}
        className="overflow-visible"
      >
        {/* Background */}
        <rect x={0} y={0} width={GRAPH_WIDTH} height={GRAPH_HEIGHT} rx={3} fill="#1f2937" />

        {/* Session bars */}
        {bars}

        {/* Date labels */}
        {labels.map((l, i) => (
          <text
            key={i}
            x={l.x}
            y={GRAPH_HEIGHT + 12}
            textAnchor={i === labels.length - 1 ? 'end' : i === 0 ? 'start' : 'middle'}
            className="fill-gray-500"
            fontSize={9}
            fontFamily="monospace"
          >
            {l.text}
          </text>
        ))}
      </svg>
      <div className="flex items-center gap-3 mt-1.5 text-[10px] text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm bg-blue-500 opacity-90" />
          Current
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-sm bg-green-500 opacity-60" />
          Past
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function UptimeDisplay(): ReactNode {
  const [elapsed, setElapsed] = useState(() => Date.now() - SESSION_START);
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<Period>(7);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const interval = setInterval(() => setElapsed(Date.now() - SESSION_START), 1000);
    return () => clearInterval(interval);
  }, []);

  // Fetch sessions when dropdown opens or period changes
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    const fetchSessions = async () => {
      try {
        const [sessionsResult, currentResult] = await Promise.all([
          invoke<Session[]>('get_sessions_cmd', { days: period }),
          invoke<{ session_id: string }>('get_current_session_cmd'),
        ]);
        if (cancelled) return;
        setSessions(sessionsResult);
        setCurrentSessionId(currentResult.session_id);
      } catch (e) {
        console.error('Failed to fetch sessions:', e);
      }
    };

    fetchSessions();
    return () => { cancelled = true; };
  }, [open, period]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as globalThis.Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const toggle = useCallback(() => setOpen((p) => !p), []);

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={toggle}
        className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
          open ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
        }`}
        title="Session uptime"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span className="font-mono tabular-nums">{formatElapsed(elapsed)}</span>
      </button>

      {open && (
        <div className="absolute top-full mt-2 right-0 bg-gray-800 border border-gray-700 rounded-lg shadow-xl z-50 p-3 space-y-3" style={{ width: GRAPH_WIDTH + 24 }}>
          {/* Current session info */}
          <div className="flex items-start justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Session Uptime</div>
              <div className="text-lg font-mono font-semibold text-gray-100 tabular-nums">
                {formatElapsedLong(elapsed)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-1">Started At</div>
              <div className="text-xs font-mono text-gray-300">{formatStartTime(SESSION_START)}</div>
            </div>
          </div>

          {/* Period selector */}
          <div className="border-t border-gray-700 pt-2">
            <div className="flex items-center gap-1 mb-2">
              {([7, 14, 30] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                    period === p
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:text-gray-200'
                  }`}
                >
                  {p}d
                </button>
              ))}
            </div>

            {/* Timeline graph */}
            <SessionTimeline
              sessions={sessions}
              period={period}
              currentSessionId={currentSessionId}
            />
          </div>
        </div>
      )}
    </div>
  );
}
