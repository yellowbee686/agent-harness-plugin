import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { ContextMirror } from './mirror.mjs';

export const name = 'dsh-clm';
export const inject = ['agents', 'sessions', 'systemPrompt', 'llm'];
export const Config = z.object({
  directory: z.string().default('.dsh/clm'),
  maxBytes: z.number().min(1024).default(4194304),
});

export function apply(ctx, config = {}) {
  const mirrors = new WeakMap();
  ctx.on('agent/created', ({ agent }) => {
    const key = createHash('sha256').update(agent.id).digest('hex');
    const path = resolve(agent.session.header.cwd ?? process.cwd(), config.directory ?? '.dsh/clm', key, 'LIVE_CONTEXT.json');
    const mirror = new ContextMirror(path, config.maxBytes);
    mirrors.set(agent, mirror);
    // A new lifecycle never trusts a leftover editable file. Replay has already
    // restored every accepted replacement from the durable session events.
    mirror.publish(agent.session);
    const removeSection = agent.ctx.systemPrompt.section({
      name: 'clm:editable-context',
      order: 850,
      interpolate: false,
      text: `Your editable context mirror is ${path}. Read it using native file tools or the REPL filesystem. Edit only the text fields of blocks with editable=true; keep all other JSON fields, block order, and block membership unchanged. The next agent step validates the file and uses accepted edits as user-role context notes in the actual model request. Empty text omits the block. Unchanged blocks retain their native roles and tool structure. Complete tool-call/result groups are one block. Real system/developer instructions are outside the mirror; original user tasks are read-only. Growth is allowed within the ${config.maxBytes ?? 4194304}-byte mirror limit; this is not a model token budget. Perform the entire read-modify-write in ONE tool call or REPL cell. Never cache or reuse the mirror document across cells: its revision changes each request, even though business objects may persist in the REPL. Batch edits, write valid JSON, and read the refreshed status field to check acceptance. The mirror is refreshed before each main model request; never restore an old revision. Raw history remains in the session log.`,
    });
    ctx.effect(() => removeSection);
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    const changed = mirrors.get(agent)?.accept(agent.session) ?? 0;
    return changed ? { ...decision, startsRequestSeries: true } : decision;
  });
  ctx.on('llm/stream', (options, next) => {
    const agent = ctx.agents.currentInitiator();
    const mirror = agent && mirrors.get(agent);
    // Subcalls (summarizers, recursive inference) must not replace the mirror.
    // This hook observes frozen options; it never changes request messages.
    if (mirror && JSON.stringify(options.messages) === JSON.stringify(agent.session.deriveMessages())) {
      mirror.publish(agent.session);
    }
    return next();
  });
}
