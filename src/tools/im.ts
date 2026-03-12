/**
 * IM (messaging) tools — ported from openclaw-lark.
 *
 * Source files:
 *   - /tmp/openclaw-lark/src/tools/oapi/im/message.ts
 *   - /tmp/openclaw-lark/src/tools/oapi/im/message-read.ts
 *   - /tmp/openclaw-lark/src/tools/oapi/im/resource.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Type } from '@sinclair/typebox';
import { json, assertLarkOk, formatToolError } from '../core/helpers.js';
import { getLarkClient } from '../core/client.js';
import type { ToolResult } from '../core/helpers.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// ===========================================================================
// Shared types
// ===========================================================================

/** Standard paginated list response. */
interface PaginatedData<T = unknown> {
  items?: T[];
  has_more?: boolean;
  page_token?: string;
  total?: number;
}

// ===========================================================================
// Helper: MIME type to extension mapping (for resource download)
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
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-powerpoint': '.ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip',
  'application/x-rar-compressed': '.rar',
  'text/plain': '.txt',
  'application/json': '.json',
};

// ===========================================================================
// Helper: sort rule mapping
// ===========================================================================

function sortRuleToSortType(rule?: 'create_time_asc' | 'create_time_desc'): 'ByCreateTimeAsc' | 'ByCreateTimeDesc' {
  return rule === 'create_time_asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc';
}

// ===========================================================================
// 1. feishu_im_user_message — send / reply
// ===========================================================================

