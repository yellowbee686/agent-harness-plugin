import { apply as applyPrime } from 'dsh-prime-agent';

export { name, inject, Config } from 'dsh-prime-agent';

export const HEADLESS_COMPLETION_SECTION = 'agent-harness-plugin:headless-completion';

export const HEADLESS_COMPLETION_GUIDANCE = `Complete this headless task before giving your final answer. The process may exit after your final answer and stop unfinished children; completion notifications cannot keep it alive.
For every delegated result needed by this task, call await agents.spawn({ description, prompt, run_in_background: false }) or await agents.fork({ description, prompt, run_in_background: false }). Read the returned output, finish the requested artifacts, and verify them before answering. For independent required children, await Promise.allSettled over these foreground calls and inspect every result.
Use progress commentary while working. A statement that you are waiting for a child is not a final answer. agents.send confirms delivery, not completion; agents.list reports status, not the child's answer. Neither substitutes for collecting the required result. Do not invent an agents.wait or agents.join API.
If a required child fails or cannot finish, inspect the failure and either complete the work yourself or clearly report the unfinished requirement. Never describe a draft as the completed deliverable.`;

/** Compose the upstream REPL with the one-shot headless completion contract. */
export function apply(ctx, config) {
  applyPrime(ctx, config);
  // Keep this outside tool:*: Prime replaces those sections with its SDK.
  ctx.systemPrompt.section({
    name: HEADLESS_COMPLETION_SECTION,
    order: 650,
    text: HEADLESS_COMPLETION_GUIDANCE,
  });
}
