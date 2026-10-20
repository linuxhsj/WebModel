import { describe, it, expect } from 'vitest';
import { DeepSeekProvider } from '../../../src/providers/deepseek/index.js';
import type { StreamEvent } from '../../../src/core/stream.js';

// Captured verbatim from chat.deepseek.com on 2026-10-20: the id moved into
// data.biz_data.chat_session, and API errors arrive as HTTP 200 envelopes.
const createReply = {
  code: 0, msg: '',
  data: { biz_code: 0, biz_msg: '', biz_data: { chat_session: { id: 'session-1' }, ttl_seconds: 1800 } },
};
const powReply = { challenge: { algorithm: 'sha256', challenge: 'c', difficulty: 4, salt: 's', signature: 'sig' } };

// Fake tab: answers the provider's in-page fetches in order.
function providerWithReplies(replies: unknown[]) {
  const page = { evaluate: async () => replies.shift() };
  const provider = new DeepSeekProvider({} as any, undefined, async () => page as any);
  provider.setBearerToken('test');
  return provider;
}

// session create, PoW challenge, then the completion SSE.
function providerWithSse(sse: string) {
  return providerWithReplies([{ data: createReply }, powReply, { data: sse }]);
}

async function events(provider: DeepSeekProvider): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of provider.chat({ model: 'deepseek-v4', messages: [{ role: 'user', content: 'hi' }], stream: true })) out.push(e);
  return out;
}

describe('DeepSeekProvider.chat SSE handling', () => {
  it('reports the rate-limit hint as an upstream_rate_limit error instead of an empty reply', async () => {
    // Captured verbatim from chat.deepseek.com when requests come too fast.
    const sse = 'event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n\n'
      + 'event: hint\ndata: {"type":"error","content":"Messages too frequent. Try again later.","clear_response":true,"finish_reason":"rate_limit_reached"}\n\n'
      + 'event: close\ndata: {"click_behavior":"retry","auto_resume":false}\n\n';
    expect(await events(providerWithSse(sse))).toEqual([
      { type: 'error', message: 'DeepSeek: Messages too frequent. Try again later.', code: 'upstream_rate_limit' },
    ]);
  });

  it('still streams normal content', async () => {
    const sse = 'data: {"v":{"response":{"fragments":[{"content":"Hola"}]}}}\n\n'
      + 'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" mundo"}\n\n'
      + 'data: {"p":"response/status","v":"FINISHED"}\n\n';
    expect(await events(providerWithSse(sse))).toEqual([
      { type: 'text_delta', delta: 'Hola' },
      { type: 'text_delta', delta: ' mundo' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('emits only the unseen tail when a fragment content patch is SET', async () => {
    // CodeRabbit on PR #10: a SET patch replaces the fragment; appending it would duplicate.
    const sse = 'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"Hola"}]}}}\n\n'
      + 'data: {"p":"response/fragments/-1/content","o":"SET","v":"Hola mundo"}\n\n'
      + 'data: {"p":"response/fragments/-1/content","o":"SET","v":"Adiós"}\n\n'
      + 'data: {"p":"response/status","v":"FINISHED"}\n\n';
    expect(await events(providerWithSse(sse))).toEqual([
      { type: 'text_delta', delta: 'Hola' },
      { type: 'text_delta', delta: ' mundo' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('streams THINK fragments as thinking and keeps the RESPONSE fragment appended later', async () => {
    // Shape captured from chat.deepseek.com with thinking_enabled: the snapshot opens a THINK
    // fragment, its APPENDs follow, then the answer arrives as a new RESPONSE fragment.
    const sse = 'data: {"v":{"response":{"thinking_enabled":true,"fragments":[{"id":2,"type":"THINK","content":"We","references":[]}]}}}\n\n'
      + 'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" need"}\n\n'
      + 'data: {"v":" 391."}\n\n'
      + 'data: {"p":"response/fragments/-1/elapsed_secs","o":"SET","v":0.76}\n\n'
      + 'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"39","references":[],"stage_id":1}]}\n\n'
      + 'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"1"}\n\n'
      + 'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n';
    expect(await events(providerWithSse(sse))).toEqual([
      { type: 'thinking_delta', delta: 'We' },
      { type: 'thinking_delta', delta: ' need' },
      { type: 'thinking_delta', delta: ' 391.' },
      { type: 'text_delta', delta: '39' },
      { type: 'text_delta', delta: '1' },
      { type: 'done', reason: 'stop' },
    ]);
  });
});

describe('DeepSeekProvider session create', () => {
  it('reads the id from data.biz_data.chat_session', async () => {
    const provider = providerWithReplies([
      { data: createReply },
      powReply,
      { data: 'data: {"p":"response/content","v":"hi"}\n\ndata: {"p":"response/status","v":"FINISHED"}\n\n' },
    ]);
    expect(await events(provider)).toEqual([
      { type: 'text_delta', delta: 'hi' },
      { type: 'done', reason: 'stop' },
    ]);
  });

  it('surfaces the HTTP 200 error envelope instead of "no session id"', async () => {
    const provider = providerWithReplies([{ data: { code: 40003, msg: 'INVALID_TOKEN', data: null } }]);
    expect(await events(provider)).toEqual([
      { type: 'error', message: 'DeepSeek session create failed: 40003: INVALID_TOKEN' },
    ]);
  });
});
