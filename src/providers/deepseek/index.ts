import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';

import { solvePow, buildPowResponse, type DeepSeekPowChallenge } from './pow.js';
import { DEEPSEEK_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';

/** HTTP 200 envelope DeepSeek wraps every reply in. */
interface SessionCreateEnvelope {
  code?: number;
  msg?: string;
  data?: {
    biz_code?: number;
    biz_msg?: string;
    biz_data?: { chat_session?: { id?: string } };
  };
}

interface SessionCreateReply {
  data?: SessionCreateEnvelope;
  error?: string;
}

type SessionCreateResult =
  | { kind: 'ok'; sessionId: string }
  | { kind: 'error'; message: string }
  | { kind: 'malformed' };

/**
 * DeepSeek answers HTTP 200 even on failure: {code:0, data:{biz_code:0,
 * biz_data:{chat_session:{id}}}} on success (2026-10-20 shape); {code:40003,
 * msg:"INVALID_TOKEN", data:null} on auth failure.
 */
function sessionCreateResult(reply: SessionCreateReply): SessionCreateResult {
  if (reply.error) return { kind: 'error', message: reply.error };
  const envelope = reply.data;
  const errorCode = envelope?.data?.biz_code ?? envelope?.code;
  if (errorCode) {
    return { kind: 'error', message: `${errorCode}: ${envelope?.data?.biz_msg || envelope?.msg || 'unknown error'}` };
  }
  const sessionId = envelope?.data?.biz_data?.chat_session?.id;
  return sessionId ? { kind: 'ok', sessionId } : { kind: 'malformed' };
}

export class DeepSeekProvider extends BaseProvider {
  readonly info: ProviderInfo = {
    id: 'deepseek-web',
    name: 'DeepSeek Web',
    website: DEEPSEEK_WEB_BASE_URL,
    loginUrl: `${DEEPSEEK_WEB_BASE_URL}/sign_in`,
    needsBrowser: true,
  };

  private bearerToken: string | null = null;

  constructor(
    private authStore: AuthStore,
    _browserFetch?: (url: string, init: RequestInit) => Promise<Response>,
    private getPage?: (origin: string) => Promise<Page>,
  ) {
    super();
  }

  /** Set a bearer token for API authentication (e.g. from OpenClaw auth-profiles) */
  setBearerToken(token: string): void {
    this.bearerToken = token;
  }

  async login(context: { openUrl: (url: string) => Promise<void> }): Promise<void> {
    await context.openUrl(this.info.loginUrl);
  }

  async isAuthenticated(): Promise<boolean> {
    return this.authStore.getStatus(this.info.id).status === 'active';
  }

  async detectLoginComplete(): Promise<boolean> {
    return false;
  }

  async models(): Promise<ModelInfo[]> {
    return [
      { id: 'deepseek-v4', name: 'DeepSeek V4', contextWindow: 128000, maxOutput: 8192 },
      { id: 'deepseek-v4-reasoner', name: 'DeepSeek V4 Reasoner', contextWindow: 128000, maxOutput: 8192 },
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    if (!this.getPage) {
      yield { type: 'error', message: 'Browser not connected' };
      return;
    }

    try {
      const page = await this.getPage(DEEPSEEK_WEB_BASE_URL);

      // Step 1: Extract bearer token
      // DeepSeek stores JWT in a cookie named "ds_chat_token" or via login response.
      // Strategy: try /api/v0/users/current with cookies → intercept from page.
      let bearer = this.bearerToken;
      if (!bearer) {
        // Primary method: Intercept request headers by reloading the page.
        // DeepSeek's frontend JS adds the Authorization header from its own state.
        const tokenPromise = new Promise<string | null>((resolve) => {
          const timeout = setTimeout(() => resolve(null), 10000);
          const handler = (request: any) => {
            const url = request.url() as string;
            if (url.includes('/api/v0/')) {
              const auth = request.headers()['authorization'] as string | undefined;
              if (auth?.startsWith('Bearer ')) {
                clearTimeout(timeout);
                page.off('request', handler);
                resolve(auth.slice(7));
              }
            }
          };
          page.on('request', handler);
        });
        // Reload the page — DeepSeek frontend will fire API calls with Bearer token
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => {});
        bearer = await tokenPromise;
      }
      if (!bearer) {
        yield { type: 'error', message: 'DeepSeek: could not extract bearer token. Please re-login at chat.deepseek.com' };
        return;
      }

      // Step 2: Create chat session
      const sessionResult = await page.evaluate(async (bearerToken: string | null) => {
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
          const res = await fetch('/api/v0/chat_session/create', {
            method: 'POST',
            headers,
            body: '{}',
            credentials: 'include',
          });
          if (!res.ok) {
            const text = await res.text();
            return { error: `HTTP ${res.status}: ${text.substring(0, 200)}` };
          }
          return { data: await res.json() };
        } catch (e: any) {
          return { error: e.message };
        }
      }, bearer);
      const session = sessionCreateResult(sessionResult);

      if (session.kind === 'error') {
        yield { type: 'error', message: `DeepSeek session create failed: ${session.message}` };
        return;
      }
      if (session.kind === 'malformed') {
        yield { type: 'error', message: 'DeepSeek session create failed: no session id' };
        return;
      }

      // Step 3: Get PoW challenge
      const challengeResult = await page.evaluate(async (bearerToken: string | null) => {
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
          const res = await fetch('/api/v0/chat/create_pow_challenge', {
            method: 'POST',
            headers,
            body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
            credentials: 'include',
          });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          const data = await res.json();
          const c = data?.data?.biz_data?.challenge || data?.data?.challenge || data?.challenge;
          return { challenge: c };
        } catch (e: any) {
          return { error: e.message };
        }
      }, bearer);

      if (challengeResult.error || !challengeResult.challenge) {
        yield { type: 'error', message: `DeepSeek PoW challenge failed: ${challengeResult.error || 'no challenge'}` };
        return;
      }

      // Step 4: Solve PoW (runs in Node.js, not browser)
      const challenge = challengeResult.challenge as DeepSeekPowChallenge;
      let powResponse: string;
      try {
        const answer = await solvePow(challenge);
        powResponse = buildPowResponse(challenge, answer, '/api/v0/chat/completion');
      } catch (err) {
        yield { type: 'error', message: `DeepSeek PoW solve failed: ${(err as Error).message}` };
        return;
      }

      // Step 5: Build prompt
      const prompt = buildWebPrompt(req.messages, req.tools);

      const isThinking = req.thinking || req.model.includes('reasoner');

      // Step 6: Send message with PoW header, read SSE
      const sseResult = await page.evaluate(async (args: {
        sessionId: string; prompt: string; powResponse: string; thinkingEnabled: boolean; bearerToken: string | null;
      }) => {
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'x-ds-pow-response': args.powResponse,
          };
          if (args.bearerToken) headers['Authorization'] = `Bearer ${args.bearerToken}`;
          const res = await fetch('/api/v0/chat/completion', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              chat_session_id: args.sessionId,
              parent_message_id: null,
              prompt: args.prompt,
              ref_file_ids: [],
              thinking_enabled: args.thinkingEnabled,
              search_enabled: false,
              preempt: false,
            }),
            credentials: 'include',
          });

          if (!res.ok) {
            const text = await res.text();
            return { error: `HTTP ${res.status}: ${text.substring(0, 200)}` };
          }

          const reader = res.body?.getReader();
          if (!reader) return { error: 'No response body' };

          const decoder = new TextDecoder();
          let fullText = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            fullText += decoder.decode(value, { stream: true });
          }
          return { data: fullText };
        } catch (e: any) {
          return { error: e.message };
        }
      }, {
        sessionId: session.sessionId,
        prompt,
        powResponse,
        thinkingEnabled: isThinking,
        bearerToken: bearer,
      });

      if (sseResult.error) {
        yield { type: 'error', message: `DeepSeek API error: ${sseResult.error}` };
        return;
      }


      // Step 7: Parse SSE
      // DeepSeek Web uses a JSON-patch SSE format:
      //   {"p":"response/content","o":"APPEND","v":"Hello"} — append to content
      //   {"v":"!"} — short form append (continues previous path)
      //   {"p":"response/status","v":"FINISHED"} — status update
      //   {"p":"response/thinking_content","o":"APPEND","v":"..."} — thinking
      // Newer replies are a list of fragments: a THINK fragment (reasoning, when thinking is
      // enabled) then a RESPONSE fragment appended via {"p":"response/fragments","o":"APPEND",
      // "v":[{type, content}]}. Content patches address a fragment by index, so track their types.
      const fragmentTypes: string[] = [];
      const fragmentDelta = (type: string | undefined, delta: string): StreamEvent =>
        type === 'THINK' ? { type: 'thinking_delta', delta } : { type: 'text_delta', delta };
      // Content already yielded per fragment: a SET patch replaces the fragment, so emit
      // only its unseen tail instead of duplicating what streamed before it. A SET that
      // contradicts what was sent can't be retracted and is dropped.
      const emitted: string[] = [];
      const emitFragment = (index: number, type: string | undefined, content: string, op?: string): StreamEvent | null => {
        const prev = emitted[index] ?? '';
        if (op === 'SET') {
          if (!content.startsWith(prev)) return null;
          emitted[index] = content;
          const delta = content.slice(prev.length);
          return delta.length > 0 ? fragmentDelta(type, delta) : null;
        }
        emitted[index] = prev + content;
        return content.length > 0 ? fragmentDelta(type, content) : null;
      };
      const lines = (sseResult.data ?? '').split('\n');
      let lastPath = '';
      let sawSnapshot = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('event:')) continue;
        if (!trimmed.startsWith('data: ')) continue;

        const raw = trimmed.slice(6);
        if (raw === '[DONE]' || raw === '{}') continue;

        try {
          const parsed = JSON.parse(raw);

          // Full response object (initial WIP state). DeepSeek ships the first
          // fragment already prefixed here and streams only the remainder as
          // APPEND patches on response/fragments/<i>/content.
          if (parsed?.v?.response) {
            if (!sawSnapshot) {
              sawSnapshot = true;
              const frags = parsed.v.response.fragments;
              for (const frag of Array.isArray(frags) ? frags : []) {
                const index = fragmentTypes.length;
                fragmentTypes.push(frag?.type);
                const event = typeof frag?.content === 'string' ? emitFragment(index, frag.type, frag.content) : null;
                if (event) yield event;
              }
            }
            continue;
          }

          // `event: hint` reports server-side refusals, e.g. when requests come too fast:
          // {"type":"error","content":"Messages too frequent...","finish_reason":"rate_limit_reached"}
          if (parsed?.type === 'error' && typeof parsed.content === 'string') {
            const code = parsed.finish_reason === 'rate_limit_reached' ? 'upstream_rate_limit' : parsed.finish_reason;
            yield { type: 'error', message: `DeepSeek: ${parsed.content}`, code };
            continue;
          }

          const path = parsed.p ?? lastPath;
          if (parsed.p) lastPath = parsed.p;
          const value = parsed.v;
          const op = parsed.o as string | undefined;

          const fragmentContent = /^response\/fragments\/(-?\d+)\/content$/.exec(path);
          if (path === 'response/fragments' && Array.isArray(value)) {
            for (const frag of value) {
              const index = fragmentTypes.length;
              fragmentTypes.push(frag?.type);
              const event = typeof frag?.content === 'string' ? emitFragment(index, frag.type, frag.content, op) : null;
              if (event) yield event;
            }
          } else if (fragmentContent && typeof value === 'string' && value.length > 0) {
            const raw = Number(fragmentContent[1]);
            const index = raw < 0 ? fragmentTypes.length + raw : raw;
            const event = emitFragment(index, fragmentTypes.at(raw), value, op);
            if (event) yield event;
          } else if (path === 'response/content' && typeof value === 'string' && value.length > 0) {
            yield { type: 'text_delta', delta: value };
          } else if (path === 'response/thinking_content' && typeof value === 'string' && value.length > 0) {
            yield { type: 'thinking_delta', delta: value };
          } else if (path === 'response/status' && (value === 'FINISHED' || value === 'DONE')) {
            yield { type: 'done', reason: 'stop' };
          }
        } catch {
          // Skip non-JSON lines
        }
      }

    } catch (err) {
      yield { type: 'error', message: `DeepSeek provider error: ${(err as Error).message}` };
    }
  }
}
