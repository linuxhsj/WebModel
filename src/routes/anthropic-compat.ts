import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { ProviderRegistry } from '../core/registry.js';
import {
  formatAnthropicNonStream,
  formatMessageStart,
  formatContentBlockStart,
  formatContentBlockDelta,
  formatThinkingDelta,
  formatContentBlockStop,
  formatInputJsonDelta,
  formatMessageDelta,
  formatMessageStop,
  formatPing,
  streamEventToStopReason,
  type AnthropicContentBlock,
} from '../core/anthropic-formatter.js';
import { dsmlShape, parseToolCalls, renderToolCalls } from '../core/tool-protocol.js';
import { ProviderQueue } from '../core/queue.js';
import { setTimeout as sleep } from 'node:timers/promises';
import { AuthRequiredError, InvalidBodyError, errorToHttpResponse } from '../core/errors.js';
import { buildWebPrompt, estimateTokens, type Message, type ToolDef } from '../core/provider.js';

/** Cooldown when the provider answers "too frequent"; exported for tests. */
export const rateLimitPacing = { firstWaitMs: 5_000, maxWaitMs: 180_000 };

export function anthropicRoutes(registry: ProviderRegistry): Hono {
  const app = new Hono();
  const queue = new ProviderQueue();

  app.post('/v1/messages', async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      const res = errorToHttpResponse(new InvalidBodyError('invalid JSON'));
      return c.json(res.body, res.status as any);
    }

    if (!body.model || typeof body.model !== 'string') {
      const res = errorToHttpResponse(new InvalidBodyError('missing model field'));
      return c.json(res.body, res.status as any);
    }

    if (!body.messages || !Array.isArray(body.messages)) {
      const res = errorToHttpResponse(new InvalidBodyError('missing messages field'));
      return c.json(res.body, res.status as any);
    }

    // Resolve provider from model ID
    let resolved;
    try {
      resolved = await registry.resolve(body.model);
    } catch (err) {
      const res = errorToHttpResponse(err as Error);
      return c.json(res.body, res.status as any);
    }

    const { provider, model } = resolved;

    if (!(await provider.isAuthenticated())) {
      const res = errorToHttpResponse(new AuthRequiredError(provider.info.id));
      return c.json(res.body, res.status as any);
    }

    const { messages, tools } = toChatInput(body);
    // Claude Code asks for extended thinking per request; web providers have it as a mode.
    const wantThinking = ['enabled', 'adaptive'].includes(body.thinking?.type);

    const msgId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Claude Code times out or the user cancels; the shared browser tab is the scarce
    // resource, so abandoned work must stop instead of sending more prompts.
    const signal = c.req.raw.signal;
    const disconnected = () =>
      c.json({ type: 'error', error: { type: 'api_error', message: 'client disconnected' } }, 499 as any);

    async function attempt() {
      let text = '';
      let thinking = '';
      let error: string | null = null;
      let code: string | undefined;
      let stopReason = 'end_turn';
      if (signal.aborted) return { text, thinking, error: 'client disconnected', code: 'aborted', stopReason };
      try {
        for await (const event of provider.chat({ model, messages, tools, thinking: wantThinking, stream: body.stream === true, signal })) {
          if (event.type === 'text_delta') text += event.delta;
          else if (event.type === 'thinking_delta') thinking += event.delta;
          else if (event.type === 'error') { error = event.message; code = event.code; }
          else if (event.type === 'done') stopReason = streamEventToStopReason(event) ?? 'end_turn';
        }
      } catch (err) {
        error = (err as Error).message;
      }
      return { text, thinking, error, code, stopReason };
    }

    const failed = (r: Awaited<ReturnType<typeof attempt>>) => r.error && !r.text && !r.thinking;

    // DeepSeek answers "Messages too frequent" when messages come too close together.
    // Waiting inside the lane also holds back every queued request (other subagents);
    // a 429 at once let each agent retry on its own and hit the limit again.
    async function paced() {
      for (let wait = rateLimitPacing.firstWaitMs, waited = 0; ; waited += wait, wait *= 2) {
        const r = await attempt();
        if (signal.aborted) return r;
        if (!(failed(r) && r.code === 'upstream_rate_limit') || waited + wait > rateLimitPacing.maxWaitMs) return r;
        console.warn(`[${provider.info.id}] ${new Date().toISOString()} rate limited, retrying in ${wait / 1000}s`);
        // Abort cuts the cooldown so the lane is released to the next request.
        try { await sleep(wait, undefined, { signal }); } catch { return r; }
      }
    }

    // Web providers drive one shared browser tab, so requests run one at a time;
    // a single retry absorbs transient tab errors (e.g. a navigation mid-request).
    const run = () => queue.enqueue(provider.info.id, paced);
    let reply = await run();
    if (signal.aborted) return disconnected();
    if (failed(reply) && reply.code !== 'upstream_rate_limit') reply = await run();
    if (signal.aborted) return disconnected();

    // Nothing usable: answer like the real API does, so Claude Code retries
    // instead of treating the error as the assistant's message.
    if (failed(reply)) {
      const limited = reply.code === 'upstream_rate_limit';
      return c.json(
        { type: 'error', error: { type: limited ? 'rate_limit_error' : 'api_error', message: reply.error } },
        (limited ? 429 : 502) as any,
      );
    }

    let parsed = parseToolCalls(reply.text);
    if (parsed.malformed) {
      // DeepSeek garbled 4 of 336 tool-call blocks on 2026-10-18; ask once more rather than end the turn.
      const garbled = (what: string) => console.warn(
        `[${provider.info.id}] ${new Date().toISOString()} ${what} (${parsed.calls.length} calls): ${dsmlShape(reply.text)}`);
      garbled('garbled tool-call block, asking again');
      if (signal.aborted) return disconnected();
      const again = await run();
      if (!failed(again)) { reply = again; parsed = parseToolCalls(again.text); }
      if (parsed.malformed) garbled('still garbled');
    }
    const prose = parsed.text + (reply.error ? `\n\nError: ${reply.error}` : '');
    const blocks: AnthropicContentBlock[] = [
      ...(reply.thinking ? [{ type: 'thinking' as const, thinking: reply.thinking, signature: '' }] : []),
      ...(prose ? [{ type: 'text' as const, text: prose }] : []),
      ...parsed.calls.map(call => ({
        type: 'tool_use' as const,
        id: `toolu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
        name: call.name,
        input: call.input,
      })),
    ];
    if (!blocks.some(b => b.type !== 'thinking')) blocks.push({ type: 'text', text: '' });
    // Cut off or still garbled: max_tokens makes Claude Code ask the model to resume
    // instead of ending the turn on a call that never ran.
    const stopReason = parsed.calls.length ? 'tool_use' : parsed.truncated || parsed.malformed ? 'max_tokens' : reply.stopReason;

    // What the web model really received and produced, so Claude Code's context meter and auto-compact work.
    const usage = {
      input_tokens: estimateTokens(buildWebPrompt(messages, tools)),
      output_tokens: estimateTokens(reply.thinking, reply.text),
    };

    // chisle: the whole reply is buffered so tool-call blocks can be parsed out
    // before emitting; incremental DSML detection only if streaming latency matters.
    if (body.stream === true) {
      c.header('Content-Type', 'text/event-stream');
      c.header('Cache-Control', 'no-cache');
      c.header('Connection', 'keep-alive');

      return stream(c, async (s) => {
        await s.write(formatMessageStart(msgId, body.model, usage.input_tokens));
        await s.write(formatPing());
        for (const [i, block] of blocks.entries()) {
          if (block.type === 'thinking') {
            await s.write(formatContentBlockStart(i, { ...block, thinking: '' }));
            await s.write(formatThinkingDelta(i, block.thinking));
          } else if (block.type === 'text') {
            await s.write(formatContentBlockStart(i));
            await s.write(formatContentBlockDelta(i, block.text));
          } else {
            await s.write(formatContentBlockStart(i, { ...block, input: {} }));
            await s.write(formatInputJsonDelta(i, JSON.stringify(block.input)));
          }
          await s.write(formatContentBlockStop(i));
        }
        await s.write(formatMessageDelta(stopReason, usage));
        await s.write(formatMessageStop());
      });
    }

    return c.json(formatAnthropicNonStream(msgId, body.model, blocks, stopReason, usage));
  });

  // Claude Code sizes its context with this; no provider involved.
  app.post('/v1/messages/count_tokens', async (c) => {
    const body: any = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.messages)) {
      const res = errorToHttpResponse(new InvalidBodyError('missing messages field'));
      return c.json(res.body, res.status as any);
    }
    const { messages, tools } = toChatInput(body);
    return c.json({ input_tokens: estimateTokens(buildWebPrompt(messages, tools)) });
  });

  return app;
}

/** tool_use id → its number in the conversation and tool name; results quote both. */
type CallIndex = Map<string, { n: number; name: string }>;

/** Anthropic request body → the messages and tools every provider consumes. */
function toChatInput(body: any): { messages: Message[]; tools: ToolDef[] } {
  const messages: Message[] = [];
  const systemText = typeof body.system === 'string'
    ? body.system
    : Array.isArray(body.system) ? body.system.map((b: any) => blockToText(b)).join('\n\n') : '';
  if (systemText) messages.push({ role: 'system', content: systemText });
  // Calls precede their results, so one pass numbers both.
  const calls: CallIndex = new Map();
  for (const msg of body.messages) {
    messages.push({ role: msg.role, content: messageToText(msg.content, calls) });
  }
  // Always set (maybe empty) so providers build the full agent transcript.
  const tools: ToolDef[] = (Array.isArray(body.tools) ? body.tools : [])
    .filter((t: any) => t?.name)
    .map((t: any) => ({
      type: 'function',
      function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? {} },
    }));
  return { messages, tools };
}

/** Flatten one Anthropic content block into transcript text (tool round trips included). */
function blockToText(block: any, calls?: CallIndex): string {
  if (typeof block === 'string') return block;
  if (block?.type === 'text') return block.text ?? '';
  if (block?.type === 'tool_result') {
    const content = typeof block.content === 'string'
      ? block.content
      : Array.isArray(block.content) ? block.content.map((b: any) => blockToText(b)).join('\n') : '';
    const call = calls?.get(block.tool_use_id);
    const ref = call ? ` call="${call.n}" name="${call.name}"` : '';
    const err = block.is_error ? ' is_error="true"' : '';
    return `<tool_result${ref}${err}>\n${content}\n</tool_result>`;
  }
  if (block?.type === 'image' || block?.type === 'document') return `[${block.type} omitted]`;
  return ''; // thinking, redacted_thinking, etc.
}

function messageToText(content: unknown, index: CallIndex): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const calls = content
    .filter((b: any) => b?.type === 'tool_use')
    .map((b: any) => {
      const call = index.size + 1;
      index.set(b.id, { n: call, name: b.name });
      return { name: b.name, input: b.input ?? {}, call };
    });
  const text = content.map((b: any) => blockToText(b, index)).filter(Boolean).join('\n\n');
  return calls.length ? [text, renderToolCalls(calls)].filter(Boolean).join('\n\n') : text;
}
