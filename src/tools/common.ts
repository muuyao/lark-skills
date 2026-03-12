/**
 * Common tools (user lookup) — ported from openclaw-lark.
 *
 * Source files:
 *   - /tmp/openclaw-lark/src/tools/oapi/common/get-user.ts
 *   - /tmp/openclaw-lark/src/tools/oapi/common/search-user.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Type } from '@sinclair/typebox';
import { json, assertLarkOk, formatToolError } from '../core/helpers.js';
import { getLarkClient } from '../core/client.js';
import type { ToolResult } from '../core/helpers.js';

// ===========================================================================
// Shared types
// ===========================================================================

interface SearchUserData {
  users?: unknown[];
  has_more?: boolean;
  page_token?: string;
}

// ===========================================================================
// 1. feishu_get_user — get user info
// ===========================================================================

const GetUserSchema = Type.Object({
  user_id: Type.Optional(
    Type.String({
      description: '用户 ID（格式如 ou_xxx）。若不传入，则获取当前用户自己的信息',
    }),
  ),
  user_id_type: Type.Optional(
    Type.Union([Type.Literal('open_id'), Type.Literal('union_id'), Type.Literal('user_id')]),
  ),
});

interface GetUserParams {
  user_id?: string;
  user_id_type?: 'open_id' | 'union_id' | 'user_id';
}

const feishuGetUser = {
  name: 'feishu_get_user',
  description:
    '获取用户信息。不传 user_id 时获取当前用户自己的信息；传 user_id 时获取指定用户的信息。' +
    '返回用户姓名、头像、邮箱、手机号、部门等信息。',
  schema: GetUserSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as GetUserParams;
    try {
      const client = getLarkClient();

      // Mode 1: Get current user's info
      if (!p.user_id) {
        try {
          const res = await client.authen.userInfo.get({});
          assertLarkOk(res);
          return json({ user: res.data });
        } catch (invokeErr) {
          if (invokeErr && typeof invokeErr === 'object') {
            const e = invokeErr as any;
            if (e.response?.data?.code === 41050) {
              return json({
                error:
                  '无权限查询该用户信息。\n\n' +
                  '说明：使用用户身份调用通讯录 API 时，可操作的权限范围不受应用的通讯录权限范围影响，' +
                  '而是受当前用户的组织架构可见范围影响。该范围限制了用户在企业内可见的组织架构数据范围。',
              });
            }
          }
          throw invokeErr;
        }
      }

      // Mode 2: Get specific user's info
      const userIdType = p.user_id_type || 'open_id';

      try {
        const res = await client.contact.v3.user.get({
          path: { user_id: p.user_id },
          params: { user_id_type: userIdType as any },
        });
        assertLarkOk(res);
        return json({ user: res.data?.user });
      } catch (invokeErr) {
        if (invokeErr && typeof invokeErr === 'object') {
          const e = invokeErr as any;
          if (e.response?.data?.code === 41050) {
            return json({
              error:
                '无权限查询该用户信息。\n\n' +
                '说明：使用用户身份调用通讯录 API 时，可操作的权限范围不受应用的通讯录权限范围影响，' +
                '而是受当前用户的组织架构可见范围影响。该范围限制了用户在企业内可见的组织架构数据范围。\n\n' +
                '建议：请联系管理员调整当前用户的组织架构可见范围，或使用应用身份（tenant_access_token）调用 API。',
            });
          }
        }
        throw invokeErr;
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 2. feishu_search_user — search employees
// ===========================================================================

const SearchUserSchema = Type.Object({
  query: Type.String({
    description: '搜索关键词，用于匹配用户名（必填）',
  }),
  page_size: Type.Optional(
    Type.Integer({
      description: '分页大小，控制每次返回的用户数量（默认20，最大200）',
      minimum: 1,
      maximum: 200,
    }),
  ),
  page_token: Type.Optional(
    Type.String({
      description: '分页标识。首次请求无需填写；当返回结果中包含 page_token 时，可传入该值继续请求下一页',
    }),
  ),
});

interface SearchUserParams {
  query: string;
  page_size?: number;
  page_token?: string;
}

const feishuSearchUser = {
  name: 'feishu_search_user',
  description:
    '搜索员工信息（通过关键词搜索姓名、手机号、邮箱）。返回匹配的员工列表，包含姓名、部门、open_id 等信息。',
  schema: SearchUserSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as SearchUserParams;
    try {
      const client = getLarkClient();

      const requestQuery: Record<string, string> = {
        query: p.query,
        page_size: String(p.page_size ?? 20),
      };
      if (p.page_token) requestQuery.page_token = p.page_token;

      const res = await client.request({
        method: 'GET',
        url: '/open-apis/search/v1/user',
        params: requestQuery,
      });
      assertLarkOk(res as any);

      const data = (res as any).data as SearchUserData | undefined;
      const users = data?.users ?? [];

      return json({
        users,
        has_more: data?.has_more ?? false,
        page_token: data?.page_token,
      });
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// Export
// ===========================================================================

export const commonTools = [feishuGetUser, feishuSearchUser];
