import type { StreamEvent } from './stream.js';

export type AnthropicContentBlock =
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };

export interface AnthropicUsage { input_tokens: number; output_tokens: number }

interface AnthropicMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export function formatAnthropicNonStream(
  msgId: string,
  model: string,
  content: AnthropicContentBlock[],
  stopReason = 'end_turn',
  usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 },
): AnthropicMessage {
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  };
}

// Streaming SSE events for Anthropic format

export function formatMessageStart(msgId: string, model: string, inputTokens = 0): string {
  const data = {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 },
    },
  };
  return `event: message_start\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatContentBlockStart(
  index: number,
  block: AnthropicContentBlock = { type: 'text', text: '' },
): string {
  const data = { type: 'content_block_start', index, content_block: block };
  return `event: content_block_start\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatContentBlockDelta(index: number, text: string): string {
  const data = {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  };
  return `event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatThinkingDelta(index: number, thinking: string): string {
  const data = {
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
  };
  return `event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatInputJsonDelta(index: number, partialJson: string): string {
  const data = {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partialJson },
  };
  return `event: content_block_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatContentBlockStop(index: number): string {
  const data = { type: 'content_block_stop', index };
  return `event: content_block_stop\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatMessageDelta(stopReason: string, usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 }): string {
  const data = {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  };
  return `event: message_delta\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatMessageStop(): string {
  return `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
}

export function formatPing(): string {
  return `event: ping\ndata: {"type":"ping"}\n\n`;
}

export function streamEventToStopReason(event: StreamEvent): string | null {
  if (event.type !== 'done') return null;
  if (event.reason === 'stop') return 'end_turn';
  if (event.reason === 'length') return 'max_tokens';
  if (event.reason === 'tool_use') return 'tool_use';
  return 'end_turn';
}
