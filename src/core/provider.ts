import type { StreamEvent } from './stream.js';
import { renderToolsPrompt } from './tool-protocol.js';

export interface ProviderInfo {
  id: string;
  name: string;
  website: string;
  loginUrl: string;
  needsBrowser: boolean;
}

export interface ModelInfo {
  id: string;
  name: string;
  contextWindow: number;
  maxOutput: number;
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
}

export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatRequest {
  model: string;
  messages: Message[];
  stream: boolean;
  tools?: ToolDef[];
  /** Client asked for extended thinking (Anthropic `thinking` enabled/adaptive). */
  thinking?: boolean;
  signal?: AbortSignal;
}

export abstract class BaseProvider {
  abstract readonly info: ProviderInfo;

  abstract login(context: { openUrl: (url: string) => Promise<void> }): Promise<void>;
  abstract isAuthenticated(): Promise<boolean>;
  abstract detectLoginComplete(): Promise<boolean>;
  abstract models(): Promise<ModelInfo[]>;
  abstract chat(req: ChatRequest): AsyncIterable<StreamEvent>;
}

// Script-aware estimate: Latin runs ~0.3 tokens per char (chars/4 is within 20%
// of a real BPE tokenizer), but CJK and Hangul are ~0.6 per char, so chars/4
// halved every Chinese or Korean reply and Claude Code's meter read half the cost.
// ponytail: heuristic, not a tokenizer; swap in one if the count must be exact.
const CJK = /[\u1100-\u11FF\u3000-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/g;
export const estimateTokens = (...texts: string[]): number =>
  Math.ceil(texts.reduce((n, t) => {
    const cjk = t.match(CJK)?.length ?? 0;
    return n + (t.length - cjk) / 4 + cjk * 0.6;
  }, 0));

/**
 * Extract plain text from message content, handling both string and
 * OpenAI content-block array formats.
 */
export function extractText(content: string | unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('');
  }
  return String(content ?? '');
}

/**
 * Extract the actual user prompt from OpenClaw-wrapped messages.
 *
 * OpenClaw sends messages like:
 *   system: "You are 聪聪, an AI assistant... [long agent framework boilerplate]"
 *   user: "A new session was started via /new...\n[Mon 2026-04-06 21:46 GMT+8] 你好"
 *
 * For web models we only need the real user question. Strategy:
 * 1. Drop system/tool messages (framework boilerplate, not useful for web models)
 * 2. From user messages, strip OpenClaw metadata prefixes
 * 3. Keep assistant messages for multi-turn context
 * 4. Return a clean prompt string
 */
export function buildWebPrompt(messages: Message[], tools?: ToolDef[]): string {
  // Agent clients (Anthropic route, e.g. Claude Code) always pass `tools`, maybe empty.
  // Every web request opens a fresh chat, so they need the whole transcript.
  if (tools) return buildTranscript(messages, tools);

  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'tool') continue;

    const text = extractText(msg.content);
    if (!text) continue;

    if (msg.role === 'assistant') {
      parts.push(text);
      continue;
    }

    // user message — strip OpenClaw metadata
    const cleaned = stripOpenClawMeta(text);
    if (cleaned) {
      parts.push(cleaned);
    }
  }

  // Return only the last user exchange (last user message + any preceding assistant)
  // to avoid sending the entire conversation history to web models
  return parts.length > 0 ? parts[parts.length - 1] : '';
}

function buildTranscript(messages: Message[], tools: ToolDef[]): string {
  // Leading system messages form the header; later ones (Claude Code sends hook
  // output and MCP instructions mid-conversation) stay where they were sent.
  const firstTurn = messages.findIndex(m => m.role !== 'system');
  const header = firstTurn < 0 ? messages : messages.slice(0, firstTurn);
  const turns = firstTurn < 0 ? [] : messages.slice(firstTurn);
  const system = header.map(m => extractText(m.content)).filter(Boolean).join('\n\n');
  const parts: string[] = [];
  if (system) parts.push(`<system>\n${system}\n</system>`);
  if (tools.length) parts.push(renderToolsPrompt(tools));
  parts.push('# Conversation');
  for (const msg of turns) {
    const text = extractText(msg.content);
    if (text) parts.push(`[${msg.role}]\n${text}`);
  }
  parts.push('Continue as [assistant]: write only your next assistant message.');
  return parts.join('\n\n');
}

/**
 * Strip OpenClaw framework metadata from a user message, leaving only the
 * actual human-written text.
 *
 * Handles formats like:
 *   "[Mon 2026-04-06 21:46 GMT+8] 你好"
 *   "A new session was started...\n[Mon 2026-04-06 21:46 GMT+8] 你好"
 *   "Sender (untrusted metadata):...\n[Mon 2026-04-06 21:46 GMT+8] 你好"
 */
function stripOpenClawMeta(text: string): string {
  // Pattern: [Day YYYY-MM-DD HH:MM timezone] actual message
  // The timestamp line marks where the real user input begins.
  const timestampPattern = /\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+\S+\]\s*/;
  const match = text.match(timestampPattern);
  if (match) {
    const afterTimestamp = text.slice(match.index! + match[0].length).trim();
    return afterTimestamp || text;
  }

  // Fallback pattern: lines starting with OpenClaw boilerplate keywords
  const boilerplatePatterns = [
    /^A new session was started via\b/m,
    /^Run your Session Startup sequence\b/m,
    /^Current time:/m,
    /^Sender \(untrusted metadata\):/m,
  ];
  const hasBoilerplate = boilerplatePatterns.some(p => p.test(text));
  if (hasBoilerplate) {
    // Try to find the last non-empty line as the actual message
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    // Walk backwards to find a line that's not JSON or metadata
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.startsWith('{') || line.startsWith('}') || line.startsWith('"') || line.startsWith('```')) continue;
      if (boilerplatePatterns.some(p => p.test(line))) continue;
      if (/^Current time:/i.test(line)) continue;
      return line;
    }
  }

  // No OpenClaw metadata detected — return as-is
  return text;
}

export type { StreamEvent } from './stream.js';
