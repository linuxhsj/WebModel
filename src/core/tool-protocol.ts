import type { ToolDef } from './provider.js';

/**
 * Text protocol for tool calls over web chat UIs, which have no native tool API.
 * Uses DeepSeek's DSML syntax: DeepSeek emits it unprompted, other models follow
 * the instructions. Parsing tolerates `｜`/`|` and spacing variants.
 */

export interface ParsedToolCall {
  name: string;
  input: Record<string, unknown>;
}

const P = '[｜|]+\\s*DSML\\s*[｜|]+\\s*';
const CALLS_CLOSE = `</${P}(?:function_)?calls\\s*>`;
const INVOKE_CLOSE = `</${P}invoke\\s*>`;
// `parameter name="` is optional (`<｜DSML｜file_path" string="true">`) or doubled
// (`parameter name="parameter name="command"`): both seen from DeepSeek.
const PARAM_START = `<${P}(?:parameter\\s+name=")*`;
// Sticky patterns, matched by the scanner at its current position.
const RE_CALLS_OPEN = new RegExp(`<${P}(?:function_)?calls\\s*>`, 'y');
// Also DeepSeek's garbled `parameter name="invoke name="Bash">` and
// `parameter name="invoke" string="true">Bash</｜DSML｜parameter>`. Extra attributes
// (a `call="n"` copied from the history) are ignored.
const RE_INVOKE_OPEN = new RegExp(
  `<${P}(?:parameter\\s+name=")?invoke(?:\\s+name="([^"]+)"(?:\\s+[\\w-]+="[^"]*")*|"(?:\\s+string="(?:true|false)")?\\s*>\\s*([^<"\\s]+)\\s*</${P}parameter)\\s*>`, 'y');
const RE_INVOKE_CLOSE = new RegExp(INVOKE_CLOSE, 'y');
const RE_CALLS_CLOSE = new RegExp(CALLS_CLOSE, 'y');
const RE_PARAM_OPEN = new RegExp(`${PARAM_START}([^"<>\\s]+)"(?:\\s+string="(true|false)")?\\s*>`, 'y');
// A closer ends a value only when DSML structure (or the end) follows, so values may
// contain closer text themselves, e.g. when the model edits this very file.
// chisle: DSML has no escaping; a value holding a closer followed by a parameter opener still splits.
const RE_VALUE_END = new RegExp(
  `</${P}parameter\\s*>(?=\\s*(?:${PARAM_START}[^"<>\\s]+"|${INVOKE_CLOSE}|${CALLS_CLOSE}|$))`, 'g');
// Any DSML opener outside code starts a block, so unknown garbles (e.g. the opener fused
// with a parameter, `<｜DSML｜function_calls｜parameter name=`) are flagged, not shown as prose.
const RE_BLOCK_START = new RegExp(`<${P}\\w`, 'g');
const RE_ANY_CLOSE = new RegExp(`${INVOKE_CLOSE}|${CALLS_CLOSE}`);
const RE_DSML_OPEN = new RegExp(`<${P}`);
const RE_REPEATED_CALLS_OPEN = new RegExp(`^\\s*<${P}(?:function_)?calls\\s*>`, 'y');

function parseJson(v: string): unknown {
  try { return JSON.parse(v); } catch { return v; }
}

