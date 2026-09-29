import { JevError, JevResponseError, noulAnswer } from './request.js';
import {
  collectToolCalls,
  estimateTokens,
  fitState,
  truncationNote,
} from './state.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  CompactResult,
  CompactionState,
  JevAsker,
  JevQuestions,
  JevResponse,
  Message,
  ResolvedCompactOptions,
  ToolCall,
  ToolUse,
} from './types.js';

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: '',
  /**
   * A Noul of 0.5 is Jev saying it is unsure, not "half". Distance from 0.5 is
   * the confidence signal, so a threshold of 0.5 puts every uncertain answer on
   * the truncate side. Observed keep-result scores sit between 0.06 and 0.37,
   * so only a low floor lets any result stay verbatim.
   */
  keepThreshold: 0.15,
  /**
   * The gate for the *call*, separate from the gate for the *result*.
   *
   * `keepCall` and `keepResult` are two independent nouls; their absolute
   * scales are not comparable, so one threshold cannot serve both
   * (https://docs.typesafe.ai/model-jaggedness/jev-1.13 — "don't rely on
   * expected structural invariance"). They also carry very different costs:
   * a result runs to thousands of characters, its call to a few dozen. Losing
   * the call loses the record that the work happened at all, for savings that
   * round to zero — so this gate sits far lower than the result's.
   */
  keepCallThreshold: 0.05,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  maxConcurrentRequests: 4,
  truncateHeadChars: 300,
  retries: 2,
  retryDelayMs: 500,
  onBatchFailure: 'throw',
  sleep: defaultSleep,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

/** A timer where the host has one; no wait at all where it does not. */
function defaultSleep(ms: number): Promise<void> {
  const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout;
  if (ms <= 0 || typeof timer !== 'function') return Promise.resolve();
  return new Promise((resolve) => timer(resolve, ms));
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  const keepThreshold = finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold);
  if (keepThreshold < 0 || keepThreshold > 1) {
    throw new RangeError('keepThreshold must be between 0 and 1');
  }
  const keepCallThreshold = finite(options.keepCallThreshold, DEFAULT_OPTIONS.keepCallThreshold);
  if (keepCallThreshold < 0 || keepCallThreshold > 1) {
    throw new RangeError('keepCallThreshold must be between 0 and 1');
  }
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold,
    keepCallThreshold,
    preserveRecentMessages: Math.max(
      0,
      Math.floor(
        finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages),
      ),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    maxConcurrentRequests: Math.max(
      1, Math.floor(finite(options.maxConcurrentRequests, DEFAULT_OPTIONS.maxConcurrentRequests)),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
    retries: Math.max(0, Math.floor(finite(options.retries, DEFAULT_OPTIONS.retries))),
    retryDelayMs: Math.max(0, finite(options.retryDelayMs, DEFAULT_OPTIONS.retryDelayMs)),
    onBatchFailure: options.onBatchFailure === 'keep' ? 'keep' : DEFAULT_OPTIONS.onBatchFailure,
    sleep: options.sleep ?? DEFAULT_OPTIONS.sleep,
  };
}

/**
 * The `noul` questions asked about one call: keep the call, keep its result.
 * Both carry criteria, because the boundary is subtle and the docs ask for
 * `true`/`false` sides whenever it is: https://docs.typesafe.ai/primitives/noul.
 * A result an earlier round already cut to a head is not asked about again;
 * there is no full output left to keep.
 */
