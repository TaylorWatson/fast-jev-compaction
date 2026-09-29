import type {
  On,
  PluginOptions,
  Register,
  SessionMessage,
  ToolResultSummary,
  ToolUseSummary,
  TurnCompleteInput,
} from 'claude-code';

import { compact, reductionBound, reductionRatio, resolveOptions } from '../src/compact.js';
import { buildJevRequest, DEFAULT_MODEL, parseJevResponse } from '../src/request.js';
import { goalFromMessages } from '../src/state.js';
import type {
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolResult,
  ToolUse,
} from '../src/types.js';

/**
 * Which compactions Jev could not do may go on to Claude Code's built-in
 * summary: `auto` (default) only the engine's own, `always` every one,
 * `never` none.
 */
export type BuiltinFallback = 'auto' | 'always' | 'never';

const HOOK_DEFAULTS = {
  compactAtPercent: 60,
  minReductionRatio: 0.25,
  model: DEFAULT_MODEL,
  builtinFallback: 'auto' as BuiltinFallback,
};

/**
 * Percentage points the context must grow by after a skipped `turn.complete`
 * request before the next one, so a conversation with nothing left to prune
 * is not re-scored after every turn.
 */
const RETRY_AFTER_SKIP_PERCENT = 10;

export type HookFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type HookFetchResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The shape of `$.http.fetch`, so the hook can be driven without an engine. */
export type HookFetch = (url: string, init?: HookFetchInit) => Promise<HookFetchResponse>;

export type HookConfig = CompactOptions & {
  apiKey?: string;
  compactAtPercent: number;
  minReductionRatio: number;
  model: string;
  builtinFallback: BuiltinFallback;
};

function optionNumber(options: PluginOptions, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionString(options: PluginOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function optionFallback(options: PluginOptions): BuiltinFallback {
  const value = options['builtinFallback'];
  return value === 'auto' || value === 'always' || value === 'never'
    ? value
    : HOOK_DEFAULTS.builtinFallback;
}

/**
 * Whether a compaction Jev could not do may be handed to the built-in summary.
 * Only the engine's `auto` compaction (its threshold, or a prompt too long)
 * must shrink the conversation; `/compact` (`manual`), a plugin's request and
 * a `precompute` can leave it as it is, which is free, where the summary is a
 * long model call that rewrites the verbatim history.
 */
export function mayUseBuiltin(trigger: string | undefined, mode: BuiltinFallback): boolean {
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return trigger === 'auto';
}

/** Reads the plugin's `userConfig` values; anything missing takes the defaults. */
export function resolveHookConfig(options: PluginOptions): HookConfig {
  const numbers: Partial<Omit<CompactOptions, 'goal'>> = {};
  for (const key of [
    'keepThreshold',
    'keepCallThreshold',
    'preserveRecentMessages',
    'maxStateTokens',
    'maxRequestTokens',
    'truncateHeadChars',
  ] as const) {
    const value = options[key];
    if (typeof value === 'number' && Number.isFinite(value)) numbers[key] = value;
  }
  const config: HookConfig = {
    ...numbers,
    compactAtPercent: optionNumber(options, 'compactAtPercent', HOOK_DEFAULTS.compactAtPercent),
    minReductionRatio: optionNumber(
      options,
      'minReductionRatio',
      HOOK_DEFAULTS.minReductionRatio,
    ),
    model: optionString(options, 'model') ?? HOOK_DEFAULTS.model,
    builtinFallback: optionFallback(options),
  };
  const apiKey = optionString(options, 'apiKey');
  if (apiKey) config.apiKey = apiKey;
  const goal = optionString(options, 'goal');
  if (goal) config.goal = goal;
  return config;
}

export type Verdict =
  | { kind: 'scored' }
  | { kind: 'nothing_to_prune'; bound: number }
  | { kind: 'capacity'; estimatedPercent: number }
  | { kind: 'below_minimum' };

/**
 * What the compaction outcome means. Reduction below `minReductionRatio` is
 * not a failure when the candidates could not have freed that much anyway
 * (`nothing_to_prune`); it is only a problem when the window would still be
 * over the compaction threshold afterwards (`capacity`), which is when the
 * built-in summary is worth its cost. Where the host does not report the
 * window's fill, the plain ratio rule applies (`below_minimum`).
 */
export function verdict(
  result: CompactResult,
  config: Pick<HookConfig, 'minReductionRatio' | 'compactAtPercent'>,
  contextPercent: number | undefined,
): Verdict {
  const reduction = reductionRatio(result);
  if (reduction >= config.minReductionRatio) return { kind: 'scored' };
  if (contextPercent === undefined) return { kind: 'below_minimum' };
  const estimatedPercent = contextPercent * (1 - reduction);
  if (estimatedPercent >= config.compactAtPercent) return { kind: 'capacity', estimatedPercent };
  const bound = reductionBound(result);
  if (bound < config.minReductionRatio) return { kind: 'nothing_to_prune', bound };
  return { kind: 'scored' };
}

/** Why the built-in summary replaces a compaction, or undefined when the compaction stands. */
function fallbackReason(outcome: Verdict, config: Pick<HookConfig, 'minReductionRatio'>): string | undefined {
  if (outcome.kind === 'capacity') return `window would stay at ~${Math.round(outcome.estimatedPercent)}%`;
  if (outcome.kind === 'below_minimum') return `below ${percent(config.minReductionRatio)} minimum`;
  return undefined;
}

/** A `JevAsker` over the engine's `$.http.fetch`. */
export function jevAsker(fetchFn: HookFetch, apiKey: string, model: string): JevAsker {
  return {
    async ask(state, questions) {
      const request = buildJevRequest({ apiKey, model }, state, questions);
      const response = await fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
      });
      return parseJevResponse(response.status, response.ok, response.text);
    },
  };
}

