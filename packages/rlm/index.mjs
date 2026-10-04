import { apply as applyPrime } from 'dsh-prime-agent';
import { installSchemaPresentation } from './schema-presentation.mjs';

export { name, inject, Config } from 'dsh-prime-agent';

export const HEADLESS_COMPLETION_SECTION = 'agent-harness-plugin:headless-completion';

export const HEADLESS_COMPLETION_GUIDANCE = `Complete this headless task before giving your final answer. The process may exit after your final answer and stop unfinished children; completion notifications cannot keep it alive.
For every delegated result needed by this task, call await agents.spawn({ description, prompt, run_in_background: false }) or await agents.fork({ description, prompt, run_in_background: false }). Read the returned output, finish the requested artifacts, and verify them before answering. For independent required children, await Promise.allSettled over these foreground calls and inspect every result.
Use progress commentary while working. A statement that you are waiting for a child is not a final answer. agents.send confirms delivery, not completion; agents.list reports status, not the child's answer. Neither substitutes for collecting the required result. Do not invent an agents.wait or agents.join API.
If a required child fails or cannot finish, inspect the failure and either complete the work yourself or clearly report the unfinished requirement. Never describe a draft as the completed deliverable.`;

/** Compose the upstream REPL with the one-shot headless completion contract. */
export function apply(ctx, config) {
  installSchemaPresentation(ctx);
  applyPrime(ctx, config);
  // Headless cannot deliver required background results reliably. Reject the
  // request rather than silently changing the caller's execution semantics.
  ctx.tools.guard(exec => ['subagent', 'subagent_fork'].includes(exec.name)
    && exec.arguments?.run_in_background !== false
    ? 'Headless RLM requires foreground children. Retry with run_in_background: false and await the returned result before answering.'
    : undefined);
  // Keep this outside tool:*: Prime replaces those sections with its SDK.
  ctx.systemPrompt.section({
    name: HEADLESS_COMPLETION_SECTION,
    order: 650,
    text: HEADLESS_COMPLETION_GUIDANCE,
  });
  // Prime removes tool:* sections, including the native structured child's
  // terminal instruction. Restore that contract using the REPL transport;
  // the host still validates and captures only a successful outer execution.
  ctx.systemPrompt.section({
    name: 'agent-harness-plugin:structured-completion',
    order: 660,
    text: ({ agent }) => ctx.tools.get('structured_output', agent)
      ? 'This child must finish with a validated structured result. Call repl with code `await tools.structured_output(result)` where result matches the generated ToolArgsMap. Make this the last operation of that cell. Do not call structured_output directly, and do not finish with plain text: only the successful structured_output call inside a successful REPL cell counts as the result.'
      : '',
  });
}
