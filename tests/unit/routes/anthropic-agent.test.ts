import { describe, it, expect, afterEach } from 'vitest';
import { createTestContext, type TestContext } from '../../helpers/test-server.js';
import { BaseProvider, buildWebPrompt, estimateTokens, type ChatRequest, type ModelInfo, type ProviderInfo } from '../../../src/core/provider.js';
import type { StreamEvent } from '../../../src/core/stream.js';
import { parseToolCalls } from '../../../src/core/tool-protocol.js';
import { rateLimitPacing } from '../../../src/routes/anthropic-compat.js';
import { encode } from 'gpt-tokenizer';

// Shape of what DeepSeek Web emits when it decides to call a tool (DSML).
const DSML_REPLY = [
  'Voy a ver el directorio.',
  '<｜DSML｜function_calls>',
  '<｜DSML｜invoke name="Bash">',
  '<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>',
  '<｜DSML｜parameter name="description" string="true">Print cwd</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜function_calls>',
].join('\n');

class CapturingProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'cap', name: 'Cap', website: 'https://x', loginUrl: 'https://x', needsBrowser: false,
  };
  last: ChatRequest | null = null;
  constructor(private reply: string, private thought = '') { super(); }
  async login() {}
  async isAuthenticated() { return true; }
  async detectLoginComplete() { return true; }
  async models(): Promise<ModelInfo[]> { return [{ id: 'm', name: 'm', contextWindow: 1, maxOutput: 1 }]; }
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.last = req;
    if (this.thought) yield { type: 'thinking_delta', delta: this.thought };
    yield { type: 'text_delta', delta: this.reply };
    yield { type: 'done', reason: 'stop' };
  }
}

// Minimal Claude Code-shaped request: system blocks, tools, and a prior tool round trip.
const claudeCodeBody = (stream: boolean) => ({
  model: 'cap/m',
  max_tokens: 1024,
  stream,
  system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
  tools: [{
    name: 'Bash',
    description: 'Executes a bash command',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command'],
    },
  }],
  messages: [
    { role: 'user', content: [
      { type: 'text', text: '<system-reminder>gitStatus: branch feat/x</system-reminder>' },
      { type: 'text', text: 'list files' },
    ] },
    { role: 'assistant', content: [
      { type: 'text', text: 'Listing.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md\npackage.json' },
    ] },
  ],
});

