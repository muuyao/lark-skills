/**
 * IM (messaging) tools — ported from openclaw-lark.
 *
 * Tools:
 *   1. feishu_im_user_message       — send / reply
 *   2. feishu_im_user_get_messages  — chat history (with open_id, relative_time, formatting)
 *   3. feishu_im_user_get_thread_messages — thread history
 *   4. feishu_im_user_search_messages     — cross-chat keyword search
 *   5. feishu_im_user_fetch_resource      — download IM files/images
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Type } from '@sinclair/typebox';
import { json, assertLarkOk, formatToolError } from '../core/helpers.js';
import { getLarkClient, larkApiCall } from '../core/client.js';
import {
  dateTimeToSecondsString,
  parseTimeRangeToSeconds,
} from '../core/time-utils.js';
import {
  formatMessageList,
  type FormattedMessage,
} from '../core/message-format.js';
import type { ToolResult } from '../core/helpers.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ===========================================================================
// Shared helpers
// ===========================================================================

const MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'video/mp4': '.mp4',
  'video/mpeg': '.mpeg',
  'video/quicktime': '.mov',
  'video/x-msvideo': '.avi',
  'video/webm': '.webm',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/mp4': '.m4a',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    '.pptx',
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'text/plain': '.txt',
  'application/json': '.json',
};

function sortRuleToSortType(
  rule?: 'create_time_asc' | 'create_time_desc',
): 'ByCreateTimeAsc' | 'ByCreateTimeDesc' {
  return rule === 'create_time_asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc';
}

/** Batch resolve user names via Lark contact API */
async function batchResolveUserNames(
  openIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (openIds.length === 0) return result;

  const client = getLarkClient();
  const BATCH_SIZE = 50;

  for (let i = 0; i < openIds.length; i += BATCH_SIZE) {
    const chunk = openIds.slice(i, i + BATCH_SIZE);
    try {
      const res: any = await client.contact.user.batch({
        params: { user_ids: chunk, user_id_type: 'open_id' },
      });
      for (const item of res?.data?.items ?? []) {
        const openId: string | undefined = item.open_id;
        const name: string | undefined =
          item.name || item.display_name || item.nickname || item.en_name;
        if (openId && name) {
          result.set(openId, name);
        }
      }
    } catch {
      // Best-effort — continue without names
    }
  }

  return result;
}

/** Resolve open_id → chat_id for P2P chat */
async function resolveP2PChatId(openId: string): Promise<string> {
  const res = (await larkApiCall(
    '/open-apis/im/v1/chat_p2p/batch_query',
    'POST',
    {
      params: { user_id_type: 'open_id' },
      body: { chatter_ids: [openId] },
    },
  )) as any;

  const chats = res?.data?.p2p_chats;
  if (!chats?.length) {
    throw new Error(
      `未找到与 open_id=${openId} 的单聊。可能尚无聊天记录。`,
    );
  }
  return chats[0].chat_id;
}

/** Parse time parameters to Unix seconds strings */
function resolveTimeRange(p: {
  relative_time?: string;
  start_time?: string;
  end_time?: string;
}): { start?: string; end?: string } {
  if (p.relative_time) {
    return parseTimeRangeToSeconds(p.relative_time);
  }
  return {
    start: p.start_time ? dateTimeToSecondsString(p.start_time) : undefined,
    end: p.end_time ? dateTimeToSecondsString(p.end_time) : undefined,
  };
}

/** Format and return message list result */
async function formatAndReturn(
  res: any,
): Promise<ToolResult> {
  const items = res.data?.items ?? [];
  const messages = await formatMessageList(items, batchResolveUserNames);

  const hasMore: boolean = res.data?.has_more ?? false;
  const pageToken: string | undefined = res.data?.page_token;

  return json({ messages, has_more: hasMore, page_token: pageToken });
}

// ===========================================================================
// 1. feishu_im_user_message — send / reply
// ===========================================================================