export function questionsFor(call: ToolCall): JevQuestions {
  const questions: JevQuestions = {
    [`call_${call.id}`]: {
      type: 'noul',
      instructions: `Tool call \`${call.id}\` (${call.tool}) should stay in \`history\`: knowing this call was made, with its input, still matters for what the assistant does next`,
      criteria: {
        true: 'The call records a change to the world, or a constraint the assistant must not violate again: an edit or write that changed a file, a command that installed, moved or deleted something, a check whose outcome the user was told about',
        false: 'The call only gathered information that has since been superseded or acted upon: a search used to locate a file that was then edited, a read of a file that has since changed, a failing check that has since been fixed',
      },
    },
  };
  if (call.originalChars === undefined) {
    questions[`result_${call.id}`] = {
      type: 'noul',
      instructions: `The full output of tool call \`${call.id}\` (${call.tool}, ${call.resultChars} chars) should stay in \`history\` verbatim: the assistant still needs its contents, and re-running the tool would not do`,
      criteria: {
        true: 'The exact contents are still in use and could not be recovered by re-running the tool: an error the assistant is still diagnosing, output the user asked about, the current state of a file being edited',
        false: 'The contents are stale, already stated in the assistant text, or trivially re-obtainable: a directory listing already used, a passing test run, a file read before it was rewritten',
      },
    };
  }
  return questions;
}

/**
 * Splits the candidate calls into batches whose questions, together with the
 * (always complete) state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, 'maxRequestTokens'>,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, 'id' | 'tool' | 'pinned'>,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, 'keepThreshold'> &
    Partial<Pick<ResolvedCompactOptions, 'keepCallThreshold'>>,
): CallDecision {
  if (!Number.isFinite(options.keepThreshold) || options.keepThreshold < 0 || options.keepThreshold > 1) {
    throw new RangeError('keepThreshold must be between 0 and 1');
  }
  if (![answer.keepCall, answer.keepResult].every(value =>
    Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error('Invalid keep probabilities');
  }
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: 'keep', reason: 'pinned' };
  const callThreshold = finite(options.keepCallThreshold, DEFAULT_OPTIONS.keepCallThreshold);
  if (answer.keepResult >= options.keepThreshold) {
    return { ...base, action: 'keep', reason: 'kept' };
  }
  if (answer.keepCall >= callThreshold) {
    return { ...base, action: 'drop_result', reason: 'result_dropped' };
  }
  return { ...base, action: 'drop_call', reason: 'call_dropped' };
}

/** A failure worth another attempt: a 429/5xx, or the transport failing before a status came back. */
function transient(error: unknown): boolean {
  return error instanceof JevError && error.retryable;
}

/** What `onBatchFailure: 'keep'` may keep: a hiccup that outlived its retries, or a bad answer. */
function keepable(error: unknown): boolean {
  return transient(error) || error instanceof JevResponseError;
}

interface BatchTally {
  retries: number;
  failedBatches: number;
}

type RetryOptions = Pick<ResolvedCompactOptions, 'retries' | 'retryDelayMs' | 'sleep'>;

/** One request, retried on transient failures; an interrupted wait rejects with its reason. */
async function askWithRetries(
  asker: JevAsker,
  state: CompactionState,
  questions: JevQuestions,
  options: RetryOptions,
  tally: BatchTally,
): Promise<JevResponse> {
  let delay = options.retryDelayMs;
  for (let attempt = 0; ; attempt++) {
    try {
      return await asker.ask(state, questions);
    } catch (error) {
      if (attempt >= options.retries || !transient(error)) throw error;
    }
    tally.retries += 1;
    await options.sleep(delay);
    delay *= 3;
  }
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
  options: RetryOptions,
  tally: BatchTally,
): Promise<Map<string, CallAnswer>> {
  const questions: JevQuestions = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await askWithRetries(asker, state, questions, options, tally);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult:
          call.originalChars === undefined ? noulAnswer(answers, `result_${call.id}`) : 0,
      },
    ]),
  );
}

