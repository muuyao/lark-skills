/**
 * Drive tools — ported from openclaw-lark.
 *
 * Source files:
 *   - /tmp/openclaw-lark/src/tools/oapi/drive/file.ts
 *   - /tmp/openclaw-lark/src/tools/oapi/drive/doc-comments.ts
 *   - /tmp/openclaw-lark/src/tools/oapi/drive/doc-media.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { Type } from '@sinclair/typebox';
import { json, assertLarkOk, formatToolError } from '../core/helpers.js';
import { getLarkClient } from '../core/client.js';
import type { ToolResult } from '../core/helpers.js';
import * as fs from 'fs/promises';
import * as path from 'path';

// ===========================================================================
// Shared types
// ===========================================================================

interface DriveFileListData {
  files?: unknown[];
  has_more?: boolean;
  next_page_token?: string;
}

interface DriveFileData {
  file?: { token?: string; [key: string]: unknown };
}

interface DriveTaskData {
  task_id?: string;
}

interface CommentReplyListData {
  items?: unknown[];
  has_more?: boolean;
  page_token?: string;
}

// ===========================================================================
// Constants
// ===========================================================================

const SMALL_FILE_THRESHOLD = 15 * 1024 * 1024; // 15MB

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
// 1. feishu_drive_file — file management
// ===========================================================================

const FeishuDriveFileSchema = Type.Union([
  // LIST FILES
  Type.Object({
    action: Type.Literal('list'),
    folder_token: Type.Optional(
      Type.String({
        description:
          '文件夹 token（可选）。不填写或填空字符串时，获取用户云空间根目录下的清单（注意：根目录模式不支持分页和返回快捷方式）',
      }),
    ),
    page_size: Type.Optional(
      Type.Integer({
        description: '分页大小（默认 200，最大 200）',
        minimum: 1,
        maximum: 200,
      }),
    ),
    page_token: Type.Optional(
      Type.String({
        description: '分页标记。首次请求无需填写',
      }),
    ),
    order_by: Type.Optional(
      Type.Union([Type.Literal('EditedTime'), Type.Literal('CreatedTime')], {
        description: '排序方式：EditedTime（编辑时间）、CreatedTime（创建时间）',
      }),
    ),
    direction: Type.Optional(
      Type.Union([Type.Literal('ASC'), Type.Literal('DESC')], {
        description: '排序方向：ASC（升序）、DESC（降序）',
      }),
    ),
  }),

  // GET META
  Type.Object({
    action: Type.Literal('get_meta'),
    request_docs: Type.Array(
      Type.Object({
        doc_token: Type.String({
          description: '文档 token（从浏览器 URL 中获取，如 spreadsheet_token、doc_token 等）',
        }),
        doc_type: Type.Union(
          [
            Type.Literal('doc'),
            Type.Literal('sheet'),
            Type.Literal('file'),
            Type.Literal('bitable'),
            Type.Literal('docx'),
            Type.Literal('folder'),
            Type.Literal('mindnote'),
            Type.Literal('slides'),
          ],
          {
            description: '文档类型：doc、sheet、file、bitable、docx、folder、mindnote、slides',
          },
        ),
      }),
      {
        description:
          "要查询的文档列表（批量查询，最多 50 个）。示例：[{doc_token: 'Z1FjxxxxxxxxxxxxxxxxxxxtnAc', doc_type: 'sheet'}]",
        minItems: 1,
        maxItems: 50,
      },
    ),
  }),

  // COPY FILE
  Type.Object({
    action: Type.Literal('copy'),
    file_token: Type.String({ description: '文件 token（必填）' }),
    name: Type.String({ description: '目标文件名（必填）' }),
    type: Type.Union(
      [
        Type.Literal('doc'), Type.Literal('sheet'), Type.Literal('file'),
        Type.Literal('bitable'), Type.Literal('docx'), Type.Literal('folder'),
        Type.Literal('mindnote'), Type.Literal('slides'),
      ],
      { description: '文档类型（必填）' },
    ),
    folder_token: Type.Optional(Type.String({ description: '目标文件夹 token。不传则复制到「我的空间」根目录' })),
    parent_node: Type.Optional(
      Type.String({ description: '【folder_token 的别名】目标文件夹 token（为兼容性保留，建议使用 folder_token）' }),
    ),
  }),

  // MOVE FILE
  Type.Object({
    action: Type.Literal('move'),
    file_token: Type.String({ description: '文件 token（必填）' }),
    type: Type.Union(
      [
        Type.Literal('doc'), Type.Literal('sheet'), Type.Literal('file'),
        Type.Literal('bitable'), Type.Literal('docx'), Type.Literal('folder'),
        Type.Literal('mindnote'), Type.Literal('slides'),
      ],
      { description: '文档类型（必填）' },
    ),
    folder_token: Type.String({ description: '目标文件夹 token（必填）' }),
  }),

  // DELETE FILE
  Type.Object({
    action: Type.Literal('delete'),
    file_token: Type.String({ description: '文件 token（必填）' }),
    type: Type.Union(
      [
        Type.Literal('doc'), Type.Literal('sheet'), Type.Literal('file'),
        Type.Literal('bitable'), Type.Literal('docx'), Type.Literal('folder'),
        Type.Literal('mindnote'), Type.Literal('slides'),
      ],
      { description: '文档类型（必填）' },
    ),
  }),

  // UPLOAD FILE
  Type.Object({
    action: Type.Literal('upload'),
    parent_node: Type.Optional(
      Type.String({
        description:
          '父节点 token（可选）。explorer 类型填文件夹 token，bitable 类型填 app_token。不填写或填空字符串时，上传到云空间根目录',
      }),
    ),
    file_path: Type.Optional(
      Type.String({
        description:
          '本地文件路径（与 file_content_base64 二选一）。优先使用此参数，会自动读取文件内容、计算大小、提取文件名。',
      }),
    ),
    file_content_base64: Type.Optional(
      Type.String({
        description: '文件内容的 Base64 编码（与 file_path 二选一）。当不提供 file_path 时使用。',
      }),
    ),
    file_name: Type.Optional(
      Type.String({
        description:
          '文件名（可选）。如果提供了 file_path，会自动从路径中提取文件名；如果使用 file_content_base64，则必须提供此参数。',
      }),
    ),
    size: Type.Optional(
      Type.Integer({
        description:
          '文件大小（字节，可选）。如果提供了 file_path，会自动计算；如果使用 file_content_base64，则必须提供此参数。',
      }),
    ),
  }),

  // DOWNLOAD FILE
  Type.Object({
    action: Type.Literal('download'),
    file_token: Type.String({ description: '文件 token（必填）' }),
    output_path: Type.Optional(
      Type.String({
        description:
          "本地保存的完整文件路径（可选）。必须包含文件名和扩展名，例如 '/tmp/file.pdf'。如果不提供，则返回 Base64 编码的文件内容。",
      }),
    ),
  }),
]);

type FeishuDriveFileParams =
  | {
      action: 'list';
      folder_token?: string;
      page_size?: number;
      page_token?: string;
      order_by?: 'EditedTime' | 'CreatedTime';
      direction?: 'ASC' | 'DESC';
    }
  | {
      action: 'get_meta';
      request_docs: Array<{ doc_token: string; doc_type: string }>;
    }
  | {
      action: 'copy';
      file_token: string;
      name: string;
      type: string;
      folder_token?: string;
      parent_node?: string;
    }
  | {
      action: 'move';
      file_token: string;
      type: string;
      folder_token: string;
    }
  | {
      action: 'delete';
      file_token: string;
      type: string;
    }
  | {
      action: 'upload';
      parent_node?: string;
      file_path?: string;
      file_content_base64?: string;
      file_name?: string;
      size?: number;
    }
  | {
      action: 'download';
      file_token: string;
      output_path?: string;
    };

const feishuDriveFile = {
  name: 'feishu_drive_file',
  description:
    '【以用户身份】飞书云空间文件管理工具。当用户要求查看云空间(云盘)中的文件列表、获取文件信息、复制/移动/删除文件、上传/下载文件时使用。消息中的文件读写**禁止**使用该工具!' +
    '\n\nActions:' +
    '\n- list（列出文件）：列出文件夹下的文件。不提供 folder_token 时获取根目录清单' +
    "\n- get_meta（批量获取元数据）：批量查询文档元信息，使用 request_docs 数组参数，格式：[{doc_token: '...', doc_type: 'sheet'}]" +
    '\n- copy（复制文件）：复制文件到指定位置' +
    '\n- move（移动文件）：移动文件到指定文件夹' +
    '\n- delete（删除文件）：删除文件' +
    '\n- upload（上传文件）：上传本地文件到云空间。提供 file_path（本地文件路径）或 file_content_base64（Base64 编码）' +
    '\n- download（下载文件）：下载文件到本地。提供 output_path（本地保存路径）则保存到本地，否则返回 Base64 编码' +
    '\n\n【重要】copy/move/delete 操作需要 file_token 和 type 参数。get_meta 使用 request_docs 数组参数。' +
    '\n【重要】upload 优先使用 file_path（自动读取文件、提取文件名和大小），也支持 file_content_base64（需手动提供 file_name 和 size）。' +
    '\n【重要】download 提供 output_path 时保存到本地（可以是文件路径或文件夹路径+file_name），不提供则返回 Base64。',
  schema: FeishuDriveFileSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as FeishuDriveFileParams;
    try {
      const client = getLarkClient();

      switch (p.action) {
        // LIST FILES
        case 'list': {
          const res = await client.drive.file.list({
            params: {
              folder_token: p.folder_token as any,
              page_size: p.page_size as any,
              page_token: p.page_token,
              order_by: p.order_by as any,
              direction: p.direction as any,
            },
          });
          assertLarkOk(res);

          const data = res.data as DriveFileListData | undefined;
          return json({
            files: data?.files,
            has_more: data?.has_more,
            page_token: data?.next_page_token,
          });
        }

        // GET META
        case 'get_meta': {
          if (!p.request_docs || !Array.isArray(p.request_docs) || p.request_docs.length === 0) {
            return json({
              error:
                "request_docs must be a non-empty array. Correct format: {action: 'get_meta', request_docs: [{doc_token: '...', doc_type: 'sheet'}]}",
            });
          }

          const res = await client.drive.meta.batchQuery({
            data: { request_docs: p.request_docs as any },
          });
          assertLarkOk(res);

          return json({
            metas: res.data?.metas ?? [],
          });
        }

        // COPY FILE
        case 'copy': {
          const targetFolderToken = p.folder_token || p.parent_node;

          const res = await client.drive.file.copy({
            path: { file_token: p.file_token },
            data: {
              name: p.name,
              type: p.type as any,
              folder_token: targetFolderToken as any,
            },
          });
          assertLarkOk(res);

          const data = res.data as DriveFileData | undefined;
          return json({ file: data?.file });
        }

        // MOVE FILE
        case 'move': {
          const res = await client.drive.file.move({
            path: { file_token: p.file_token },
            data: {
              type: p.type as any,
              folder_token: p.folder_token,
            },
          });
          assertLarkOk(res);

          const data = res.data as DriveTaskData | undefined;
          return json({
            success: true,
            task_id: data?.task_id,
            file_token: p.file_token,
            target_folder_token: p.folder_token,
          });
        }

        // DELETE FILE
        case 'delete': {
          const res = await client.drive.file.delete({
            path: { file_token: p.file_token },
            params: { type: p.type as any },
          });
          assertLarkOk(res);

          const data = res.data as DriveTaskData | undefined;
          return json({
            success: true,
            task_id: data?.task_id,
            file_token: p.file_token,
          });
        }

        // UPLOAD FILE
        case 'upload': {
          let fileBuffer: Buffer;
          let fileName: string;
          let fileSize: number;

          if (p.file_path) {
            try {
              fileBuffer = await fs.readFile(p.file_path);
              fileName = p.file_name || path.basename(p.file_path);
              fileSize = p.size || fileBuffer.length;
            } catch (err) {
              return json({
                error: `failed to read local file: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          } else if (p.file_content_base64) {
            if (!p.file_name || !p.size) {
              return json({ error: 'file_name and size are required when using file_content_base64' });
            }
            fileBuffer = Buffer.from(p.file_content_base64, 'base64');
            fileName = p.file_name;
            fileSize = p.size;
          } else {
            return json({ error: 'either file_path or file_content_base64 is required' });
          }

          if (fileSize <= SMALL_FILE_THRESHOLD) {
            // Small file: single upload
            const res: any = await client.drive.file.uploadAll({
              data: {
                file_name: fileName,
                parent_type: 'explorer' as any,
                parent_node: p.parent_node || '',
                size: fileSize,
                file: fileBuffer as any,
              },
            });
            assertLarkOk(res);

            return json({
              file_token: res.data?.file_token,
              file_name: fileName,
              size: fileSize,
            });
          } else {
            // Large file: chunked upload
            // 1. Prepare
            const prepareRes: any = await client.drive.file.uploadPrepare({
              data: {
                file_name: fileName,
                parent_type: 'explorer' as any,
                parent_node: p.parent_node || '',
                size: fileSize,
              },
            });

            if (!prepareRes) {
              return json({ error: 'pre-upload failed: empty response' });
            }
            assertLarkOk(prepareRes);

            const { upload_id, block_size, block_num } = prepareRes.data;

            // 2. Upload chunks
            for (let seq = 0; seq < block_num; seq++) {
              const start = seq * block_size;
              const end = Math.min(start + block_size, fileSize);
              const chunkBuffer = fileBuffer.subarray(start, end);

              await client.drive.file.uploadPart({
                data: {
                  upload_id: String(upload_id),
                  seq: Number(seq),
                  size: Number(chunkBuffer.length),
                  file: chunkBuffer,
                },
              });
            }

            // 3. Finish
            const finishRes: any = await client.drive.file.uploadFinish({
              data: { upload_id, block_num },
            });
            assertLarkOk(finishRes);

            return json({
              file_token: finishRes.data?.file_token,
              file_name: fileName,
              size: fileSize,
              upload_method: 'chunked',
              chunks_uploaded: block_num,
            });
          }
        }

        // DOWNLOAD FILE
        case 'download': {
          const res: any = await client.drive.file.download({
            path: { file_token: p.file_token },
          });

          const stream = res.getReadableStream();
          const chunks: Buffer[] = [];
          for await (const chunk of stream) {
            chunks.push(chunk);
          }
          const fileBuffer = Buffer.concat(chunks);

          if (p.output_path) {
            try {
              await fs.mkdir(path.dirname(p.output_path), { recursive: true });
              await fs.writeFile(p.output_path, fileBuffer);
              return json({ saved_path: p.output_path, size: fileBuffer.length });
            } catch (err) {
              return json({
                error: `failed to save file: ${err instanceof Error ? err.message : String(err)}`,
              });
            }
          } else {
            const base64Content = fileBuffer.toString('base64');
            return json({ file_content_base64: base64Content, size: fileBuffer.length });
          }
        }
      }
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 2. feishu_doc_comments — document comment management
// ===========================================================================

const ReplyElementSchema = Type.Object({
  type: Type.Union([Type.Literal('text'), Type.Literal('mention'), Type.Literal('link')]),
  text: Type.Optional(Type.String({ description: '文本内容(type=text时必填)' })),
  open_id: Type.Optional(Type.String({ description: '被@用户的open_id(type=mention时必填)' })),
  url: Type.Optional(Type.String({ description: '链接URL(type=link时必填)' })),
});

const DocCommentsSchema = Type.Object({
  action: Type.Union([Type.Literal('list'), Type.Literal('create'), Type.Literal('patch')]),
  file_token: Type.String({
    description: '云文档token或wiki节点token(可从文档URL获取)。如果是wiki token，会自动转换为实际文档的obj_token',
  }),
  file_type: Type.Union(
    [
      Type.Literal('doc'), Type.Literal('docx'), Type.Literal('sheet'),
      Type.Literal('file'), Type.Literal('slides'), Type.Literal('wiki'),
    ],
    { description: '文档类型。wiki类型会自动解析为实际文档类型(docx/sheet/bitable等)' },
  ),
  is_whole: Type.Optional(Type.Boolean({ description: '是否只获取全文评论(action=list时可选)' })),
  is_solved: Type.Optional(Type.Boolean({ description: '是否只获取已解决的评论(action=list时可选)' })),
  page_size: Type.Optional(Type.Integer({ description: '分页大小' })),
  page_token: Type.Optional(Type.String({ description: '分页标记' })),
  elements: Type.Optional(
    Type.Array(ReplyElementSchema, {
      description: '评论内容元素数组(action=create时必填)。支持text(纯文本)、mention(@用户)、link(超链接)三种类型',
    }),
  ),
  comment_id: Type.Optional(Type.String({ description: '评论ID(action=patch时必填)' })),
  is_solved_value: Type.Optional(Type.Boolean({ description: '解决状态:true=解决,false=恢复(action=patch时必填)' })),
  user_id_type: Type.Optional(Type.Union([Type.Literal('open_id'), Type.Literal('union_id'), Type.Literal('user_id')])),
});

interface ReplyElement {
  type: 'text' | 'mention' | 'link';
  text?: string;
  open_id?: string;
  url?: string;
}

interface DocCommentsParams {
  action: 'list' | 'create' | 'patch';
  file_token: string;
  file_type: 'doc' | 'docx' | 'sheet' | 'file' | 'slides' | 'wiki';
  is_whole?: boolean;
  is_solved?: boolean;
  page_size?: number;
  page_token?: string;
  elements?: ReplyElement[];
  comment_id?: string;
  is_solved_value?: boolean;
  user_id_type?: 'open_id' | 'union_id' | 'user_id';
}

function convertElementsToSDKFormat(elements: ReplyElement[]) {
  return elements.map((el) => {
    if (el.type === 'text') {
      return { type: 'text_run', text_run: { text: el.text! } };
    } else if (el.type === 'mention') {
      return { type: 'person', person: { user_id: el.open_id! } };
    } else if (el.type === 'link') {
      return { type: 'docs_link', docs_link: { url: el.url! } };
    }
    return { type: 'text_run', text_run: { text: '' } };
  });
}

async function assembleCommentsWithReplies(
  client: any,
  file_token: string,
  file_type: string,
  comments: any[],
  user_id_type: string,
) {
  const result = [];

  for (const comment of comments) {
    const assembled: any = { ...comment };

    if (comment.reply_list?.replies?.length > 0 || comment.has_more) {
      try {
        const replies: any[] = [];
        let pageToken: string | undefined = undefined;
        let hasMore = true;

        while (hasMore) {
          const replyRes = await client.drive.v1.fileCommentReply.list({
            path: { file_token, comment_id: comment.comment_id },
            params: {
              file_type,
              page_token: pageToken,
              page_size: 50,
              user_id_type,
            },
          });

          const replyData = replyRes.data as CommentReplyListData | undefined;
          if ((replyRes as any).code === 0 && replyData?.items) {
            replies.push(...(replyData.items || []));
            hasMore = replyData.has_more || false;
            pageToken = replyData.page_token;
          } else {
            break;
          }
        }

        assembled.reply_list = { replies };
      } catch {
        // Keep original reply data on error
      }
    }

    result.push(assembled);
  }

  return result;
}

const feishuDocComments = {
  name: 'feishu_doc_comments',
  description:
    '【以用户身份】管理云文档评论。支持: ' +
    '(1) list - 获取评论列表(含完整回复); ' +
    '(2) create - 添加全文评论(支持文本、@用户、超链接); ' +
    '(3) patch - 解决/恢复评论。' +
    '支持 wiki token。',
  schema: DocCommentsSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as DocCommentsParams;
    try {
      const client = getLarkClient();
      const userIdType = p.user_id_type || 'open_id';

      // Convert wiki token to actual obj_token if needed
      let actualFileToken = p.file_token;
      let actualFileType: string = p.file_type;

      if (p.file_type === 'wiki') {
        try {
          const wikiNodeRes = await client.wiki.space.getNode({
            params: { token: p.file_token, obj_type: 'wiki' as any },
          });
          assertLarkOk(wikiNodeRes as any);

          const node = (wikiNodeRes as any).data?.node;
          if (!node || !node.obj_token || !node.obj_type) {
            return json({
              error: `failed to resolve wiki token "${p.file_token}" to document object (may be a folder node rather than a document)`,
              wiki_node: node,
            });
          }

          actualFileToken = node.obj_token;
          actualFileType = node.obj_type;
        } catch (err) {
          return json({ error: `failed to resolve wiki token "${p.file_token}": ${err}` });
        }
      }

      // Action: list
      if (p.action === 'list') {
        const res = await (client.drive as any).v1.fileComment.list({
          path: { file_token: actualFileToken },
          params: {
            file_type: actualFileType,
            is_whole: p.is_whole,
            is_solved: p.is_solved,
            page_size: p.page_size || 50,
            page_token: p.page_token,
            user_id_type: userIdType,
          },
        });
        assertLarkOk(res as any);

        const items = ((res as any).data as any)?.items || [];

        const assembledItems = await assembleCommentsWithReplies(
          client,
          actualFileToken,
          actualFileType,
          items,
          userIdType,
        );

        return json({
          items: assembledItems,
          has_more: ((res as any).data as any)?.has_more ?? false,
          page_token: ((res as any).data as any)?.page_token,
        });
      }

      // Action: create
      if (p.action === 'create') {
        if (!p.elements || p.elements.length === 0) {
          return json({ error: 'elements 参数必填且不能为空' });
        }

        const sdkElements = convertElementsToSDKFormat(p.elements);

        const res = await (client.drive as any).v1.fileComment.create({
          path: { file_token: actualFileToken },
          params: { file_type: actualFileType, user_id_type: userIdType },
          data: {
            reply_list: {
              replies: [{ content: { elements: sdkElements } }],
            },
          },
        });
        assertLarkOk(res as any);

        return json((res as any).data);
      }

      // Action: patch
      if (p.action === 'patch') {
        if (!p.comment_id) {
          return json({ error: 'comment_id 参数必填' });
        }
        if (p.is_solved_value === undefined) {
          return json({ error: 'is_solved_value 参数必填' });
        }

        const res = await (client.drive as any).v1.fileComment.patch({
          path: { file_token: actualFileToken, comment_id: p.comment_id },
          params: { file_type: actualFileType },
          data: { is_solved: p.is_solved_value },
        });
        assertLarkOk(res as any);

        return json({ success: true });
      }

      return json({ error: `未知的 action: ${p.action}` });
    } catch (err) {
      return formatToolError(err);
    }
  },
};

// ===========================================================================
// 3. feishu_doc_media — document media management (download only)
//    Note: insert action omitted because it depends on openclaw-specific
//    imports (validateLocalMediaRoots, imageSize). Only download is ported.
// ===========================================================================

const DocMediaSchema = Type.Object({
  action: Type.Literal('download'),
  resource_token: Type.String({
    description: '资源的唯一标识（file_token 用于文档素材，whiteboard_id 用于画板）',
  }),
  resource_type: Type.Union([Type.Literal('media'), Type.Literal('whiteboard')], {
    description: '资源类型：media（文档素材：图片、视频、文件等）或 whiteboard（画板缩略图）',
  }),
  output_path: Type.String({
    description:
      '保存文件的完整本地路径。可以包含扩展名（如 /tmp/image.png），' +
      '也可以不带扩展名，系统会根据 Content-Type 自动添加',
  }),
});

interface DocMediaDownloadParams {
  action: 'download';
  resource_token: string;
  resource_type: 'media' | 'whiteboard';
  output_path: string;
}

const feishuDocMedia = {
  name: 'feishu_doc_media',
  description:
    '【以用户身份】文档媒体管理工具。' +
    '支持下载文档素材或画板缩略图到本地（需要资源 token + 输出路径）。',
  schema: DocMediaSchema,
  async handler(params: unknown): Promise<ToolResult> {
    const p = params as DocMediaDownloadParams;
    try {
      const client = getLarkClient();

      let res: any;
      if (p.resource_type === 'media') {
        res = await (client.drive as any).v1.media.download({ path: { file_token: p.resource_token } });
      } else {
        res = await (client.board as any).v1.whiteboard.downloadAsImage({
          path: { whiteboard_id: p.resource_token },
        });
      }

      const stream = res.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);

      // Determine extension from Content-Type
      const contentType: string = res.headers?.['content-type'] || '';
      let finalPath = p.output_path;
      const currentExt = path.extname(p.output_path);

      if (!currentExt && contentType) {
        const mimeType = contentType.split(';')[0].trim();
        const defaultExt = p.resource_type === 'whiteboard' ? '.png' : undefined;
        const suggestedExt = MIME_TO_EXT[mimeType] || defaultExt;
        if (suggestedExt) {
          finalPath = p.output_path + suggestedExt;
        }
      }

      await fs.mkdir(path.dirname(finalPath), { recursive: true });

      try {
        await fs.writeFile(finalPath, buffer);
      } catch (err) {
        return json({
          error: `failed to save file: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return json({
        resource_type: p.resource_type,
        resource_token: p.resource_token,
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

export const driveTools = [feishuDriveFile, feishuDocComments, feishuDocMedia];