const FeishuImMessageSchema = Type.Union([
  // SEND
  Type.Object({
    action: Type.Literal('send'),
    receive_id_type: Type.Union(
      [Type.Literal('open_id'), Type.Literal('chat_id')],
      {
        description:
          '接收者 ID 类型：open_id（私聊，ou_xxx）、chat_id（群聊，oc_xxx）',
      },
    ),
    receive_id: Type.String({
      description:
        "接收者 ID，与 receive_id_type 对应。open_id 填 'ou_xxx'，chat_id 填 'oc_xxx'",
    }),
    msg_type: Type.Union(
      [
        Type.Literal('text'),
        Type.Literal('post'),
        Type.Literal('image'),
        Type.Literal('file'),
        Type.Literal('audio'),
        Type.Literal('media'),
        Type.Literal('interactive'),
        Type.Literal('share_chat'),
        Type.Literal('share_user'),
      ],
      {
        description:
          '消息类型：text（纯文本）、post（富文本）、image（图片）、file（文件）、interactive（消息卡片）、share_chat（群名片）、share_user（个人名片）等',
      },
    ),
    content: Type.String({
      description:
        '消息内容（JSON 字符串），格式取决于 msg_type。' +
        '示例：text → \'{"text":"你好"}\'，' +
        'image → \'{"image_key":"img_xxx"}\'，' +
        'share_chat → \'{"chat_id":"oc_xxx"}\'，' +
        'post → \'{"zh_cn":{"title":"标题","content":[[{"tag":"text","text":"正文"}]]}}\'',
    }),
    uuid: Type.Optional(
      Type.String({
        description:
          '幂等唯一标识。同一 uuid 在 1 小时内只会发送一条消息，用于去重',
      }),
    ),
  }),

  // REPLY
  Type.Object({
    action: Type.Literal('reply'),
    message_id: Type.String({
      description: '被回复消息的 ID（om_xxx 格式）',
    }),
    msg_type: Type.Union(
      [
        Type.Literal('text'),
        Type.Literal('post'),
        Type.Literal('image'),
        Type.Literal('file'),
        Type.Literal('audio'),
        Type.Literal('media'),
        Type.Literal('interactive'),
        Type.Literal('share_chat'),
        Type.Literal('share_user'),
      ],
      {
        description:
          '消息类型：text（纯文本）、post（富文本）、image（图片）、interactive（消息卡片）等',
      },
    ),
    content: Type.String({
      description: '回复消息内容（JSON 字符串），格式同 send 的 content',
    }),
    reply_in_thread: Type.Optional(
      Type.Boolean({
        description:
          '是否以话题形式回复。true 则消息出现在该消息的话题中，false（默认）则出现在聊天主流',
      }),
    ),
    uuid: Type.Optional(Type.String({ description: '幂等唯一标识' })),
  }),
]);

type FeishuImMessageParams =
  | {
      action: 'send';
      receive_id_type: 'open_id' | 'chat_id';
      receive_id: string;
      msg_type: string;
      content: string;
      uuid?: string;
    }
  | {
      action: 'reply';
      message_id: string;
      msg_type: string;
      content: string;
      reply_in_thread?: boolean;
      uuid?: string;
    };

