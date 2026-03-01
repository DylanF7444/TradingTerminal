// ============================================================================
// REAL-TIME CLOCK COMPONENT
// ============================================================================
//
// Module: components/UI/Clock.tsx
// Purpose: Displays the current time with second-level precision
// ============================================================================

import { useState, useEffect, type ReactNode } from 'react';

/**
 * Formats a Date to HH:MM:SS string.
 */
function formatTime(date: Date): string {
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((n) => n.toString().padStart(2, '0'))
    .join(':');
}

/**
 * Real-time clock component that updates every second.
 * Used in the sidebar header to display current time.
 */
export function Clock(): ReactNode {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex items-center justify-center gap-2">
      <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
      <span className="font-mono text-sm text-gray-300 tracking-wider">
        {formatTime(time)}
      </span>
    </div>
  );
}

export default Clock;
