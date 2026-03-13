/**
 * Document tools — create/fetch/update cloud documents via Feishu MCP gateway.
 *
 * These tools call the Feishu MCP gateway (mcp.feishu.cn/mcp) which handles
 * Markdown ↔ Block conversion server-side. The LLM works with Lark-flavored
 * Markdown, not raw Block JSON.
 *
 * Source: openclaw-lark/src/tools/mcp/doc/
 */

import { Type, type Static } from '@sinclair/typebox';
import { json, formatToolError } from '../core/helpers.js';
import { callMcpTool } from '../core/mcp-gateway.js';
import type { ToolResult } from '../core/helpers.js';

// ---------------------------------------------------------------------------
// Helper: parse MCP gateway result
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function parseMcpResult(result: unknown): ToolResult {
  // MCP tools/call returns { content: [{ type, text }] } format.
  // Try to parse single-text content as JSON for cleaner output.
  if (isRecord(result) && Array.isArray((result as Record<string, unknown>).content)) {
    const mcpContent = (result as Record<string, unknown>).content as Array<{
      type: string;
      text: string;
    }>;
    if (mcpContent.length === 1 && mcpContent[0]?.type === 'text') {
      try {
        const parsed = JSON.parse(mcpContent[0].text);
        return json(parsed);
      } catch {
        // Keep original
      }
    }
    return {
      content: mcpContent.map((c) => ({
        type: 'text' as const,
        text: c.text,
      })),
    };
  }
  return json(result);
}

// ===========================================================================
// 1. feishu_create_doc
// ===========================================================================

const CreateDocSchema = Type.Object({
  markdown: Type.Optional(Type.String({ description: 'Markdown 内容' })),
  title: Type.Optional(Type.String({ description: '文档标题' })),
  folder_token: Type.Optional(
    Type.String({ description: '父文件夹 token（可选）' }),
  ),
  wiki_node: Type.Optional(
    Type.String({
      description: '知识库节点 token 或 URL（可选，传入则在该节点下创建文档）',
    }),
  ),
  wiki_space: Type.Optional(
    Type.String({ description: '知识空间 ID（可选，特殊值 my_library）' }),
  ),
  task_id: Type.Optional(
    Type.String({
      description: '异步任务 ID。提供此参数将查询任务状态而非创建新文档',
    }),
  ),
});

type CreateDocParams = Static<typeof CreateDocSchema>;

const feishuCreateDoc = {
  name: 'feishu_create_doc',
  description:
    '从 Markdown 创建飞书云文档。' +
    '支持 Lark-flavored Markdown（callout、grid、lark-table、image url 等自定义标签）。' +
    '大文档创建为异步任务，返回 task_id 供后续查询。' +
    '\n\n参数约束：未提供 task_id 时必须提供 markdown 和 title。' +
    'folder_token / wiki_node / wiki_space 三者互斥。',
  schema: CreateDocSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as CreateDocParams;
    try {
      if (!p.task_id) {
        if (!p.markdown || !p.title) {
          return json({
            error: '未提供 task_id 时必须提供 markdown 和 title',
          });
        }
        const flags = [p.folder_token, p.wiki_node, p.wiki_space].filter(
          Boolean,
        );
        if (flags.length > 1) {
          return json({
            error: 'folder_token / wiki_node / wiki_space 三者互斥，请只提供一个',
          });
        }
      }

      const result = await callMcpTool(
        'create-doc',
        p as Record<string, unknown>,
      );
      return parseMcpResult(result);
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 2. feishu_fetch_doc
// ===========================================================================

const FetchDocSchema = Type.Object({
  doc_id: Type.String({
    description: '文档 ID 或 URL（支持自动解析）',
  }),
  offset: Type.Optional(
    Type.Integer({
      description: '字符偏移量（可选，默认0）。用于大文档分页获取。',
      minimum: 0,
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: '返回的最大字符数（可选）。仅在用户明确要求分页时使用。',
      minimum: 1,
    }),
  ),
});

type FetchDocParams = Static<typeof FetchDocSchema>;

const feishuFetchDoc = {
  name: 'feishu_fetch_doc',
  description:
    '获取飞书云文档内容，返回文档标题和 Markdown 格式内容。' +
    '支持分页获取大文档（offset + limit）。' +
    '\n\ndoc_id 支持文档 URL 或纯 ID。',
  schema: FetchDocSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FetchDocParams;
    try {
      const result = await callMcpTool(
        'fetch-doc',
        p as Record<string, unknown>,
      );
      return parseMcpResult(result);
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 3. feishu_update_doc
// ===========================================================================

const UpdateDocSchema = Type.Object({
  doc_id: Type.Optional(Type.String({ description: '文档 ID 或 URL' })),
  markdown: Type.Optional(Type.String({ description: 'Markdown 内容' })),
  mode: Type.Union(
    [
      Type.Literal('overwrite'),
      Type.Literal('append'),
      Type.Literal('replace_range'),
      Type.Literal('replace_all'),
      Type.Literal('insert_before'),
      Type.Literal('insert_after'),
      Type.Literal('delete_range'),
    ],
    { description: '更新模式（必填）' },
  ),
  selection_with_ellipsis: Type.Optional(
    Type.String({
      description:
        '定位表达式：开头内容...结尾内容（与 selection_by_title 二选一）',
    }),
  ),
  selection_by_title: Type.Optional(
    Type.String({
      description:
        '标题定位：例如 ## 章节标题（与 selection_with_ellipsis 二选一）',
    }),
  ),
  new_title: Type.Optional(
    Type.String({ description: '新的文档标题（可选）' }),
  ),
  task_id: Type.Optional(
    Type.String({ description: '异步任务 ID，用于查询任务状态' }),
  ),
});

type UpdateDocParams = Static<typeof UpdateDocSchema>;

const feishuUpdateDoc = {
  name: 'feishu_update_doc',
  description:
    '更新飞书云文档。支持 7 种模式：' +
    'overwrite（覆盖全文）、append（追加到末尾）、replace_range（替换选区）、' +
    'replace_all（全文替换）、insert_before（选区前插入）、insert_after（选区后插入）、' +
    'delete_range（删除选区）。' +
    '\n\n定位方式：selection_with_ellipsis（开头...结尾）或 selection_by_title（## 标题），二选一。' +
    '\n大文档更新为异步任务，返回 task_id 供查询。',
  schema: UpdateDocSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as UpdateDocParams;
    try {
      // Validation
      if (!p.task_id) {
        if (!p.doc_id) {
          return json({ error: '未提供 task_id 时必须提供 doc_id' });
        }

        const needSelection =
          p.mode === 'replace_range' ||
          p.mode === 'insert_before' ||
          p.mode === 'insert_after' ||
          p.mode === 'delete_range';

        if (needSelection) {
          const hasEllipsis = Boolean(p.selection_with_ellipsis);
          const hasTitle = Boolean(p.selection_by_title);
          if ((hasEllipsis && hasTitle) || (!hasEllipsis && !hasTitle)) {
            return json({
              error:
                'mode 为 replace_range/insert_before/insert_after/delete_range 时，' +
                'selection_with_ellipsis 与 selection_by_title 必须二选一',
            });
          }
        }

        if (p.mode !== 'delete_range' && !p.markdown) {
          return json({ error: `mode=${p.mode} 时必须提供 markdown` });
        }
      }

      const result = await callMcpTool(
        'update-doc',
        p as Record<string, unknown>,
      );
      return parseMcpResult(result);
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// Export
// ===========================================================================

export const docTools = [feishuCreateDoc, feishuFetchDoc, feishuUpdateDoc];
