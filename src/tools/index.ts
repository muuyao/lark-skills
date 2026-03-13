/**
 * Tool registry — aggregates all tool modules.
 */

import type { ToolResult } from '../core/helpers.js';
import type { TSchema } from '@sinclair/typebox';

export interface ToolDefinition {
  name: string;
  description: string;
  schema: TSchema;
  handler: (params: unknown) => Promise<ToolResult>;
}

export async function getAllTools(): Promise<ToolDefinition[]> {
  const { taskTools } = await import('./task.js');
  const { calendarTools } = await import('./calendar.js');
  const { bitableTools } = await import('./bitable.js');
  const { imTools } = await import('./im.js');
  const { sheetsTools } = await import('./sheets.js');
  const { driveTools } = await import('./drive.js');
  const { docTools } = await import('./doc.js');
  const { wikiTools } = await import('./wiki.js');
  const { searchTools } = await import('./search.js');
  const { commonTools } = await import('./common.js');
  const { chatTools } = await import('./chat.js');

  return [
    ...taskTools,
    ...calendarTools,
    ...bitableTools,
    ...imTools,
    ...sheetsTools,
    ...driveTools,
    ...docTools,
    ...wikiTools,
    ...searchTools,
    ...commonTools,
    ...chatTools,
  ];
}
