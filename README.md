# fast-jev-compaction

## this project is just the main repo with all PR's reviewed and merged. I will be accepting most PR's after reviewed and will keep this fork maintained.

Claude Code plugin that replaces the compaction summary with Jev decisions:
every tool call and result is scored in one fast request, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and a Claude Code plugin
(`hooks/`, `.claude-plugin/`) that uses the package to replace Claude Code's
built-in compaction summary with the original messages.

## Data sent to the endpoint

The plugin posts each decision request to
`https://api.typesafe.ai/v1/systemone` with the configured API key as bearer
authorization. When using the library directly, a supplied `baseUrl` changes
the destination. Each request contains a fitted conversation state and a batch
of questions. The state includes user and assistant text, tool names, and tool
inputs, with the values of credential-named fields (for example
`authorization`, `*token`, `*secret`, `apiKey`) replaced by `[REDACTED]`.
Inputs can be shortened to fit; tool-result bodies are replaced by
status and character-count notes, and older text may be abridged or omitted as
described below. If questions require multiple requests, each request resends
the same fitted state. This is an external service: only enable the plugin for
session data you are authorized to send to that endpoint.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included with credential-shaped fields redacted, texts are
   included, and nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (60k by default). Jev 1.13 currently documents
   64k tokens for the whole request and 32k for `state` plus the longest
   question; the state is fitted so it plus the longest question stays under
   32k, and the default request budget stays under 64k. The same full state is resent with
   every request; requests run concurrently and their answers are merged.
6. Decisions per call. The result is gated by `keepThreshold`, the call by its
   own, much lower `keepCallThreshold`:
   - `keepResult ≥ keepThreshold` → keep call and result;
   - else `keepCall ≥ keepCallThreshold` → keep the call, truncate the result to
     its first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.

   The two gates are separate because the two nouls are separate questions.
   Their absolute scales are not comparable — each is an independent
   probability, and one can sit low while the other sits high — so a single
   threshold silently applies one question's calibration to the other. They also
   carry very different costs: a result runs to thousands of characters, its
   call to a few dozen. Dropping a call reclaims almost nothing and erases the
   record that the work happened, leaving the assistant's own narration of it
   standing with no evidence behind it. So the call gate sits far lower: a call
   goes only when Jev is fairly sure it is spent. To reclaim the last bytes of a
   call whose result is gone, set `truncateHeadChars: 0` — the call and its note
   survive, the result body does not.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

A 429, a 5xx or a failed fetch (`JevTransportError`, unless it was an abort or
an unparsable URL) is retried `retries` times with a tripling delay; a timeout
is not retried. By default (`onBatchFailure: 'throw'`) any batch that still
fails, a malformed answer, a missing key, or a history that cannot be fitted
throws, and the caller (or the Claude Code hook) decides what to fall back to.
With `onBatchFailure: 'keep'`, a batch that outlived its retries or came back
malformed keeps its calls whole, is counted in `stats.failedBatches`, and the
other batches' answers apply.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.15` | Minimum keep probability for a tool *result* to stay verbatim |
| `keepCallThreshold` | `0.05` | Minimum keep probability for the tool *call* to stay; below it the call goes with its result |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `60000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |
| `retries` | `2` | Further attempts per request after a 429, a 5xx or a `JevTransportError`; nothing else is retried |
| `retryDelayMs` | `500` | Wait before the first retry, tripled on each further one |
| `onBatchFailure` | `throw` | `throw` rejects the compaction when a batch fails after its retries; `keep` leaves that batch whole and applies the rest |
| `sleep` | `setTimeout` | Injectable wait between retries, for hosts without a timer |
| `archive` | none | Called for each result that is actually truncated; the returned path is cited in its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.
- Tool-input redaction is based on credential-shaped field names. Secrets in
  free-form text or embedded inside command/content strings are not detected.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and,
when Claude Code's own automatic compaction has to shrink the conversation,
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

The plugin can also trim long Bash output before it reaches the model
(`bashOutput`, off by default). Jev scores 20-line chunks; the first and last
chunks, chunks that look like errors, JSON, diffs and whole-file commands such
as `cat`, `jq` or `git diff` are never trimmed, and each discarded run becomes
a marker pointing to the full output saved under the project's
`.claude/fast-jev-compaction/` directory (ignored by a local `.gitignore`).
Output that looks like credentials is trimmed but never saved. With
`archiveResults` (also off by default), tool results that compaction truncates
are saved there too and their note cites the file.

Replacement depends on the early-access function event `session.compact`, whose
hook can return replacement `messages`. This is distinct from command hooks
such as `PreCompact` and `PostCompact`; those hooks alone do not return the
replacement messages this plugin needs. The host must support and load the
function-hook interface. If it is unavailable, this plugin cannot replace the
summary; if a loaded hook errors or removes too little, Claude Code's own
automatic compaction falls back to the normal summary and a `/compact` leaves
the conversation as it is (see `builtinFallback`).

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add TaylorWatson/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary. When Jev could not remove enough (short
sessions, or when it fails) it reads `fallback to built-in summary (…)` during
Claude Code's automatic compaction, and `not compacted, no built-in summary (…)`
on `/compact` or the plugin's own request, which leave the conversation as it
is; `builtinFallback` changes which compactions fall back.

To turn on Bash output trimming, run `/plugin configure fast-jev-compaction`
inside Claude Code, or set it in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "fast-jev-compaction@fast-jev-compaction": { "options": { "bashOutput": true } } } }
```

then `/reload-plugins`.

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Animated demo (macOS)

`demo/JevDemo` is a small native SwiftUI app that plays a scripted, dramatized
version of the compaction flow inside a Claude Code-style terminal: the tool
calls of a canned transcript are scored, results and calls Jev lets go turn red
and collapse away, and the rest stays verbatim. It never calls the API; it
exists to be screen recorded.

```sh
demo/JevDemo/build.sh   # builds demo/JevDemo/build/JevDemo.app and launches it
```

Press space in the app to replay from the start.
