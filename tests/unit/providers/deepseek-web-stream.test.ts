import { describe, it, expect } from 'vitest';
import { DeepSeekWebSSEParser } from '../../../src/providers/deepseek/stream.js';

/** A whole-response frame, as sent by chat.deepseek.com on the first chunk. */
function snapshotFrame(content: string, status = 'WIP', type = 'RESPONSE'): string {
  return `data: ${JSON.stringify({ v: { response: { fragments: [{ type, content }], status } } })}`;
}

/** An incremental patch frame. */
function patchFrame(path: string, value: string): string {
  return `data: ${JSON.stringify({ p: path, o: 'APPEND', v: value })}`;
}

function collect(lines: string[]): ReturnType<DeepSeekWebSSEParser['pushText']> {
  const parser = new DeepSeekWebSSEParser();
  return lines.flatMap((line) => parser.pushLine(line));
}

function text(events: { type: string; delta?: string }[]): string {
  return events
    .filter((e) => e.type === 'text_delta')
    .map((e) => e.delta)
    .join('');
}

describe('DeepSeekWebSSEParser', () => {
  describe('snapshots', () => {
    it('emits the leading text carried by the first snapshot', () => {
      const events = collect([snapshotFrame('杭州')]);
      expect(events).toEqual([{ type: 'text_delta', delta: '杭州' }]);
    });

    it('does not repeat text when a snapshot arrives again unchanged', () => {
      const events = collect([snapshotFrame('杭州'), snapshotFrame('杭州')]);
      expect(text(events)).toBe('杭州');
    });

    it('emits only the unseen tail when a snapshot grows', () => {
      // Patches and snapshots write to the same buffer, so a snapshot that
      // follows patches must resume from the watermark instead of restarting.
      const events = collect([
        snapshotFrame('杭'),
        patchFrame('response/fragments/-1/content', '州'),
        snapshotFrame('杭州是'),
      ]);
      expect(text(events)).toBe('杭州是');
    });

    it('ignores a snapshot that rewinds behind the watermark', () => {
      const events = collect([
        snapshotFrame('杭州是浙江省会'),
        snapshotFrame('杭州'),
      ]);
      expect(text(events)).toBe('杭州是浙江省会');
    });

    it('emits thinking fragments as thinking_delta', () => {
      const events = collect([snapshotFrame('让我想想', 'WIP', 'THINK')]);
      expect(events).toEqual([{ type: 'thinking_delta', delta: '让我想想' }]);
    });
  });

  describe('patches', () => {
    it('appends fragments/-1/content patches', () => {
      const events = collect([patchFrame('response/fragments/-1/content', '是')]);
      expect(events).toEqual([{ type: 'text_delta', delta: '是' }]);
    });

    it('still accepts the legacy response/content path', () => {
      const events = collect([patchFrame('response/content', 'Hello')]);
      expect(events).toEqual([{ type: 'text_delta', delta: 'Hello' }]);
    });

    it('applies a short-form patch to the previous path', () => {
      const events = collect([
        patchFrame('response/fragments/-1/content', '浙江'),
        `data: ${JSON.stringify({ v: '省会' })}`,
      ]);
      expect(text(events)).toBe('浙江省会');
    });

    it('maps thinking paths to thinking_delta', () => {
      const events = collect([patchFrame('response/thinking_content', '推理中')]);
      expect(events).toEqual([{ type: 'thinking_delta', delta: '推理中' }]);
    });

    it('applies batched patches', () => {
      const batch = `data: ${JSON.stringify({
        p: 'response',
        o: 'BATCH',
        v: [
          { p: 'response/fragments/-1/content', o: 'APPEND', v: '浙江' },
          { p: 'response/fragments/-1/content', o: 'APPEND', v: '省会' },
        ],
      })}`;
      expect(text(collect([batch]))).toBe('浙江省会');
    });
  });

  describe('completion', () => {
    it('yields done on a FINISHED status patch', () => {
      expect(collect([patchFrame('response/status', 'FINISHED')])).toEqual([
        { type: 'done', reason: 'stop' },
      ]);
    });

    it('yields done when the snapshot is already finished', () => {
      expect(collect([snapshotFrame('杭州', 'FINISHED')])).toEqual([
        { type: 'text_delta', delta: '杭州' },
        { type: 'done', reason: 'stop' },
      ]);
    });

    it('yields done once even if the status is repeated', () => {
      const events = collect([
        patchFrame('response/status', 'FINISHED'),
        patchFrame('response/status', 'FINISHED'),
      ]);
      expect(events).toEqual([{ type: 'done', reason: 'stop' }]);
    });

    it('accepts DONE as well as FINISHED', () => {
      expect(collect([patchFrame('response/status', 'DONE')])).toEqual([
        { type: 'done', reason: 'stop' },
      ]);
    });
  });

  describe('noise', () => {
    it('ignores event, empty and keepalive lines', () => {
      expect(collect(['event: ready', '', 'data: {}', 'data: [DONE]', ': ping'])).toEqual([]);
    });

    it('ignores malformed JSON', () => {
      expect(collect(['data: {invalid json}}}'])).toEqual([]);
    });

    it('ignores patches for unknown paths', () => {
      expect(collect([patchFrame('response/quota', '12')])).toEqual([]);
    });

    it('ignores empty and non-string values on content paths', () => {
      expect(collect([patchFrame('response/fragments/-1/content', '')])).toEqual([]);
      expect(
        collect([`data: ${JSON.stringify({ p: 'response/fragments', o: 'SET', v: ['x'] })}`]),
      ).toEqual([]);
    });
  });

  it('reassembles a real stream end to end', () => {
    const events = collect([
      'event: ready',
      snapshotFrame('杭'),
      patchFrame('response/fragments/-1/content', '州'),
      `data: ${JSON.stringify({ v: '是浙江省会' })}`,
      patchFrame('response/status', 'FINISHED'),
    ]);
    expect(text(events)).toBe('杭州是浙江省会');
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  });

  it('parses a whole body through pushText', () => {
    const body = [snapshotFrame('杭'), patchFrame('response/fragments/-1/content', '州'), ''].join(
      '\n',
    );
    expect(text(new DeepSeekWebSSEParser().pushText(body))).toBe('杭州');
  });
});