const FeishuImMessageSchema = Type.Union([
  // SEND
  Type.Object({
    action: Type.Literal('send'),
    receive_id_type: Type.Union([Type.Literal('open_id'), Type.Literal('chat_id')], {
      description: '接收者 ID 类型：open_id（私聊，ou_xxx）、chat_id（群聊，oc_xxx）',
    }),
    receive_id: Type.String({
      description: "接收者 ID，与 receive_id_type 对应。open_id 填 'ou_xxx'，chat_id 填 'oc_xxx'",
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
        description: '幂等唯一标识。同一 uuid 在 1 小时内只会发送一条消息，用于去重',
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
        description: '消息类型：text（纯文本）、post（富文本）、image（图片）、interactive（消息卡片）等',
      },
    ),
    content: Type.String({
      description: '回复消息内容（JSON 字符串），格式同 send 的 content',
    }),
    reply_in_thread: Type.Optional(
      Type.Boolean({
        description: '是否以话题形式回复。true 则消息出现在该消息的话题中，false（默认）则出现在聊天主流',
      }),
    ),
    uuid: Type.Optional(
      Type.String({
        description: '幂等唯一标识',
      }),
    ),
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
    '飞书用户身份 IM 消息工具。**有且仅当用户明确要求以自己身份发消息、回复消息时使用，当没有明确要求时优先使用message系统工具**。' +
    '\n\nActions:' +
    '\n- send（发送消息）：发送消息到私聊或群聊。私聊用 receive_id_type=open_id，群聊用 receive_id_type=chat_id' +
    '\n- reply（回复消息）：回复指定 message_id 的消息，支持话题回复（reply_in_thread=true）' +
    '\n\n【重要】content 必须是合法 JSON 字符串，格式取决于 msg_type。' +
    '最常用：text 类型 content 为 \'{"text":"消息内容"}\'。' +
    '\n\n【安全约束】此工具以用户身份发送消息，发出后对方看到的发送者是用户本人。' +
    '调用前必须先向用户确认：1) 发送对象（哪个人或哪个群）2) 消息内容。' +
    '禁止在用户未明确同意的情况下自行发送消息。',
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
// 2. feishu_im_user_get_messages — get chat / thread messages
// ===========================================================================

const GetMessagesSchema = Type.Object({
  chat_id: Type.String({
    description: '会话 ID（oc_xxx），支持单聊和群聊',
  }),
  sort_rule: Type.Optional(
    Type.Union([Type.Literal('create_time_asc'), Type.Literal('create_time_desc')], {
      description: '排序方式，默认 create_time_desc（最新消息在前）',
    }),
  ),
  page_size: Type.Optional(Type.Number({ description: '每页消息数（1-50），默认 50', minimum: 1, maximum: 50 })),
  page_token: Type.Optional(Type.String({ description: '分页标记，用于获取下一页' })),
  start_time: Type.Optional(
    Type.String({
      description: '起始时间（Unix 秒级时间戳字符串）',
    }),
  ),
  end_time: Type.Optional(
    Type.String({
      description: '结束时间（Unix 秒级时间戳字符串）',
    }),
  ),
});

interface GetMessagesParams {
  chat_id: string;
  sort_rule?: 'create_time_asc' | 'create_time_desc';
  page_size?: number;
  page_token?: string;
  start_time?: string;
  end_time?: string;
}

const feishuImUserGetMessages = {
  name: 'feishu_im_user_get_messages',
  description:
    '【以用户身份】获取群聊或单聊的历史消息。' +
    '\n\n用法：' +
    '\n- 通过 chat_id 获取群聊/单聊消息' +
    '\n- 支持时间范围过滤：start_time/end_time（Unix 秒级时间戳字符串）' +
    '\n- 支持分页：page_size + page_token' +
    '\n\n返回消息列表，每条消息包含 message_id、msg_type、content、sender、create_time 等字段。',
  schema: GetMessagesSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as GetMessagesParams;
    try {
      const client = getLarkClient();

      const res = await client.im.v1.message.list({
        params: {
          container_id_type: 'chat',
          container_id: p.chat_id,
          start_time: p.start_time,
          end_time: p.end_time,
          sort_type: sortRuleToSortType(p.sort_rule),
          page_size: p.page_size ?? 50,
          page_token: p.page_token,
        } as any,
      });
      assertLarkOk(res);

      const data = res.data as PaginatedData | undefined;
      return json({
        messages: data?.items ?? [],
        has_more: data?.has_more ?? false,
        page_token: data?.page_token,
      });
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
    Type.Union([Type.Literal('create_time_asc'), Type.Literal('create_time_desc')], {
      description: '排序方式，默认 create_time_desc（最新消息在前）',
    }),
  ),
  page_size: Type.Optional(Type.Number({ description: '每页消息数（1-50），默认 50', minimum: 1, maximum: 50 })),
  page_token: Type.Optional(Type.String({ description: '分页标记，用于获取下一页' })),
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
    '【以用户身份】获取话题（thread）内的消息列表。' +
    '\n\n用法：' +
    '\n- 通过 thread_id（omt_xxx）获取话题内的所有消息' +
    '\n- 支持分页：page_size + page_token' +
    '\n\n【注意】话题消息不支持时间范围过滤（飞书 API 限制）' +
    '\n\n返回消息列表，格式同 feishu_im_user_get_messages。',
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
        } as any,
      });
      assertLarkOk(res);

      const data = res.data as PaginatedData | undefined;
      return json({
        messages: data?.items ?? [],
        has_more: data?.has_more ?? false,
        page_token: data?.page_token,
      });
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 4. feishu_im_user_fetch_resource — download IM resource
// ===========================================================================

const FetchResourceSchema = Type.Object({
  message_id: Type.String({
    description: '消息 ID（om_xxx 格式），从消息事件或消息列表中获取',
  }),
  file_key: Type.String({
    description: '资源 Key，从消息体中获取。图片消息的 image_key（img_xxx）或文件消息的 file_key（file_xxx）',
  }),
  type: Type.Union([Type.Literal('image'), Type.Literal('file')], {
    description: '资源类型：image（图片消息中的图片）、file（文件/音频/视频消息中的文件）',
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
    '【以用户身份】下载飞书 IM 消息中的文件或图片资源到本地文件。' +
    '\n\n适用场景：当你获取到 message_id 和 file_key 时，' +
    '使用本工具下载资源。' +
    '\n\n参数说明：' +
    '\n- message_id：消息 ID（om_xxx），从消息事件或消息列表中获取' +
    '\n- file_key：资源 Key，从消息体中获取。图片用 image_key（img_xxx），文件用 file_key（file_xxx）' +
    '\n- type：图片用 image，文件/音频/视频用 file' +
    '\n\n文件自动保存到临时目录下，返回值中的 saved_path 为实际保存路径。' +
    '\n限制：文件大小不超过 100MB。不支持下载表情包、合并转发消息、卡片中的资源。',
  schema: FetchResourceSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FetchResourceParams;
    try {
      const client = getLarkClient();

      const res: any = await client.im.v1.messageResource.get({
        params: { type: p.type },
        path: { message_id: p.message_id, file_key: p.file_key },
      });

      // Response is a binary stream
      const stream = res.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Determine file extension from Content-Type
      const contentType = res.headers?.['content-type'] || '';
      const mimeType = contentType ? contentType.split(';')[0].trim() : '';
      const mimeExt = mimeType ? MIME_TO_EXT[mimeType] : undefined;
      const ext = mimeExt || (p.type === 'image' ? '.bin' : '.bin');

      const finalPath = path.join(os.tmpdir(), `im-resource-${Date.now()}${ext}`);
      await fs.mkdir(path.dirname(finalPath), { recursive: true });

      try {
        await fs.writeFile(finalPath, buffer);
        return json({
          message_id: p.message_id,
          file_key: p.file_key,
          type: p.type,
          size_bytes: buffer.length,
          content_type: contentType,
          saved_path: finalPath,
        });
      } catch (saveErr) {
        return json({
          error: `保存文件失败: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
        });
      }
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
  feishuImUserFetchResource,
];
