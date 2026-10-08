# Agent Harness Plugins

Composable CLM and RLM plugins for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), tested against **DSH 0.1.7-rc.2 and 0.2.0-rc.2**.

| Plugin | Responsibility | Implementation |
| --- | --- | --- |
| [CLM](packages/clm/README.md) | Let the model edit its effective conversation context | A session-scoped mirror committed through durable DSH surface replacements |
| [RLM](packages/rlm/README.md) | Keep computation state across cells and orchestrate recursive agents | A minimal composition of [dsh-prime-agent](https://github.com/yoke233/dsh-prime-agent) runtime and REPL |

The plugins can run separately or together. RLM owns live TypeScript variables; CLM owns model-request history edits. The RLM composition deliberately omits Prime's context manager and preset, so it preserves the existing headless runner, model configuration and host tools.

## Install

Requirements: Node.js 24+, npm, and an explicitly installed DSH version satisfying `>=0.1.7-rc.2 || >=0.2.0-rc.2`. The explicit 0.2.0 prerelease branch keeps npm peer checks aligned with DSH compatibility checks. DSH peer dependencies have no upper version bound; future incompatibilities are addressed with fixes. Development dependencies remain pinned for reproducible tests. No model credentials or provider settings are included.

```sh
git clone https://github.com/yellowbee686/agent-harness-plugin.git
cd agent-harness-plugin
npm ci --ignore-scripts
npm test
```

The RLM dependency is a locally patched archive based on upstream commit `4b5596a8661a6a78b4de0a63a5dfb75bd5d8a2b7` (version 0.6.3). [Patch provenance](packages/rlm/vendor/README.md) records the source/build change that removes the recursive generation cap. The lockfile records the complete dependency resolution. Nothing is installed into your default DSH profile by this setup.

## Run

Use an existing DSH profile with its model configured. For one invocation, pass absolute patch paths from this checkout:

```sh
# CLM with the profile's existing tools.
dsh --profile headless --patch "$PWD/packages/clm/cordis.patch.yml" "Your task"

# RLM: the profile must provide native subagent and jobs tools.
dsh --profile headless --patch "$PWD/packages/rlm/cordis.patch.yml" "Your task"

# Both capabilities in the same session.
dsh --profile headless \
  --patch "$PWD/packages/rlm/cordis.patch.yml" \
  --patch "$PWD/packages/clm/cordis.patch.yml" "Your task"
```

Set `DSH_HOME` to an isolated directory when trying a new composition. Add your own model/provider patch before these plugin patches. The plugins do not configure models, purchase API access, or upgrade DSH.

## Semantics and limits

- **CLM is an editable context interface, not a trained model.** It preserves user tasks and system/developer instructions. Its editable text blocks are narrower than arbitrary role/message rewriting in pi-clm. Accepted edits persist in the append-only session log and change subsequent model requests; they do not erase the original transcript.
- **RLM is a TypeScript runtime, not Prime's Python kernel.** Ordinary bindings live across cells in one Worker. Abort, timeout, process exit or Worker loss can destroy live state. Save important results to files for recovery.
- **Avoid competing context policies.** Do not also load `dsh-prime-agent/context-manager` or the full Prime preset. The host's native compaction policy is unchanged; if it changes the source surface, CLM rejects stale edits. Preserve useful variable names and artifact paths when editing context; CLM cannot reconstruct a lost runtime object.
- **No performance claims.** Neither paper accuracy/FLOPs results nor Python snapshot guarantees transfer to this composition. CLM does not implement training, Suffix Cache Reuse, or a serving backend.
- **Host permissions still apply.** A persistent execution environment is not a security sandbox.

## Validation

`npm test` runs CLM integration tests (including actual RLM composition), RLM integration tests and schema presentation regressions. They use real DSH services and the real persistent Worker, with a deterministic model adapter. Tests cover effective next-request edits, raw-history preservation and replay, protected messages, tool pairing, stale/invalid edits, parent/child isolation, plugin unload, cross-cell state, timeout state loss, native child-to-grandchild recursion, bounded MCP schema projection, foreground-only headless delegation, and validated structured child completion through the REPL. CLM also protects host user-role instructions and skill loads, and commits edits before native pruning without weakening stale checks.

The consuming host also exercised CLM, RLM, and their combination with Qwen 3.8 on real data. Those private business artifacts are not distributed here. This is functional validation, not a benchmark or a guarantee that a model will follow the protocol on every task. Required headless children must be awaited before the final answer; the RLM wrapper rejects background delegation but does not enforce child completion in the host lifecycle.

## Discoverability and attribution

DSH recommends the [`dsh-plugin` GitHub topic](https://github.com/topics/dsh-plugin) for plugin discovery. Existing RLM implementations include [yoke233/dsh-prime-agent](https://github.com/yoke233/dsh-prime-agent) and [OpenCnid/deepseek-rlm](https://github.com/OpenCnid/deepseek-rlm). This repository reuses the former rather than reimplementing its runtime.

CLM draws on the editable-context approach of [Context Language Models](https://github.com/facebookresearch/context-language-models) and [pi-clm](https://github.com/lolipopshock/pi-clm). See package READMEs for exact contracts and tests, and [RLM third-party notices](packages/rlm/THIRD_PARTY_NOTICES.md) for upstream attribution.

MIT licensed. This is an independent community project, not an official DeepSeek plugin.