/** First DSML opener that is not inside a ``` fence or `inline code` (examples, not calls). */
function blockStart(text: string): number {
  let fences = 0;
  let scanned = 0;
  for (const m of text.matchAll(RE_BLOCK_START)) {
    fences += text.slice(scanned, m.index).match(/```/g)?.length ?? 0;
    scanned = m.index;
    const line = text.slice(text.lastIndexOf('\n', m.index - 1) + 1, m.index);
    const ticks = line.replace(/```/g, '').match(/`/g)?.length ?? 0;
    if (fences % 2 === 0 && ticks % 2 === 0) return m.index;
  }
  return -1;
}

/** A DSML opener still pending after any tolerated repeated openers: a call was cut off. */
function pendingCallPrefix(rest: string): boolean {
  let tail = rest;
  RE_REPEATED_CALLS_OPEN.lastIndex = 0;
  for (;;) {
    if (!RE_REPEATED_CALLS_OPEN.exec(tail)) break;
    tail = tail.slice(RE_REPEATED_CALLS_OPEN.lastIndex);
    RE_REPEATED_CALLS_OPEN.lastIndex = 0;
  }
  return RE_DSML_OPEN.test(tail);
}

/**
 * Read the invokes of one block starting at `pos`; stops at the first thing that isn't DSML.
 * `malformed`: something other than a closer (or the end) followed, so calls may be missing.
 */
function scanBlock(text: string, pos: number): { calls: ParsedToolCall[]; cut: boolean; malformed: boolean } {
  const calls: ParsedToolCall[] = [];
  const take = (re: RegExp) => {
    while (/\s/.test(text[pos] ?? '')) pos++;
    re.lastIndex = pos;
    const m = re.exec(text);
    if (m) pos = re.lastIndex;
    return m;
  };
  while (take(RE_CALLS_OPEN)); // DeepSeek sometimes repeats the opener
  let invokeClosed = false;
  for (let invoke; (invoke = take(RE_INVOKE_OPEN)); ) {
    const input = new Map<string, unknown>();
    for (let param; (param = take(RE_PARAM_OPEN)); ) {
      RE_VALUE_END.lastIndex = pos;
      const end = RE_VALUE_END.exec(text);
      if (!end) return { calls, cut: true, malformed: false };
      const value = text.slice(pos, end.index);
      if (!input.has(param[1])) input.set(param[1], param[2] === 'true' ? value : parseJson(value));
      pos = RE_VALUE_END.lastIndex;
    }
    calls.push({ name: invoke[1] ?? invoke[2], input: Object.fromEntries(input) });
    invokeClosed = !!take(RE_INVOKE_CLOSE);
    if (!invokeClosed) break; // missing closer is tolerated, but ends the block
  }
  // Every invoke closed and nothing call-shaped follows: a broken block closer
  // (DeepSeek repeats the opener or drops the DSML prefix) cannot hide a call.
  const closed = !!take(RE_CALLS_CLOSE) || pos === text.length
    || (invokeClosed && !pendingCallPrefix(text.slice(pos)));
  return { calls, cut: false, malformed: !closed };
}

/**
 * Split a model reply into the prose before its first tool-call block and that block's calls.
 * Text after the block is the model hallucinating results, so it is dropped.
 * `truncated`: the reply stopped inside the block (provider output limit).
 * `malformed`: the block is garbled beyond the drift tolerated above; ask the model again.
 */
export function parseToolCalls(text: string): { text: string; calls: ParsedToolCall[]; truncated?: boolean; malformed?: boolean } {
  const start = blockStart(text);
  if (start < 0) return { text, calls: [] };
  const prose = text.slice(0, start).trimEnd();
  const { calls, cut, malformed } = scanBlock(text, start);
  if (cut || (calls.length === 0 && !RE_ANY_CLOSE.test(text.slice(start)))) {
    return { text: prose, calls: [], truncated: true };
  }
  return malformed ? { text: prose, calls, malformed } : { text: prose, calls };
}

/** A reply's DSML tags with all other text replaced by its length, so logs carry no content. */
export function dsmlShape(text: string): string {
  let shape = '';
  let last = 0;
  for (const m of text.matchAll(new RegExp(`</?${P}[^<>]{0,80}>`, 'g'))) {
    if (m.index > last) shape += `«${m.index - last}»`;
    shape += m[0].replace(/="([^"]*)"/g, (attr, v) => (/^[\w.-]{1,40}$/.test(v) ? attr : '="…"'));
    last = m.index + m[0].length;
  }
  return (last < text.length ? `${shape}«${text.length - last}»` : shape).slice(0, 2000);
}

/** `call`: the call's number in the conversation, so the model can tell which result answers it. */
export function renderToolCalls(calls: (ParsedToolCall & { call?: number })[]): string {
  const invokes = calls.map(({ name, input, call }) => [
    `<｜DSML｜invoke name="${name}"${call ? ` call="${call}"` : ''}>`,
    ...Object.entries(input).map(([key, value]) => typeof value === 'string'
      ? `<｜DSML｜parameter name="${key}" string="true">${value}</｜DSML｜parameter>`
      : `<｜DSML｜parameter name="${key}" string="false">${JSON.stringify(value)}</｜DSML｜parameter>`),
    '</｜DSML｜invoke>',
  ].join('\n'));
  return ['<｜DSML｜function_calls>', ...invokes, '</｜DSML｜function_calls>'].join('\n');
}

export function renderToolsPrompt(tools: ToolDef[]): string {
  const example = renderToolCalls([{ name: 'TOOL_NAME', input: { string_param: 'plain text', other_param: { any: 'json' } } }]);
  return [
    '# Tools',
    'You can call the tools listed below. To call tools, end your reply with a block in exactly this format and write nothing after it:',
    example,
    'Use string="true" for string values (raw, unquoted) and string="false" for any other JSON value. Several invoke blocks may share one function_calls block.',
    'After the block, stop. Results arrive in the next user message as <tool_result> blocks. Never invent tool results.',
    'Past calls are numbered call="n" in order; a <tool_result call="n"> answers the call with the same number.',
    'Long replies get cut off: keep each tool call small and split large file contents across several calls.',
    '',
    '## Available tools',
    ...tools.map(t => JSON.stringify({ name: t.function.name, description: t.function.description, parameters: t.function.parameters })),
  ].join('\n');
}
