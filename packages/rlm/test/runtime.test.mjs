import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import LlmRuntime, { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import SubagentRuntime from '@deepseek-ai/dsh-subagent';
import * as NativeSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import * as ToolSubagent from '@deepseek-ai/dsh-tool-subagent';
import * as rlm from '../index.mjs';
import * as runtime from '../runtime.mjs';

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-test-'));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  await ctx.plugin(LlmRuntime);
  await ctx.plugin(SessionStore);
  await ctx.plugin(AgentRegistry);
  await ctx.plugin(SessionProjectionRegistry);
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(SubagentRuntime);
  await ctx.plugin(NativeSpawn, { providerName: 'spawn' });
  await ctx.plugin(ToolSubagent, { provider: 'spawn', toolName: 'subagent', maxDepth: 3, backgroundMode: 'one-shot' });
  const stateDirectory = join(root, 'state');
  await ctx.plugin(runtime, { stateDirectory, ...options });
  // Focus this fixture on real Realm/child execution. The shipped patch retains
  // the stricter jobs and orchestration catalog check for full headless hosts.
  await ctx.plugin(rlm, { stateDirectory, requireOrchestrationTools: false });
  const create = id => ctx.agentLoop.create(SessionId(id), { provider: 'fixture', model: 'deterministic' });
  let sequence = 0;
  const rawCell = (agent, code) => ctx.tools.execute({
    callId: ToolCallId(`cell-${++sequence}`), name: 'repl', arguments: { code },
    signal: new AbortController().signal, agent,
  });
  const cell = async (agent, code) => {
    const output = await rawCell(agent, code);
    assert.equal(output.isError, false, output.error?.message);
    return output.value;
  };
  return { ctx, create, cell, rawCell };
}

function toolChunks(id, code) {
  const args = JSON.stringify({ code });
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId(id), name: 'repl', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(id), name: 'repl', arguments: args } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

test('real worker retains Maps and closures across cells and isolates sessions', { timeout: 30000 }, async t => {
  const { create, cell } = await fixture(t);
  const first = await create('parent');
  const second = await create('other');
  assert.equal((await cell(first, 'let data = new Map([["x", 41]]); let answer = () => data.get("x") + 1; answer()')).result, 42);
  assert.deepEqual((await cell(first, 'data.set("y", 7); ({ count: data.size, value: answer() })')).result, { count: 2, value: 42 });
  assert.equal((await cell(second, 'typeof data')).result, 'undefined');
  assert.equal((await cell(first, 'answer()')).result, 42);
});

test('real Prime assembly repairs bounded tools and guard rejects background children', { timeout: 30000 }, async t => {
  const { ctx, create, rawCell, cell } = await fixture(t);
  const parameters = {
    type: 'object', additionalProperties: false, required: ['room_ids'],
    properties: {
      room_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
      limit: { type: 'integer', minimum: 1, maximum: 2000 },
    },
  };
  let executions = 0;
  ctx.tools.register({
    name: 'bounded_live', description: 'Live rooms fixture.', parameters,
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async (args) => {
      executions++;
      if (args.limit > 2000) throw new Error('Runtime limit must be <=2000');
      return args.room_ids.join(',');
    },
  });
  const agent = await create('schema-guard');
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent.ctx });
  const sdk = assembly.sections.find(section => section.name === 'tools:sdk').text;
  assert.match(sdk, /room_ids: string\[\]/);
  assert.match(sdk, /maximum=2000/);
  assert.deepEqual(ctx.tools.get('bounded_live', agent).parameters, parameters);
  const invalid = await rawCell(agent, 'await tools.bounded_live({ room_ids: ["1"], limit: 5000 })');
  assert.equal(invalid.isError, true);
  assert.match(invalid.error.message, /Runtime limit must be <=2000/);
  assert.equal(executions, 1);
  assert.equal((await cell(agent, 'await tools.bounded_live({ room_ids: ["1"], limit: 2000 })')).result, '1');
  const background = await rawCell(agent, 'await agents.spawn({ description: "child", prompt: "Do required work", run_in_background: true })');
  assert.equal(background.isError, true);
  assert.match(background.error.message, /requires foreground children/);
  const implicit = await rawCell(agent, 'await agents.spawn({ description: "child", prompt: "Do required work" })');
  assert.equal(implicit.isError, true);
  assert.match(implicit.error.message, /requires foreground children/);
});