const feishuImUserMessage = {
  name: 'feishu_im_user_message',
  description:
    '飞书 IM 消息工具。**有且仅当用户明确要求发消息、回复消息时使用**。' +
    '\n\nActions:' +
    '\n- send（发送消息）：发送消息到私聊或群聊' +
    '\n- reply（回复消息）：回复指定 message_id 的消息' +
    '\n\n【重要】content 必须是合法 JSON 字符串。' +
    '最常用：text 类型 content 为 \'{"text":"消息内容"}\'。' +
    '\n\n【安全约束】调用前必须确认发送对象和消息内容。',
  schema: FeishuImMessageSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FeishuImMessageParams;
    try {
      const client = getLarkClient();

      switch (p.action) {
        case 'send': {
          const res = await client.im.v1.message.create({
            params: { receive_id_type: p.receive_id_type },
            data: {
              receive_id: p.receive_id,
              msg_type: p.msg_type,
              content: p.content,
              uuid: p.uuid,
            },
          });
          assertLarkOk(res);

          const data = res.data as any;
          return json({
            message_id: data?.message_id,
            chat_id: data?.chat_id,
            create_time: data?.create_time,
          });
        }

        case 'reply': {
          const res = await client.im.v1.message.reply({
            path: { message_id: p.message_id },
            data: {
              content: p.content,
              msg_type: p.msg_type,
              reply_in_thread: p.reply_in_thread,
              uuid: p.uuid,
            },
          });
          assertLarkOk(res);

          const data = res.data as any;
          return json({
            message_id: data?.message_id,
            chat_id: data?.chat_id,
            create_time: data?.create_time,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 2. feishu_im_user_get_messages — enhanced with open_id, relative_time
// ===========================================================================

const GetMessagesSchema = Type.Object({
  open_id: Type.Optional(
    Type.String({
      description:
        '用户 open_id（ou_xxx），获取与该用户的单聊消息。与 chat_id 互斥',
    }),
  ),
  chat_id: Type.Optional(
    Type.String({
      description: '会话 ID（oc_xxx），支持单聊和群聊。与 open_id 互斥',
    }),
  ),
  sort_rule: Type.Optional(
    Type.Union(
      [Type.Literal('create_time_asc'), Type.Literal('create_time_desc')],
      { description: '排序方式，默认 create_time_desc（最新消息在前）' },
    ),
  ),
  page_size: Type.Optional(
    Type.Number({
      description: '每页消息数（1-50），默认 50',
      minimum: 1,
      maximum: 50,
    }),
  ),
  page_token: Type.Optional(
    Type.String({ description: '分页标记，用于获取下一页' }),
  ),
  relative_time: Type.Optional(
    Type.String({
      description:
        '相对时间范围：today / yesterday / day_before_yesterday / this_week / last_week / this_month / last_month / last_{N}_{unit}（unit: minutes/hours/days）。与 start_time/end_time 互斥',
    }),
  ),
  start_time: Type.Optional(
    Type.String({
      description:
        '起始时间（ISO 8601 格式，如 2026-02-27T00:00:00+08:00）。与 relative_time 互斥',
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description:
        '结束时间（ISO 8601 格式，如 2026-02-27T23:59:59+08:00）。与 relative_time 互斥',
    }),
  ),
});

interface GetMessagesParams {
  open_id?: string;
  chat_id?: string;
  sort_rule?: 'create_time_asc' | 'create_time_desc';
  page_size?: number;
  page_token?: string;
  relative_time?: string;
  start_time?: string;
  end_time?: string;
}

const feishuImUserGetMessages = {
  name: 'feishu_im_user_get_messages',
  description:
    '获取群聊或单聊的历史消息。' +
    '\n\n用法：' +
    '\n- 通过 chat_id 获取群聊/单聊消息' +
    '\n- 通过 open_id 获取与指定用户的单聊消息（自动解析 chat_id）' +
    '\n- 支持时间范围过滤：relative_time（如 today、last_3_days）或 start_time/end_time（ISO 8601 格式）' +
    '\n- 支持分页：page_size + page_token' +
    '\n\n【参数约束】' +
    '\n- open_id 和 chat_id 必须二选一' +
    '\n- relative_time 和 start_time/end_time 不能同时使用' +
    '\n\n返回 AI 可读的消息列表，包含 content（文本）、sender（含名字）、create_time（ISO 8601）等。',
  schema: GetMessagesSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as GetMessagesParams;
    try {
      if (p.open_id && p.chat_id) {
        return json({
          error: 'open_id 和 chat_id 不能同时提供，请只提供一个',
        });
      }
      if (!p.open_id && !p.chat_id) {
        return json({ error: '必须提供 open_id 或 chat_id' });
      }
      if (p.relative_time && (p.start_time || p.end_time)) {
        return json({
          error: 'relative_time 和 start_time/end_time 不能同时使用',
        });
      }

      const client = getLarkClient();

      // Resolve chat_id from open_id if needed
      let chatId = p.chat_id ?? '';
      if (p.open_id) {
        chatId = await resolveP2PChatId(p.open_id);
      }

      // Parse time range
      const time = resolveTimeRange(p);

      const res = await client.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: chatId,
          start_time: time.start,
          end_time: time.end,
          sort_type: sortRuleToSortType(p.sort_rule),
          page_size: p.page_size ?? 50,
          page_token: p.page_token,
          card_msg_content_type: 'raw_card_content',
        } as any,
      });
      assertLarkOk(res);

      return formatAndReturn(res);
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 3. feishu_im_user_get_thread_messages
// ===========================================================================

const GetThreadMessagesSchema = Type.Object({
  thread_id: Type.String({ description: '话题 ID（omt_xxx 格式）' }),
  sort_rule: Type.Optional(
    Type.Union(
      [Type.Literal('create_time_asc'), Type.Literal('create_time_desc')],
      { description: '排序方式，默认 create_time_desc（最新消息在前）' },
    ),
  ),
  page_size: Type.Optional(
    Type.Number({
      description: '每页消息数（1-50），默认 50',
      minimum: 1,
      maximum: 50,
    }),
  ),
  page_token: Type.Optional(
    Type.String({ description: '分页标记，用于获取下一页' }),
  ),
});

interface GetThreadMessagesParams {
  thread_id: string;
  sort_rule?: 'create_time_asc' | 'create_time_desc';
  page_size?: number;
  page_token?: string;
}

const feishuImUserGetThreadMessages = {
  name: 'feishu_im_user_get_thread_messages',
  description:
    '获取话题（thread）内的消息列表。' +
    '\n\n用法：通过 thread_id（omt_xxx）获取话题内消息。' +
    '\n\n【注意】话题消息不支持时间范围过滤（飞书 API 限制）。',
  schema: GetThreadMessagesSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as GetThreadMessagesParams;
    try {
      const client = getLarkClient();

      const res = await client.im.v1.message.list({
        params: {
          container_id_type: 'thread',
          container_id: p.thread_id,
          sort_type: sortRuleToSortType(p.sort_rule),
          page_size: p.page_size ?? 50,
          page_token: p.page_token,
          card_msg_content_type: 'raw_card_content',
        } as any,
      });
      assertLarkOk(res);

      return formatAndReturn(res);
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 4. feishu_im_user_search_messages — cross-chat keyword search
// ===========================================================================

const SearchMessagesSchema = Type.Object({
  query: Type.Optional(
    Type.String({
      description: '搜索关键词，匹配消息内容。可为空字符串表示不按内容过滤',
    }),
  ),
  sender_ids: Type.Optional(
    Type.Array(Type.String({ description: '发送者的 open_id（ou_xxx）' }), {
      description:
        '发送者 open_id 列表。如需根据用户名查找 open_id，请先使用 feishu_search_user 工具',
    }),
  ),
  chat_id: Type.Optional(
    Type.String({ description: '限定搜索范围的会话 ID（oc_xxx）' }),
  ),
  mention_ids: Type.Optional(
    Type.Array(Type.String({ description: '被@用户的 open_id（ou_xxx）' }), {
      description: '被@用户的 open_id 列表',
    }),
  ),
  message_type: Type.Optional(
    Type.Union(
      [Type.Literal('file'), Type.Literal('image'), Type.Literal('media')],
      { description: '消息类型过滤：file / image / media。为空则搜索所有类型' },
    ),
  ),
  sender_type: Type.Optional(
    Type.Union(
      [Type.Literal('user'), Type.Literal('bot'), Type.Literal('all')],
      { description: '发送者类型：user / bot / all。默认 user' },
    ),
  ),
  chat_type: Type.Optional(
    Type.Union([Type.Literal('group'), Type.Literal('p2p')], {
      description: '会话类型：group（群聊）/ p2p（单聊）',
    }),
  ),
  relative_time: Type.Optional(
    Type.String({
      description:
        '相对时间范围：today / yesterday / this_week / last_week / last_{N}_{unit}。与 start_time/end_time 互斥',
    }),
  ),
  start_time: Type.Optional(
    Type.String({
      description:
        '起始时间（ISO 8601 格式）。与 relative_time 互斥',
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description:
        '结束时间（ISO 8601 格式）。与 relative_time 互斥',
    }),
  ),
  page_size: Type.Optional(
    Type.Number({
      description: '每页消息数（1-50），默认 50',
      minimum: 1,
      maximum: 50,
    }),
  ),
  page_token: Type.Optional(
    Type.String({ description: '分页标记，用于获取下一页' }),
  ),
});

interface SearchMessagesParams {
  query?: string;
  sender_ids?: string[];
  chat_id?: string;
  mention_ids?: string[];
  message_type?: 'file' | 'image' | 'media';
  sender_type?: 'user' | 'bot' | 'all';
  chat_type?: 'group' | 'p2p';
  relative_time?: string;
  start_time?: string;
  end_time?: string;
  page_size?: number;
  page_token?: string;
}

interface ChatContext {
  name: string;
  chat_mode: string;
  p2p_target_id?: string;
}

function buildSearchData(
  p: SearchMessagesParams,
  time: { start: string; end: string },
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    query: p.query ?? '',
    start_time: time.start,
    end_time: time.end,
  };
  if (p.sender_ids?.length) data.from_ids = p.sender_ids;
  if (p.chat_id) data.chat_ids = [p.chat_id];
  if (p.mention_ids?.length) data.at_chatter_ids = p.mention_ids;
  if (p.message_type) data.message_type = p.message_type;
  if (p.sender_type && p.sender_type !== 'all')
    data.from_type = p.sender_type;
  if (p.chat_type)
    data.chat_type = p.chat_type === 'group' ? 'group_chat' : 'p2p_chat';
  return data;
}

async function fetchChatContexts(
  chatIds: string[],
): Promise<Map<string, ChatContext>> {
  const map = new Map<string, ChatContext>();
  if (chatIds.length === 0) return map;

  try {
    const res = (await larkApiCall(
      '/open-apis/im/v1/chats/batch_query',
      'POST',
      {
        params: { user_id_type: 'open_id' },
        body: { chat_ids: chatIds },
      },
    )) as any;

    for (const c of res?.data?.items ?? []) {
      if (c.chat_id) {
        map.set(c.chat_id, {
          name: c.name ?? '',
          chat_mode: c.chat_mode ?? '',
          p2p_target_id: c.p2p_target_id,
        });
      }
    }
  } catch {
    // Best-effort
  }
  return map;
}

function enrichMessages(
  messages: FormattedMessage[],
  items: any[],
  chatMap: Map<string, ChatContext>,
  nameCache: Map<string, string>,
) {
  return messages.map((msg, idx) => {
    const chatId: string | undefined = items[idx]?.chat_id;
    const ctx = chatId ? chatMap.get(chatId) : undefined;
    if (!chatId || !ctx) return { ...msg, chat_id: chatId };

    if (ctx.chat_mode === 'p2p' && ctx.p2p_target_id) {
      const name = nameCache.get(ctx.p2p_target_id);
      return {
        ...msg,
        chat_id: chatId,
        chat_type: 'p2p' as const,
        chat_name: name || undefined,
        chat_partner: {
          open_id: ctx.p2p_target_id,
          name: name || undefined,
        },
      };
    }

    return {
      ...msg,
      chat_id: chatId,
      chat_type: ctx.chat_mode,
      chat_name: ctx.name || undefined,
    };
  });
}

const feishuImUserSearchMessages = {
  name: 'feishu_im_user_search_messages',
  description:
    '跨会话搜索飞书消息。' +
    '\n\n用法：' +
    '\n- 按关键词搜索消息内容' +
    '\n- 按发送者、被@用户、消息类型过滤' +
    '\n- 按时间范围过滤：relative_time 或 start_time/end_time' +
    '\n- 限定在某个会话内搜索（chat_id）' +
    '\n\n【参数约束】所有参数均可选，但至少应提供一个过滤条件。' +
    '\n\n返回消息列表，每条消息包含 chat_id、chat_type（p2p/group）、chat_name。' +
    '\n单聊消息额外包含 chat_partner（对方 open_id 和名字）。',
  schema: SearchMessagesSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as SearchMessagesParams;
    try {
      if (p.relative_time && (p.start_time || p.end_time)) {
        return json({
          error: 'relative_time 和 start_time/end_time 不能同时使用',
        });
      }

      const client = getLarkClient();

      // 1. Search message IDs
      const time = resolveTimeRange(p);
      const searchData = buildSearchData(p, {
        start: time.start ?? '978307200',
        end: time.end ?? Math.floor(Date.now() / 1000).toString(),
      });

      const searchRes: any = await (client.search as any).message.create({
        data: searchData,
        params: {
          user_id_type: 'open_id',
          page_size: p.page_size ?? 50,
          page_token: p.page_token,
        },
      });
      assertLarkOk(searchRes);

      const messageIds: string[] = searchRes.data?.items ?? [];
      const hasMore: boolean = searchRes.data?.has_more ?? false;
      const pageToken: string | undefined = searchRes.data?.page_token;

      if (messageIds.length === 0) {
        return json({ messages: [], has_more: hasMore, page_token: pageToken });
      }

      // 2. Batch fetch message details
      const queryStr = messageIds
        .map((id) => `message_ids=${encodeURIComponent(id)}`)
        .join('&');
      const mgetRes = (await larkApiCall(
        `/open-apis/im/v1/messages/mget?${queryStr}`,
        'GET',
        {
          params: {
            user_id_type: 'open_id',
            card_msg_content_type: 'raw_card_content',
          },
        },
      )) as any;
      const items = mgetRes?.data?.items ?? [];

      // 3. Batch fetch chat info
      const chatIds = [
        ...new Set(
          items
            .map((i: any) => i.chat_id as string | undefined)
            .filter(Boolean),
        ),
      ] as string[];
      const chatMap = await fetchChatContexts(chatIds);

      // 4. Format messages with name resolution
      const messages = await formatMessageList(items, batchResolveUserNames);

      // 5. Resolve P2P target names
      const p2pTargetIds = [
        ...new Set(
          [...chatMap.values()]
            .map((c) => c.p2p_target_id)
            .filter((id): id is string => !!id),
        ),
      ];
      const targetNames =
        p2pTargetIds.length > 0
          ? await batchResolveUserNames(p2pTargetIds)
          : new Map<string, string>();

      // Merge all known names
      const allNames = new Map<string, string>();
      for (const msg of messages) {
        if (msg.sender.name) allNames.set(msg.sender.id, msg.sender.name);
      }
      for (const [id, name] of targetNames) {
        allNames.set(id, name);
      }

      // 6. Enrich with chat context
      const result = enrichMessages(messages, items, chatMap, allNames);

      return json({ messages: result, has_more: hasMore, page_token: pageToken });
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 5. feishu_im_user_fetch_resource — download IM resource
// ===========================================================================

const FetchResourceSchema = Type.Object({
  message_id: Type.String({
    description:
      '消息 ID（om_xxx 格式），从消息事件或消息列表中获取',
  }),
  file_key: Type.String({
    description:
      '资源 Key，从消息体中获取。图片消息的 image_key（img_xxx）或文件消息的 file_key（file_xxx）',
  }),
  type: Type.Union([Type.Literal('image'), Type.Literal('file')], {
    description:
      '资源类型：image（图片消息中的图片）、file（文件/音频/视频消息中的文件）',
  }),
});

interface FetchResourceParams {
  message_id: string;
  file_key: string;
  type: 'image' | 'file';
}

const feishuImUserFetchResource = {
  name: 'feishu_im_user_fetch_resource',
  description:
    '下载飞书 IM 消息中的文件或图片资源到本地文件。' +
    '\n\n参数说明：' +
    '\n- message_id：消息 ID（om_xxx）' +
    '\n- file_key：资源 Key。图片用 image_key（img_xxx），文件用 file_key（file_xxx）' +
    '\n- type：图片用 image，文件/音频/视频用 file' +
    '\n\n文件自动保存到临时目录。限制：不超过 100MB。',
  schema: FetchResourceSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FetchResourceParams;
    try {
      const client = getLarkClient();

      const res: any = await client.im.v1.messageResource.get({
        params: { type: p.type },
        path: { message_id: p.message_id, file_key: p.file_key },
      });

      const stream = res.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      const contentType = res.headers?.['content-type'] || '';
      const mimeType = contentType ? contentType.split(';')[0].trim() : '';
      const mimeExt = mimeType ? MIME_TO_EXT[mimeType] : undefined;
      const ext = mimeExt || '.bin';

      const finalPath = path.join(
        os.tmpdir(),
        `im-resource-${Date.now()}${ext}`,
      );
      await fs.mkdir(path.dirname(finalPath), { recursive: true });

      await fs.writeFile(finalPath, buffer);
      return json({
        message_id: p.message_id,
        file_key: p.file_key,
        type: p.type,
        size_bytes: buffer.length,
        content_type: contentType,
        saved_path: finalPath,
      });
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// Export
// ===========================================================================

export const imTools = [
  feishuImUserMessage,
  feishuImUserGetMessages,
  feishuImUserGetThreadMessages,
  feishuImUserSearchMessages,
  feishuImUserFetchResource,
];
