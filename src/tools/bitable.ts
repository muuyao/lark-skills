/**
 * Feishu Bitable (multidimensional table) tools.
 *
 * Ported from openclaw-lark bitable modules:
 *   - app.ts          (create, get, list, patch, copy)
 *   - app-table.ts    (create, list, patch, delete, batch_create, batch_delete)
 *   - app-table-record.ts (create, list, update, delete, batch_create, batch_update, batch_delete)
 *   - app-table-field.ts  (create, list, update, delete)
 *   - app-table-view.ts   (create, get, list, patch, delete)
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Type } from '@sinclair/typebox';
import { json, assertLarkOk, formatToolError } from '../core/helpers.js';
import { getLarkClient } from '../core/client.js';
import type { ToolResult } from '../core/helpers.js';

// ===========================================================================
// SDK type helpers (inlined from sdk-types to keep self-contained)
// ===========================================================================

interface PaginatedData<T = any> {
  items?: T[];
  has_more?: boolean;
  page_token?: string;
  total?: number;
}

interface BitableAppListData {
  files?: any[];
  has_more?: boolean;
  page_token?: string;
}

interface FieldData {
  field?: any;
}

// ===========================================================================
//  1. feishu_bitable_app — Bitable app management
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuBitableAppSchema = Type.Union([
  // CREATE (P0)
  Type.Object({
    action: Type.Literal('create'),
    name: Type.String({ description: '多维表格名称' }),
    folder_token: Type.Optional(Type.String({ description: '所在文件夹 token（默认创建在我的空间）' })),
  }),

  // GET (P0)
  Type.Object({
    action: Type.Literal('get'),
    app_token: Type.String({ description: '多维表格的唯一标识 token' }),
  }),

  // LIST (P0) - 通过 Drive API 获取
  Type.Object({
    action: Type.Literal('list'),
    folder_token: Type.Optional(Type.String({ description: '文件夹 token（默认列出我的空间）' })),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 200' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // PATCH (P0)
  Type.Object({
    action: Type.Literal('patch'),
    app_token: Type.String({ description: '多维表格 token' }),
    name: Type.Optional(Type.String({ description: '新的名称' })),
    is_advanced: Type.Optional(Type.Boolean({ description: '是否开启高级权限' })),
  }),

  // COPY (P1)
  Type.Object({
    action: Type.Literal('copy'),
    app_token: Type.String({ description: '源多维表格 token' }),
    name: Type.String({ description: '新的名称' }),
    folder_token: Type.Optional(Type.String({ description: '目标文件夹 token' })),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuBitableAppParams =
  | {
      action: 'create';
      name: string;
      folder_token?: string;
    }
  | {
      action: 'get';
      app_token: string;
    }
  | {
      action: 'list';
      folder_token?: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'patch';
      app_token: string;
      name?: string;
      is_advanced?: boolean;
    }
  | {
      action: 'copy';
      app_token: string;
      name: string;
      folder_token?: string;
    };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const feishuBitableApp = {
  name: 'feishu_bitable_app',
  description:
    '【以用户身份】飞书多维表格应用管理工具。当用户要求创建/查询/管理多维表格时使用。Actions: create（创建多维表格）, get（获取多维表格元数据）, list（列出多维表格）, patch（更新元数据）, delete（删除多维表格）, copy（复制多维表格）。',
  schema: FeishuBitableAppSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FeishuBitableAppParams;

    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // CREATE
        // -----------------------------------------------------------------
        case 'create': {
          const data: any = { name: p.name };
          if (p.folder_token) {
            data.folder_token = p.folder_token;
          }

          const res = await client.bitable.app.create({
            data,
          });
          assertLarkOk(res);

          return json({
            app: res.data?.app,
          });
        }

        // -----------------------------------------------------------------
        // GET
        // -----------------------------------------------------------------
        case 'get': {
          const res = await client.bitable.app.get({
            path: {
              app_token: p.app_token,
            },
          });
          assertLarkOk(res);

          return json({
            app: res.data?.app,
          });
        }

        // -----------------------------------------------------------------
        // LIST - 使用 Drive API 筛选 bitable 类型文件
        // -----------------------------------------------------------------
        case 'list': {
          const res = await client.drive.v1.file.list({
            params: {
              folder_token: p.folder_token || '',
              page_size: p.page_size,
              page_token: p.page_token,
            },
          });
          assertLarkOk(res);

          // 筛选出 type === "bitable" 的文件
          const data = res.data as BitableAppListData | undefined;
          const bitables =
            data?.files?.filter(
              (f: any) => f.type === 'bitable',
            ) || [];

          return json({
            apps: bitables,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // PATCH
        // -----------------------------------------------------------------
        case 'patch': {
          const updateData: any = {};
          if (p.name !== undefined) updateData.name = p.name;
          if (p.is_advanced !== undefined) updateData.is_advanced = p.is_advanced;

          const res = await client.bitable.app.update({
            path: {
              app_token: p.app_token,
            },
            data: updateData,
          });
          assertLarkOk(res);

          return json({
            app: res.data?.app,
          });
        }

        // -----------------------------------------------------------------
        // COPY (P1)
        // -----------------------------------------------------------------
        case 'copy': {
          const data: any = { name: p.name };
          if (p.folder_token) {
            data.folder_token = p.folder_token;
          }

          const res = await client.bitable.app.copy({
            path: {
              app_token: p.app_token,
            },
            data,
          });
          assertLarkOk(res);

          return json({
            app: res.data?.app,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
//  2. feishu_bitable_app_table — Data table management
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuBitableAppTableSchema = Type.Union([
  // CREATE (P0)
  Type.Object({
    action: Type.Literal('create'),
    app_token: Type.String({ description: '多维表格 token' }),
    table: Type.Object({
      name: Type.String({ description: '数据表名称' }),
      default_view_name: Type.Optional(Type.String({ description: '默认视图名称' })),
      fields: Type.Optional(
        Type.Array(
          Type.Object({
            field_name: Type.String({ description: '字段名称' }),
            type: Type.Number({
              description:
                '字段类型（1=文本，2=数字，3=单选，4=多选，5=日期，7=复选框，11=人员，13=电话，15=超链接，17=附件，1001=创建时间，1002=修改时间等）',
            }),
            property: Type.Optional(Type.Any({ description: '字段属性配置（根据类型而定）' })),
          }),
          { description: '字段列表（可选，但强烈建议在创建表时就传入所有字段，避免后续逐个添加）。不传则创建空表。' },
        ),
      ),
    }),
  }),

  // LIST (P0)
  Type.Object({
    action: Type.Literal('list'),
    app_token: Type.String({ description: '多维表格 token' }),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // PATCH (P0)
  Type.Object({
    action: Type.Literal('patch'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    name: Type.Optional(Type.String({ description: '新的表名' })),
  }),

  // DELETE (P0)
  Type.Object({
    action: Type.Literal('delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
  }),

  // BATCH_CREATE (P1)
  Type.Object({
    action: Type.Literal('batch_create'),
    app_token: Type.String({ description: '多维表格 token' }),
    tables: Type.Array(
      Type.Object({
        name: Type.String({ description: '数据表名称' }),
      }),
      { description: '要批量创建的数据表列表' },
    ),
  }),

  // BATCH_DELETE (P1)
  Type.Object({
    action: Type.Literal('batch_delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_ids: Type.Array(Type.String(), { description: '要删除的数据表 ID 列表' }),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuBitableAppTableParams =
  | {
      action: 'create';
      app_token: string;
      table: {
        name: string;
        default_view_name?: string;
        fields?: Array<{
          field_name: string;
          type: number;
          property?: any;
        }>;
      };
    }
  | {
      action: 'list';
      app_token: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'patch';
      app_token: string;
      table_id: string;
      name?: string;
    }
  | {
      action: 'delete';
      app_token: string;
      table_id: string;
    }
  | {
      action: 'batch_create';
      app_token: string;
      tables: Array<{ name: string }>;
    }
  | {
      action: 'batch_delete';
      app_token: string;
      table_ids: string[];
    };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const feishuBitableAppTable = {
  name: 'feishu_bitable_app_table',
  description:
    '【以用户身份】飞书多维表格数据表管理工具。当用户要求创建/查询/管理数据表时使用。' +
    '\n\nActions: create（创建数据表，可选择在创建时传入 fields 数组定义字段，或后续逐个添加）, list（列出所有数据表）, patch（更新数据表）, delete（删除数据表）, batch_create（批量创建）, batch_delete（批量删除）。' +
    '\n\n【字段定义方式】支持两种模式：1) 明确需求时，在 create 中通过 table.fields 一次性定义所有字段（减少 API 调用）；2) 探索式场景时，使用默认表 + feishu_bitable_app_table_field 逐步修改字段（更稳定，易调整）。',
  schema: FeishuBitableAppTableSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FeishuBitableAppTableParams;

    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // CREATE
        // -----------------------------------------------------------------
        case 'create': {
          // 特殊处理：复选框（type=7）和超链接（type=15）字段不能传 property
          const tableData = { ...p.table };
          if (tableData.fields) {
            tableData.fields = tableData.fields.map((field: any) => {
              if ((field.type === 7 || field.type === 15) && field.property !== undefined) {
                const { property: _property, ...fieldWithoutProperty } = field;
                return fieldWithoutProperty;
              }
              return field;
            });
          }

          const res = await client.bitable.appTable.create({
            path: {
              app_token: p.app_token,
            },
            data: {
              table: tableData,
            },
          });
          assertLarkOk(res);

          return json({
            table_id: res.data?.table_id,
            default_view_id: res.data?.default_view_id,
            field_id_list: res.data?.field_id_list,
          });
        }

        // -----------------------------------------------------------------
        // LIST
        // -----------------------------------------------------------------
        case 'list': {
          const res = await client.bitable.appTable.list({
            path: {
              app_token: p.app_token,
            },
            params: {
              page_size: p.page_size,
              page_token: p.page_token,
            },
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            tables: data?.items,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // PATCH
        // -----------------------------------------------------------------
        case 'patch': {
          const res = await client.bitable.appTable.patch({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
            },
            data: {
              name: p.name,
            },
          });
          assertLarkOk(res);

          return json({
            name: res.data?.name,
          });
        }

        // -----------------------------------------------------------------
        // DELETE
        // -----------------------------------------------------------------
        case 'delete': {
          const res = await client.bitable.appTable.delete({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
            },
          });
          assertLarkOk(res);

          return json({
            success: true,
          });
        }

        // -----------------------------------------------------------------
        // BATCH_CREATE (P1)
        // -----------------------------------------------------------------
        case 'batch_create': {
          if (!p.tables || p.tables.length === 0) {
            return json({
              error: 'tables is required and cannot be empty',
            });
          }

          const res = await client.bitable.appTable.batchCreate({
            path: {
              app_token: p.app_token,
            },
            data: {
              tables: p.tables,
            },
          });
          assertLarkOk(res);

          return json({
            table_ids: res.data?.table_ids,
          });
        }

        // -----------------------------------------------------------------
        // BATCH_DELETE (P1)
        // -----------------------------------------------------------------
        case 'batch_delete': {
          if (!p.table_ids || p.table_ids.length === 0) {
            return json({
              error: 'table_ids is required and cannot be empty',
            });
          }

          const res = await client.bitable.appTable.batchDelete({
            path: {
              app_token: p.app_token,
            },
            data: {
              table_ids: p.table_ids,
            },
          });
          assertLarkOk(res);

          return json({
            success: true,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
//  3. feishu_bitable_app_table_record — Record (row) management
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuBitableAppTableRecordSchema = Type.Union([
  // CREATE (P0)
  Type.Object({
    action: Type.Literal('create'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    fields: Type.Object(
      {},
      {
        additionalProperties: true,
        description:
          "记录字段（单条记录）。键为字段名，值根据字段类型而定：\n- 文本：string\n- 数字：number\n- 单选：string（选项名）\n- 多选：string[]（选项名数组）\n- 日期：number（毫秒时间戳，如 1740441600000）\n- 复选框：boolean\n- 人员：[{id: 'ou_xxx'}]\n- 附件：[{file_token: 'xxx'}]\n⚠️ 注意：create 只创建单条记录；批量创建请使用 batch_create",
      },
    ),
  }),

  // UPDATE (P0)
  Type.Object({
    action: Type.Literal('update'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    record_id: Type.String({ description: '记录 ID' }),
    fields: Type.Object(
      {},
      {
        additionalProperties: true,
        description: '要更新的字段',
      },
    ),
  }),

  // DELETE (P0)
  Type.Object({
    action: Type.Literal('delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    record_id: Type.String({ description: '记录 ID' }),
  }),

  // BATCH_CREATE (P1)
  Type.Object({
    action: Type.Literal('batch_create'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    records: Type.Array(
      Type.Object({
        fields: Type.Object({}, { additionalProperties: true }),
      }),
      { description: '要批量创建的记录列表（最多 500 条）' },
    ),
  }),

  // BATCH_UPDATE (P1)
  Type.Object({
    action: Type.Literal('batch_update'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    records: Type.Array(
      Type.Object({
        record_id: Type.String(),
        fields: Type.Object({}, { additionalProperties: true }),
      }),
      { description: '要批量更新的记录列表（最多 500 条）' },
    ),
  }),

  // BATCH_DELETE (P1)
  Type.Object({
    action: Type.Literal('batch_delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    record_ids: Type.Array(Type.String(), { description: '要删除的记录 ID 列表（最多 500 条）' }),
  }),

  // LIST (P0) - 使用 search API（旧 list API 已废弃）
  Type.Object({
    action: Type.Literal('list'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_id: Type.Optional(Type.String({ description: '视图 ID（可选，建议指定以获得更好的性能）' })),
    field_names: Type.Optional(
      Type.Array(Type.String(), {
        description: '要返回的字段名列表（可选，不指定则返回所有字段）',
      }),
    ),
    filter: Type.Optional(
      Type.Object(
        {
          conjunction: Type.Union([Type.Literal('and'), Type.Literal('or')], {
            description: '条件逻辑：and（全部满足）or（任一满足）',
          }),
          conditions: Type.Array(
            Type.Object({
              field_name: Type.String({ description: '字段名' }),
              operator: Type.Union(
                [
                  Type.Literal('is'),
                  Type.Literal('isNot'),
                  Type.Literal('contains'),
                  Type.Literal('doesNotContain'),
                  Type.Literal('isEmpty'),
                  Type.Literal('isNotEmpty'),
                  Type.Literal('isGreater'),
                  Type.Literal('isGreaterEqual'),
                  Type.Literal('isLess'),
                  Type.Literal('isLessEqual'),
                ],
                { description: '运算符' },
              ),
              value: Type.Optional(
                Type.Array(Type.String(), {
                  description: '条件值（isEmpty/isNotEmpty 时可省略）',
                }),
              ),
            }),
            { description: '筛选条件列表' },
          ),
        },
        {
          description:
            "筛选条件（必须是结构化对象）。示例：{conjunction: 'and', conditions: [{field_name: '文本', operator: 'is', value: ['测试']}]}",
        },
      ),
    ),
    sort: Type.Optional(
      Type.Array(
        Type.Object({
          field_name: Type.String({ description: '排序字段名' }),
          desc: Type.Boolean({ description: '是否降序' }),
        }),
        { description: '排序规则' },
      ),
    ),
    automatic_fields: Type.Optional(
      Type.Boolean({
        description: '是否返回自动字段（created_time, last_modified_time, created_by, last_modified_by），默认 false',
      }),
    ),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 500' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuBitableAppTableRecordParams =
  | {
      action: 'create';
      app_token: string;
      table_id: string;
      fields: Record<string, any>;
    }
  | {
      action: 'get';
      app_token: string;
      table_id: string;
      record_id: string;
    }
  | {
      action: 'update';
      app_token: string;
      table_id: string;
      record_id: string;
      fields: Record<string, any>;
    }
  | {
      action: 'delete';
      app_token: string;
      table_id: string;
      record_id: string;
    }
  | {
      action: 'batch_create';
      app_token: string;
      table_id: string;
      records: Array<{ fields: Record<string, any> }>;
    }
  | {
      action: 'batch_update';
      app_token: string;
      table_id: string;
      records: Array<{ record_id: string; fields: Record<string, any> }>;
    }
  | {
      action: 'batch_delete';
      app_token: string;
      table_id: string;
      record_ids: string[];
    }
  | {
      action: 'list';
      app_token: string;
      table_id: string;
      view_id?: string;
      field_names?: string[];
      filter?: {
        conjunction: 'and' | 'or';
        conditions: Array<{
          field_name: string;
          operator:
            | 'is'
            | 'isNot'
            | 'contains'
            | 'doesNotContain'
            | 'isEmpty'
            | 'isNotEmpty'
            | 'isGreater'
            | 'isGreaterEqual'
            | 'isLess'
            | 'isLessEqual';
          value?: string[];
        }>;
      };
      sort?: Array<{ field_name: string; desc: boolean }>;
      automatic_fields?: boolean;
      page_size?: number;
      page_token?: string;
    };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const feishuBitableAppTableRecord = {
  name: 'feishu_bitable_app_table_record',
  description:
    '【以用户身份】飞书多维表格记录（行）管理工具。当用户要求创建/查询/更新/删除记录、搜索数据时使用。\n\n' +
    'Actions:\n' +
    '- create（创建单条记录，使用 fields 参数）\n' +
    '- batch_create（批量创建记录，使用 records 数组参数）\n' +
    '- list（列出/搜索记录）\n' +
    '- update（更新记录）\n' +
    '- delete（删除记录）\n' +
    '- batch_update（批量更新）\n' +
    '- batch_delete（批量删除）\n\n' +
    '⚠️ 注意参数区别：\n' +
    "- create 使用 'fields' 对象（单条）\n" +
    "- batch_create 使用 'records' 数组（批量）",
  schema: FeishuBitableAppTableRecordSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FeishuBitableAppTableRecordParams;

    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // CREATE
        // -----------------------------------------------------------------
        case 'create': {
          // 参数验证：检查是否误用了 batch_create 的参数格式
          if ((p as any).records) {
            return json({
              error: "create action does not accept 'records' parameter",
              hint: "Use 'fields' for single record creation. For batch creation, use action: 'batch_create' with 'records' parameter.",
              correct_format: {
                action: 'create',
                fields: { 字段名: '字段值' },
              },
              batch_create_format: {
                action: 'batch_create',
                records: [{ fields: { 字段名: '字段值' } }],
              },
            });
          }

          if (!p.fields || Object.keys(p.fields).length === 0) {
            return json({
              error: 'fields is required and cannot be empty',
              hint: "create action requires 'fields' parameter, e.g. { 'field_name': 'value', ... }",
            });
          }

          const res = await client.bitable.appTableRecord.create({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
            data: {
              fields: p.fields,
            },
          });
          assertLarkOk(res);

          return json({
            record: res.data?.record,
          });
        }

        // -----------------------------------------------------------------
        // UPDATE
        // -----------------------------------------------------------------
        case 'update': {
          // 参数验证：检查是否误用了 batch_update 的参数格式
          if ((p as any).records) {
            return json({
              error: "update action does not accept 'records' parameter",
              hint: "Use 'record_id' + 'fields' for single record update. For batch update, use action: 'batch_update' with 'records' parameter.",
              correct_format: {
                action: 'update',
                record_id: 'recXXX',
                fields: { 字段名: '字段值' },
              },
              batch_update_format: {
                action: 'batch_update',
                records: [{ record_id: 'recXXX', fields: { 字段名: '字段值' } }],
              },
            });
          }

          const res = await client.bitable.appTableRecord.update({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
              record_id: p.record_id,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
            data: {
              fields: p.fields,
            },
          });
          assertLarkOk(res);

          return json({
            record: res.data?.record,
          });
        }

        // -----------------------------------------------------------------
        // DELETE
        // -----------------------------------------------------------------
        case 'delete': {
          const res = await client.bitable.appTableRecord.delete({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
              record_id: p.record_id,
            },
          });
          assertLarkOk(res);

          return json({
            success: true,
          });
        }

        // -----------------------------------------------------------------
        // BATCH_CREATE (P1)
        // -----------------------------------------------------------------
        case 'batch_create': {
          // 参数验证：检查是否误用了 create 的参数格式
          if ((p as any).fields) {
            return json({
              error: "batch_create action does not accept 'fields' parameter",
              hint: "Use 'records' array for batch creation. For single record, use action: 'create' with 'fields' parameter.",
              correct_format: {
                action: 'batch_create',
                records: [{ fields: { 字段名: '字段值' } }],
              },
              single_create_format: {
                action: 'create',
                fields: { 字段名: '字段值' },
              },
            });
          }

          if (!p.records || p.records.length === 0) {
            return json({
              error: 'records is required and cannot be empty',
              hint: "batch_create requires 'records' array, e.g. [{ fields: {...} }, ...]",
            });
          }

          if (p.records.length > 500) {
            return json({
              error: 'records count exceeds limit (maximum 500)',
              received_count: p.records.length,
            });
          }

          const res = await client.bitable.appTableRecord.batchCreate({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
            data: {
              records: p.records,
            },
          });
          assertLarkOk(res);

          return json({
            records: res.data?.records,
          });
        }

        // -----------------------------------------------------------------
        // BATCH_UPDATE (P1)
        // -----------------------------------------------------------------
        case 'batch_update': {
          // 参数验证：检查是否误用了 update 的参数格式
          if ((p as any).record_id || (p as any).fields) {
            return json({
              error: "batch_update action does not accept 'record_id' or 'fields' parameters",
              hint: "Use 'records' array for batch update. For single record, use action: 'update' with 'record_id' + 'fields' parameters.",
              correct_format: {
                action: 'batch_update',
                records: [{ record_id: 'recXXX', fields: { 字段名: '字段值' } }],
              },
              single_update_format: {
                action: 'update',
                record_id: 'recXXX',
                fields: { 字段名: '字段值' },
              },
            });
          }

          if (!p.records || p.records.length === 0) {
            return json({
              error: 'records is required and cannot be empty',
              hint: "batch_update requires 'records' array, e.g. [{ record_id: 'recXXX', fields: {...} }, ...]",
            });
          }

          if (p.records.length > 500) {
            return json({
              error: 'records cannot exceed 500 items',
            });
          }

          const res = await client.bitable.appTableRecord.batchUpdate({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
            },
            params: {
              user_id_type: 'open_id' as any,
            },
            data: {
              records: p.records,
            },
          });
          assertLarkOk(res);

          return json({
            records: res.data?.records,
          });
        }

        // -----------------------------------------------------------------
        // BATCH_DELETE (P1)
        // -----------------------------------------------------------------
        case 'batch_delete': {
          if (!p.record_ids || p.record_ids.length === 0) {
            return json({
              error: 'record_ids is required and cannot be empty',
            });
          }

          if (p.record_ids.length > 500) {
            return json({
              error: 'record_ids cannot exceed 500 items',
            });
          }

          const res = await client.bitable.appTableRecord.batchDelete({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
            },
            data: {
              records: p.record_ids,
            },
          });
          assertLarkOk(res);

          return json({
            success: true,
          });
        }

        // -----------------------------------------------------------------
        // LIST (P0) - 使用 search API（旧 list API 已废弃）
        // -----------------------------------------------------------------
        case 'list': {
          const searchData: any = {};
          if (p.view_id !== undefined) searchData.view_id = p.view_id;
          if (p.field_names !== undefined) searchData.field_names = p.field_names;

          // 特殊处理：isEmpty/isNotEmpty 必须带 value=[]（即使逻辑上不需要值）
          if (p.filter !== undefined) {
            const filter = { ...p.filter };
            if (filter.conditions) {
              filter.conditions = filter.conditions.map((cond: any) => {
                if ((cond.operator === 'isEmpty' || cond.operator === 'isNotEmpty') && !cond.value) {
                  return { ...cond, value: [] };
                }
                return cond;
              });
            }
            searchData.filter = filter;
          }

          if (p.sort !== undefined) searchData.sort = p.sort;
          if (p.automatic_fields !== undefined) searchData.automatic_fields = p.automatic_fields;

          const res = await client.bitable.appTableRecord.search({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
            },
            params: {
              user_id_type: 'open_id' as any,
              page_size: p.page_size,
              page_token: p.page_token,
            },
            data: searchData,
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            records: data?.items,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
            total: data?.total,
          });
        }

        default:
          return json({
            error: `Unknown action: ${(p as any).action}`,
          });
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
//  4. feishu_bitable_app_table_field — Field (column) management
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuBitableAppTableFieldSchema = Type.Union([
  // CREATE (P1)
  Type.Object({
    action: Type.Literal('create'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    field_name: Type.String({ description: '字段名称' }),
    type: Type.Number({
      description:
        '字段类型（1=文本，2=数字，3=单选，4=多选，5=日期，7=复选框，11=人员，13=电话，15=超链接，17=附件，1001=创建时间，1002=修改时间等）',
    }),
    property: Type.Optional(
      Type.Any({
        description:
          '字段属性配置（根据类型而定，例如单选/多选需要options，数字需要formatter等）。' +
          '⚠️ 重要：超链接字段（type=15）必须完全省略此参数，传空对象 {} 也会报错（URLFieldPropertyError）。',
      }),
    ),
  }),

  // LIST (P1)
  Type.Object({
    action: Type.Literal('list'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_id: Type.Optional(Type.String({ description: '视图 ID（可选）' })),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // UPDATE (P1)
  Type.Object({
    action: Type.Literal('update'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    field_id: Type.String({ description: '字段 ID' }),
    field_name: Type.Optional(Type.String({ description: '字段名（可选，不传则不修改）' })),
    type: Type.Optional(
      Type.Number({
        description:
          '字段类型（可选，不传则自动查询）：1=文本, 2=数字, 3=单选, 4=多选, 5=日期, 7=复选框, 11=人员, 13=电话, 15=超链接, 17=附件等',
      }),
    ),
    property: Type.Optional(Type.Any({ description: '字段属性配置（可选，不传则自动查询）' })),
  }),

  // DELETE (P1)
  Type.Object({
    action: Type.Literal('delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    field_id: Type.String({ description: '字段 ID' }),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuBitableAppTableFieldParams =
  | {
      action: 'create';
      app_token: string;
      table_id: string;
      field_name: string;
      type: number;
      property?: any;
    }
  | {
      action: 'list';
      app_token: string;
      table_id: string;
      view_id?: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'update';
      app_token: string;
      table_id: string;
      field_id: string;
      field_name?: string;
      type?: number;
      property?: any;
    }
  | {
      action: 'delete';
      app_token: string;
      table_id: string;
      field_id: string;
    };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const feishuBitableAppTableField = {
  name: 'feishu_bitable_app_table_field',
  description:
    '【以用户身份】飞书多维表格字段（列）管理工具。当用户要求创建/查询/更新/删除字段、调整表结构时使用。Actions: create（创建字段）, list（列出所有字段）, update（更新字段，支持只传 field_name 改名）, delete（删除字段）。',
  schema: FeishuBitableAppTableFieldSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FeishuBitableAppTableFieldParams;

    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // CREATE
        // -----------------------------------------------------------------
        case 'create': {
          // 特殊处理：超链接字段（type=15）和复选框字段（type=7）不能传 property，即使是空对象也会报错
          let propertyToSend = p.property;
          if ((p.type === 15 || p.type === 7) && p.property !== undefined) {
            propertyToSend = undefined;
          }

          const res = await client.bitable.appTableField.create({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
            },
            data: {
              field_name: p.field_name,
              type: p.type,
              property: propertyToSend,
            },
          });
          assertLarkOk(res);

          const data = res.data as FieldData | undefined;

          return json({
            field: data?.field ?? res.data,
          });
        }

        // -----------------------------------------------------------------
        // LIST
        // -----------------------------------------------------------------
        case 'list': {
          const res = await client.bitable.appTableField.list({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
            },
            params: {
              view_id: p.view_id,
              page_size: p.page_size,
              page_token: p.page_token,
            },
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            fields: data?.items,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // UPDATE
        // -----------------------------------------------------------------
        case 'update': {
          // 如果缺少 type 或 field_name，自动查询当前字段信息
          let finalFieldName = p.field_name;
          let finalType = p.type;
          let finalProperty = p.property;

          if (!finalType || !finalFieldName) {
            const listRes = await client.bitable.appTableField.list({
              path: {
                app_token: p.app_token,
                table_id: p.table_id,
              },
              params: {
                page_size: 500,
              },
            });
            assertLarkOk(listRes);

            const listData = listRes.data as
              | PaginatedData<{ field_id?: string; field_name?: string; type?: number; property?: any }>
              | undefined;
            const currentField = listData?.items?.find((f) => f.field_id === p.field_id);

            if (!currentField) {
              return json({
                error: `field ${p.field_id} does not exist`,
                hint: 'Please verify field_id is correct. Use list action to view all fields.',
              });
            }

            // 合并：用户传的优先，否则用查询到的
            finalFieldName = p.field_name || currentField.field_name;
            finalType = p.type ?? currentField.type;
            finalProperty = p.property !== undefined ? p.property : currentField.property;
          }

          const updateData: any = {
            field_name: finalFieldName,
            type: finalType,
          };
          if (finalProperty !== undefined) {
            updateData.property = finalProperty;
          }

          const res = await client.bitable.appTableField.update({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
              field_id: p.field_id,
            },
            data: updateData,
          });
          assertLarkOk(res);

          const updateResData = res.data as FieldData | undefined;

          return json({
            field: updateResData?.field ?? res.data,
          });
        }

        // -----------------------------------------------------------------
        // DELETE
        // -----------------------------------------------------------------
        case 'delete': {
          const res = await client.bitable.appTableField.delete({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
              field_id: p.field_id,
            },
          });
          assertLarkOk(res);

          return json({
            success: true,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
//  5. feishu_bitable_app_table_view — View management
// ===========================================================================

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const FeishuBitableAppTableViewSchema = Type.Union([
  // CREATE (P1)
  Type.Object({
    action: Type.Literal('create'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_name: Type.String({ description: '视图名称' }),
    view_type: Type.Optional(
      Type.Union([
        Type.Literal('grid'), // 表格视图
        Type.Literal('kanban'), // 看板视图
        Type.Literal('gallery'), // 画册视图
        Type.Literal('gantt'), // 甘特图
        Type.Literal('form'), // 表单视图
      ]),
    ),
  }),

  // GET (P1)
  Type.Object({
    action: Type.Literal('get'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_id: Type.String({ description: '视图 ID' }),
  }),

  // LIST (P1)
  Type.Object({
    action: Type.Literal('list'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    page_size: Type.Optional(Type.Number({ description: '每页数量，默认 50，最大 100' })),
    page_token: Type.Optional(Type.String({ description: '分页标记' })),
  }),

  // PATCH (P1)
  Type.Object({
    action: Type.Literal('patch'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_id: Type.String({ description: '视图 ID' }),
    view_name: Type.Optional(Type.String({ description: '新的视图名称' })),
  }),

  // DELETE (P1)
  Type.Object({
    action: Type.Literal('delete'),
    app_token: Type.String({ description: '多维表格 token' }),
    table_id: Type.String({ description: '数据表 ID' }),
    view_id: Type.String({ description: '视图 ID' }),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

type FeishuBitableAppTableViewParams =
  | {
      action: 'create';
      app_token: string;
      table_id: string;
      view_name: string;
      view_type?: string;
    }
  | {
      action: 'get';
      app_token: string;
      table_id: string;
      view_id: string;
    }
  | {
      action: 'list';
      app_token: string;
      table_id: string;
      page_size?: number;
      page_token?: string;
    }
  | {
      action: 'patch';
      app_token: string;
      table_id: string;
      view_id: string;
      view_name?: string;
    }
  | {
      action: 'delete';
      app_token: string;
      table_id: string;
      view_id: string;
    };

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const feishuBitableAppTableView = {
  name: 'feishu_bitable_app_table_view',
  description:
    '【以用户身份】飞书多维表格视图管理工具。当用户要求创建/查询/更新/删除视图、切换展示方式时使用。Actions: create（创建视图）, get（获取视图详情）, list（列出所有视图）, patch（更新视图）, delete（删除视图）。',
  schema: FeishuBitableAppTableViewSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FeishuBitableAppTableViewParams;

    try {
      const client = getLarkClient();

      switch (p.action) {
        // -----------------------------------------------------------------
        // CREATE
        // -----------------------------------------------------------------
        case 'create': {
          const res = await client.bitable.appTableView.create({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
            },
            data: {
              view_name: p.view_name,
              view_type: (p.view_type || 'grid') as any,
            },
          });
          assertLarkOk(res);

          return json({
            view: res.data?.view,
          });
        }

        // -----------------------------------------------------------------
        // GET
        // -----------------------------------------------------------------
        case 'get': {
          const res = await client.bitable.appTableView.get({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
              view_id: p.view_id,
            },
          });
          assertLarkOk(res);

          return json({
            view: res.data?.view,
          });
        }

        // -----------------------------------------------------------------
        // LIST
        // -----------------------------------------------------------------
        case 'list': {
          const res = await client.bitable.appTableView.list({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
            },
            params: {
              page_size: p.page_size,
              page_token: p.page_token,
            },
          });
          assertLarkOk(res);

          const data = res.data as PaginatedData | undefined;

          return json({
            views: data?.items,
            has_more: data?.has_more ?? false,
            page_token: data?.page_token,
          });
        }

        // -----------------------------------------------------------------
        // PATCH
        // -----------------------------------------------------------------
        case 'patch': {
          const res = await client.bitable.appTableView.patch({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
              view_id: p.view_id,
            },
            data: {
              view_name: p.view_name,
            },
          });
          assertLarkOk(res);

          return json({
            view: res.data?.view,
          });
        }

        // -----------------------------------------------------------------
        // DELETE
        // -----------------------------------------------------------------
        case 'delete': {
          const res = await client.bitable.appTableView.delete({
            path: {
              app_token: p.app_token,
              table_id: p.table_id,
              view_id: p.view_id,
            },
          });
          assertLarkOk(res);

          return json({
            success: true,
          });
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
//  Export all bitable tools
// ===========================================================================

export const bitableTools = [
  feishuBitableApp,
  feishuBitableAppTable,
  feishuBitableAppTableRecord,
  feishuBitableAppTableField,
  feishuBitableAppTableView,
];
