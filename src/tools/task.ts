/**
 * Feishu Task tools -- Manage tasks, task lists, comments, and subtasks.
 *
 * Ported from OpenClaw format (task.ts, tasklist.ts, comment.ts, subtask.ts)
 * to standalone MCP tool format.
 *
 * Uses the Feishu Task v2 API.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Type } from '@sinclair/typebox';
import { json, assertLarkOk, parseTimeToTimestampMs, formatToolError } from '../core/helpers.js';
import { getLarkClient } from '../core/client.js';

// ===========================================================================
// TASK TOOL
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuTaskTaskSchema = Type.Union([
  // CREATE
  Type.Object({
    action: Type.Literal('create'),
    summary: Type.String({
      description: '任务标题',
    }),
    current_user_id: Type.Optional(
      Type.String({
        description:
          '当前用户的 open_id（强烈建议，从消息上下文的 SenderId 获取）。如果 members 中不包含此用户，工具会自动添加为 follower，确保创建者可以编辑任务。',
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: '任务描述',
      }),
    ),
    due: Type.Optional(
      Type.Object({
        timestamp: Type.String({
          description: "截止时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
        }),
        is_all_day: Type.Optional(
          Type.Boolean({
            description: '是否为全天任务',
          }),
        ),
      }),
    ),
    start: Type.Optional(
      Type.Object({
        timestamp: Type.String({
          description: "开始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
        }),
        is_all_day: Type.Optional(
          Type.Boolean({
            description: '是否为全天',
          }),
        ),
      }),
    ),
    members: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String({
            description: '成员 open_id',
          }),
          role: Type.Optional(Type.Union([Type.Literal('assignee'), Type.Literal('follower')])),
        }),
        {
          description: '任务成员列表（assignee=负责人，follower=关注人）',
        },
      ),
    ),
    repeat_rule: Type.Optional(
      Type.String({
        description: '重复规则（RRULE 格式）',
      }),
    ),
    tasklists: Type.Optional(
      Type.Array(
        Type.Object({
          tasklist_guid: Type.String({
            description: '清单 GUID',
          }),
          section_guid: Type.Optional(
            Type.String({
              description: '分组 GUID',
            }),
          ),
        }),
        {
          description: '任务所属清单列表',
        },
      ),
    ),
    user_id_type: Type.Optional(
      Type.Union([Type.Literal('open_id'), Type.Literal('union_id'), Type.Literal('user_id')]),
    ),
  }),

  // GET
  Type.Object({
    action: Type.Literal('get'),
    task_guid: Type.String({
      description: 'Task GUID',
    }),
    user_id_type: Type.Optional(
      Type.Union([Type.Literal('open_id'), Type.Literal('union_id'), Type.Literal('user_id')]),
    ),
  }),

  // LIST
  Type.Object({
    action: Type.Literal('list'),
    page_size: Type.Optional(
      Type.Number({
        description: '每页数量（默认 50，最大 100）。',
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记',
      }),
    ),
    completed: Type.Optional(
      Type.Boolean({
        description: '是否筛选已完成任务',
      }),
    ),
    user_id_type: Type.Optional(
      Type.Union([Type.Literal('open_id'), Type.Literal('union_id'), Type.Literal('user_id')]),
    ),
  }),

  // PATCH
  Type.Object({
    action: Type.Literal('patch'),
    task_guid: Type.String({
      description: 'Task GUID',
    }),
    summary: Type.Optional(
      Type.String({
        description: '新的任务标题',
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: '新的任务描述',
      }),
    ),
    due: Type.Optional(
      Type.Object({
        timestamp: Type.String({
          description: "新的截止时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
        }),
        is_all_day: Type.Optional(
          Type.Boolean({
            description: '是否为全天任务',
          }),
        ),
      }),
    ),
    start: Type.Optional(
      Type.Object({
        timestamp: Type.String({
          description: "新的开始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
        }),
        is_all_day: Type.Optional(
          Type.Boolean({
            description: '是否为全天',
          }),
        ),
      }),
    ),
    completed_at: Type.Optional(
      Type.String({
        description:
          "完成时间。支持三种格式：1) ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'（设为已完成）；2) '0'（反完成，任务变为未完成）；3) 毫秒时间戳字符串。",
      }),
    ),
    members: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String({
            description: '成员 open_id',
          }),
          role: Type.Optional(Type.Union([Type.Literal('assignee'), Type.Literal('follower')])),
        }),
        {
          description: '新的任务成员列表',
        },
      ),
    ),
    repeat_rule: Type.Optional(
      Type.String({
        description: '新的重复规则（RRULE 格式）',
      }),
    ),
    user_id_type: Type.Optional(
      Type.Union([Type.Literal('open_id'), Type.Literal('union_id'), Type.Literal('user_id')]),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuTaskTaskParams =
  | {
      action: 'create';
      summary: string;
      current_user_id?: string;
      description?: string;
      due?: {
        timestamp: string;
        is_all_day?: boolean;
      };
      start?: {
        timestamp: string;
        is_all_day?: boolean;
      };
      members?: Array<{
        id: string;
        role?: 'assignee' | 'follower';
      }>;
      repeat_rule?: string;
      tasklists?: Array<{
        tasklist_guid: string;
        section_guid?: string;
      }>;
      user_id_type?: 'open_id' | 'union_id' | 'user_id';
    }
  | {
      action: 'get';
      task_guid: string;
      user_id_type?: 'open_id' | 'union_id' | 'user_id';
    }
  | {
      action: 'list';
      page_size?: number;
      page_token?: string;
      completed?: boolean;
      user_id_type?: 'open_id' | 'union_id' | 'user_id';
    }
  | {
      action: 'patch';
      task_guid: string;
      summary?: string;
      description?: string;
      due?: {
        timestamp: string;
        is_all_day?: boolean;
      };
      start?: {
        timestamp: string;
        is_all_day?: boolean;
      };
      completed_at?: string;
      members?: Array<{
        id: string;
        role?: 'assignee' | 'follower';
      }>;
      repeat_rule?: string;
      user_id_type?: 'open_id' | 'union_id' | 'user_id';
    };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const taskTool = {
  name: 'feishu_task_task',
  description:
    "飞书任务管理工具。用于创建、查询、更新任务。Actions: create（创建任务）, get（获取任务详情）, list（查询任务列表，仅返回我负责的任务）, patch（更新任务）。时间参数使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
  schema: FeishuTaskTaskSchema,
  handler: async (params: unknown) => {
    const p = params as FeishuTaskTaskParams;
    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // CREATE TASK
        // -----------------------------------------------------------------
        case 'create': {
          const taskData: any = {
            summary: p.summary,
          };

          if (p.description) taskData.description = p.description;

          // Handle due time conversion
          if (p.due?.timestamp) {
            const dueTs = parseTimeToTimestampMs(p.due.timestamp);
            if (!dueTs) {
              return json({
                error:
                  "due 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'，例如 '2026-02-25 18:00'。",
                received: p.due.timestamp,
              });
            }
            taskData.due = {
              timestamp: dueTs,
              is_all_day: p.due.is_all_day ?? false,
            };
          }

          // Handle start time conversion
          if (p.start?.timestamp) {
            const startTs = parseTimeToTimestampMs(p.start.timestamp);
            if (!startTs) {
              return json({
                error:
                  "start 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
                received: p.start.timestamp,
              });
            }
            taskData.start = {
              timestamp: startTs,
              is_all_day: p.start.is_all_day ?? false,
            };
          }

          if (p.members) taskData.members = p.members;
          if (p.repeat_rule) taskData.repeat_rule = p.repeat_rule;
          if (p.tasklists) taskData.tasklists = p.tasklists;

          const res = await client.task.v2.task.create({
            data: taskData,
            params: {
              user_id_type: (p.user_id_type || 'open_id') as any,
            },
          });
          assertLarkOk(res);

          return json({
            task: res.data?.task,
          });
        }

        // -----------------------------------------------------------------
        // GET TASK
        // -----------------------------------------------------------------
        case 'get': {
          const res = await client.task.v2.task.get({
            path: { task_guid: p.task_guid },
            params: {
              user_id_type: (p.user_id_type || 'open_id') as any,
            },
          });
          assertLarkOk(res);

          return json({
            task: res.data?.task,
          });
        }

        // -----------------------------------------------------------------
        // LIST TASKS
        // -----------------------------------------------------------------
        case 'list': {
          const res = await client.task.v2.task.list({
            params: {
              page_size: p.page_size,
              page_token: p.page_token,
              completed: p.completed,
              user_id_type: (p.user_id_type || 'open_id') as any,
            },
          });
          assertLarkOk(res);

          const data = res.data as any;

          return json({
            tasks: data?.items,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // PATCH TASK
        // -----------------------------------------------------------------
        case 'patch': {
          const updateData: any = {};

          if (p.summary) updateData.summary = p.summary;
          if (p.description !== undefined) updateData.description = p.description;

          // Handle due time conversion
          if (p.due?.timestamp) {
            const dueTs = parseTimeToTimestampMs(p.due.timestamp);
            if (!dueTs) {
              return json({
                error:
                  "due 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
                received: p.due.timestamp,
              });
            }
            updateData.due = {
              timestamp: dueTs,
              is_all_day: p.due.is_all_day ?? false,
            };
          }

          // Handle start time conversion
          if (p.start?.timestamp) {
            const startTs = parseTimeToTimestampMs(p.start.timestamp);
            if (!startTs) {
              return json({
                error:
                  "start 时间格式错误！必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'。",
                received: p.start.timestamp,
              });
            }
            updateData.start = {
              timestamp: startTs,
              is_all_day: p.start.is_all_day ?? false,
            };
          }

          // Handle completed_at conversion
          if (p.completed_at !== undefined) {
            // 特殊值：反完成（设为未完成）
            if (p.completed_at === '0') {
              updateData.completed_at = '0';
            }
            // 数字字符串时间戳（直通）
            else if (/^\d+$/.test(p.completed_at)) {
              updateData.completed_at = p.completed_at;
            }
            // 时间格式字符串（需要转换）
            else {
              const completedTs = parseTimeToTimestampMs(p.completed_at);
              if (!completedTs) {
                return json({
                  error:
                    "completed_at 格式错误！支持：1) ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'；2) '0'（反完成）；3) 毫秒时间戳字符串。",
                  received: p.completed_at,
                });
              }
              updateData.completed_at = completedTs;
            }
          }

          if (p.members) updateData.members = p.members;
          if (p.repeat_rule) updateData.repeat_rule = p.repeat_rule;

          // Build update_fields list (required by Task API)
          const updateFields = Object.keys(updateData);

          const res = await client.task.v2.task.patch({
            path: { task_guid: p.task_guid },
            data: {
              task: updateData,
              update_fields: updateFields,
            },
            params: {
              user_id_type: (p.user_id_type || 'open_id') as any,
            },
          });
          assertLarkOk(res);

          return json({
            task: res.data?.task,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// TASKLIST TOOL
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuTaskTasklistSchema = Type.Union([
  // CREATE (P0)
  Type.Object({
    action: Type.Literal('create'),
    name: Type.String({
      description: '清单名称',
    }),
    members: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String({ description: '成员 open_id' }),
          role: Type.Optional(Type.Union([Type.Literal('editor'), Type.Literal('viewer')])),
        }),
        {
          description:
            '清单成员列表（editor=可编辑，viewer=可查看）。注意：创建人自动成为 owner，如在 members 中也指定创建人，该用户最终成为 owner 并从 members 中移除（同一用户只能有一个角色）',
        },
      ),
    ),
  }),

  // GET (P0)
  Type.Object({
    action: Type.Literal('get'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
  }),

  // LIST (P0)
  Type.Object({
    action: Type.Literal('list'),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // TASKS (P0) - 列出清单内的任务
  Type.Object({
    action: Type.Literal('tasks'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
    completed: Type.Optional(Type.Boolean({ description: '是否只返回已完成的任务（默认返回所有）' })),
  }),

  // PATCH (P1)
  Type.Object({
    action: Type.Literal('patch'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
    name: Type.Optional(Type.String({ description: '新的清单名称' })),
  }),

  // DELETE (P1)
  Type.Object({
    action: Type.Literal('delete'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
  }),

  // ADD_MEMBERS (P1)
  Type.Object({
    action: Type.Literal('add_members'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
    members: Type.Array(
      Type.Object({
        id: Type.String({ description: '成员 open_id' }),
        role: Type.Optional(Type.Union([Type.Literal('editor'), Type.Literal('viewer')])),
      }),
      { description: '要添加的成员列表' },
    ),
  }),

  // REMOVE_MEMBERS (P1)
  Type.Object({
    action: Type.Literal('remove_members'),
    tasklist_guid: Type.String({ description: '清单 GUID' }),
    members: Type.Array(
      Type.Object({
        id: Type.String({ description: '成员 open_id' }),
        type: Type.Optional(Type.Union([Type.Literal('user'), Type.Literal('chat'), Type.Literal('app')])),
      }),
      {
        description: '要移除的成员列表。注意：移除成员时不需要传 role 字段',
      },
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuTaskTasklistParams =
  | {
      action: 'create';
      name: string;
      members?: Array<{ id: string; role?: string }>;
    }
  | {
      action: 'get';
      tasklist_guid: string;
    }
  | {
      action: 'list';
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'tasks';
      tasklist_guid: string;
      page_size?: number;
      page_token?: string;
      completed?: boolean;
    }
  | {
      action: 'patch';
      tasklist_guid: string;
      name?: string;
    }
  | {
      action: 'delete';
      tasklist_guid: string;
    }
  | {
      action: 'add_members';
      tasklist_guid: string;
      members: Array<{ id: string; role?: string }>;
    }
  | {
      action: 'remove_members';
      tasklist_guid: string;
      members: Array<{ id: string; type?: string }>;
    };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const tasklistTool = {
  name: 'feishu_task_tasklist',
  description:
    '飞书任务清单管理工具。当用户要求创建/查询/管理清单、查看清单内的任务时使用。Actions: create（创建清单）, get（获取清单详情）, list（列出所有可读取的清单，包括我创建的和他人共享给我的）, tasks（列出清单内的任务）, patch（更新清单）, delete（删除清单）, add_members（添加成员）, remove_members（移除成员）。',
  schema: FeishuTaskTasklistSchema,
  handler: async (params: unknown) => {
    const p = params as FeishuTaskTasklistParams;

    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // CREATE
        // -----------------------------------------------------------------
        case 'create': {
          const data: any = { name: p.name };

          // 转换成员格式
          if (p.members && p.members.length > 0) {
            data.members = p.members.map((m) => ({
              id: m.id,
              type: 'user',
              role: m.role || 'editor',
            }));
          }

          const res = await client.task.v2.tasklist.create({
            params: {
              user_id_type: 'open_id' as any,
            },
            data,
          });
          assertLarkOk(res);

          return json({
            tasklist: res.data?.tasklist,
          });
        }

        // -----------------------------------------------------------------
        // GET
        // -----------------------------------------------------------------
        case 'get': {
          const res = await client.task.v2.tasklist.get({
            path: {
              tasklist_guid: p.tasklist_guid,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
          });
          assertLarkOk(res);

          return json({
            tasklist: res.data?.tasklist,
          });
        }

        // -----------------------------------------------------------------
        // LIST
        // -----------------------------------------------------------------
        case 'list': {
          const res = await client.task.v2.tasklist.list({
            params: {
              page_size: p.page_size,
              page_token: p.page_token,
              user_id_type: 'open_id' as any,
            },
          });
          assertLarkOk(res);

          const data = res.data as any;

          return json({
            tasklists: data?.items,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // TASKS - 列出清单内的任务
        // -----------------------------------------------------------------
        case 'tasks': {
          const res = await client.task.v2.tasklist.tasks({
            path: {
              tasklist_guid: p.tasklist_guid,
            },
            params: {
              page_size: p.page_size,
              page_token: p.page_token,
              completed: p.completed,
              user_id_type: 'open_id' as any,
            },
          });
          assertLarkOk(res);

          const data = res.data as any;

          return json({
            tasks: data?.items,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // PATCH
        // -----------------------------------------------------------------
        case 'patch': {
          // 飞书 Task API 要求特殊的更新格式
          const tasklistData: any = {};
          const updateFields: string[] = [];

          if (p.name !== undefined) {
            tasklistData.name = p.name;
            updateFields.push('name');
          }

          if (updateFields.length === 0) {
            return json({
              error: 'No fields to update',
            });
          }

          const res = await client.task.v2.tasklist.patch({
            path: {
              tasklist_guid: p.tasklist_guid,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
            data: {
              tasklist: tasklistData,
              update_fields: updateFields,
            },
          });
          assertLarkOk(res);

          return json({
            tasklist: res.data?.tasklist,
          });
        }

        // -----------------------------------------------------------------
        // DELETE
        // -----------------------------------------------------------------
        case 'delete': {
          const res = await client.task.v2.tasklist.delete({
            path: {
              tasklist_guid: p.tasklist_guid,
            },
          });
          assertLarkOk(res);

          return json({
            success: true,
          });
        }

        // -----------------------------------------------------------------
        // ADD_MEMBERS
        // -----------------------------------------------------------------
        case 'add_members': {
          if (!p.members || p.members.length === 0) {
            return json({
              error: 'members is required and cannot be empty',
            });
          }

          const memberData = p.members.map((m) => ({
            id: m.id,
            type: 'user',
            role: m.role || 'editor',
          }));

          const res = await client.task.v2.tasklist.addMembers({
            path: {
              tasklist_guid: p.tasklist_guid,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
            data: {
              members: memberData,
            },
          });
          assertLarkOk(res);

          return json({
            tasklist: res.data?.tasklist,
          });
        }

        // -----------------------------------------------------------------
        // REMOVE_MEMBERS
        // -----------------------------------------------------------------
        case 'remove_members': {
          if (!p.members || p.members.length === 0) {
            return json({
              error: 'members is required and cannot be empty',
            });
          }

          const memberData = p.members.map((m) => ({
            id: m.id,
            type: m.type || 'user',
          }));

          const res = await client.task.v2.tasklist.removeMembers({
            path: {
              tasklist_guid: p.tasklist_guid,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
            data: {
              members: memberData,
            },
          });
          assertLarkOk(res);

          return json({
            tasklist: res.data?.tasklist,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// COMMENT TOOL
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuTaskCommentSchema = Type.Union([
  // CREATE (P1)
  Type.Object({
    action: Type.Literal('create'),
    task_guid: Type.String({ description: '任务 GUID' }),
    content: Type.String({ description: '评论内容（纯文本，最长 3000 字符）' }),
    reply_to_comment_id: Type.Optional(Type.String({ description: '要回复的评论 ID（用于回复评论）' })),
  }),

  // LIST (P1)
  Type.Object({
    action: Type.Literal('list'),
    resource_id: Type.String({ description: '要获取评论的资源 ID（任务 GUID）' }),
    direction: Type.Optional(
      Type.Union([Type.Literal('asc'), Type.Literal('desc')], {
        description: '排序方式（asc=从旧到新，desc=从新到旧，默认 asc）',
      }),
    ),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // GET (P1)
  Type.Object({
    action: Type.Literal('get'),
    comment_id: Type.String({ description: '评论 ID' }),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuTaskCommentParams =
  | {
      action: 'create';
      task_guid: string;
      content: string;
      reply_to_comment_id?: string;
    }
  | {
      action: 'list';
      resource_id: string;
      direction?: 'asc' | 'desc';
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'get';
      comment_id: string;
    };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const commentTool = {
  name: 'feishu_task_comment',
  description:
    '飞书任务评论管理工具。当用户要求添加/查询任务评论、回复评论时使用。Actions: create（添加评论）, list（列出任务的所有评论）, get（获取单个评论详情）。',
  schema: FeishuTaskCommentSchema,
  handler: async (params: unknown) => {
    const p = params as FeishuTaskCommentParams;

    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // CREATE
        // -----------------------------------------------------------------
        case 'create': {
          const data: any = {
            content: p.content,
            resource_type: 'task',
            resource_id: p.task_guid,
          };

          if (p.reply_to_comment_id) {
            data.reply_to_comment_id = p.reply_to_comment_id;
          }

          const res = await client.task.v2.comment.create({
            params: {
              user_id_type: 'open_id' as any,
            },
            data,
          });
          assertLarkOk(res);

          return json({
            comment: res.data?.comment,
          });
        }

        // -----------------------------------------------------------------
        // LIST
        // -----------------------------------------------------------------
        case 'list': {
          const res = await client.task.v2.comment.list({
            params: {
              resource_type: 'task',
              resource_id: p.resource_id,
              direction: p.direction,
              page_size: p.page_size,
              page_token: p.page_token,
              user_id_type: 'open_id' as any,
            },
          });
          assertLarkOk(res);

          const data = res.data as any;

          return json({
            comments: data?.items,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // GET
        // -----------------------------------------------------------------
        case 'get': {
          const res = await client.task.v2.comment.get({
            path: {
              comment_id: p.comment_id,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
          });
          assertLarkOk(res);

          return json({
            comment: res.data?.comment,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// SUBTASK TOOL
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuTaskSubtaskSchema = Type.Union([
  // CREATE (P1)
  Type.Object({
    action: Type.Literal('create'),
    task_guid: Type.String({ description: '父任务 GUID' }),
    summary: Type.String({ description: '子任务标题' }),
    description: Type.Optional(Type.String({ description: '子任务描述' })),
    due: Type.Optional(
      Type.Object({
        timestamp: Type.String({
          description: "截止时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
        }),
        is_all_day: Type.Optional(Type.Boolean({ description: '是否为全天任务' })),
      }),
    ),
    start: Type.Optional(
      Type.Object({
        timestamp: Type.String({
          description: "开始时间（ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'）",
        }),
        is_all_day: Type.Optional(Type.Boolean({ description: '是否为全天' })),
      }),
    ),
    members: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String({ description: '成员 open_id' }),
          role: Type.Optional(Type.Union([Type.Literal('assignee'), Type.Literal('follower')])),
        }),
        { description: '子任务成员列表（assignee=负责人，follower=关注人）' },
      ),
    ),
  }),

  // LIST (P1)
  Type.Object({
    action: Type.Literal('list'),
    task_guid: Type.String({ description: '父任务 GUID' }),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuTaskSubtaskParams =
  | {
      action: 'create';
      task_guid: string;
      summary: string;
      description?: string;
      due?: { timestamp: string; is_all_day?: boolean };
      start?: { timestamp: string; is_all_day?: boolean };
      members?: Array<{ id: string; role?: string }>;
    }
  | {
      action: 'list';
      task_guid: string;
      page_size?: number;
      page_token?: string;
    };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const subtaskTool = {
  name: 'feishu_task_subtask',
  description:
    '飞书任务的子任务管理工具。当用户要求创建子任务、查询任务的子任务列表时使用。Actions: create（创建子任务）, list（列出任务的所有子任务）。',
  schema: FeishuTaskSubtaskSchema,
  handler: async (params: unknown) => {
    const p = params as FeishuTaskSubtaskParams;

    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // CREATE
        // -----------------------------------------------------------------
        case 'create': {
          const data: any = {
            summary: p.summary,
          };

          if (p.description) {
            data.description = p.description;
          }

          // 转换截止时间
          if (p.due) {
            const dueTs = parseTimeToTimestampMs(p.due.timestamp);
            if (!dueTs) {
              return json({
                error: `时间格式错误！due.timestamp 必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'，当前值：${p.due.timestamp}`,
              });
            }
            data.due = {
              timestamp: dueTs,
              is_all_day: p.due.is_all_day ?? false,
            };
          }

          // 转换开始时间
          if (p.start) {
            const startTs = parseTimeToTimestampMs(p.start.timestamp);
            if (!startTs) {
              return json({
                error: `时间格式错误！start.timestamp 必须使用ISO 8601 / RFC 3339 格式（包含时区），例如 '2024-01-01T00:00:00+08:00'，当前值：${p.start.timestamp}`,
              });
            }
            data.start = {
              timestamp: startTs,
              is_all_day: p.start.is_all_day ?? false,
            };
          }

          // 转换成员格式
          if (p.members && p.members.length > 0) {
            data.members = p.members.map((m) => ({
              id: m.id,
              type: 'user',
              role: m.role || 'assignee',
            }));
          }

          const res = await client.task.v2.taskSubtask.create({
            path: {
              task_guid: p.task_guid,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
            data,
          });
          assertLarkOk(res);

          return json({
            subtask: res.data?.subtask,
          });
        }

        // -----------------------------------------------------------------
        // LIST
        // -----------------------------------------------------------------
        case 'list': {
          const res = await client.task.v2.taskSubtask.list({
            path: {
              task_guid: p.task_guid,
            },
            params: {
              page_size: p.page_size,
              page_token: p.page_token,
              user_id_type: 'open_id' as any,
            },
          });
          assertLarkOk(res);

          const data = res.data as any;

          return json({
            subtasks: data?.items,
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
// Export all tools
// ===========================================================================

export const taskTools = [taskTool, tasklistTool, commentTool, subtaskTool];
