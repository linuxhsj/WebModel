import { BaseProvider, type ProviderInfo, type ModelInfo, type ChatRequest, buildWebPrompt } from '../../core/provider.js';
import type { StreamEvent } from '../../core/stream.js';

import { solvePow, buildPowResponse, type DeepSeekPowChallenge } from './pow.js';
import { DeepSeekWebSSEParser } from './stream.js';
import { DEEPSEEK_WEB_BASE_URL } from './client.js';
import { AuthStore } from '../../auth/store.js';
import type { Page } from 'playwright-core';

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
          const data = await res.json();
          // The web API has moved the session id to data.biz_data.chat_session.id;
          // keep the older shapes as fallbacks.
          return {
            sessionId:
              data?.data?.biz_data?.chat_session?.id ||
              data?.data?.biz_data?.id ||
              data?.data?.id,
          };
        } catch (e: any) {
          return { error: e.message };
        }
      }, bearer);

      if (sessionResult.error || !sessionResult.sessionId) {
        yield { type: 'error', message: `DeepSeek session create failed: ${sessionResult.error || 'no session id'}` };
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
      const prompt = buildWebPrompt(req.messages);

      const isThinking = req.model.includes('reasoner');

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
        sessionId: sessionResult.sessionId,
        prompt,
        powResponse,
        thinkingEnabled: isThinking,
        bearerToken: bearer,
      });

      if (sseResult.error) {
        yield { type: 'error', message: `DeepSeek API error: ${sseResult.error}` };
        return;
      }

      // Step 7: Parse SSE (protocol details live in ./stream.ts)
      const parser = new DeepSeekWebSSEParser();
      yield* parser.pushText(sseResult.data ?? '');

    } catch (err) {
      yield { type: 'error', message: `DeepSeek provider error: ${(err as Error).message}` };
    }
  }
}
