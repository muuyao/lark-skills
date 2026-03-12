/**
 * Sheets tools — ported from openclaw-lark.
 *
 * Source: /tmp/openclaw-lark/src/tools/oapi/sheets/sheet.ts
 *
 * Actions: info, read, write, append, find, create, export
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Type } from '@sinclair/typebox';
import { json, assertLarkOk, formatToolError } from '../core/helpers.js';
import { getLarkClient } from '../core/client.js';
import type { ToolResult } from '../core/helpers.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_READ_ROWS = 200;
const MAX_WRITE_ROWS = 5000;
const MAX_WRITE_COLS = 100;
const EXPORT_POLL_INTERVAL_MS = 1000;
const EXPORT_POLL_MAX_RETRIES = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSheetUrl(url: string): { token: string; sheetId?: string } | null {
  try {
    const u = new URL(url);
    const match = u.pathname.match(/\/(?:sheets|wiki)\/([^/?#]+)/);
    if (!match) return null;
    return {
      token: match[1],
      sheetId: u.searchParams.get('sheet') || undefined,
    };
  } catch {
    return null;
  }
}

const KNOWN_TOKEN_TYPES = new Set([
  'dox', 'doc', 'sht', 'bas', 'app', 'sld', 'bmn', 'fld', 'nod', 'box',
  'jsn', 'img', 'isv', 'wik', 'wia', 'wib', 'wic', 'wid', 'wie', 'dsb',
]);

function getTokenType(token: string): string | null {
  if (token.length >= 15) {
    const prefix = token[4] + token[9] + token[14];
    if (KNOWN_TOKEN_TYPES.has(prefix)) return prefix;
  }
  if (token.length >= 3) {
    const prefix = token.substring(0, 3);
    if (KNOWN_TOKEN_TYPES.has(prefix)) return prefix;
  }
  return null;
}

async function resolveToken(
  p: { url?: string; spreadsheet_token?: string },
): Promise<{ token: string; urlSheetId?: string }> {
  let token: string;
  let urlSheetId: string | undefined;

  if (p.spreadsheet_token) {
    token = p.spreadsheet_token;
  } else if (p.url) {
    const parsed = parseSheetUrl(p.url);
    if (!parsed) {
      throw new Error(`Failed to parse spreadsheet_token from URL: ${p.url}`);
    }
    token = parsed.token;
    urlSheetId = parsed.sheetId;
  } else {
    throw new Error('url or spreadsheet_token is required');
  }

  // Detect wiki token and resolve to real spreadsheet_token
  const tokenType = getTokenType(token);
  if (tokenType === 'wik') {
    const client = getLarkClient();
    const wikiNodeRes = await client.wiki.space.getNode({
      params: { token, obj_type: 'wiki' as any },
    });
    assertLarkOk(wikiNodeRes);
    const objToken = wikiNodeRes.data?.node?.obj_token;
    if (!objToken) {
      throw new Error(`Failed to resolve spreadsheet token from wiki token: ${token}`);
    }
    token = objToken;
  }

  return { token, urlSheetId };
}

async function resolveRange(
  token: string,
  range: string | undefined,
  sheetId: string | undefined,
): Promise<string> {
  if (range) return range;
  if (sheetId) return sheetId;

  const client = getLarkClient();
  const sheetsRes = await client.sheets.spreadsheetSheet.query({ path: { spreadsheet_token: token } });
  assertLarkOk(sheetsRes);
  const firstSheet = (sheetsRes.data?.sheets ?? [])[0];
  if (!firstSheet?.sheet_id) {
    throw new Error('spreadsheet has no worksheets');
  }
  return firstSheet.sheet_id;
}

function colLetter(n: number): string {
  let result = '';
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

function flattenCellValue(cell: unknown): unknown {
  if (!Array.isArray(cell)) return cell;
  if (cell.length > 0 && cell.every((seg) => seg != null && typeof seg === 'object' && 'text' in seg)) {
    return cell.map((seg: any) => seg.text).join('');
  }
  return cell;
}

function flattenValues(values: unknown[][] | undefined): unknown[][] | undefined {
  if (!values) return values;
  return values.map((row) => row.map(flattenCellValue));
}

function truncateRows(
  values: unknown[][] | undefined,
  maxRows: number,
): { values: unknown[][] | undefined; truncated: boolean; total_rows: number } {
  if (!values) return { values, truncated: false, total_rows: 0 };
  const total = values.length;
  if (total <= maxRows) return { values, truncated: false, total_rows: total };
  return { values: values.slice(0, maxRows), truncated: true, total_rows: total };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const UrlOrToken = [
  Type.Optional(
    Type.String({
      description:
        '电子表格 URL，例如 https://xxx.feishu.cn/sheets/TOKEN 或 https://xxx.feishu.cn/wiki/TOKEN（与 spreadsheet_token 二选一）',
    }),
  ),
  Type.Optional(
    Type.String({
      description: '电子表格 token（与 url 二选一）',
    }),
  ),
] as const;

const ValueRenderOption = Type.Optional(
  Type.Union(
    [
      Type.Literal('ToString'),
      Type.Literal('FormattedValue'),
      Type.Literal('Formula'),
      Type.Literal('UnformattedValue'),
    ],
    {
      description:
        '值渲染方式：ToString（默认）、FormattedValue（按格式）、Formula（公式）、UnformattedValue（原始值）',
    },
  ),
);

const FeishuSheetSchema = Type.Union([
  // INFO
  Type.Object({
    action: Type.Literal('info'),
    url: UrlOrToken[0],
    spreadsheet_token: UrlOrToken[1],
  }),

  // READ
  Type.Object({
    action: Type.Literal('read'),
    url: UrlOrToken[0],
    spreadsheet_token: UrlOrToken[1],
    range: Type.Optional(
      Type.String({
        description:
          '读取范围（可选）。格式：<sheetId>!A1:D10 或 <sheetId>（sheetId 通过 info 获取）。不填则自动读取第一个工作表全部数据',
      }),
    ),
    sheet_id: Type.Optional(
      Type.String({
        description: '工作表 ID（可选）。仅当不提供 range 时生效，指定要读取的工作表。不填则读取第一个工作表',
      }),
    ),
    value_render_option: ValueRenderOption,
  }),

  // WRITE
  Type.Object({
    action: Type.Literal('write'),
    url: UrlOrToken[0],
    spreadsheet_token: UrlOrToken[1],
    range: Type.Optional(
      Type.String({
        description:
          '写入范围（可选）。格式：<sheetId>!A1:D10（sheetId 通过 info 获取）。不填则写入第一个工作表（从 A1 开始）',
      }),
    ),
    sheet_id: Type.Optional(
      Type.String({
        description: '工作表 ID（可选）。仅当不提供 range 时生效。不填则使用第一个工作表',
      }),
    ),
    values: Type.Array(Type.Array(Type.Any()), {
      description: '二维数组，每个元素是一行。例如 [["姓名","年龄"],["张三",25]]',
    }),
  }),

  // APPEND
  Type.Object({
    action: Type.Literal('append'),
    url: UrlOrToken[0],
    spreadsheet_token: UrlOrToken[1],
    range: Type.Optional(
      Type.String({
        description: '追加范围（可选）。格式同 write。不填则追加到第一个工作表末尾',
      }),
    ),
    sheet_id: Type.Optional(
      Type.String({
        description: '工作表 ID（可选）。仅当不提供 range 时生效',
      }),
    ),
    values: Type.Array(Type.Array(Type.Any()), {
      description: '要追加的二维数组数据',
    }),
  }),

  // FIND
  Type.Object({
    action: Type.Literal('find'),
    url: UrlOrToken[0],
    spreadsheet_token: UrlOrToken[1],
    sheet_id: Type.String({
      description: '工作表 ID（必填，可通过 info action 获取）',
    }),
    find: Type.String({
      description: '查找内容（字符串或正则表达式）',
    }),
    range: Type.Optional(
      Type.String({
        description: '查找范围。格式：A1:D10（不含 sheetId 前缀）。不填则搜索整个工作表',
      }),
    ),
    match_case: Type.Optional(Type.Boolean({ description: '是否区分大小写（默认 true）' })),
    match_entire_cell: Type.Optional(Type.Boolean({ description: '是否完全匹配整个单元格（默认 false）' })),
    search_by_regex: Type.Optional(Type.Boolean({ description: '是否使用正则表达式（默认 false）' })),
    include_formulas: Type.Optional(Type.Boolean({ description: '是否搜索公式（默认 false）' })),
  }),

  // CREATE
  Type.Object({
    action: Type.Literal('create'),
    title: Type.String({
      description: '电子表格标题',
    }),
    folder_token: Type.Optional(
      Type.String({
        description: '文件夹 token（可选）。不填时创建到「我的空间」根目录',
      }),
    ),
    headers: Type.Optional(
      Type.Array(Type.String(), {
        description: '表头列名（可选）。例如 ["姓名", "部门", "入职日期"]。提供后会写入第一行',
      }),
    ),
    data: Type.Optional(
      Type.Array(Type.Array(Type.Any()), {
        description: '初始数据（可选）。二维数组，写在表头之后。例如 [["张三", "工程", "2026-01-01"]]',
      }),
    ),
  }),

  // EXPORT
  Type.Object({
    action: Type.Literal('export'),
    url: UrlOrToken[0],
    spreadsheet_token: UrlOrToken[1],
    file_extension: Type.Union([Type.Literal('xlsx'), Type.Literal('csv')], {
      description: '导出格式：xlsx 或 csv',
    }),
    output_path: Type.Optional(
      Type.String({
        description: '本地保存路径（含文件名）。不填则只返回文件信息',
      }),
    ),
    sheet_id: Type.Optional(
      Type.String({
        description: '工作表 ID。导出 CSV 时必填（CSV 一次只能导出一个工作表），导出 xlsx 时可选',
      }),
    ),
  }),
]);

// ---------------------------------------------------------------------------
// Params type
// ---------------------------------------------------------------------------

interface BaseParams {
  url?: string;
  spreadsheet_token?: string;
}

type FeishuSheetParams =
  | (BaseParams & { action: 'info' })
  | (BaseParams & {
      action: 'read';
      range?: string;
      sheet_id?: string;
      value_render_option?: 'ToString' | 'FormattedValue' | 'Formula' | 'UnformattedValue';
    })
  | (BaseParams & {
      action: 'write';
      range?: string;
      sheet_id?: string;
      values: unknown[][];
    })
  | (BaseParams & {
      action: 'append';
      range?: string;
      sheet_id?: string;
      values: unknown[][];
    })
  | (BaseParams & {
      action: 'find';
      sheet_id: string;
      find: string;
      range?: string;
      match_case?: boolean;
      match_entire_cell?: boolean;
      search_by_regex?: boolean;
      include_formulas?: boolean;
    })
  | {
      action: 'create';
      title: string;
      folder_token?: string;
      headers?: string[];
      data?: unknown[][];
    }
  | (BaseParams & {
      action: 'export';
      file_extension: 'xlsx' | 'csv';
      output_path?: string;
      sheet_id?: string;
    });

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const feishuSheet = {
  name: 'feishu_sheet',
  description:
    '【以用户身份】飞书电子表格工具。支持创建、读写、查找、导出电子表格。' +
    '\n\n电子表格（Sheets）类似 Excel/Google Sheets，与多维表格（Bitable/Airtable）是不同产品。' +
    '\n\n所有 action（除 create 外）均支持传入 url 或 spreadsheet_token，工具会自动解析。支持知识库 wiki URL，自动解析为电子表格 token。' +
    '\n\nActions:' +
    '\n- info：获取表格信息 + 全部工作表列表（一次调用替代 get_info + list_sheets）' +
    '\n- read：读取数据。不填 range 自动读取第一个工作表全部数据' +
    '\n- write：覆盖写入,高危,请谨慎使用该操作。不填 range 自动写入第一个工作表（从 A1 开始）' +
    '\n- append：在已有数据末尾追加行' +
    '\n- find：在工作表中查找单元格' +
    '\n- create：创建电子表格。支持带 headers + data 一步创建含数据的表格' +
    '\n- export：导出为 xlsx 或 csv（csv 必须指定 sheet_id）',
  schema: FeishuSheetSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FeishuSheetParams;
    try {
      const client = getLarkClient();

      switch (p.action) {
        // INFO
        case 'info': {
          const { token } = await resolveToken(p);

          const [spreadsheetRes, sheetsRes] = await Promise.all([
            client.sheets.spreadsheet.get({ path: { spreadsheet_token: token } }),
            client.sheets.spreadsheetSheet.query({ path: { spreadsheet_token: token } }),
          ]);
          assertLarkOk(spreadsheetRes);
          assertLarkOk(sheetsRes);

          const spreadsheet = spreadsheetRes.data?.spreadsheet;
          const sheets = (sheetsRes.data?.sheets ?? []).map((s: any) => ({
            sheet_id: s.sheet_id,
            title: s.title,
            index: s.index,
            row_count: s.grid_properties?.row_count,
            column_count: s.grid_properties?.column_count,
            frozen_row_count: s.grid_properties?.frozen_row_count,
            frozen_column_count: s.grid_properties?.frozen_column_count,
          }));

          return json({
            title: spreadsheet?.title,
            spreadsheet_token: token,
            url: `https://www.feishu.cn/sheets/${token}`,
            sheets,
          });
        }

        // READ
        case 'read': {
          const { token, urlSheetId } = await resolveToken(p);
          const range = await resolveRange(token, p.range, p.sheet_id ?? urlSheetId);

          const query: Record<string, string> = {
            valueRenderOption: p.value_render_option ?? 'ToString',
            dateTimeRenderOption: 'FormattedString',
          };

          const res = await client.request({
            method: 'GET',
            url: `/open-apis/sheets/v2/spreadsheets/${token}/values/${encodeURIComponent(range)}`,
            params: query,
          });

          if ((res as any).code && (res as any).code !== 0) {
            return json({ error: (res as any).msg || `API error code: ${(res as any).code}` });
          }

          const valueRange = (res as any).data?.valueRange;
          const { values, truncated, total_rows } = truncateRows(flattenValues(valueRange?.values), MAX_READ_ROWS);

          return json({
            range: valueRange?.range,
            values,
            ...(truncated
              ? {
                  truncated: true,
                  total_rows,
                  hint: `Data exceeds ${MAX_READ_ROWS} rows, truncated. Please narrow the range and read again.`,
                }
              : {}),
          });
        }

        // WRITE
        case 'write': {
          const { token, urlSheetId } = await resolveToken(p);

          if (p.values && p.values.length > MAX_WRITE_ROWS) {
            return json({ error: `write row count ${p.values.length} exceeds limit ${MAX_WRITE_ROWS}` });
          }
          if (p.values && p.values.some((row) => Array.isArray(row) && row.length > MAX_WRITE_COLS)) {
            return json({ error: `write column count exceeds limit ${MAX_WRITE_COLS}` });
          }

          const range = await resolveRange(token, p.range, p.sheet_id ?? urlSheetId);

          const res = await client.request({
            method: 'PUT',
            url: `/open-apis/sheets/v2/spreadsheets/${token}/values`,
            data: { valueRange: { range, values: p.values } },
          });

          if ((res as any).code && (res as any).code !== 0) {
            return json({ error: (res as any).msg || `API error code: ${(res as any).code}` });
          }

          return json({
            updated_range: (res as any).data?.updatedRange,
            updated_rows: (res as any).data?.updatedRows,
            updated_columns: (res as any).data?.updatedColumns,
            updated_cells: (res as any).data?.updatedCells,
            revision: (res as any).data?.revision,
          });
        }

        // APPEND
        case 'append': {
          const { token, urlSheetId } = await resolveToken(p);

          if (p.values && p.values.length > MAX_WRITE_ROWS) {
            return json({ error: `append row count ${p.values.length} exceeds limit ${MAX_WRITE_ROWS}` });
          }

          const range = await resolveRange(token, p.range, p.sheet_id ?? urlSheetId);

          const res = await client.request({
            method: 'POST',
            url: `/open-apis/sheets/v2/spreadsheets/${token}/values_append`,
            data: { valueRange: { range, values: p.values } },
          });

          if ((res as any).code && (res as any).code !== 0) {
            return json({ error: (res as any).msg || `API error code: ${(res as any).code}` });
          }

          const updates = (res as any).data?.updates;

          return json({
            table_range: (res as any).data?.tableRange,
            updated_range: updates?.updatedRange,
            updated_rows: updates?.updatedRows,
            updated_columns: updates?.updatedColumns,
            updated_cells: updates?.updatedCells,
            revision: updates?.revision,
          });
        }

        // FIND
        case 'find': {
          const { token } = await resolveToken(p);

          const findCondition: Record<string, unknown> = {
            range: p.range ? `${p.sheet_id}!${p.range}` : p.sheet_id,
          };
          if (p.match_case !== undefined) findCondition.match_case = !p.match_case; // API inverted logic
          if (p.match_entire_cell !== undefined) findCondition.match_entire_cell = p.match_entire_cell;
          if (p.search_by_regex !== undefined) findCondition.search_by_regex = p.search_by_regex;
          if (p.include_formulas !== undefined) findCondition.include_formulas = p.include_formulas;

          const res = await client.sheets.spreadsheetSheet.find({
            path: {
              spreadsheet_token: token,
              sheet_id: p.sheet_id,
            },
            data: {
              find_condition: findCondition as any,
              find: p.find,
            },
          });
          assertLarkOk(res);

          const findResult = res.data?.find_result;

          return json({
            matched_cells: findResult?.matched_cells,
            matched_formula_cells: findResult?.matched_formula_cells,
            rows_count: findResult?.rows_count,
          });
        }

        // CREATE
        case 'create': {
          const createRes = await client.sheets.spreadsheet.create({
            data: {
              title: p.title,
              folder_token: p.folder_token,
            },
          });
          assertLarkOk(createRes);

          const spreadsheet = createRes.data?.spreadsheet;
          const token = spreadsheet?.spreadsheet_token;
          if (!token) {
            return json({ error: 'failed to create spreadsheet: no token returned' });
          }

          const url = `https://www.feishu.cn/sheets/${token}`;

          // Write initial data if provided
          if (p.headers || p.data) {
            const allRows: unknown[][] = [];
            if (p.headers) allRows.push(p.headers);
            if (p.data) allRows.push(...p.data);

            if (allRows.length > 0) {
              const sheetsRes = await client.sheets.spreadsheetSheet.query({ path: { spreadsheet_token: token } });
              assertLarkOk(sheetsRes);
              const firstSheet = (sheetsRes.data?.sheets ?? [])[0];
              if (firstSheet?.sheet_id) {
                const sheetId = firstSheet.sheet_id;
                const numRows = allRows.length;
                const numCols = Math.max(...allRows.map((r) => r.length));
                const range = `${sheetId}!A1:${colLetter(numCols)}${numRows}`;

                const writeRes = await client.request({
                  method: 'PUT',
                  url: `/open-apis/sheets/v2/spreadsheets/${token}/values`,
                  data: { valueRange: { range, values: allRows } },
                });

                if ((writeRes as any).code && (writeRes as any).code !== 0) {
                  return json({
                    spreadsheet_token: token,
                    url,
                    warning: `spreadsheet created but failed to write initial data: ${(writeRes as any).msg}`,
                  });
                }
              }
            }
          }

          return json({
            spreadsheet_token: token,
            title: p.title,
            url,
          });
        }

        // EXPORT
        case 'export': {
          const { token } = await resolveToken(p);

          if (p.file_extension === 'csv' && !p.sheet_id) {
            return json({
              error:
                'sheet_id is required for CSV export (CSV can only export one worksheet at a time). Use info action to get the worksheet list.',
            });
          }

          // Step 1: Create export task
          const createRes = await client.drive.exportTask.create({
            data: {
              file_extension: p.file_extension,
              token,
              type: 'sheet',
              sub_id: p.sheet_id,
            },
          });
          assertLarkOk(createRes);

          const ticket = createRes.data?.ticket;
          if (!ticket) {
            return json({ error: 'failed to create export task: no ticket returned' });
          }

          // Step 2: Poll until complete
          let fileToken: string | undefined;
          let fileName: string | undefined;
          let fileSize: number | undefined;

          for (let i = 0; i < EXPORT_POLL_MAX_RETRIES; i++) {
            await sleep(EXPORT_POLL_INTERVAL_MS);

            const pollRes = await client.drive.exportTask.get({ path: { ticket }, params: { token } });
            assertLarkOk(pollRes);

            const result = pollRes.data?.result;
            const jobStatus = result?.job_status;

            if (jobStatus === 0) {
              fileToken = result?.file_token;
              fileName = result?.file_name;
              fileSize = result?.file_size;
              break;
            }

            if (jobStatus !== undefined && jobStatus >= 3) {
              return json({ error: result?.job_error_msg || `export failed (status=${jobStatus})` });
            }
          }

          if (!fileToken) {
            return json({ error: 'export timeout: task did not complete within 30 seconds' });
          }

          // Step 3: Download if output_path given
          if (p.output_path) {
            const dlRes: any = await client.drive.exportTask.download({ path: { file_token: fileToken } });

            const stream = dlRes.getReadableStream();
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
              chunks.push(chunk);
            }

            await fs.mkdir(path.dirname(p.output_path), { recursive: true });
            await fs.writeFile(p.output_path, Buffer.concat(chunks));

            return json({
              file_path: p.output_path,
              file_name: fileName,
              file_size: fileSize,
            });
          }

          return json({
            file_token: fileToken,
            file_name: fileName,
            file_size: fileSize,
            hint: 'File exported. Provide output_path parameter to download locally.',
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

export const sheetsTools = [feishuSheet];
