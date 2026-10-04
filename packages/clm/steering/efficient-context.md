Use editable context to preserve reliable working state while reducing material
that future requests must read. Acceptance alone does not establish a saving.

At a completed work stage, consider one batched edit when substantial consumed
tool output, duplicate text, or superseded exploration will otherwise remain for
several more requests. First identify the remaining business step that will use
the summary. If you can answer now, answer without a context edit; hypothetical
future follow-up questions are not a reason to compress at the end of a task.
Do not edit merely to demonstrate that CLM is available.

Replace stale evidence with a self-contained plain-text summary. Do not append
notes to the original transcript or serialize message objects into the summary.
The outer mirror is JSON. Existing block text may contain multiple JSON messages
separated by newlines; it is not necessarily one JSON value. Replacement text
does not need role/source/id/tool-call/usage wrappers.

Keep exact findings and units, their source paths or IDs, decisions and reasons,
failed approaches that should not be repeated, unresolved uncertainty, and the
next action. Preserve exact evidence when it is still needed. Before removing
details needed later, verify that a durable file contains them and retain a
usable path and lookup key. Do not turn missing data into zero or an uncertain
finding into a verified fact.

Keep observations, hypotheses, and unavailable evidence separate. Preserve the
population and time window, timezone, measurement unit, aggregation formula,
identity/role filters, and sampling or coverage limits needed to reproduce a
number. A failed extraction is not a negative finding; retain the failed scope
and recovery status. Verify calculations against saved evidence before placing
them in a summary that later steps will treat as working state.

Leave project instructions, permissions, runtime configuration, and tool/skill
catalog blocks unchanged even if marked editable. Use completed analysis blocks
for working notes. Update an existing note's meaning instead of nesting its old
message JSON or appending another copy.
Loaded skill instructions remain active rules, not consumed analysis evidence;
preserve them, including when loaded inside a REPL cell.

Read the mirror inside a local script; never print the entire mirror. If needed,
print only a bounded index of blocks and short previews. Re-read the current
revision and finish all replacements in one tool call or REPL cell. Retain all
metadata, block membership and order. In the REPL use the available filesystem
tools; do not assume node:fs imports are supported.

For example, after selecting a stale editable analysis block from the current
document, assign block.text directly to a note containing the verified finding,
source path and lookup key, uncertainty, and next action. Serialize the outer
document once. Never serialize the old message into that note.

Prefer a meaningful reduction across the edited batch. Growth is appropriate
when needed to correct or restore essential state, not as routine note-taking.
Edits can invalidate prefix caching after the first changed region: avoid tiny
early edits before a long useful tail, and batch changes where possible.
Check only the refreshed status during subsequent work. Acceptance confirms
application, not token savings. Do not add repeated verification calls or new
subagents merely to manage the mirror.
Keep mirror paths, revisions, acceptance status, and context-maintenance narration
out of the business answer unless the user explicitly asks about that mechanism.
