/**
 * Chat tools — ported from openclaw-lark.
 *
 * Source files:
 *   - /tmp/openclaw-lark/src/tools/oapi/chat/chat.ts
 *   - /tmp/openclaw-lark/src/tools/oapi/chat/members.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Type } from '@sinclair/typebox';
import { json, assertLarkOk, formatToolError } from '../core/helpers.js';
import { getLarkClient } from '../core/client.js';
import type { ToolResult } from '../core/helpers.js';

// ===========================================================================
// Shared types
// ===========================================================================

interface PaginatedData<T = unknown> {
  items?: T[];
  has_more?: boolean;
  page_token?: string;
  total?: number;
}

interface ChatMemberListData {
  items?: unknown[];
  member_total?: number;
  has_more?: boolean;
  page_token?: string;
}

// ===========================================================================
// 1. feishu_chat — chat search & get
// ===========================================================================

const FeishuChatSchema = Type.Union([
  // SEARCH
  Type.Object({
    action: Type.Literal('search'),
    query: Type.String({
      description: '搜索关键词（必填）。支持匹配群名称、群成员名称。支持多语种、拼音、前缀等模糊搜索。',
    }),
    page_size: Type.Optional(
      Type.Integer({
        description: '分页大小（默认20）',
        minimum: 1,
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记。首次请求无需填写',
      }),
    ),
    user_id_type: Type.Optional(
      Type.Union([Type.Literal('open_id'), Type.Literal('union_id'), Type.Literal('user_id')], {
        description: '用户 ID 类型（默认 open_id）',
      }),
    ),
  }),

  // GET
  Type.Object({
    action: Type.Literal('get'),
    chat_id: Type.String({
      description: '群 ID（格式如 oc_xxx）',
    }),
    user_id_type: Type.Optional(
      Type.Union([Type.Literal('open_id'), Type.Literal('union_id'), Type.Literal('user_id')], {
        description: '用户 ID 类型（默认 open_id）',
      }),
    ),
  }),
]);

type FeishuChatParams =
  | {
      action: 'search';
      query: string;
      page_size?: number;
      page_token?: string;
      user_id_type?: 'open_id' | 'union_id' | 'user_id';
    }
  | {
      action: 'get';
      chat_id: string;
      user_id_type?: 'open_id' | 'union_id' | 'user_id';
    };

const feishuChat = {
  name: 'feishu_chat',
  description:
    '以用户身份调用飞书群聊管理工具。Actions: search（搜索群列表，支持关键词匹配群名称、群成员）, get（获取指定群的详细信息，包括群名称、描述、头像、群主、权限配置等）。',
  schema: FeishuChatSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FeishuChatParams;
    try {
      const client = getLarkClient();

      switch (p.action) {
        // SEARCH
        case 'search': {
          const res = await client.im.v1.chat.search({
            params: {
              user_id_type: p.user_id_type || 'open_id',
              query: p.query,
              page_size: p.page_size,
              page_token: p.page_token,
            },
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            items: data?.items,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // GET
        case 'get': {
          const res = await client.im.v1.chat.get({
            path: { chat_id: p.chat_id },
            params: { user_id_type: p.user_id_type || 'open_id' },
          });
          assertLarkOk(res);

          return json({
            chat: res.data,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 2. feishu_chat_members — get chat members
// ===========================================================================

const ChatMembersSchema = Type.Object({
  chat_id: Type.String({
    description: '群 ID（格式如 oc_xxx）。可以通过 feishu_chat_search 工具搜索获取',
  }),
  member_id_type: Type.Optional(
    Type.Union([Type.Literal('open_id'), Type.Literal('union_id'), Type.Literal('user_id')]),
  ),
  page_size: Type.Optional(
    Type.Integer({
      description: '分页大小（默认20）',
      minimum: 1,
    }),
  ),
  page_token: Type.Optional(
    Type.String({
      description: '分页标记。首次请求无需填写',
    }),
  ),
});

interface ChatMembersParams {
  chat_id: string;
  member_id_type?: 'open_id' | 'union_id' | 'user_id';
  page_size?: number;
  page_token?: string;
}

const feishuChatMembers = {
  name: 'feishu_chat_members',
  description:
    '以用户的身份获取指定群组的成员列表。' +
    '返回成员信息，包含成员 ID、姓名等。' +
    '注意：不会返回群组内的机器人成员。',
  schema: ChatMembersSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as ChatMembersParams;
    try {
      const client = getLarkClient();

      const res = await client.im.v1.chatMembers.get({
        path: { chat_id: p.chat_id },
        params: {
          member_id_type: p.member_id_type || 'open_id',
          page_size: p.page_size,
          page_token: p.page_token,
        },
      });
      assertLarkOk(res);

      const data = res.data as ChatMemberListData | undefined;

      return json({
        items: data?.items,
        has_more: data?.has_more ?? false,
        page_token: data?.page_token,
        member_total: data?.member_total ?? 0,
      });
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// Export
// ===========================================================================

export const chatTools = [feishuChat, feishuChatMembers];
