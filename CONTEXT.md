# fast-jev-compaction

Shrinks an agent conversation by asking Jev which tool calls and tool results are still needed, then dropping or truncating the rest. Everything kept stays verbatim.

## Conversation

**Dialogue text**:
The text of user-role and assistant-role messages, including text the host injects into user-role messages (system reminders, task notifications, command echoes, `!` command output). Never modified by compaction.
_Avoid_: prose, narration, chat text

**Host notice**:
Text Claude Code injects into a user-role message that the user did not type. Part of the dialogue text; excluded only when inferring the goal.
_Avoid_: system text, harness text

**Tool call**:
A `tool_use` block together with its input, identified by `tool_use_id`.
_Avoid_: tool use, invocation

**Tool result**:
The output paired with a tool call by `tool_use_id`.
_Avoid_: tool output, response

**Pending call**:
A tool call whose tool result has not arrived yet.
_Avoid_: unresolved call, orphan call

**Pinned call**:
A tool call in the first message or in the newest `preserveRecentMessages` messages; never scored and never touched.
_Avoid_: protected call, recent call

## Decisions

**State**:
The whole conversation, oldest first, fitted into a token budget with tool results reduced to a short note, sent to Jev with every request.
_Avoid_: context, snapshot, summary

**Keep-call score**:
Jev's probability that knowing a tool call was made, with its input, still matters.

**Keep-result score**:
Jev's probability that a tool result's full contents are still needed and re-running the tool would not do.

**Keep**:
The outcome where a tool call and its tool result both stay verbatim.

**Truncate**:
The outcome where the tool call stays and its tool result is cut to a head plus a one-line note.
_Avoid_: trim, shorten, stub

**Drop**:
The outcome where a tool call and its tool result are both removed.
_Avoid_: delete, prune, remove

**Verbatim promise**:
Compaction only keeps, truncates, or drops tool calls and tool results; it never rewrites or annotates dialogue text. Notes may appear only inside a truncated tool result.

**Fallback summary**:
Claude Code's built-in LLM summary, used instead of Jev compaction only when Claude Code's own auto compaction cannot be satisfied by Jev; a manual or plugin-requested compaction that Jev cannot satisfy leaves the conversation unchanged.
_Avoid_: built-in compaction, default compaction
