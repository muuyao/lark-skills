/**
 * Shared helpers for tool implementations.
 * Ported from openclaw-lark/src/tools/helpers.ts and oapi/helpers.ts
 */

// ---------------------------------------------------------------------------
// Tool result formatting
// ---------------------------------------------------------------------------

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
}

export function formatToolResult(data: unknown): ToolResult {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

/** Shorthand for formatToolResult */
export function json(data: unknown): ToolResult {
  return formatToolResult(data);
}

export function formatToolError(error: unknown, context?: Record<string, unknown>): ToolResult {
  const errorMsg = error instanceof Error ? error.message : String(error);
  return formatToolResult({
    error: errorMsg,
    ...context,
  });
}

// ---------------------------------------------------------------------------
// Lark API response assertion
// ---------------------------------------------------------------------------

export function assertLarkOk(res: { code?: number; msg?: string }): void {
  if (res.code !== undefined && res.code !== 0) {
    throw new Error(`Lark API error: code=${res.code}, msg=${res.msg || 'unknown'}`);
  }
}

// ---------------------------------------------------------------------------
// Time conversion utilities (ported from oapi/helpers.ts)
// ---------------------------------------------------------------------------

/**
 * Parse a time string to Unix timestamp (seconds).
 * Supports ISO 8601 with timezone, or plain datetime (defaults to Asia/Shanghai UTC+8).
 */
export function parseTimeToTimestamp(input: string): string | null {
  try {
    const trimmed = input.trim();
    const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed);

    if (hasTimezone) {
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return Math.floor(date.getTime() / 1000).toString();
    }

    const normalized = trimmed.replace('T', ' ');
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);

    if (!match) {
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return Math.floor(date.getTime() / 1000).toString();
    }

    const [, year, month, day, hour, minute, second] = match;
    const utcDate = new Date(
      Date.UTC(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour) - 8,
        parseInt(minute),
        parseInt(second ?? '0'),
      ),
    );

    return Math.floor(utcDate.getTime() / 1000).toString();
  } catch {
    return null;
  }
}

/**
 * Parse a time string to Unix timestamp (milliseconds).
 */
export function parseTimeToTimestampMs(input: string): string | null {
  try {
    const trimmed = input.trim();
    const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed);

    if (hasTimezone) {
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return date.getTime().toString();
    }

    const normalized = trimmed.replace('T', ' ');
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);

    if (!match) {
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return date.getTime().toString();
    }

    const [, year, month, day, hour, minute, second] = match;
    const utcDate = new Date(
      Date.UTC(
        parseInt(year),
        parseInt(month) - 1,
        parseInt(day),
        parseInt(hour) - 8,
        parseInt(minute),
        parseInt(second ?? '0'),
      ),
    );

    return utcDate.getTime().toString();
  } catch {
    return null;
  }
}

/**
 * Parse time string to RFC 3339 format.
 */
export function parseTimeToRFC3339(input: string): string | null {
  try {
    const trimmed = input.trim();
    const hasTimezone = /[Zz]$|[+-]\d{2}:\d{2}$/.test(trimmed);

    if (hasTimezone) {
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return trimmed;
    }

    const normalized = trimmed.replace('T', ' ');
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);

    if (!match) {
      const date = new Date(trimmed);
      if (isNaN(date.getTime())) return null;
      return trimmed.includes('T') ? `${trimmed}+08:00` : trimmed;
    }

    const [, year, month, day, hour, minute, second] = match;
    const sec = second ?? '00';

    return `${year}-${month}-${day}T${hour}:${minute}:${sec}+08:00`;
  } catch {
    return null;
  }
}

/**
 * Convert time range object with string timestamps to numeric.
 */
export function convertTimeRange(
  timeRange: { start?: string; end?: string } | undefined,
  unit: 's' | 'ms' = 's',
): { start?: number; end?: number } | undefined {
  if (!timeRange) return undefined;

  const result: { start?: number; end?: number } = {};
  const parseFn = unit === 'ms' ? parseTimeToTimestampMs : parseTimeToTimestamp;

  if (timeRange.start) {
    const ts = parseFn(timeRange.start);
    if (!ts) {
      throw new Error(`Invalid time format for start: ${timeRange.start}. Use ISO 8601 format.`);
    }
    result.start = parseInt(ts, 10);
  }

  if (timeRange.end) {
    const ts = parseFn(timeRange.end);
    if (!ts) {
      throw new Error(`Invalid time format for end: ${timeRange.end}. Use ISO 8601 format.`);
    }
    result.end = parseInt(ts, 10);
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Convert Unix timestamp (seconds or milliseconds) to ISO 8601 in Asia/Shanghai.
 */
export function unixTimestampToISO8601(raw: string | number | undefined): string | null {
  if (raw === undefined || raw === null) return null;

  const text = typeof raw === 'number' ? String(raw) : String(raw).trim();
  if (!/^-?\d+$/.test(text)) return null;

  const num = Number(text);
  if (!Number.isFinite(num)) return null;

  const utcMs = Math.abs(num) >= 1e12 ? num : num * 1000;
  const pad2 = (v: number) => String(v).padStart(2, '0');

  const beijingDate = new Date(utcMs + 8 * 60 * 60 * 1000);
  if (Number.isNaN(beijingDate.getTime())) return null;

  const year = beijingDate.getUTCFullYear();
  const month = pad2(beijingDate.getUTCMonth() + 1);
  const day = pad2(beijingDate.getUTCDate());
  const hour = pad2(beijingDate.getUTCHours());
  const minute = pad2(beijingDate.getUTCMinutes());
  const second = pad2(beijingDate.getUTCSeconds());

  return `${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`;
}
