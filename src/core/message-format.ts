/**
 * Simplified message content formatter.
 * Converts Lark IM API message content to human-readable text.
 *
 * Handles all common message types: text, post, image, file, audio, media,
 * sticker, share_chat, share_user, interactive (cards), merge_forward, system.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { millisStringToDateTime } from './time-utils.js';

// ---------------------------------------------------------------------------
// Message content formatting
// ---------------------------------------------------------------------------

export function formatMessageContent(
  msgType: string,
  rawContent: string,
): string {
  if (!rawContent) return '';

  try {
    const content = JSON.parse(rawContent);

    switch (msgType) {
      case 'text':
        return content.text ?? rawContent;

      case 'post': {
        const lang =
          content.zh_cn ||
          content.en_us ||
          content.ja_jp ||
          Object.values(content)[0];
        if (!lang || typeof lang !== 'object') return rawContent;
        const title = (lang as any).title || '';
        const body = ((lang as any).content || [])
          .flat()
          .map((el: any) => {
            if (el.tag === 'text') return el.text;
            if (el.tag === 'a') return `[${el.text}](${el.href})`;
            if (el.tag === 'at')
              return `@${el.user_name || el.user_id || 'unknown'}`;
            if (el.tag === 'img') return '[Image]';
            if (el.tag === 'media') return '[Media]';
            return '';
          })
          .join('');
        return title ? `${title}\n${body}` : body;
      }

      case 'image':
        return `[Image: ${content.image_key || 'unknown'}]`;

      case 'file':
        return `[File: ${content.file_name || content.file_key || 'unknown'}]`;

      case 'audio':
        return `[Audio: ${content.file_key || 'unknown'}]`;

      case 'media':
        return `[Video: ${content.file_name || content.file_key || 'unknown'}]`;

      case 'sticker':
        return `[Sticker: ${content.file_key || 'unknown'}]`;

      case 'share_chat':
        return `[Share Chat: ${content.chat_id || 'unknown'}]`;

      case 'share_user':
        return `[Share User: ${content.user_id || 'unknown'}]`;

      case 'system':
        return content.text || '[System Message]';

      case 'interactive':
        return formatCardContent(content);

      case 'merge_forward':
        return '[Merge Forward Message]';

      default:
        return rawContent;
    }
  } catch {
    return rawContent;
  }
}

function formatCardContent(content: any): string {
  const parts: string[] = [];

  if (content.header?.title?.content) {
    parts.push(content.header.title.content);
  }

  if (content.elements) {
    for (const el of content.elements) {
      if (el.tag === 'div' && el.text?.content) {
        parts.push(el.text.content);
      } else if (el.tag === 'markdown' && el.content) {
        parts.push(el.content);
      } else if (el.tag === 'note') {
        const noteTexts = (el.elements || [])
          .filter((n: any) => n.tag === 'plain_text' || n.tag === 'lark_md')
          .map((n: any) => n.content)
          .filter(Boolean);
        if (noteTexts.length) parts.push(noteTexts.join(' '));
      }
    }
  }

  return parts.length ? parts.join('\n') : '[Interactive Card]';
}

// ---------------------------------------------------------------------------
// Format a raw message item from Lark IM API into AI-readable structure
// ---------------------------------------------------------------------------

export interface FormattedMessage {
  message_id: string;
  msg_type: string;
  content: string;
  sender: { id: string; sender_type: string; name?: string };
  create_time: string;
  reply_to?: string;
  thread_id?: string;
  mentions?: Array<{ key: string; id: string; name: string }>;
  deleted: boolean;
  updated: boolean;
}

/**
 * Format a single message item from the Lark IM API.
 */
export function formatMessageItem(
  item: any,
  nameResolver?: (openId: string) => string | undefined,
): FormattedMessage {
  const messageId: string = item.message_id ?? '';
  const msgType: string = item.msg_type ?? 'unknown';

  // Parse content
  const rawContent: string = item.body?.content ?? '';
  const content = formatMessageContent(msgType, rawContent);

  // Build sender
  const senderId: string = item.sender?.id ?? '';
  const senderType: string = item.sender?.sender_type ?? 'unknown';
  const sender: FormattedMessage['sender'] = {
    id: senderId,
    sender_type: senderType,
  };
  if (senderId && senderType === 'user' && nameResolver) {
    const name = nameResolver(senderId);
    if (name) sender.name = name;
  }

  // Build mentions
  let mentions: FormattedMessage['mentions'];
  if (item.mentions?.length) {
    mentions = item.mentions.map((m: any) => ({
      key: m.key ?? '',
      id: m.id ?? '',
      name: m.name ?? '',
    }));
  }

  // Convert create_time (Lark API returns millisecond timestamp string)
  const createTime = item.create_time
    ? millisStringToDateTime(item.create_time)
    : '';

  const formatted: FormattedMessage = {
    message_id: messageId,
    msg_type: msgType,
    content,
    sender,
    create_time: createTime,
    deleted: item.deleted ?? false,
    updated: item.updated ?? false,
  };

  // Optional fields: thread_id takes precedence over reply_to
  if (item.thread_id) {
    formatted.thread_id = item.thread_id;
  } else if (item.parent_id) {
    formatted.reply_to = item.parent_id;
  }
  if (mentions) {
    formatted.mentions = mentions;
  }

  return formatted;
}

/**
 * Batch format message items with user name resolution.
 */
export async function formatMessageList(
  items: any[],
  resolveNames: (openIds: string[]) => Promise<Map<string, string>>,
): Promise<FormattedMessage[]> {
  // 1. Seed name cache from mentions (free info)
  const nameCache = new Map<string, string>();
  for (const item of items) {
    for (const m of item.mentions ?? []) {
      if (m.id && m.name) {
        nameCache.set(m.id, m.name);
      }
    }
  }

  // 2. Collect user sender IDs needing resolution
  const senderIds = [
    ...new Set(
      items
        .map((item) =>
          item.sender?.sender_type === 'user' ? item.sender.id : undefined,
        )
        .filter((id): id is string => !!id && !nameCache.has(id)),
    ),
  ];

  // 3. Batch resolve missing names
  if (senderIds.length > 0) {
    try {
      const resolved = await resolveNames(senderIds);
      for (const [id, name] of resolved) {
        nameCache.set(id, name);
      }
    } catch {
      // Best-effort — continue without names
    }
  }

  // 4. Format each message
  const nameResolver = (id: string) => nameCache.get(id);
  return items.map((item) => formatMessageItem(item, nameResolver));
}
