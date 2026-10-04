# RLM composition for DSH headless

This package reuses [dsh-prime-agent 0.6.3](https://github.com/yoke233/dsh-prime-agent/tree/4b5596a8661a6a78b4de0a63a5dfb75bd5d8a2b7) on DSH **0.1.7-rc.2**. It mounts the upstream runtime and control plane directly into the existing headless composition. It does not install the upstream Prime preset or evaluation runner shim.

Apply `cordis.patch.yml` after the host's ordinary model/tool configuration. The patch preserves the headless runner, model provider and MCP registrations. It selects native tool presentation, then the upstream plugin exposes `repl` as the only model-facing tool. Host capabilities remain available inside `repl` through the generated `tools.*` declarations.

```ts
// First cell: ordinary TypeScript bindings stay alive.
let records = new Map([['first', { value: 42 }]])
let readValue = () => records.get('first').value
readValue()

// A later cell in this session:
records.set('second', { value: 7 })
;({ count: records.size, original: readValue() })
```

This is a persistent **TypeScript Realm**, not a Python/IPython kernel. Imports and `require` are unavailable. Functions, classes, Maps and ordinary bindings persist in the live worker; only displayed output enters the conversation.

## Recursive work and route ownership

- `agents.query` and `agents.queryMany` run bounded, stateless sub-model calls using the current agent's model route. Their input can come from retained variables, and results remain in the Realm until displayed.
- `agents.spawn` and `agents.fork` use the existing DSH subagent tools. Native in-process children have their own sessions and Realms, inherit this composition, and can recursively delegate within the host's depth limits.
- Keep native subagent tools enabled. This composition retains the upstream `requireOrchestrationTools: true` check and requires spawn/fork, list/send/interrupt, and job list/output/kill capabilities. Missing capabilities fail during prompt assembly.
- Credentials, model endpoints, permission policy, and child-depth limits belong to the host configuration. This package defines none.

## Headless completion

The wrapper adds one prompt section for headless completion. Required child work must use `await agents.spawn({ description, prompt, run_in_background: false })` (or `agents.fork`) and its returned output must be incorporated before the final answer. Parallel required calls can be awaited together with `Promise.allSettled`. `agents.send` acknowledges delivery, and `agents.list` reports status; neither waits for a report. There is no `agents.wait` or `agents.join` API. A final answer can end the host process and stop background children, so waiting commentary and unfinished drafts must not be presented as completion.

The wrapper requires explicit `run_in_background: false` for native spawn/fork calls. It rejects both `true` and omission, since a host's continuable tool can default to background execution. It does not silently convert the request or block final answers. Verify the final artifact and child result in real model tests.

A structured one-shot child must submit its schema-valid result with `await tools.structured_output(result)` as the last operation in a REPL cell. The wrapper restores this child-specific completion instruction after Prime removes native tool prompt sections. The host still owns schema validation and captures the result only after the enclosing REPL execution succeeds. Ordinary agents do not receive this instruction.

## Tool schema presentation

The pinned DSH SDK renders an entire tool argument type as `unknown` when a JSON Schema contains value constraints such as `minimum` or `maxItems`. This composition repairs failed declarations after Prime assembles its SDK. A detached presentation copy places those constraints in documentation while retaining property names, required fields, enums and array types. Registered MCP schemas and runtime validation remain unchanged.

Schemas whose structure still cannot be projected retain `unknown` with an explicit original JSON Schema fallback. The adapter preserves Prime's guidance, agents/jobs aliases and the host's visible capability scope. A changed SDK layout fails visibly rather than dropping declarations silently.

## Context ownership and lifetime

The upstream `context-manager` and `new_context` tools are intentionally not mounted. RLM alone uses the host's existing context management. With the CLM package enabled, CLM owns context replacement and RLM owns only live computation state. A conversation-context replacement does not serialize, clone, or reset the Realm.

The reused control plane also includes upstream `refine.status()` / `refine.run()` and local learning notes. `refine.run()` explicitly schedules a bounded model review; global refinement is disabled. This is separate from CLM conversation compaction.

State and identity files live under `dshHomePath('agent-harness-plugin', 'rlm')`. A running worker retains variables only within its owning process/session. Hard cancellation, timeout, heap failure, idle reclamation, or process exit may destroy variables. The next cell reports an explicit empty/restarted namespace notice; disk identity files are **not** a heap checkpoint. Save irreplaceable data to files and rebuild bindings after a loss notice.

The default upstream limits include a 10-minute idle lifetime and a pool of 32 active Realms. Use the upstream runtime configuration fields on the `harness-rlm-runtime` patch row when another bounded deployment policy is required.

## Validation

`npm test --workspace @yellowbee686/dsh-rlm` exercises the installed upstream worker through DSH's actual tool dispatcher, verifies cross-cell state and session isolation, and verifies explicit state loss after timeout. The recursive integration uses the real native child provider with deterministic model responses; it verifies runtime composition, not model quality or an external API. Real model/business-task verification belongs to the host integration.

See [third-party attribution](THIRD_PARTY_NOTICES.md). Upstream code is pinned and unmodified.