function toolUseSummary(tool: ToolUse): ToolUseSummary {
  const summary: ToolUseSummary = {
    tool_use_id: tool.tool_use_id,
    tool: tool.tool,
    input: tool.input,
  };
  if (tool.text !== undefined) summary.text = tool.text;
  if (tool.isError) summary.isError = true;
  return summary;
}

function toolResultSummary(result: ToolResult): ToolResultSummary {
  return {
    tool_use_id: result.tool_use_id,
    text: result.text,
    isError: result.isError ?? false,
  };
}

/**
 * Maps the library's output back onto session messages. Whatever came back
 * unchanged (a message, a tool use, a tool result) is the engine's own object,
 * handle included; anything rebuilt is a fresh message without a handle, so the
 * engine takes the edited content instead of its original.
 */
export function toSessionMessages(
  input: readonly SessionMessage[],
  output: readonly Message[],
): SessionMessage[] {
  const messages = new Map<Message, SessionMessage>();
  const uses = new Map<ToolUse, ToolUseSummary>();
  const results = new Map<ToolResult, ToolResultSummary>();
  for (const message of input) {
    messages.set(message, message);
    for (const tool of message.toolUses) uses.set(tool, tool);
    for (const result of message.toolResults ?? []) results.set(result, result);
  }
  return output.map((message) => {
    const own = messages.get(message);
    if (own) return own;
    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map((tool) => uses.get(tool) ?? toolUseSummary(tool)),
    };
    if (message.toolResults && message.toolResults.length > 0) {
      rebuilt.toolResults = message.toolResults.map(
        (result) => results.get(result) ?? toolResultSummary(result),
      );
    }
    return rebuilt;
  });
}

export type SessionCompaction = {
  result: CompactResult;
  messages: SessionMessage[];
};

