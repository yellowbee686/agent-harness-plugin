# dsh-prime-agent generation-policy patch

The checked-in `dsh-prime-agent-0.6.3.tgz` is a patched dependency, not the unmodified upstream release. Base: `yoke233/dsh-prime-agent` commit `4b5596a8661a6a78b4de0a63a5dfb75bd5d8a2b7`. `dsh-prime-agent.patch` contains source, generated declarations/JavaScript, tests and documentation changes. The npm lockfile verifies the archive integrity. Installation needs no postinstall mutation; `npm ci --ignore-scripts` installs the tested artifact.

The patch removes `llm.maxTokens` from plugin configuration. `agents.query` and `queryMany` omit generation options when not specified, so DSH applies the selected model's defaults. Explicit positive integer `maxTokens` values pass through without silent clamping. Model/provider constraints still apply. Prompt-size, batch-size, concurrency, cancellation, session identity, and partial-generation status retain their existing semantics.

This follows the separation observed in Prime Agent commit `41e1f41c072e8f31ac6a79ad1b7fe19920c6d61f`: Python `rlm.spawn` has no token-budget parameter and inherits its model/thinking selection. Prime's shared provider layer itself has a default `min(model.max_tokens, 32000)`; this patch does not copy that provider policy into DSH. Prime has full recursive agents, while these stateless query bindings are a DSH-specific extension.

To rebuild: check out the exact base commit, apply the patch, run `npm ci --ignore-scripts`, `npm run check`, and `npx vitest run --config vitest.integration.config.ts tests/llm-binding.integration.spec.ts`. Run `npm pack --ignore-scripts --pack-destination <this directory>` and update the consuming lockfile. Do not modify a running experiment's installed dependency.
