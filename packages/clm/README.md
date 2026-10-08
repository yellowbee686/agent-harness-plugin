# DSH CLM

An optional Cordis plugin for **DSH >=0.1.7-rc.2**, tested against 0.1.7-rc.2 and 0.2.0-rc.2. The model edits a per-session JSON context mirror through ordinary filesystem tools or a filesystem-capable REPL. Accepted edits change subsequent model requests through DSH's durable surface replacements.

## Enable

From this repository after `npm install`:

```sh
npx dsh headless --patch packages/clm/cordis.patch.yml "your task"
```

The patch's `./index.mjs` resolves relative to the patch file, including when the patch is passed by absolute path. With the RLM integration, pass its patch first and this patch second. This plugin contributes `clm:editable-context`, so Prime's removal of `tool:` prompt sections does not remove the CLM protocol. The RLM patch must disable Prime's competing context manager.

The default mirror lives at `<session cwd>/.dsh/clm/<sha256 session id>/LIVE_CONTEXT.json`. The system prompt gives the exact path. Custom plugin configuration:

```yaml
- insert:
    - id: yellowbee-clm
      name: ./index.mjs
      config:
        directory: .dsh/clm
        maxBytes: 4194304
```

`directory` is resolved against the session working directory. Different sessions use different files. Use one process writer per session, as required by DSH session ownership. Add `.dsh/` to the consuming project's ignore rules if appropriate.

## Optional strategy document

The editing protocol is always present. Context-management strategy is a separate
Markdown document and is **off by default**:

```sh
DSH_CLM_STEERING=on npx dsh headless --patch packages/clm/cordis.patch.yml "your task"
DSH_CLM_STEERING=/absolute/path/strategy.md npx dsh headless --patch packages/clm/cordis.patch.yml "your task"
```

`on` loads `steering/efficient-context.md`; `off` keeps only the protocol. The Cordis
config field `steering` accepts the same values and takes precedence over the environment.
The document is read once at plugin startup and injected as `clm:steering` into main
and child agents, with its path and SHA-256. Missing or empty documents fail explicitly.
`DSH_CLM_STEERING_SHA256`, when set by a launcher, rejects changed content before use.
The built-in strategy guides selective plain-text replacement, evidence retention,
bounded inspection, and batched edits. It does not add token estimation, a shrink gate,
or change the mirror acceptance protocol. Token savings still require evaluation.

## Editing contract

Read the mirror, change only `blocks[i].text` where `editable` is `true`, then write valid JSON. Keep every other field, block, and ordering intact. Complete the read-modify-write in **one tool call or REPL cell**; never reuse a mirror object cached across cells. Business data can remain in the REPL, but mirror revisions change per request. For example, in Prime's REPL after setting `path` to the path in the prompt:

```js
const page = await tools.read({ file_path: path });
const document = JSON.parse(page.lines.map(line => line.text).join('\n'));
const block = document.blocks.find(b => b.editable && b.text.includes('long evidence'));
block.text = 'Key finding: the parser requires quoted CSV fields.';
await tools.write({ file_path: path, content: JSON.stringify(document, null, 2) });
```

Prime exposes host filesystem capabilities through `tools.read`, `tools.write`, and `tools.bash`; it does not allow `import('node:fs')`. For large mirrors, use a single `tools.bash` call running a Python read-modify-write script to avoid paginated/truncated read output. Native-tool agents can use the same shell pattern.

- Unchanged blocks keep their original structured messages, roles, and tool calls.
- An edited block becomes one plain user-role context note. It cannot create privileged system/developer instructions or executable tool calls.
- An assistant tool-call message and all its tool results form one indivisible block. Incomplete or orphaned tool groups are not editable.
- Actual system/developer messages are outside the mirror. All user-role messages except CLM working notes (`source.kind: dsh-clm`) are read-only. This includes user tasks, project instructions, runtime context, catalogs, and unknown host sources. Complete tool groups that load skills are also read-only, including loads recorded through PTC/REPL dispatch provenance; this protection survives replay.
- Empty text becomes a short omission marker. Growth is allowed. `maxBytes` bounds edited file size; it is **not a token-budget or context-window guarantee**. DSH's existing compaction/overflow policies remain in force.
- Malformed JSON, oversized files, altered metadata, removed/reordered blocks, old revisions, and changed source surfaces are rejected. A raw suffix appended after the snapshot remains intact.
- The refreshed `status` field reports acceptance or rejection. Refresh happens before the next main model request; edits made in a final turn are applied at the next step. Do not rely on edits that have not yet been accepted before shutdown.

This is a restricted text-block CLM, **not pi-clm's unrestricted mode**. It does not insert/reorder arbitrary messages, edit user tasks, preserve edited assistant/tool roles, implement learned context policies, estimate tokens, implement Suffix Cache Reuse, or persist live REPL objects.

## Runtime and durability

`agent/created` registers a scoped prompt section and creates a fresh mirror. `llm/stream` only observes the frozen main request to refresh the mirror; it never mutates stream options. `agent/pre-step` uses a prepended hook to validate and commit completed edits before host automatic pruning. Stale source validation remains strict; external changes that already happened still reject the edit. A later admission rejection does not undo an accepted durable edit. The hook appends standard `user/message` events with `surfaceOp: replace` and complete `sourceEventSeqs`. Each accepted block is a DSH append transaction. Changed steps start a new request series.

Raw events remain in the append-only log. DSH replay reconstructs accepted replacements even without this plugin; there is no custom required event type or independent checkpoint database. The mirror itself is disposable, and a new agent lifecycle overwrites old unaccepted files from durable history. Disk durability uses the host's configured DSH session persistence/checkpoint policy. A crash in the middle of several block commits can preserve a subset of independently valid edits; the next lifecycle recovers the actual committed surface.

Concurrent writes to one mirror are unsupported; finish and await filesystem edits before returning from the tool. Mirrors are retained locally after disposal and may contain conversation data. The implementation uses the public `Session.eventAt` read API available in the tested releases; upstream marks this API deprecated, so future API changes may require compatibility fixes.

Publishing filesystem failures fail the agent request instead of silently disabling context editing. A published mirror can exceed `maxBytes` when raw history is large; an edited candidate must be reduced below the limit to be accepted.

## Verification

```sh
npm test --workspace=@yellowbee686/dsh-clm
```

Tests mount real Cordis, DSH AgentLoop, SessionStore, prompt and tool services from the pinned published packages. Only the model adapter is scripted. They verify raw history versus effective next provider request, tool-initiated filesystem editing, serialized event replay into a fresh runtime, concurrent session isolation, malformed/stale/oversized edits, protected system/developer/user and host instruction messages, native/REPL skill loads, acceptance before real native tool-result pruning, tool grouping, repeated edits, growth, omission, and plugin unload cleanup. The repository combination test mounts the real RLM worker and DSH filesystem tools, edits the mirror through `tools.read`/`tools.write`, and verifies a retained `Map` still returns 42 after the accepted context replacement.

These are in-process integration tests, not live-model, production-sandbox, benchmark, or business-outcome evidence. The repository-level validation may add separate Qwen 3.8 runs.
