/**
 * Time utilities for IM tools.
 * Ported from openclaw-lark/src/tools/oapi/im/time-utils.ts
 *
 * All calculations use Beijing time (UTC+8).
 */

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// ISO 8601 formatting
// ---------------------------------------------------------------------------

function formatBeijingISO(d: Date): string {
  const bj = new Date(d.getTime() + BJ_OFFSET_MS);
  const y = bj.getUTCFullYear();
  const mo = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const da = String(bj.getUTCDate()).padStart(2, '0');
  const h = String(bj.getUTCHours()).padStart(2, '0');
  const mi = String(bj.getUTCMinutes()).padStart(2, '0');
  const s = String(bj.getUTCSeconds()).padStart(2, '0');
  return `${y}-${mo}-${da}T${h}:${mi}:${s}+08:00`;
}

// ---------------------------------------------------------------------------
// Unix ↔ ISO 8601
// ---------------------------------------------------------------------------

export function secondsToDateTime(seconds: number): string {
  return formatBeijingISO(new Date(seconds * 1000));
}

export function millisToDateTime(millis: number): string {
  return formatBeijingISO(new Date(millis));
}

export function millisStringToDateTime(millis: string): string {
  return millisToDateTime(parseInt(millis, 10));
}

export function dateTimeToSeconds(datetime: string): number {
  const d = new Date(datetime);
  if (isNaN(d.getTime())) {
    throw new Error(
      `无法解析 ISO 8601 时间: "${datetime}"。格式示例: 2026-02-27T14:30:00+08:00`,
    );
  }
  return Math.floor(d.getTime() / 1000);
}

export function dateTimeToSecondsString(datetime: string): string {
  return dateTimeToSeconds(datetime).toString();
}

// ---------------------------------------------------------------------------
// Relative time range parsing
// ---------------------------------------------------------------------------

export interface TimeRange {
  start: string;
  end: string;
}

function toBeijingDate(d: Date): Date {
  return new Date(d.getTime() + BJ_OFFSET_MS);
}

function beijingStartOfDay(bjDate: Date): Date {
  return new Date(
    Date.UTC(bjDate.getUTCFullYear(), bjDate.getUTCMonth(), bjDate.getUTCDate()) -
      BJ_OFFSET_MS,
  );
}

function beijingEndOfDay(bjDate: Date): Date {
  return new Date(
    Date.UTC(
      bjDate.getUTCFullYear(),
      bjDate.getUTCMonth(),
      bjDate.getUTCDate(),
      23,
      59,
      59,
    ) - BJ_OFFSET_MS,
  );
}

function subtractFromNow(now: Date, n: number, unit: string): Date {
  const d = new Date(now);
  switch (unit) {
    case 'minute':
      d.setMinutes(d.getMinutes() - n);
      break;
    case 'hour':
      d.setHours(d.getHours() - n);
      break;
    case 'day':
      d.setDate(d.getDate() - n);
      break;
    default:
      throw new Error(`不支持的时间单位: ${unit}`);
  }
  return d;
}

/**
 * Parse a relative time identifier to an ISO 8601 time range.
 *
 * Supported formats:
 * - `today` / `yesterday` / `day_before_yesterday`
 * - `this_week` / `last_week` / `this_month` / `last_month`
 * - `last_{N}_{unit}` (unit: minutes / hours / days)
 */
export function parseTimeRange(input: string): TimeRange {
  const now = new Date();
  const bjNow = toBeijingDate(now);

  let start: Date;
  let end: Date;

  switch (input) {
    case 'today':
      start = beijingStartOfDay(bjNow);
      end = now;
      break;

    case 'yesterday': {
      const d = new Date(bjNow);
      d.setUTCDate(d.getUTCDate() - 1);
      start = beijingStartOfDay(d);
      end = beijingEndOfDay(d);
      break;
    }

    case 'day_before_yesterday': {
      const d = new Date(bjNow);
      d.setUTCDate(d.getUTCDate() - 2);
      start = beijingStartOfDay(d);
      end = beijingEndOfDay(d);
      break;
    }

    case 'this_week': {
      const day = bjNow.getUTCDay();
      const diffToMon = day === 0 ? 6 : day - 1;
      const monday = new Date(bjNow);
      monday.setUTCDate(monday.getUTCDate() - diffToMon);
      start = beijingStartOfDay(monday);
      end = now;
      break;
    }

    case 'last_week': {
      const day = bjNow.getUTCDay();
      const diffToMon = day === 0 ? 6 : day - 1;
      const thisMonday = new Date(bjNow);
      thisMonday.setUTCDate(thisMonday.getUTCDate() - diffToMon);
      const lastMonday = new Date(thisMonday);
      lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
      const lastSunday = new Date(thisMonday);
      lastSunday.setUTCDate(lastSunday.getUTCDate() - 1);
      start = beijingStartOfDay(lastMonday);
      end = beijingEndOfDay(lastSunday);
      break;
    }

    case 'this_month': {
      const firstDay = new Date(
        Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), 1),
      );
      start = beijingStartOfDay(firstDay);
      end = now;
      break;
    }

    case 'last_month': {
      const firstDayThisMonth = new Date(
        Date.UTC(bjNow.getUTCFullYear(), bjNow.getUTCMonth(), 1),
      );
      const lastDayPrevMonth = new Date(firstDayThisMonth);
      lastDayPrevMonth.setUTCDate(lastDayPrevMonth.getUTCDate() - 1);
      const firstDayPrevMonth = new Date(
        Date.UTC(
          lastDayPrevMonth.getUTCFullYear(),
          lastDayPrevMonth.getUTCMonth(),
          1,
        ),
      );
      start = beijingStartOfDay(firstDayPrevMonth);
      end = beijingEndOfDay(lastDayPrevMonth);
      break;
    }

    default: {
      const match = input.match(/^last_(\d+)_(minutes?|hours?|days?)$/);
      if (!match) {
        throw new Error(
          `不支持的 relative_time 格式: "${input}"。` +
            '支持: today, yesterday, day_before_yesterday, this_week, last_week, this_month, last_month, last_{N}_{unit}（unit: minutes/hours/days）',
        );
      }
      const n = parseInt(match[1], 10);
      const unit = match[2].replace(/s$/, '');
      start = subtractFromNow(now, n, unit);
      end = now;
      break;
    }
  }

  return {
    start: formatBeijingISO(start),
    end: formatBeijingISO(end),
  };
}

/**
 * Parse relative time identifier to Unix seconds string pair.
 */
export function parseTimeRangeToSeconds(
  input: string,
): { start: string; end: string } {
  const range = parseTimeRange(input);
  return {
    start: dateTimeToSecondsString(range.start),
    end: dateTimeToSecondsString(range.end),
  };
}
