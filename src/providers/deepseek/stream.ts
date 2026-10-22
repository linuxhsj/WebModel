import type { StreamEvent } from '../../core/stream.js';

/**
 * Normalize DeepSeek Web SSE events to internal StreamEvent format.
 *
 * DeepSeek Web API returns two formats:
 * 1. Web format: data: {"v":{"response":{"content":"...","thinking_content":"..."}}}
 * 2. OpenAI-like: data: {"choices":[{"delta":{"content":"..."}}]}
 */
export function normalizeDeepSeekSSE(line: string): StreamEvent[] {
  if (!line.startsWith('data: ')) return [];
  const data = line.slice(6);
  if (data === '[DONE]') return [{ type: 'done', reason: 'stop' }];

  let parsed: any;
  try {
    parsed = JSON.parse(data);
  } catch {
    return [];
  }

  const events: StreamEvent[] = [];

  // Format 1: DeepSeek Web API format
  const response = parsed?.v?.response;
  if (response) {
    if (response.status === 'DONE' || response.status === 'done') {
      events.push({ type: 'done', reason: 'stop' });
      return events;
    }

    if (response.thinking_content && response.thinking_content.length > 0) {
      events.push({ type: 'thinking_delta', delta: response.thinking_content });
    }

    if (response.content && response.content.length > 0) {
      events.push({ type: 'text_delta', delta: response.content });
    }

    return events;
  }

  // Format 2: OpenAI-like format (fallback)
  const choice = parsed.choices?.[0];
  if (!choice) return [];

  if (choice.finish_reason) {
    const reason = choice.finish_reason === 'length' ? 'length' : 'stop';
    events.push({ type: 'done', reason });
    return events;
  }

  const delta = choice.delta;
  if (!delta) return [];

  if (delta.reasoning_content) {
    events.push({ type: 'thinking_delta', delta: delta.reasoning_content });
  }

  if (delta.content && delta.content.length > 0) {
    events.push({ type: 'text_delta', delta: delta.content });
  }

  return events;
}

/**
 * Stateful parser for the DeepSeek Web chat completion stream.
 *
 * The web endpoint speaks a JSON-patch dialect instead of OpenAI chunks.
 * Frame shapes observed against chat.deepseek.com:
 *
 *   data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"He"}],"status":"WIP"}}}
 *        initial snapshot — `content` is the full accumulated text so far
 *   data: {"p":"response/fragments/-1/content","o":"APPEND","v":"llo"}
 *        incremental patch — `v` carries only the new tail
 *   data: {"v":" there"}              short form, reuses the previous path
 *   data: {"p":"response","o":"BATCH","v":[{"p":"response/status","v":"FINISHED"}]}
 *   data: {"p":"response/status","v":"FINISHED"}
 *
 * Snapshots and patches both write to the same buffer, so the parser keeps a
 * watermark of what it already emitted and slices it off snapshots instead of
 * forwarding the whole text again. The legacy `response/content` path is still
 * accepted.
 */
export class DeepSeekWebSSEParser {
  private lastPath = '';
  private textEmitted = '';
  private thinkingEmitted = '';
  private finished = false;

  /** Feed one raw SSE line and get the events it produced. */
  pushLine(line: string): StreamEvent[] {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('event:') || !trimmed.startsWith('data: ')) return [];

    const raw = trimmed.slice(6);
    if (raw === '[DONE]' || raw === '{}') return [];

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return []; // keepalive or non-JSON noise
    }

    // A whole response object — the initial snapshot, or a mid-stream refresh.
    const snapshot = parsed?.v?.response;
    if (snapshot && typeof snapshot === 'object') {
      return this.applySnapshot(snapshot);
    }

    // Batched patches: several operations in a single frame.
    if (parsed?.p === 'response' && parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
      return parsed.v.flatMap((op: any) => this.applyPatch(op));
    }

    return this.applyPatch(parsed);
  }

  /** Feed a complete SSE body at once. */
  pushText(text: string): StreamEvent[] {
    return text.split('\n').flatMap((line) => this.pushLine(line));
  }

  private applySnapshot(snapshot: any): StreamEvent[] {
    const events: StreamEvent[] = [];
    const fragments: any[] = Array.isArray(snapshot.fragments) ? snapshot.fragments : [];

    for (const frag of fragments) {
      if (frag?.type !== 'RESPONSE' || typeof frag.content !== 'string') continue;
      const delta = this.sliceNew(frag.content, this.textEmitted);
      if (delta === null) continue;
      this.textEmitted = frag.content;
      if (delta) events.push({ type: 'text_delta', delta });
    }

    for (const frag of fragments) {
      if (frag?.type !== 'THINK' || typeof frag.content !== 'string') continue;
      const delta = this.sliceNew(frag.content, this.thinkingEmitted);
      if (delta === null) continue;
      this.thinkingEmitted = frag.content;
      if (delta) events.push({ type: 'thinking_delta', delta });
    }

    events.push(...this.finishIf(snapshot.status));
    return events;
  }

  private applyPatch(patch: any): StreamEvent[] {
    if (!patch || typeof patch !== 'object') return [];

    const path: string = typeof patch.p === 'string' ? patch.p : this.lastPath;
    if (typeof patch.p === 'string') this.lastPath = patch.p;

    const value = patch.v;

    if (path === 'response/status') {
      return typeof value === 'string' ? this.finishIf(value) : [];
    }

    if (typeof value !== 'string' || value.length === 0) return [];

    // Thinking paths also end in `/content`, so they must be matched first.
    if (path.includes('thinking')) {
      this.thinkingEmitted += value;
      return [{ type: 'thinking_delta', delta: value }];
    }

    if (path === 'response/content' || path.endsWith('/content')) {
      this.textEmitted += value;
      return [{ type: 'text_delta', delta: value }];
    }

    return [];
  }

  /**
   * A snapshot holds the full text, so return only the part past the
   * watermark. Returns null when the snapshot is stale or does not extend the
   * text we already emitted (e.g. a retried branch).
   */
  private sliceNew(full: string, emitted: string): string | null {
    if (full.length < emitted.length) return null;
    if (!full.startsWith(emitted)) return null;
    return full.slice(emitted.length);
  }

  private finishIf(status: unknown): StreamEvent[] {
    if (this.finished) return [];
    if (status !== 'FINISHED' && status !== 'DONE') return [];
    this.finished = true;
    return [{ type: 'done', reason: 'stop' }];
  }
}
