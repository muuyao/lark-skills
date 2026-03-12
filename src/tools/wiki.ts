/**
 * Wiki tools — ported from openclaw-lark.
 *
 * Source files:
 *   - /tmp/openclaw-lark/src/tools/oapi/wiki/space.ts
 *   - /tmp/openclaw-lark/src/tools/oapi/wiki/space-node.ts
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

// ===========================================================================
// 1. feishu_wiki_space — space management
// ===========================================================================

const FeishuWikiSpaceSchema = Type.Union([
  // LIST SPACES
  Type.Object({
    action: Type.Literal('list'),
    page_size: Type.Optional(
      Type.Integer({
        description: '分页大小（默认 10，最大 50）',
        minimum: 1,
        maximum: 50,
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记。首次请求无需填写',
      }),
    ),
  }),

  // GET SPACE
  Type.Object({
    action: Type.Literal('get'),
    space_id: Type.String({
      description: '知识空间 ID（必填）',
    }),
  }),

  // CREATE SPACE
  Type.Object({
    action: Type.Literal('create'),
    name: Type.Optional(
      Type.String({
        description: '知识空间名称',
      }),
    ),
    description: Type.Optional(
      Type.String({
        description: '知识空间描述',
      }),
    ),
  }),
]);

type FeishuWikiSpaceParams =
  | {
      action: 'list';
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'get';
      space_id: string;
    }
  | {
      action: 'create';
      name?: string;
      description?: string;
    };

const feishuWikiSpace = {
  name: 'feishu_wiki_space',
  description:
    '飞书知识空间管理工具。当用户要求查看知识库列表、获取知识库信息、创建知识库时使用。Actions: list（列出知识空间）, get（获取知识空间信息）, create（创建知识空间）。' +
    '【重要】space_id 可以从浏览器 URL 中获取，或通过 list 接口获取。' +
    '【重要】知识空间（Space）是知识库的基本组成单位，包含多个具有层级关系的文档节点。',
  schema: FeishuWikiSpaceSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FeishuWikiSpaceParams;
    try {
      const client = getLarkClient();

      switch (p.action) {
        // LIST SPACES
        case 'list': {
          const res = await client.wiki.space.list({
            params: {
              page_size: p.page_size as any,
              page_token: p.page_token,
            },
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            spaces: data?.items,
            has_more: data?.has_more,
            page_token: data?.page_token,
          });
        }

        // GET SPACE
        case 'get': {
          const res = await client.wiki.space.get({
            path: { space_id: p.space_id },
          });
          assertLarkOk(res);

          return json({
            space: res.data?.space,
          });
        }

        // CREATE SPACE
        case 'create': {
          const res = await client.wiki.space.create({
            data: {
              name: p.name,
              description: p.description,
            },
          });
          assertLarkOk(res);

          return json({
            space: res.data?.space,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 2. feishu_wiki_space_node — node management
// ===========================================================================

const FeishuWikiSpaceNodeSchema = Type.Union([
  // LIST NODES
  Type.Object({
    action: Type.Literal('list'),
    space_id: Type.String({ description: 'space_id' }),
    parent_node_token: Type.Optional(Type.String({ description: 'parent_node_token' })),
    page_size: Type.Optional(Type.Integer({ description: 'page_size', minimum: 1 })),
    page_token: Type.Optional(Type.String({ description: 'page_token' })),
  }),

  // GET NODE
  Type.Object({
    action: Type.Literal('get'),
    token: Type.String({ description: 'node token' }),
    obj_type: Type.Optional(
      Type.Union(
        [
          Type.Literal('doc'), Type.Literal('sheet'), Type.Literal('mindnote'),
          Type.Literal('bitable'), Type.Literal('file'), Type.Literal('docx'),
          Type.Literal('slides'), Type.Literal('wiki'),
        ],
        { description: 'obj_type' },
      ),
    ),
  }),

  // CREATE NODE
  Type.Object({
    action: Type.Literal('create'),
    space_id: Type.String({ description: 'space_id' }),
    obj_type: Type.Union(
      [
        Type.Literal('doc'), Type.Literal('sheet'), Type.Literal('mindnote'),
        Type.Literal('bitable'), Type.Literal('file'), Type.Literal('docx'),
        Type.Literal('slides'),
      ],
      { description: 'obj_type' },
    ),
    parent_node_token: Type.Optional(Type.String({ description: 'parent_node_token' })),
    node_type: Type.Optional(
      Type.Union([Type.Literal('origin'), Type.Literal('shortcut')], { description: 'node_type' }),
    ),
    origin_node_token: Type.Optional(Type.String({ description: 'origin_node_token' })),
    title: Type.Optional(Type.String({ description: 'title' })),
  }),

  // MOVE NODE
  Type.Object({
    action: Type.Literal('move'),
    space_id: Type.String({ description: 'space_id' }),
    node_token: Type.String({ description: 'node_token' }),
    target_parent_token: Type.Optional(Type.String({ description: 'target_parent_token' })),
  }),

  // COPY NODE
  Type.Object({
    action: Type.Literal('copy'),
    space_id: Type.String({ description: 'space_id' }),
    node_token: Type.String({ description: 'node_token' }),
    target_space_id: Type.Optional(Type.String({ description: 'target_space_id' })),
    target_parent_token: Type.Optional(Type.String({ description: 'target_parent_token' })),
    title: Type.Optional(Type.String({ description: 'title' })),
  }),
]);

type FeishuWikiSpaceNodeParams =
  | {
      action: 'list';
      space_id: string;
      parent_node_token?: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'get';
      token: string;
      obj_type?: string;
    }
  | {
      action: 'create';
      space_id: string;
      obj_type: string;
      parent_node_token?: string;
      node_type?: 'origin' | 'shortcut';
      origin_node_token?: string;
      title?: string;
    }
  | {
      action: 'move';
      space_id: string;
      node_token: string;
      target_parent_token?: string;
    }
  | {
      action: 'copy';
      space_id: string;
      node_token: string;
      target_space_id?: string;
      target_parent_token?: string;
      title?: string;
    };

const feishuWikiSpaceNode = {
  name: 'feishu_wiki_space_node',
  description:
    '飞书知识库节点管理工具。操作：list（列表）、get（获取）、create（创建）、move（移动）、copy（复制）。' +
    '节点是知识库中的文档，包括 doc、bitable(多维表表格)、sheet(电子表格) 等类型。' +
    'node_token 是节点的唯一标识符，obj_token 是实际文档的 token。可通过 get 操作将 wiki 类型的 node_token 转换为实际文档的 obj_token。',
  schema: FeishuWikiSpaceNodeSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FeishuWikiSpaceNodeParams;
    try {
      const client = getLarkClient();

      switch (p.action) {
        // LIST NODES
        case 'list': {
          const res = await client.wiki.spaceNode.list({
            path: { space_id: p.space_id },
            params: {
              page_size: p.page_size as any,
              page_token: p.page_token,
              parent_node_token: p.parent_node_token,
            },
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            nodes: data?.items,
            has_more: data?.has_more,
            page_token: data?.page_token,
          });
        }

        // GET NODE
        case 'get': {
          const res = await client.wiki.space.getNode({
            params: {
              token: p.token,
              obj_type: (p.obj_type || 'wiki') as any,
            },
          });
          assertLarkOk(res);

          return json({
            node: res.data?.node,
          });
        }

        // CREATE NODE
        case 'create': {
          const res = await client.wiki.spaceNode.create({
            path: { space_id: p.space_id },
            data: {
              obj_type: p.obj_type as any,
              parent_node_token: p.parent_node_token,
              node_type: p.node_type as any,
              origin_node_token: p.origin_node_token,
              title: p.title,
            },
          });
          assertLarkOk(res);

          return json({
            node: res.data?.node,
          });
        }

        // MOVE NODE
        case 'move': {
          const res = await client.wiki.spaceNode.move({
            path: {
              space_id: p.space_id,
              node_token: p.node_token,
            },
            data: {
              target_parent_token: p.target_parent_token,
            },
          });
          assertLarkOk(res);

          return json({
            node: res.data?.node,
          });
        }

        // COPY NODE
        case 'copy': {
          const res = await client.wiki.spaceNode.copy({
            path: {
              space_id: p.space_id,
              node_token: p.node_token,
            },
            data: {
              target_space_id: p.target_space_id,
              target_parent_token: p.target_parent_token,
              title: p.title,
            },
          });
          assertLarkOk(res);

          return json({
            node: res.data?.node,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// Export
// ===========================================================================

export const wikiTools = [feishuWikiSpace, feishuWikiSpaceNode];