describe('Anthropic route as Claude Code agent backend', () => {
  let ctx: TestContext;
  const pacing = { ...rateLimitPacing };
  afterEach(() => { ctx?.cleanup(); Object.assign(rateLimitPacing, pacing); });

  async function post(provider: CapturingProvider, stream: boolean, extra: object = {}, path = '/v1/messages') {
    ctx = createTestContext({ providers: [provider as any] });
    return ctx.app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...claudeCodeBody(stream), ...extra }),
    });
  }

  it('prompt sent to the web model keeps system, tools and full history', async () => {
    const provider = new CapturingProvider('ok');
    await post(provider, false);
    const prompt = buildWebPrompt(provider.last!.messages, provider.last!.tools);
    expect(prompt).toContain("You are Claude Code");   // system prompt
    expect(prompt).toContain('Bash');                  // tool definition
    expect(prompt).toContain('list files');            // earlier user turn
    expect(prompt).toContain('README.md');             // tool_result
  });

  it('history numbers calls in order and each result carries its call number', async () => {
    const provider = new CapturingProvider('ok');
    const read = (id: string) => ({ type: 'tool_use', id, name: 'Read', input: { file_path: '/a' } });
    const result = (id: string, content: string) => ({ type: 'tool_result', tool_use_id: id, content });
    await post(provider, false, { messages: [
      ...claudeCodeBody(false).messages,
      { role: 'assistant', content: [read('toolu_2'), read('toolu_3')] },
      { role: 'user', content: [result('toolu_3', 'second'), result('toolu_2', 'first')] },
    ] });
    const prompt = buildWebPrompt(provider.last!.messages, provider.last!.tools);
    expect(prompt).toContain('<｜DSML｜invoke name="Bash" call="1">');
    expect(prompt).toContain('<｜DSML｜invoke name="Read" call="2">');
    expect(prompt).toContain('<｜DSML｜invoke name="Read" call="3">');
    expect(prompt).toContain('<tool_result call="1" name="Bash">\nREADME.md');
    expect(prompt).toContain('<tool_result call="3" name="Read">\nsecond');
    expect(prompt).toContain('<tool_result call="2" name="Read">\nfirst');
    expect(prompt).not.toContain('toolu_');
  });

  it('non-stream: DSML tool call becomes a tool_use block', async () => {
    const res = await post(new CapturingProvider(DSML_REPLY), false);
    const body = await res.json();
    const toolUse = body.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ name: 'Bash', input: { command: 'pwd', description: 'Print cwd' } });
    expect(body.stop_reason).toBe('tool_use');
    expect(JSON.stringify(body.content)).not.toContain('DSML');
  });

  it('parses the DSML variant seen in a real Claude Code session', async () => {
    const reply = [
      'I\'ll start by exploring.',
      '<｜｜DSML｜｜ calls>',
      '<｜｜DSML｜｜ invoke name="Bash">',
      '<｜｜DSML｜｜ parameter name="command" string="true">ls -la; pwd</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '<｜｜DSML｜｜ invoke name="Read">',
      '<｜｜DSML｜｜ parameter name="limit" string="false">40</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>',
      '</｜｜DSML｜｜ calls>',
    ].join('\n');
    const body = await (await post(new CapturingProvider(reply), false)).json();
    expect(body.content.map((b: any) => b.type)).toEqual(['text', 'tool_use', 'tool_use']);
    expect(body.content[1].input).toEqual({ command: 'ls -la; pwd' });
    expect(body.content[2].input).toEqual({ limit: 40 });
  });

  it('recovers a parameter whose opening tag lost `parameter name="` (seen from DeepSeek)', () => {
    // Verbatim model output captured through the bridge.
    const raw = '<｜DSML｜function_calls>\n<｜DSML｜invoke name="Read">\n'
      + '<｜DSML｜file_path" string="true">/repo/src/a.ts</｜DSML｜parameter>\n'
      + '<｜DSML｜parameter name="offset" string="false">18</｜｜DSML｜｜ parameter>\n'
      + '</｜DSML｜invoke>\n</｜DSML｜function_calls>';
    expect(parseToolCalls(raw).calls).toEqual([{ name: 'Read', input: { file_path: '/repo/src/a.ts', offset: 18 } }]);
  });

  it('reply cut off inside a tool call becomes max_tokens so Claude Code asks for smaller pieces', async () => {
    // Shape of a real DeepSeek reply truncated by its output limit while writing a big file.
    const cut = 'Writing report.\n\n<｜DSML｜function_calls>\n<｜DSML｜invoke name="Write">\n'
      + '<｜｜DSML｜｜ parameter name="file_path" string="true">/tmp/r.html</｜｜DSML｜｜ parameter>\n'
      + '<｜｜DSML｜｜ parameter name="content" string="true"><!doctype html><p class="';
    expect(parseToolCalls(cut)).toEqual({ text: 'Writing report.', calls: [], truncated: true });
    for (const stream of [false, true]) {
      const res = await post(new CapturingProvider(cut), stream);
      const text = stream ? await res.text() : JSON.stringify(await res.json());
      expect(text).toContain('"max_tokens"');
      expect(text).toContain('Writing report.');
      expect(text).not.toContain('DSML');
    }
  });

  it('keeps mid-conversation system messages in place (Claude Code hooks, MCP instructions)', async () => {
    const provider = new CapturingProvider('ok');
    ctx = createTestContext({ providers: [provider as any] });
    await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'cap/m', max_tokens: 64, system: 'TOP-SYSTEM', tools: [],
        messages: [
          { role: 'user', content: 'Q1' },
          { role: 'system', content: 'HOOK-CTX' },
          { role: 'assistant', content: 'A1' },
          { role: 'user', content: 'Q2' },
        ],
      }),
    });
    const prompt = buildWebPrompt(provider.last!.messages, provider.last!.tools);
    const header = prompt.slice(0, prompt.indexOf('# Conversation'));
    expect(header).toContain('TOP-SYSTEM');
    expect(header).not.toContain('HOOK-CTX');
    const at = (s: string) => prompt.indexOf(s);
    expect(at('Q1')).toBeLessThan(at('HOOK-CTX'));
    expect(at('HOOK-CTX')).toBeLessThan(at('A1'));
  });

  it('retries a transient provider error once', async () => {
    let calls = 0;
    const flaky = new CapturingProvider('recovered');
    flaky.chat = async function* () {
      if (calls++ === 0) { yield { type: 'error', message: 'page.evaluate: Execution context was destroyed' }; return; }
      yield { type: 'text_delta', delta: 'recovered' };
      yield { type: 'done', reason: 'stop' };
    };
    const body = await (await post(flaky, false)).json();
    expect(calls).toBe(2);
    expect(body.content[0].text).toBe('recovered');
  });

  it('persistent provider error is an API error Claude Code can retry, not assistant text', async () => {
    const broken = new CapturingProvider('');
    broken.chat = async function* () { yield { type: 'error', message: 'boom' }; };
    for (const stream of [true, false]) {
      const res = await post(broken, stream);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'api_error', message: 'boom' } });
    }
  });

  it('persistent rate limit becomes a 429 rate_limit_error once the cooldown budget is spent', async () => {
    Object.assign(rateLimitPacing, { firstWaitMs: 10, maxWaitMs: 25 });
    let calls = 0;
    const limited = new CapturingProvider('');
    limited.chat = async function* () {
      calls++;
      yield { type: 'error', message: 'DeepSeek: Messages too frequent.', code: 'upstream_rate_limit' };
    };
    const res = await post(limited, true);
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ type: 'error', error: { type: 'rate_limit_error' } });
    expect(calls).toBe(2);
  });

  // The client may give up (Claude Code timeout, user cancel) while its turn waits
  // in the lane. Abandoned work must not reach the shared browser tab.
  it('client already gone: the provider is never asked', async () => {
    const provider = new CapturingProvider('ok');
    ctx = createTestContext({ providers: [provider as any] });
    const gone = new AbortController();
    gone.abort();
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(claudeCodeBody(false)),
      signal: gone.signal,
    });
    expect(res.status).toBe(499);
    expect(provider.last).toBeNull();
  });

  it('client leaves during a rate-limit cooldown: the 5 s wait is cut and no retry is sent', async () => {
    Object.assign(rateLimitPacing, { firstWaitMs: 5_000, maxWaitMs: 60_000 });
    let calls = 0;
    const limited = new CapturingProvider('');
    limited.chat = async function* () {
      calls++;
      yield { type: 'error', message: 'DeepSeek: Messages too frequent.', code: 'upstream_rate_limit' };
    };
    ctx = createTestContext({ providers: [limited as any] });
    const gone = new AbortController();
    const pending = ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(claudeCodeBody(false)),
      signal: gone.signal,
    });
    setTimeout(() => gone.abort(), 20);
    const started = performance.now();
    const res = await pending;
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(res.status).toBe(499);
    expect(calls).toBe(1);
  });

  it('rate limit holds the provider lane and retries after a cooldown, so parallel subagents all succeed', async () => {
    Object.assign(rateLimitPacing, { firstWaitMs: 30, maxWaitMs: 1_000 });
    const starts: number[] = [];
    const deepseek = new CapturingProvider('ok');
    deepseek.chat = async function* () {
      starts.push(performance.now());
      if (starts.length <= 2) { yield { type: 'error', message: 'DeepSeek: Messages too frequent.', code: 'upstream_rate_limit' }; return; }
      yield { type: 'text_delta', delta: 'ok' };
      yield { type: 'done', reason: 'stop' };
    };
    ctx = createTestContext({ providers: [deepseek as any] });
    const req = () => ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(claudeCodeBody(false)),
    });
    const results = await Promise.all([req(), req(), req()]);
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(starts).toHaveLength(5);
    // No request reached the provider during a cooldown (30 ms, then 60 ms).
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(25);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(55);
  });

  it('a garbled tool-call block is asked again instead of ending the turn', async () => {
    const garbled = ['<｜DSML｜function_calls>',
      '<｜｜DSML｜｜ parameter name="command" string="true">pwd</｜｜DSML｜｜ parameter>',
      '</｜｜DSML｜｜ invoke>', '</｜｜DSML｜｜ calls>'].join('\n');
    const replies = [garbled, DSML_REPLY];
    const provider = new CapturingProvider('');
    provider.chat = async function* () {
      yield { type: 'text_delta', delta: replies.shift() ?? garbled };
      yield { type: 'done', reason: 'stop' };
    };
    const body = await (await post(provider, false)).json();
    expect(replies).toEqual([]);
    expect(body.stop_reason).toBe('tool_use');
    expect(body.content.at(-1)).toMatchObject({ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } });
  });

  it('garbled twice: the block is dropped and max_tokens makes Claude Code continue', async () => {
    const provider = new CapturingProvider(['Voy a mirar.', '<｜DSML｜function_calls>',
      '<｜｜DSML｜｜ parameter name="command" string="true">pwd</｜｜DSML｜｜ parameter>', '</｜｜DSML｜｜ calls>'].join('\n'));
    const body = await (await post(provider, false)).json();
    expect(body.stop_reason).toBe('max_tokens');
    expect(body.content).toEqual([{ type: 'text', text: 'Voy a mirar.' }]);
  });

  it('a model no provider has (subagents send claude-sonnet-5-5) uses the configured fallback', async () => {
    const provider = new CapturingProvider('ok');
    ctx = createTestContext({ providers: [provider as any], fallbackModel: 'cap/m' });
    const res = await ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...claudeCodeBody(false), model: 'claude-sonnet-5-5' }),
    });
    expect(res.status).toBe(200);
    expect(provider.last?.model).toBe('m');
  });

  describe('thinking', () => {
    const thought = 'Primero reviso el directorio.';

    it('reasoning becomes a thinking block ahead of the text, not part of the text', async () => {
      const body = await (await post(new CapturingProvider(DSML_REPLY, thought), false)).json();
      expect(body.content.map((b: any) => b.type)).toEqual(['thinking', 'text', 'tool_use']);
      expect(body.content[0]).toMatchObject({ type: 'thinking', thinking: thought });
      expect(body.content[1].text).not.toContain(thought);
    });

    it('streams the thinking block (thinking_delta) before the text block', async () => {
      const sse = await (await post(new CapturingProvider('Hecho.', thought), true)).text();
      expect(sse).toContain('"type":"thinking_delta"');
      expect(sse).toContain(thought);
      expect(sse.indexOf('"type":"thinking"')).toBeLessThan(sse.indexOf('"type":"text_delta"'));
    });

    it.each([
      [{ type: 'enabled', budget_tokens: 2048 }, true],
      [{ type: 'adaptive' }, true],
      [{ type: 'disabled' }, false],
      [undefined, false],
    ])('request thinking=%j reaches the provider as %s', async (thinking, want) => {
      const provider = new CapturingProvider('ok');
      await post(provider, false, { thinking });
      expect(!!provider.last?.thinking).toBe(want);
    });
  });

  describe('usage', () => {
    const reply = 'Hola mundo, esto es una respuesta.';
    const thought = 'pienso un rato';
    // Ground truth is a real BPE tokenizer, not the bridge's own heuristic, so the
    // assertion measures the right TEXT and does not just mirror the implementation.
    const within = (actual: number, text: string) => {
      const real = encode(text).length;
      expect(actual).toBeGreaterThanOrEqual(real * 0.8);
      expect(actual).toBeLessThanOrEqual(real * 1.6);
    };

    it('counts the prompt actually sent and the reply produced', async () => {
      const provider = new CapturingProvider(reply, thought);
      const body = await (await post(provider, false)).json();
      const sent = buildWebPrompt(provider.last!.messages, provider.last!.tools);
      within(body.usage.input_tokens, sent);
      within(body.usage.output_tokens, thought + reply);
    });


    it('streaming carries input in message_start and output in message_delta', async () => {
      const provider = new CapturingProvider(reply, thought);
      const sse = await (await post(provider, true)).text();
      const data = (event: string) => JSON.parse(sse.split(`event: ${event}\ndata: `)[1].split('\n')[0]);
      const sent = buildWebPrompt(provider.last!.messages, provider.last!.tools);
      within(data('message_start').message.usage.input_tokens, sent);
      within(data('message_delta').usage.output_tokens, thought + reply);
    });

    // Hangul is CJK for tokenizer purposes; chars/4 halves it like Chinese.
    it('counts Hangul syllables at the CJK rate', () => {
      expect(estimateTokens('가'.repeat(200))).toBe(120);
    });

    it('count_tokens answers with the same prompt estimate and calls no provider', async () => {
      const provider = new CapturingProvider(reply);
      const chat = await (await post(provider, false)).json();
      provider.last = null;
      const res = await post(provider, false, {}, '/v1/messages/count_tokens');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ input_tokens: chat.usage.input_tokens });
      expect(provider.last).toBeNull();
    });

    // Tool arguments are output tokens on the real API too.
    // Regression: they were once stripped out of `prose` and went uncounted.
    it('counts tool-call arguments as output tokens', async () => {
      const big = 'x'.repeat(4000);
      const reply = [
        'Running.',
        '<｜DSML｜function_calls>',
        '<｜DSML｜invoke name="Bash">',
        `<｜DSML｜parameter name="command" string="true">${big}</｜DSML｜parameter>`,
        '</｜DSML｜invoke>',
        '</｜DSML｜function_calls>',
      ].join('\n');
      const body = await (await post(new CapturingProvider(reply), false)).json();
      expect(body.usage.output_tokens).toBeGreaterThanOrEqual(Math.ceil(reply.length / 4));
    });

    // chars/4 is a Latin heuristic and halves CJK.
    it('counts CJK text at tokenizer density, not chars/4', async () => {
      const reply = '你好世界'.repeat(50); // 200 chars
      const real = encode(reply).length; // ground truth from a real BPE tokenizer
      const body = await (await post(new CapturingProvider(reply), false)).json();
      expect(body.usage.output_tokens).toBeGreaterThanOrEqual(real * 0.9);
    });

    // Claude Code sizes its context bar from the model list;
    // without the window it falls back to its own default for a custom model id.
    it('exposes the provider context window on the model list', async () => {
      ctx = createTestContext({ providers: [new CapturingProvider('ok') as any] });
      const body = await (await ctx.app.request('/v1/models')).json();
      const m = body.data.find((x: any) => x.id === 'cap/m');
      expect(m).toMatchObject({ max_input_tokens: 1, max_tokens: 1 });
    });
  });

  it('serializes concurrent requests to the same provider (one shared browser tab)', async () => {
    let active = 0, maxActive = 0;
    const slow = new CapturingProvider('ok');
    slow.chat = async function* () {
      maxActive = Math.max(maxActive, ++active);
      await new Promise(r => setTimeout(r, 20));
      active--;
      yield { type: 'text_delta', delta: 'ok' };
      yield { type: 'done', reason: 'stop' };
    };
    ctx = createTestContext({ providers: [slow as any] });
    const req = () => ctx.app.request('/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(claudeCodeBody(false)),
    });
    const results = await Promise.all([req(), req(), req()]);
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(maxActive).toBe(1);
  });

  it('stream: DSML tool call becomes tool_use SSE events', async () => {
    const res = await post(new CapturingProvider(DSML_REPLY), true);
    const text = await res.text();
    expect(text).toContain('"type":"tool_use"');
    expect(text).toContain('"input_json_delta"');
    expect(text).toContain('"stop_reason":"tool_use"');
    expect(text).not.toContain('DSML');
  });
});