/** Runs the library over a session transcript; throws when the key is missing or Jev fails. */
export async function compactSession(
  messages: readonly SessionMessage[],
  config: HookConfig,
  fetchFn: HookFetch,
): Promise<SessionCompaction> {
  if (!config.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
  const result = await compact(messages, jevAsker(fetchFn, config.apiKey, config.model), config);
  return { result, messages: toSessionMessages(messages, result.messages) };
}

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function summarize(result: CompactResult): string {
  const { stats } = result;
  const parts = [
    stats.kept > 0 ? `${stats.kept} kept` : '',
    stats.resultsDropped > 0 ? `${stats.resultsDropped} results truncated` : '',
    stats.callsDropped > 0 ? `${stats.callsDropped} call_dropped` : '',
    stats.pinned > 0 ? `${stats.pinned} pinned` : '',
  ].filter(Boolean);
  return `${percent(reductionRatio(result))} reduction; ${
    parts.join(', ') || 'no tool calls'
  }; state ~${stats.stateTokens} tokens (${stats.stateStage}) in ${stats.requests} request(s)`;
}

const UI_LOG_MAX_CHARS = 4096;

export function decisionLog(result: CompactResult): string {
  return result.decisions
    .filter((d) => d.reason !== 'pinned')
    .map(
      (d) =>
        `${d.id}:${d.tool}:${d.action}/call=${d.keepCall.toFixed(2)}/result=${d.keepResult.toFixed(2)}`,
    )
    .join(' ');
}

export function decisionLogLines(
  result: CompactResult,
  maxChars: number = UI_LOG_MAX_CHARS,
): string[] {
  const entries = decisionLog(result).split(' ').filter(Boolean);
  if (entries.length === 0) return ['decisions: (none)'];
  const chunks: string[] = [];
  let current = '';
  for (const entry of entries) {
    const next = current ? `${current} ${entry}` : entry;
    if (current && next.length > maxChars - 24) {
      chunks.push(current);
      current = entry;
    } else current = next;
  }
  chunks.push(current);
  return chunks.map((chunk, index) =>
    chunks.length === 1
      ? `decisions: ${chunk}`
      : `decisions (${index + 1}/${chunks.length}): ${chunk}`,
  );
}

async function getApiKey(
  $: {
    env: { get: (name: string) => Promise<string | undefined> };
    settings: { read: () => Promise<Readonly<Record<string, unknown>>> };
  },
  config: HookConfig,
): Promise<string | undefined> {
  if (config.apiKey) return config.apiKey;
  const fromEnv = await $.env.get('TYPESAFE_API_KEY');
  if (fromEnv) return fromEnv;
  const settings = await $.settings.read();
  const env = settings['env'];
  if (env && typeof env === 'object') {
    const value = (env as Record<string, unknown>)['TYPESAFE_API_KEY'];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function log($: { ui: { log: (text: string) => void } }, text: string): void {
  try {
    $.ui.log(text);
  } catch {
    // Diagnostics are best-effort; the compaction result must still be returned.
  }
}

/** The context window's fill before compaction, or undefined where the host does not report it. */
async function contextPercent($: {
  session?: { usage?: () => Promise<{ context?: { percent?: number } }> };
}): Promise<number | undefined> {
  try {
    const usage = await $.session?.usage?.();
    const value = usage?.context?.percent;
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function notify(
  $: {
    ui: {
      log: (text: string) => void;
      toast: (text: string, options?: { timeoutMs?: number }) => void;
    };
  },
  text: string,
): void {
  log($, text);
  try {
    $.ui.toast(text, { timeoutMs: 15_000 });
  } catch {
    // A disconnected UI must not prevent the native fallback.
  }
}

/** The host's refusal of `$.session.compact` in a headless (-p / SDK) session. */
export function isHeadlessRefusal(error: unknown): boolean {
  return error instanceof Error && error.message.includes('not available in a headless');
}

export const register: Register = (on: On, options: PluginOptions) => {
  const configured = resolveHookConfig(options);
  let compacting = false;
  let retryAtPercent = 0;

  on('session.compact', async ($, event, next) => {
    if (event.agentId) return next(event);
    if (event.trigger === 'precompute') {
      return { skip: 'fast-jev-compaction does not handle speculative compactions' };
    }

    const giveUp = (why: string) => {
      if (mayUseBuiltin(event.trigger, configured.builtinFallback)) {
        notify($, `fallback to built-in summary (${why})`);
        return next(event);
      }
      notify($, `not compacted, no built-in summary (${why})`);
      const reason = why.length > 200 ? `${why.slice(0, 200)}…` : why;
      return { skip: `fast-jev-compaction: ${reason}; conversation left as it is` };
    };

    try {
      const config = { ...configured, apiKey: await getApiKey($, configured) };
      if (event.instructions?.trim()) {
        const goal = config.goal || goalFromMessages(event.messages);
        config.goal = `${goal}\n\nCompaction instructions: ${event.instructions}`;
      }
      const { result, messages } = await compactSession(event.messages, config, async (url, init) => {
        const response = await $.http.fetch(url, init);
        return { status: response.status, ok: response.ok, text: response.text };
      });
      for (const line of decisionLogLines(result)) log($, line);
      const outcome = verdict(result, config, await contextPercent($));
      const reason = fallbackReason(outcome, config);
      if (reason) {
        return giveUp(`${reason}: ${summarize(result)}`);
      }
      const note =
        outcome.kind === 'nothing_to_prune'
          ? `; candidates were ${percent(outcome.bound)} of the history, the rest is text`
          : '';
      notify(
        $,
        `kept ${messages.length}/${event.messages.length} messages, no summary (${summarize(result)}${note})`,
      );
      return { messages };
    } catch (error) {
      return giveUp(error instanceof Error ? error.message : String(error));
    }
  });

  on('turn.complete', async ($, event: TurnCompleteInput, next) => {
    if (event.agentId || event.reason !== 'answer' || compacting) return next(event);
    compacting = true;
    let used = 0;
    try {
      const { context } = await $.session.usage();
      used = context.percent ?? 0;
      if (used < configured.compactAtPercent) retryAtPercent = 0;
      if (used < Math.max(configured.compactAtPercent, retryAtPercent)) return next(event);
      const { skip } = await $.session.compact();
      retryAtPercent = skip === undefined ? 0 : used + RETRY_AFTER_SKIP_PERCENT;
    } catch (error) {
      if (isHeadlessRefusal(error)) {
        retryAtPercent = used + RETRY_AFTER_SKIP_PERCENT;
        void $.command.run({ command: 'compact' }).catch((queued: unknown) =>
          log($, `auto-compact skipped (${queued instanceof Error ? queued.message : String(queued)})`),
        );
        return next(event);
      }
      log($,
        `auto-compact skipped (${error instanceof Error ? error.message : String(error)})`,
      );
    } finally {
      compacting = false;
    }
    return next(event);
  });
};

export { resolveOptions };