/** Keep failures atomic while avoiding an unbounded burst of HTTP requests. */
async function askBatches(
  asker: JevAsker,
  state: CompactionState,
  batches: readonly ToolCall[][],
  options: ResolvedCompactOptions,
  tally: BatchTally,
): Promise<Map<string, CallAnswer>[]> {
  const concurrency = options.maxConcurrentRequests;
  const answers: Map<string, CallAnswer>[] = new Array(batches.length);
  let cursor = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && cursor < batches.length) {
      const index = cursor++;
      try {
        answers[index] = await askBatch(asker, state, batches[index]!, options, tally);
      } catch (error) {
        if (options.onBatchFailure === 'keep' && keepable(error)) {
          tally.failedBatches += 1;
          continue;
        }
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  if (failed) throw failure;
  return answers.filter(Boolean);
}

/** Whether ending `text` at `index` would separate the two halves of a surrogate pair. */
function splitsSurrogatePair(text: string, index: number): boolean {
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const cut = splitsSurrogatePair(text, headChars) ? headChars - 1 : headChars;
  const head = cut > 0 ? `${text.slice(0, cut)}\n` : '';
  return `${head}${truncationNote(text.length - cut, isError)}`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears
 * together with its result; a dropped result keeps a bounded head and note.
 * Messages that lose all their content are removed; untouched messages are
 * returned as the same objects they came in as.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallDecision['action']>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && !call.pinned && decision.action !== 'keep') actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses
      .filter((tool) => actions.get(tool.tool_use_id) !== 'drop_call')
      .map((tool) => {
        if (actions.get(tool.tool_use_id) !== 'drop_result') return tool;
        const text = truncatedResultText(
          tool.text ?? '',
          tool.isError ?? false,
          headChars,
        );
        if ((tool.text ?? '') === text) return tool;
        const copy: ToolUse = {
          tool_use_id: tool.tool_use_id,
          tool: tool.tool,
          input: tool.input,
          text,
        };
        if (tool.isError) copy.isError = true;
        return copy;
      });
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== 'drop_call')
      .map((result) => {
        if (actions.get(result.tool_use_id) !== 'drop_result') return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text
          ? result
          : {
              tool_use_id: result.tool_use_id,
              text,
              isError: result.isError,
            };
      });
    if (
      !message.toolUses.some(
        (tool) => actions.get(tool.tool_use_id) === 'drop_call',
      ) &&
      !(message.toolResults ?? []).some(
        (result) => actions.get(result.tool_use_id) === 'drop_call',
      ) &&
      toolUses.every((tool, index) => tool === message.toolUses[index]) &&
      toolResults.every(
        (result, index) => result === message.toolResults?.[index],
      )
    ) {
      kept.push(message);
      continue;
    }
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

/** The reduction dropping every candidate would give: the most a round can free. */
export function reductionBound(result: Pick<CompactResult, 'stats'>): number {
  const { charsBefore, candidateChars } = result.stats;
  return charsBefore === 0 ? 0 : candidateChars / charsBefore;
}

function inputChars(call: Pick<ToolCall, 'input'>): number {
  try {
    return JSON.stringify(call.input).length;
  } catch {
    return 20;
  }
}

function count(decisions: readonly CallDecision[], reason: CallDecision['reason']): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned
 * first and newest messages, whether the call and whether its result must
 * stay. The whole history (results omitted, fitted into `maxStateTokens`) is
 * sent as state with every batch of questions. Throws when Jev fails or the
 * history cannot be fitted; the caller decides whether to fall back.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: '' };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  const tally: BatchTally = { retries: 0, failedBatches: 0 };
  if (candidates.length > 0) {
    const largestQuestion = candidates.reduce((largest, call) => Math.max(
      largest, estimateTokens(JSON.stringify(questionsFor(call))),
    ), 0);
    const stateBudget = resolved.maxRequestTokens - REQUEST_OVERHEAD_TOKENS - largestQuestion;
    if (stateBudget < 1) throw new Error('request budget leaves no room for state and questions');
    const state = fitState(messages, calls, {
      ...resolved,
      maxStateTokens: Math.min(resolved.maxStateTokens, stateBudget),
    });
    fitted = state;
    batches = batchCalls(candidates, state.tokens, resolved);
    const answered = await askBatches(asker, state.state, batches, resolved, tally);
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(
    messages,
    decisions,
    calls,
    resolved.truncateHeadChars,
  );
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, 'kept'),
      resultsDropped: count(decisions, 'result_dropped'),
      callsDropped: count(decisions, 'call_dropped'),
      pinned: count(decisions, 'pinned'),
      candidateChars: candidates.reduce(
        (sum, call) => sum + inputChars(call) + call.resultChars,
        0,
      ),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      retries: tally.retries,
      failedBatches: tally.failedBatches,
      ms: Date.now() - started,
    },
  };
}