test('hard timeout loses bindings and explicitly reports namespace restart', { timeout: 30000 }, async t => {
  const { create, cell, rawCell } = await fixture(t, { computeMs: 300, maxWallMs: 5000 });
  const agent = await create('timeout');
  await cell(agent, 'let volatileValue = 99; volatileValue');
  const failed = await rawCell(agent, 'while (true) {}');
  assert.equal(failed.isError, true);
  const after = await cell(agent, 'typeof volatileValue');
  assert.equal(after.result, 'undefined');
  assert.match(after.logs.join('\n'), /live namespace restarted; previous bindings and retained results were lost/);
});

test('real native child recursively creates a grandchild with separate live Realms', { timeout: 60000 }, async t => {
  const { ctx, create, cell } = await fixture(t);
  const requests = [];
  const childResults = [];
  ctx.systemPrompt.section({ name: 'fixture:host-guidance', order: 50, text: 'Existing host guidance stays visible.' });
  ctx.on('tools/result', (exec, result) => {
    if (exec.name === 'repl') childResults.push({ agent: String(exec.agent?.id), result });
  });
  class ScriptedModel extends LlmAdapter {
    async *stream(options) {
      requests.push(options);
      assert.deepEqual(options.tools?.map(tool => tool.name), ['repl']);
      const systemText = options.messages.filter(message => message.role === 'system')
        .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
      assert(systemText.includes(rlm.HEADLESS_COMPLETION_GUIDANCE));
      assert(systemText.includes('Existing host guidance stays visible.'));
      const user = options.messages.find(message => message.role === 'user');
      const prompt = user.content.filter(block => block.type === 'text').map(block => block.text).join('');
      const step = options.messages.filter(message => message.role === 'assistant').length;
      const isGrandchild = prompt.includes('GRANDCHILD');
      let chunks;
      if (step === 0) {
        chunks = toolChunks(`setup-${requests.length}`, isGrandchild
          ? 'let privateValue = 7; ({ inherited: typeof parentValue, own: privateValue })'
          : 'let privateValue = 11; let nested = await agents.spawn({ description: "grandchild", prompt: "GRANDCHILD", run_in_background: false }); ({ inherited: typeof parentValue, own: privateValue, kind: nested.kind })');
      } else if (step === 1) {
        chunks = toolChunks(`read-${requests.length}`, 'privateValue');
      } else {
        chunks = textChunks(isGrandchild ? 'grandchild=7' : 'child=11');
      }
      yield* chunks;
    }
  }
  ctx.llm.registerAdapter(['fixture'], new ScriptedModel());
  const parent = await create('recursive-parent');
  const output = await cell(parent, 'let parentValue = 42; let child = await agents.spawn({ description: "child", prompt: "CHILD", run_in_background: false }); ({ kind: child.kind, output: child.output })');
  assert.equal(output.result.kind, 'foreground', JSON.stringify(output));
  assert.match(JSON.stringify(output.result.output), /child=11/);
  assert.equal((await cell(parent, 'parentValue')).result, 42);
  assert.equal(requests.length, 6);
  assert.equal(new Set(requests.map(request => request.sessionId)).size, 2);
  const values = childResults.filter(row => !row.result.isError).map(row => row.result.value?.result);
  assert(values.some(value => value === 7));
  assert(values.some(value => value === 11));
  assert(values.some(value => value?.inherited === 'undefined' && value?.own === 7));
  assert(values.some(value => value?.inherited === 'undefined' && value?.own === 11 && value?.kind === 'foreground'));
});
