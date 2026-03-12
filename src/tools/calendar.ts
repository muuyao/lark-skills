/**
 * Feishu Calendar MCP Tools
 *
 * Ported from openclaw-lark calendar tools:
 *   - calendar.ts     (calendar management: list, get, primary)
 *   - event.ts        (event CRUD: create, list, get, patch, delete, search, reply, instances, instance_view)
 *   - event-attendee.ts (attendee management: create, list, batch_delete)
 *   - freebusy.ts     (free/busy query: list)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Type } from '@sinclair/typebox';
import {
  json,
  assertLarkOk,
  parseTimeToTimestamp,
  parseTimeToTimestampMs,
  parseTimeToRFC3339,
  convertTimeRange,
  formatToolError,
  unixTimestampToISO8601,
} from '../core/helpers.js';
import { getLarkClient } from '../core/client.js';
import type { ToolResult } from '../core/helpers.js';

// ===========================================================================
// Local helper: formatLarkError (used only in event create attendee error path)
// ===========================================================================

function formatLarkError(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return String(err);
  }
  const e = err as {
    code?: number;
    msg?: string;
    message?: string;
    response?: { data?: { code?: number; msg?: string } };
  };

  if (typeof e.code === 'number' && e.msg) {
    return e.msg;
  }

  const data = e.response?.data;
  if (data && typeof data.code === 'number' && data.msg) {
    return data.msg;
  }

  return e.message ?? String(err);
}

// ===========================================================================
//  1. CALENDAR MANAGEMENT TOOL
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuCalendarCalendarSchema = Type.Union([
  // LIST
  Type.Object({
    action: Type.Literal('list'),
    page_size: Type.Optional(
      Type.Number({
        description: 'Number of calendars to return per page (default: 50, max: 1000)',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: 'Pagination token for next page',
      }),
    ),
  }),

  // GET
  Type.Object({
    action: Type.Literal('get'),
    calendar_id: Type.String({
      description: 'Calendar ID',
    }),
  }),

  // PRIMARY
  Type.Object({
    action: Type.Literal('primary'),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuCalendarCalendarParams =
  | { action: 'list'; page_size?: number; page_token?: string }
  | { action: 'get'; calendar_id: string }
  | { action: 'primary' };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const feishuCalendarCalendarTool = {
  name: 'feishu_calendar_calendar',
  description:
    '飞书日历管理工具。用于查询日历列表、获取日历信息、查询主日历。Actions: list（查询日历列表）, get（查询指定日历信息）, primary（查询主日历信息）。',
  schema: FeishuCalendarCalendarSchema,
  handler: async (params: unknown): Promise<ToolResult> => {
    const p = params as FeishuCalendarCalendarParams;
    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // LIST CALENDARS
        // -----------------------------------------------------------------
        case 'list': {
          const res = await client.calendar.calendar.list({
            params: {
              page_size: p.page_size,
              page_token: p.page_token,
            },
          });
          assertLarkOk(res);

          const data = res.data as { calendar_list?: any[]; has_more?: boolean; page_token?: string } | undefined;
          const calendars = data?.calendar_list ?? [];

          return json({
            calendars,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // GET CALENDAR
        // -----------------------------------------------------------------
        case 'get': {
          if (!p.calendar_id) {
            return json({
              error: "calendar_id is required for 'get' action",
            });
          }

          const res = await client.calendar.calendar.get({
            path: { calendar_id: p.calendar_id },
          });
          assertLarkOk(res);

          const data = res.data as { calendar?: any } | undefined;
          return json({
            calendar: data?.calendar ?? res.data,
          });
        }

        // -----------------------------------------------------------------
        // PRIMARY CALENDAR
        // -----------------------------------------------------------------
        case 'primary': {
          const res = await client.calendar.calendar.primary({});
          assertLarkOk(res);

          const data = res.data as { calendars?: any[] } | undefined;
          const calendars = data?.calendars ?? [];

          return json({
            calendars,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
//  2. CALENDAR EVENT TOOL
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuCalendarEventSchema = Type.Union([
  // CREATE
  Type.Object({
    action: Type.Literal('create'),
    start_time: Type.String({
      description: "开始时间（必填）。ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'",
    }),
    end_time: Type.String({
      description: '结束时间（必填）。格式同 start_time。如果用户未指定时长，默认为开始时间后1小时。',
    }),
    summary: Type.Optional(
      Type.String({
        description: '日程标题（可选，但强烈建议提供）',
      }),
    ),
    user_open_id: Type.Optional(
      Type.String({
        description:
          '当前请求用户的 open_id（可选，但强烈建议提供）。从消息上下文的 SenderId 字段获取，格式为 ou_xxx。日程创建在应用日历上，必须通过此参数将用户加为参会人，日程才会出现在用户的飞书日历中。',
      }),
    ),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: '日程描述',
      }),
    ),
    attendees: Type.Optional(
      Type.Array(
        Type.Object({
          type: Type.Union([
            Type.Literal('user'),
            Type.Literal('chat'),
            Type.Literal('resource'),
            Type.Literal('third_party'),
          ]),
          id: Type.String({
            description: 'Attendee open_id, chat_id, resource_id, or email',
          }),
        }),
        {
          description:
            "参会人列表（强烈建议提供，否则日程只在应用日历上，用户看不到）。type='user' 时 id 填 open_id，type='third_party' 时 id 填邮箱。",
        },
      ),
    ),
    vchat: Type.Optional(
      Type.Object(
        {
          vc_type: Type.Optional(
            Type.Union([Type.Literal('vc'), Type.Literal('third_party'), Type.Literal('no_meeting')], {
              description:
                '视频会议类型：vc（飞书视频会议）、third_party（第三方链接）、no_meeting（无视频会议）。默认为空，首次添加参与人时自动生成飞书视频会议。',
            }),
          ),
          icon_type: Type.Optional(
            Type.Union([Type.Literal('vc'), Type.Literal('live'), Type.Literal('default')], {
              description: '第三方视频会议 icon 类型（仅 vc_type=third_party 时有效）。',
            }),
          ),
          description: Type.Optional(
            Type.String({
              description: '第三方视频会议文案（仅 vc_type=third_party 时有效）。',
            }),
          ),
          meeting_url: Type.Optional(
            Type.String({
              description: '第三方视频会议链接（仅 vc_type=third_party 时有效）。',
            }),
          ),
        },
        {
          description: '视频会议信息。不传则默认在首次添加参与人时自动生成飞书视频会议。',
        },
      ),
    ),
    visibility: Type.Optional(
      Type.Union([Type.Literal('default'), Type.Literal('public'), Type.Literal('private')], {
        description:
          '日程公开范围。default（默认，跟随日历权限）、public（公开详情）、private（私密，仅自己可见）。默认值：default。',
      }),
    ),
    attendee_ability: Type.Optional(
      Type.Union(
        [
          Type.Literal('none'),
          Type.Literal('can_see_others'),
          Type.Literal('can_invite_others'),
          Type.Literal('can_modify_event'),
        ],
        {
          description:
            '参与人权限。none（无法编辑、邀请、查看）、can_see_others（可查看参与人列表）、can_invite_others（可邀请其他人）、can_modify_event（可编辑日程）。默认值：none。',
        },
      ),
    ),
    free_busy_status: Type.Optional(
      Type.Union([Type.Literal('busy'), Type.Literal('free')], {
        description: '日程占用的忙闲状态。busy（忙碌）、free（空闲）。默认值：busy。',
      }),
    ),
    location: Type.Optional(
      Type.Object(
        {
          name: Type.Optional(
            Type.String({
              description: '地点名称',
            }),
          ),
          address: Type.Optional(
            Type.String({
              description: '地点地址',
            }),
          ),
          latitude: Type.Optional(
            Type.Number({
              description: '地点坐标纬度（国内采用 GCJ-02 标准，海外采用 WGS84 标准）',
            }),
          ),
          longitude: Type.Optional(
            Type.Number({
              description: '地点坐标经度（国内采用 GCJ-02 标准，海外采用 WGS84 标准）',
            }),
          ),
        },
        {
          description: '日程地点信息',
        },
      ),
    ),
    reminders: Type.Optional(
      Type.Array(
        Type.Object({
          minutes: Type.Number({
            description:
              '日程提醒时间的偏移量（分钟）。正数表示在日程开始前提醒，负数表示在日程开始后提醒。范围：-20160 ~ 20160。',
          }),
        }),
        {
          description: '日程提醒列表',
        },
      ),
    ),
    recurrence: Type.Optional(
      Type.String({
        description: "重复日程的重复性规则（RFC5545 RRULE 格式）。例如：'FREQ=DAILY;INTERVAL=1' 表示每天重复。",
      }),
    ),
  }),

  // LIST (使用 instance_view 接口)
  Type.Object({
    action: Type.Literal('list'),
    start_time: Type.String({
      description:
        "开始时间。ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。注意：start_time 与 end_time 之间的时间区间需要小于 40 天。",
    }),
    end_time: Type.String({
      description: '结束时间。格式同 start_time。注意：start_time 与 end_time 之间的时间区间需要小于 40 天。',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
  }),

  // GET
  Type.Object({
    action: Type.Literal('get'),
    event_id: Type.String({
      description: 'Event ID',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
  }),

  // PATCH (P1)
  Type.Object({
    action: Type.Literal('patch'),
    event_id: Type.String({
      description: 'Event ID',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    summary: Type.Optional(
      Type.String({
        description: '新的日程标题',
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: '新的日程描述',
      }),
    ),
    start_time: Type.Optional(
      Type.String({
        description: "新的开始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
      }),
    ),
    end_time: Type.Optional(
      Type.String({
        description: "新的结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
      }),
    ),
    location: Type.Optional(
      Type.String({
        description: '新的地点',
      }),
    ),
  }),

  // DELETE (P1)
  Type.Object({
    action: Type.Literal('delete'),
    event_id: Type.String({
      description: 'Event ID',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    need_notification: Type.Optional(
      Type.Boolean({
        description: '是否通知参会人（默认 true）',
      }),
    ),
  }),

  // SEARCH (P1)
  Type.Object({
    action: Type.Literal('search'),
    query: Type.String({
      description: '搜索关键词',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    page_size: Type.Optional(
      Type.Number({
        description: '每页数量',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
  }),

  // REPLY (P1)
  Type.Object({
    action: Type.Literal('reply'),
    event_id: Type.String({
      description: 'Event ID',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    rsvp_status: Type.Union([Type.Literal('accept'), Type.Literal('decline'), Type.Literal('tentative')]),
  }),

  // INSTANCES (P1)
  Type.Object({
    action: Type.Literal('instances'),
    event_id: Type.String({
      description: '重复日程的 Event ID',
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    start_time: Type.String({
      description: "查询起始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
    }),
    end_time: Type.String({
      description: "查询结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
    }),
    page_size: Type.Optional(
      Type.Number({
        description: '每页数量',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
  }),

  // INSTANCE_VIEW (P1)
  Type.Object({
    action: Type.Literal('instance_view'),
    start_time: Type.String({
      description: "查询起始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
    }),
    end_time: Type.String({
      description: "查询结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
    }),
    calendar_id: Type.Optional(
      Type.String({
        description: 'Calendar ID (optional; primary calendar used if omitted)',
      }),
    ),
    page_size: Type.Optional(
      Type.Number({
        description: '每页数量',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuCalendarEventParams =
  | {
      action: 'create';
      start_time: string;
      end_time: string;
      summary?: string;
      user_open_id?: string;
      calendar_id?: string;
      description?: string;
      attendees?: Array<{ type: string; id: string }>;
      vchat?: {
        vc_type?: 'vc' | 'third_party' | 'no_meeting';
        icon_type?: 'vc' | 'live' | 'default';
        description?: string;
        meeting_url?: string;
      };
      visibility?: 'default' | 'public' | 'private';
      attendee_ability?: 'none' | 'can_see_others' | 'can_invite_others' | 'can_modify_event';
      free_busy_status?: 'busy' | 'free';
      location?: {
        name?: string;
        address?: string;
        latitude?: number;
        longitude?: number;
      };
      reminders?: Array<{ minutes: number }>;
      recurrence?: string;
    }
  | {
      action: 'list';
      start_time: string;
      end_time: string;
      calendar_id?: string;
    }
  | {
      action: 'get';
      event_id: string;
      calendar_id?: string;
    }
  | {
      action: 'patch';
      event_id: string;
      calendar_id?: string;
      summary?: string;
      description?: string;
      start_time?: string;
      end_time?: string;
      location?: string;
    }
  | {
      action: 'delete';
      event_id: string;
      calendar_id?: string;
      need_notification?: boolean;
    }
  | {
      action: 'search';
      query: string;
      calendar_id?: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'reply';
      event_id: string;
      calendar_id?: string;
      rsvp_status: 'accept' | 'decline' | 'tentative';
    }
  | {
      action: 'instances';
      event_id: string;
      calendar_id?: string;
      start_time: string;
      end_time: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'instance_view';
      start_time: string;
      end_time: string;
      calendar_id?: string;
      page_size?: number;
      page_token?: string;
    };

// ---------------------------------------------------------------------------
// Event time normalization helpers
// ---------------------------------------------------------------------------

function normalizeCalendarTimeValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === 'string') {
    const iso = unixTimestampToISO8601(value);
    return iso ?? value;
  }

  if (typeof value !== 'object') return undefined;

  const timeObj = value as { timestamp?: unknown; date?: unknown };
  const fromTimestamp = unixTimestampToISO8601(timeObj.timestamp as string | number | undefined);
  if (fromTimestamp) return fromTimestamp;

  if (typeof timeObj.date === 'string') return timeObj.date;

  return undefined;
}

function normalizeEventTimeFields(event: Record<string, any> | undefined): Record<string, any> | undefined {
  if (!event) return event;

  const normalized: Record<string, any> = { ...event };

  const startTime = normalizeCalendarTimeValue(event.start_time);
  if (startTime) {
    normalized.start_time = startTime;
  }

  const endTime = normalizeCalendarTimeValue(event.end_time);
  if (endTime) {
    normalized.end_time = endTime;
  }

  const createTime = unixTimestampToISO8601(event.create_time as string | number | undefined);
  if (createTime) {
    normalized.create_time = createTime;
  }

  return normalized;
}

function normalizeEventListTimeFields(
  events: Array<Record<string, any>> | undefined,
): Array<Record<string, any>> | undefined {
  if (!events) return events;
  return events.map((item) => normalizeEventTimeFields(item) as Record<string, any>);
}

// ---------------------------------------------------------------------------
// Calendar ID resolution helpers
// ---------------------------------------------------------------------------

async function resolveCalendarId(): Promise<string | null> {
  const client = getLarkClient();
  const primaryRes = await client.calendar.calendar.primary({});
  const data = primaryRes.data as { calendars?: Array<{ calendar?: { calendar_id?: string } }> } | undefined;
  const cid = data?.calendars?.[0]?.calendar?.calendar_id;
  if (cid) return cid;
  return null;
}

async function resolveCalendarIdOrFail(calendarId: string | undefined): Promise<string> {
  if (calendarId) return calendarId;
  const resolved = await resolveCalendarId();
  if (!resolved) throw new Error('Could not determine primary calendar');
  return resolved;
}

// ---------------------------------------------------------------------------
// Paginated data type (used across event and attendee tools)
// ---------------------------------------------------------------------------

interface PaginatedData<T = any> {
  items?: T[];
  has_more?: boolean;
  page_token?: string;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const feishuCalendarEventTool = {
  name: 'feishu_calendar_event',
  description:
    "飞书日程管理工具。当用户要求查看日程、创建会议、约会议、修改日程、删除日程、搜索日程、回复日程邀请时使用。Actions: create（创建日历事件）, list（查询时间范围内的日程，自动展开重复日程）, get（获取日程详情）, patch（更新日程）, delete（删除日程）, search（搜索日程）, reply（回复日程邀请）, instances（获取重复日程的实例列表，仅对重复日程有效）, instance_view（查看展开后的日程列表）。【重要】create 时必须传 user_open_id 参数，值为消息上下文中的 SenderId（格式 ou_xxx），否则日程只在应用日历上，用户完全看不到。list 操作使用 instance_view 接口，会自动展开重复日程为多个实例，时间区间不能超过40天，返回实例数量上限1000。时间参数使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
  schema: FeishuCalendarEventSchema,
  handler: async (params: unknown): Promise<ToolResult> => {
    const p = params as FeishuCalendarEventParams;
    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // CREATE EVENT
        // -----------------------------------------------------------------
        case 'create': {
          if (!p.summary) return json({ error: 'summary is required' });
          if (!p.start_time) return json({ error: 'start_time is required' });
          if (!p.end_time) return json({ error: 'end_time is required' });

          const startTs = parseTimeToTimestamp(p.start_time);
          const endTs = parseTimeToTimestamp(p.end_time);
          if (!startTs || !endTs)
            return json({
              error:
                "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00' or '2026-02-25 14:00:00'. Do not pass Unix timestamp numbers.",
              received_start: p.start_time,
              received_end: p.end_time,
            });

          // Resolve bot's calendar
          const calendarId = await resolveCalendarIdOrFail(p.calendar_id);

          const eventData: any = {
            summary: p.summary,
            start_time: { timestamp: startTs },
            end_time: { timestamp: endTs },
            need_notification: true,
            attendee_ability: p.attendee_ability ?? 'can_modify_event',
          };
          if (p.description) eventData.description = p.description;

          // 视频会议配置
          if (p.vchat) {
            eventData.vchat = {};
            if (p.vchat.vc_type) eventData.vchat.vc_type = p.vchat.vc_type;
            if (p.vchat.icon_type) eventData.vchat.icon_type = p.vchat.icon_type;
            if (p.vchat.description) eventData.vchat.description = p.vchat.description;
            if (p.vchat.meeting_url) eventData.vchat.meeting_url = p.vchat.meeting_url;
          }

          // 公开范围
          if (p.visibility) eventData.visibility = p.visibility;

          // 忙闲状态
          if (p.free_busy_status) eventData.free_busy_status = p.free_busy_status;

          // 地点信息
          if (p.location) {
            eventData.location = {};
            if (p.location.name) eventData.location.name = p.location.name;
            if (p.location.address) eventData.location.address = p.location.address;
            if (p.location.latitude !== undefined) eventData.location.latitude = p.location.latitude;
            if (p.location.longitude !== undefined) eventData.location.longitude = p.location.longitude;
          }

          // 提醒列表
          if (p.reminders) {
            eventData.reminders = p.reminders.map((r) => ({ minutes: r.minutes }));
          }

          // 重复规则
          if (p.recurrence) eventData.recurrence = p.recurrence;

          const res = await client.calendar.calendarEvent.create({
            path: { calendar_id: calendarId },
            data: eventData,
          });
          assertLarkOk(res);

          // Build attendee list: merge explicit attendees + user_open_id
          const allAttendees: Array<{ type: string; id: string }> = [...(p.attendees ?? [])];
          if (p.user_open_id) {
            const alreadyIncluded = allAttendees.some((a) => a.type === 'user' && a.id === p.user_open_id);
            if (!alreadyIncluded) {
              allAttendees.push({ type: 'user', id: p.user_open_id });
            }
          }

          let attendeeError: string | undefined;

          const operateId = p.user_open_id ?? p.attendees?.find((a) => a.type === 'user')?.id;

          if (allAttendees.length > 0 && res.data?.event?.event_id) {
            const attendeeData = allAttendees.map((a) => ({
              type: a.type as 'user' | 'chat' | 'resource' | 'third_party',
              user_id: a.type === 'user' ? a.id : undefined,
              chat_id: a.type === 'chat' ? a.id : undefined,
              room_id: a.type === 'resource' ? a.id : undefined,
              third_party_email: a.type === 'third_party' ? a.id : undefined,
              operate_id: operateId,
            }));

            try {
              const attendeeRes = await client.calendar.calendarEventAttendee.create({
                path: {
                  calendar_id: calendarId,
                  event_id: res.data?.event?.event_id!,
                },
                params: { user_id_type: 'open_id' as any },
                data: {
                  attendees: attendeeData,
                  need_notification: true,
                },
              });
              assertLarkOk(attendeeRes);
            } catch (attendeeErr) {
              attendeeError = formatLarkError(attendeeErr);
            }
          }

          // Strip calendarId from app_link -- it points to bot's calendar, users can't access it
          const appLink = (res.data?.event as any)?.app_link as string | undefined;

          const safeEvent = res.data?.event
            ? {
                event_id: res.data.event.event_id,
                summary: res.data.event.summary,
                app_link: appLink,
                start_time: unixTimestampToISO8601(startTs) ?? p.start_time,
                end_time: unixTimestampToISO8601(endTs) ?? p.end_time,
              }
            : undefined;

          const result: any = {
            event: safeEvent,
            attendees: allAttendees.map((a) => ({
              type: a.type,
              id: a.id,
            })),
            _debug: {
              calendar_id: calendarId,
              operate_id: operateId,
              start_input: p.start_time,
              start_iso8601: unixTimestampToISO8601(startTs) ?? p.start_time,
              end_input: p.end_time,
              end_iso8601: unixTimestampToISO8601(endTs) ?? p.end_time,
              attendees_count: allAttendees.length,
            },
          };
          if (attendeeError) {
            result.warning = `日程已创建，但添加参会人失败：${attendeeError}`;
          } else if (allAttendees.length === 0) {
            result.error =
              '日程已创建在应用日历上，但未添加任何参会人，用户看不到此日程。请重新调用时传入 user_open_id 参数。';
          } else {
            result.note = `已成功添加 ${allAttendees.length} 位参会人，日程应出现在参会人的飞书日历中。`;
          }
          return json(result);
        }

        // -----------------------------------------------------------------
        // LIST EVENTS (使用 instance_view 接口，自动展开重复日程)
        // -----------------------------------------------------------------
        case 'list': {
          if (!p.start_time) return json({ error: 'start_time is required' });
          if (!p.end_time) return json({ error: 'end_time is required' });

          const startTs = parseTimeToTimestamp(p.start_time);
          const endTs = parseTimeToTimestamp(p.end_time);
          if (!startTs || !endTs)
            return json({
              error:
                "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00' or '2026-02-25 14:00:00'. Do not pass Unix timestamps.",
              received_start: p.start_time,
              received_end: p.end_time,
            });

          const calendarId = await resolveCalendarIdOrFail(p.calendar_id);

          const res = await client.calendar.calendarEvent.instanceView({
            path: { calendar_id: calendarId },
            params: {
              start_time: startTs,
              end_time: endTs,
              user_id_type: 'open_id' as any,
            },
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            events: normalizeEventListTimeFields(data?.items as Array<Record<string, any>> | undefined),
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // GET EVENT
        // -----------------------------------------------------------------
        case 'get': {
          if (!p.event_id) return json({ error: 'event_id is required' });

          const calendarId = await resolveCalendarIdOrFail(p.calendar_id);

          const res = await client.calendar.calendarEvent.get({
            path: { calendar_id: calendarId, event_id: p.event_id },
          });
          assertLarkOk(res);

          return json({
            event: normalizeEventTimeFields(res.data?.event as Record<string, any> | undefined),
          });
        }

        // -----------------------------------------------------------------
        // PATCH EVENT (P1)
        // -----------------------------------------------------------------
        case 'patch': {
          if (!p.event_id) return json({ error: 'event_id is required' });

          const calendarId = await resolveCalendarIdOrFail(p.calendar_id);

          const updateData: any = {};

          // Handle time conversion if provided
          if (p.start_time) {
            const startTs = parseTimeToTimestamp(p.start_time);
            if (!startTs)
              return json({
                error:
                  "start_time 格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'",
                received: p.start_time,
              });
            updateData.start_time = { timestamp: startTs };
          }

          if (p.end_time) {
            const endTs = parseTimeToTimestamp(p.end_time);
            if (!endTs)
              return json({
                error:
                  "end_time 格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'",
                received: p.end_time,
              });
            updateData.end_time = { timestamp: endTs };
          }

          if (p.summary) updateData.summary = p.summary;
          if (p.description) updateData.description = p.description;
          if (p.location) updateData.location = { name: p.location };

          const res = await client.calendar.calendarEvent.patch({
            path: { calendar_id: calendarId, event_id: p.event_id },
            data: updateData,
          });
          assertLarkOk(res);

          return json({
            event: normalizeEventTimeFields(res.data?.event as Record<string, any> | undefined),
          });
        }

        // -----------------------------------------------------------------
        // DELETE EVENT (P1)
        // -----------------------------------------------------------------
        case 'delete': {
          if (!p.event_id) return json({ error: 'event_id is required' });

          const calendarId = await resolveCalendarIdOrFail(p.calendar_id);

          const res = await client.calendar.calendarEvent.delete({
            path: { calendar_id: calendarId, event_id: p.event_id },
            params: {
              need_notification: (p.need_notification ?? true) as any,
            },
          });
          assertLarkOk(res);

          return json({
            success: true,
            event_id: p.event_id,
          });
        }

        // -----------------------------------------------------------------
        // SEARCH EVENT (P1)
        // -----------------------------------------------------------------
        case 'search': {
          if (!p.query) return json({ error: 'query is required' });

          const calendarId = await resolveCalendarIdOrFail(p.calendar_id);

          const res = await client.calendar.calendarEvent.search({
            path: { calendar_id: calendarId },
            params: {
              page_size: p.page_size,
              page_token: p.page_token,
            },
            data: {
              query: p.query,
            },
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            events: normalizeEventListTimeFields(data?.items as Array<Record<string, any>> | undefined),
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // REPLY EVENT (P1)
        // -----------------------------------------------------------------
        case 'reply': {
          if (!p.event_id) return json({ error: 'event_id is required' });
          if (!p.rsvp_status) return json({ error: 'rsvp_status is required' });

          const calendarId = await resolveCalendarIdOrFail(p.calendar_id);

          const res = await client.calendar.calendarEvent.reply({
            path: { calendar_id: calendarId, event_id: p.event_id },
            data: {
              rsvp_status: p.rsvp_status,
            },
          });
          assertLarkOk(res);

          return json({
            success: true,
            event_id: p.event_id,
            rsvp_status: p.rsvp_status,
          });
        }

        // -----------------------------------------------------------------
        // INSTANCES (P1)
        // -----------------------------------------------------------------
        case 'instances': {
          if (!p.event_id) return json({ error: 'event_id is required' });
          if (!p.start_time) return json({ error: 'start_time is required' });
          if (!p.end_time) return json({ error: 'end_time is required' });

          const calendarId = await resolveCalendarIdOrFail(p.calendar_id);

          const startTs = parseTimeToTimestamp(p.start_time);
          const endTs = parseTimeToTimestamp(p.end_time);

          if (!startTs || !endTs)
            return json({
              error:
                "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00'",
              received_start: p.start_time,
              received_end: p.end_time,
            });

          const res = await client.calendar.calendarEvent.instances({
            path: { calendar_id: calendarId, event_id: p.event_id },
            params: {
              start_time: startTs as any,
              end_time: endTs as any,
              page_size: p.page_size,
              page_token: p.page_token,
            },
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            instances: normalizeEventListTimeFields(data?.items as Array<Record<string, any>> | undefined),
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // INSTANCE_VIEW (P1)
        // -----------------------------------------------------------------
        case 'instance_view': {
          if (!p.start_time) return json({ error: 'start_time is required' });
          if (!p.end_time) return json({ error: 'end_time is required' });

          const calendarId = await resolveCalendarIdOrFail(p.calendar_id);

          const startTs = parseTimeToTimestamp(p.start_time);
          const endTs = parseTimeToTimestamp(p.end_time);

          if (!startTs || !endTs)
            return json({
              error:
                "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00'",
              received_start: p.start_time,
              received_end: p.end_time,
            });

          const res = await client.calendar.calendarEvent.instanceView({
            path: { calendar_id: calendarId },
            params: {
              start_time: startTs,
              end_time: endTs,
              user_id_type: 'open_id' as any,
            },
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            events: normalizeEventListTimeFields(data?.items as Array<Record<string, any>> | undefined),
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
//  3. CALENDAR EVENT ATTENDEE TOOL
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuCalendarEventAttendeeSchema = Type.Union([
  // CREATE
  Type.Object({
    action: Type.Literal('create'),
    calendar_id: Type.String({
      description: '日历 ID',
    }),
    event_id: Type.String({
      description: '日程 ID',
    }),
    attendees: Type.Array(
      Type.Object({
        type: Type.Union([
          Type.Literal('user'),
          Type.Literal('chat'),
          Type.Literal('resource'),
          Type.Literal('third_party'),
        ]),
        attendee_id: Type.String({
          description:
            '参会人 ID。type=user 时为 open_id，type=chat 时为 chat_id，type=resource 时为会议室 ID，type=third_party 时为邮箱地址',
        }),
      }),
      {
        description: '参会人列表',
      },
    ),
    need_notification: Type.Optional(
      Type.Boolean({
        description: '是否给参会人发送通知（默认 true）',
      }),
    ),
    attendee_ability: Type.Optional(
      Type.Union([
        Type.Literal('none'),
        Type.Literal('can_see_others'),
        Type.Literal('can_invite_others'),
        Type.Literal('can_modify_event'),
      ]),
    ),
  }),

  // LIST
  Type.Object({
    action: Type.Literal('list'),
    calendar_id: Type.String({
      description: '日历 ID',
    }),
    event_id: Type.String({
      description: '日程 ID',
    }),
    page_size: Type.Optional(
      Type.Number({
        description: '每页数量（默认 50，最大 500）',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
    user_id_type: Type.Optional(
      Type.Union([Type.Literal('open_id'), Type.Literal('union_id'), Type.Literal('user_id')]),
    ),
  }),

  // BATCH_DELETE (P1)
  Type.Object({
    action: Type.Literal('batch_delete'),
    calendar_id: Type.String({
      description: '日历 ID',
    }),
    event_id: Type.String({
      description: '日程 ID',
    }),
    user_open_ids: Type.Array(
      Type.String({
        description: '要删除的参会人的 open_id（ou_...格式）',
      }),
      {
        description: '参会人 open_id 列表',
      },
    ),
    need_notification: Type.Optional(
      Type.Boolean({
        description: '是否给参会人发送通知（默认 false）',
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuCalendarEventAttendeeParams =
  | {
      action: 'create';
      calendar_id: string;
      event_id: string;
      attendees: Array<{ type: string; attendee_id: string }>;
      need_notification?: boolean;
      attendee_ability?: string;
    }
  | {
      action: 'list';
      calendar_id: string;
      event_id: string;
      page_size?: number;
      page_token?: string;
      user_id_type?: string;
    }
  | {
      action: 'batch_delete';
      calendar_id: string;
      event_id: string;
      user_open_ids: string[];
      need_notification?: boolean;
    };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const feishuCalendarEventAttendeeTool = {
  name: 'feishu_calendar_event_attendee',
  description:
    '飞书日程参会人管理工具。当用户要求邀请/添加参会人、查看参会人列表、移除参会人时使用。Actions: create（添加参会人）, list（查询参会人列表）, batch_delete（批量删除参会人，注意：不能删除日程组织者）。',
  schema: FeishuCalendarEventAttendeeSchema,
  handler: async (params: unknown): Promise<ToolResult> => {
    const p = params as FeishuCalendarEventAttendeeParams;

    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // CREATE ATTENDEES
        // -----------------------------------------------------------------
        case 'create': {
          if (!p.attendees || p.attendees.length === 0) {
            return json({
              error: 'attendees is required and cannot be empty',
            });
          }

          const attendeeData = p.attendees.map((a) => {
            const base: any = {
              type: a.type,
              is_optional: false,
            };

            if (a.type === 'user') {
              base.user_id = a.attendee_id;
            } else if (a.type === 'chat') {
              base.chat_id = a.attendee_id;
            } else if (a.type === 'resource') {
              base.room_id = a.attendee_id;
            } else if (a.type === 'third_party') {
              base.third_party_email = a.attendee_id;
            }

            return base;
          });

          const res = await client.calendar.calendarEventAttendee.create({
            path: {
              calendar_id: p.calendar_id,
              event_id: p.event_id,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
            data: {
              attendees: attendeeData,
              need_notification: p.need_notification ?? true,
            },
          });
          assertLarkOk(res);

          return json({
            attendees: res.data?.attendees,
          });
        }

        // -----------------------------------------------------------------
        // LIST ATTENDEES
        // -----------------------------------------------------------------
        case 'list': {
          const res = await client.calendar.calendarEventAttendee.list({
            path: {
              calendar_id: p.calendar_id,
              event_id: p.event_id,
            },
            params: {
              page_size: p.page_size,
              page_token: p.page_token,
              user_id_type: (p.user_id_type || 'open_id') as any,
            },
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            attendees: data?.items,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // BATCH DELETE ATTENDEES (P1)
        // -----------------------------------------------------------------
        case 'batch_delete': {
          if (!p.user_open_ids || p.user_open_ids.length === 0) {
            return json({
              error: 'user_open_ids is required and cannot be empty',
            });
          }

          // Step 1: List all attendees to get attendee_id (user_...) from open_id (ou_...)
          const listRes = await client.calendar.calendarEventAttendee.list({
            path: {
              calendar_id: p.calendar_id,
              event_id: p.event_id,
            },
            params: {
              page_size: 500,
              user_id_type: 'open_id' as any,
            },
          });
          assertLarkOk(listRes);

          interface AttendeeItem {
            user_id?: string;
            attendee_id?: string;
            is_organizer?: boolean;
          }
          const listData = listRes.data as PaginatedData<AttendeeItem> | undefined;
          const attendees = listData?.items || [];

          // Step 2: Map open_id to attendee_id (user_...) and track organizers
          const openIdToAttendeeId = new Map<string, string>();
          const organizerOpenIds = new Set<string>();

          for (const att of attendees) {
            if (att.user_id && att.attendee_id) {
              openIdToAttendeeId.set(att.user_id, att.attendee_id);
              if (att.is_organizer) {
                organizerOpenIds.add(att.user_id);
              }
            }
          }

          // Step 2.5: Check if trying to delete organizer(s)
          const attemptingToDeleteOrganizers = p.user_open_ids.filter((id) => organizerOpenIds.has(id));

          if (attemptingToDeleteOrganizers.length > 0) {
            return json({
              error: 'cannot delete event organizer',
              organizers_cannot_delete: attemptingToDeleteOrganizers,
              hint: 'Event organizers cannot be removed. To remove organizer, consider deleting the event or transferring organizer role.',
            });
          }

          // Step 3: Find attendee_ids for the given open_ids
          const attendeeIdsToDelete: string[] = [];
          const notFound: string[] = [];

          for (const openId of p.user_open_ids) {
            const attendeeId = openIdToAttendeeId.get(openId);
            if (attendeeId) {
              attendeeIdsToDelete.push(attendeeId);
            } else {
              notFound.push(openId);
            }
          }

          if (attendeeIdsToDelete.length === 0) {
            return json({
              error: 'None of the provided open_ids were found in the attendee list',
              not_found: notFound,
            });
          }

          // Step 4: Call batch_delete API with attendee_ids (user_...)
          const res = await client.calendar.calendarEventAttendee.batchDelete({
            path: {
              calendar_id: p.calendar_id,
              event_id: p.event_id,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
            data: {
              attendee_ids: attendeeIdsToDelete,
              need_notification: p.need_notification ?? false,
            },
          });
          assertLarkOk(res);

          return json({
            success: true,
            removed_count: attendeeIdsToDelete.length,
            not_found: notFound.length > 0 ? notFound : undefined,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
//  4. CALENDAR FREEBUSY TOOL
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuCalendarFreebusySchema = Type.Object({
  action: Type.Literal('list'),
  time_min: Type.String({
    description: "查询起始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
  }),
  time_max: Type.String({
    description: "查询结束时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
  }),
  user_ids: Type.Array(
    Type.String({
      description: '用户 open_id',
    }),
    {
      description: '要查询忙闲的用户 ID 列表（1-10 个用户）',
      minItems: 1,
      maxItems: 10,
    },
  ),
});

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

interface FeishuCalendarFreebusyParams {
  action: 'list';
  time_min: string;
  time_max: string;
  user_ids: string[];
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const feishuCalendarFreebusyTool = {
  name: 'feishu_calendar_freebusy',
  description:
    '飞书日历忙闲查询工具。当用户要求查询某时间段内某人是否空闲、查看忙闲状态时使用。支持批量查询 1-10 个用户的主日历忙闲信息，用于安排会议时间。',
  schema: FeishuCalendarFreebusySchema,
  handler: async (params: unknown): Promise<ToolResult> => {
    const p = params as FeishuCalendarFreebusyParams;

    try {
      const client = getLarkClient();

      if (p.action !== 'list') {
        return json({ error: `Unknown action: ${p.action}` });
      }

      // Validate user_ids (batch API requires 1-10 users)
      if (!p.user_ids || p.user_ids.length === 0) {
        return json({
          error: 'user_ids is required (1-10 user IDs)',
        });
      }

      if (p.user_ids.length > 10) {
        return json({
          error: `user_ids count exceeds limit, maximum 10 users (current: ${p.user_ids.length})`,
        });
      }

      // Convert time strings to RFC 3339 format (required by freebusy API)
      const timeMin = parseTimeToRFC3339(p.time_min);
      const timeMax = parseTimeToRFC3339(p.time_max);

      if (!timeMin || !timeMax) {
        return json({
          error:
            "Invalid time format. Must use ISO 8601 / RFC 3339 with timezone, e.g. '2024-01-01T00:00:00+08:00' or '2026-02-25 14:00:00'.",
          received_time_min: p.time_min,
          received_time_max: p.time_max,
        });
      }

      const res = await client.calendar.freebusy.batch({
        data: {
          time_min: timeMin,
          time_max: timeMax,
          user_ids: p.user_ids,
          include_external_calendar: true,
          only_busy: true,
        } as any, // SDK 类型定义可能未包含所有字段
      });
      assertLarkOk(res);

      const data = res.data as { freebusy_lists?: any[] } | undefined;
      const freebusyLists = data?.freebusy_lists ?? [];

      return json({
        freebusy_lists: freebusyLists,
        _debug: {
          time_min_input: p.time_min,
          time_min_rfc3339: timeMin,
          time_max_input: p.time_max,
          time_max_rfc3339: timeMax,
          user_count: p.user_ids.length,
        },
      });
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
//  Export all calendar tools
// ===========================================================================

export const calendarTools = [
  feishuCalendarCalendarTool,
  feishuCalendarEventTool,
  feishuCalendarEventAttendeeTool,
  feishuCalendarFreebusyTool,
];
