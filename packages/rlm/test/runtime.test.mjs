import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
import LocalFileSystem from '@deepseek-ai/dsh-fs-local';
import * as FileTools from '@deepseek-ai/dsh-tool-fs';
import { MAX_READ_TEXT_BYTES } from '../read-text.mjs';
import * as rlm from '../index.mjs';
import * as runtime from '../runtime.mjs';

async function fixture(t, options = {}, agentOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-rlm-test-'));
  const ctx = new Context();
  t.after(async () => {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  await ctx.plugin(LocalFileSystem, { cwd: root });
  await ctx.plugin(FileTools, {});
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
  await ctx.plugin(rlm, { stateDirectory, requireOrchestrationTools: false, ...agentOptions });
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
  return { ctx, root, create, cell, rawCell };
}

test('complete file input survives native 2k line truncation and REPL display projection', { timeout: 30000 }, async t => {
  const { ctx, root, create, cell, rawCell } = await fixture(t);
  const source = JSON.stringify({ padding: '数据😀'.repeat(18000), tail: 42 });
  await writeFile(join(root, 'large.json'), source);
  const agent = await create('file-input');
  const before = await rawCell(agent, 'let preview = await tools.read({ file_path: "large.json" }); JSON.parse(preview.lines.map(l => l.text).join("\\n"))');
  assert.equal(before.isError, true);
  const preview = await cell(agent, 'preview.lines[0].text');
  assert.match(preview.result, /line truncated to 2000 chars/);
  const result = await cell(agent, 'let raw = await tools.read_text({ file_path: "large.json" }); raw');
  assert(result); // Direct completion uses a receipt; the canonical string remains bound.
  assert.deepEqual((await cell(agent, '({ tail: JSON.parse(raw).tail, chars: raw.length })')).result,
    { tail: 42, chars: source.length });
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent.ctx });
  assert(assembly.sections.some(s => s.name === 'agent-harness-plugin:complete-file-input'));
  ctx.tools.guard(exec => exec.name === 'read_text' ? 'fixture read denied' : undefined);
  const denied = await rawCell(agent, 'await tools.read_text({ file_path: "large.json" })');
  assert.equal(denied.isError, true);
  assert.match(denied.error.message, /fixture read denied/);
});

test('complete file input fails without partial content for missing, non-file and oversized inputs', { timeout: 30000 }, async t => {
  const { root, create, rawCell } = await fixture(t);
  await writeFile(join(root, 'oversized.txt'), 'x'.repeat(MAX_READ_TEXT_BYTES + 1));
  const agent = await create('file-errors');
  for (const [file, expected] of [['absent', /not found/], ['.', /not a regular file/], ['oversized.txt', /No partial text was returned/]]) {
    const result = await rawCell(agent, `await tools.read_text({ file_path: ${JSON.stringify(file)} })`);
    assert.equal(result.isError, true);
    assert.match(result.error.message, expected);
  }
});

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

test('recursive calls inherit model defaults, preserve explicit budgets and incomplete results', { timeout: 30000 }, async t => {
  const { ctx, create, cell } = await fixture(t);
  const requests = [];
  class BudgetModel extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, defaultMaxTokens: 65536 };
    }
    async *stream(options) {
      requests.push(options);
      if (options.maxTokens < 8192) {
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
      } else {
        yield* textChunks('complete');
      }
    }
  }
  ctx.llm.registerAdapter(['fixture'], new BudgetModel());
  const agent = await create('recursive-budget');
  const small = await cell(agent, 'await agents.query({ prompt: "bounded task", maxTokens: 4096 })');
  assert.deepEqual(small.result, { text: '', truncated: true });
  const normal = await cell(agent, 'await agents.queryMany({ prompts: ["first", "second"] })');
  assert.deepEqual(normal.result, { replies: [{ text: 'complete', truncated: false }, { text: 'complete', truncated: false }] });
  await cell(agent, 'await agents.query({ prompt: "explicit", maxTokens: 98304 })');
  assert.deepEqual(requests.map(r => r.maxTokens), [4096, 65536, 65536, 98304]);
  assert(requests.every(r => r.provider === 'fixture' && r.model === 'deterministic'));
  const assembly = await ctx.systemPrompt.assemble({ agent, scope: agent.ctx });
  assert(assembly.sections.some(s => s.name === 'agent-harness-plugin:recursive-budget' && s.text.includes('Never reduce maxTokens')));
  assert(assembly.sections.find(s => s.name === 'tools:sdk').text.includes('model default'));
});

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

test('structured one-shot children finish through REPL with host validation and capture', { timeout: 30000 }, async t => {
  const { ctx, create } = await fixture(t);
  let requests = 0;
  const outputs = [];
  ctx.on('tools/result', (exec, result) => outputs.push({ name: exec.name, result }));
  class StructuredModel extends LlmAdapter {
    async *stream(options) {
      if (JSON.stringify(options.messages).includes('FAIL_AFTER_CAPTURE')) {
        yield* options.messages.some(message => message.role === 'assistant')
          ? textChunks('No valid structured result was committed.')
          : toolChunks('failed-outer', 'await tools.structured_output({ count: 3 }); throw new Error("after capture")');
        return;
      }
      requests++;
      assert.deepEqual(options.tools.map(tool => tool.name), ['repl']);
      const prompt = JSON.stringify(options.messages.filter(m => m.role === 'system'));
      assert.match(prompt, /await tools\.structured_output\(result\)/);
      assert.match(prompt, /Do not call structured_output directly/);
      // An invalid result must not conclude the child or capture an object.
      yield* toolChunks(`structured-${requests}`, requests === 1
        ? 'await tools.structured_output({ count: "wrong" })'
        : 'await tools.structured_output({ count: 3 })');
    }
  }
  ctx.llm.registerAdapter(['fixture'], new StructuredModel());
  const parent = await create('structured-parent');
  const rootPrompt = await ctx.systemPrompt.assemble({ agent: parent, scope: parent.ctx });
  assert(!rootPrompt.sections.some(s => typeof s.text === 'string' && s.text.includes('This child must finish')));
  const run = await ctx.subagents.start('spawn', {
    parent, prompt: [{ type: 'text', text: 'Return the count.' }], signal: new AbortController().signal,
    outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false },
  });
  try {
    const result = await run.result;
    assert.equal(result.stopReason, 'completed');
    assert.deepEqual(result.structured, { count: 3 });
    assert.equal(requests, 2);
    assert(outputs.some(o => o.name === 'structured_output' && o.result.isError));
    assert(outputs.some(o => o.name === 'structured_output' && !o.result.isError));
    assert(outputs.some(o => o.name === 'repl' && !o.result.isError));
  } finally { await run.dispose(); }
  const failed = await ctx.subagents.start('spawn', {
    parent, prompt: [{ type: 'text', text: 'FAIL_AFTER_CAPTURE' }], signal: new AbortController().signal,
    outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false },
  });
  try {
    const result = await failed.result;
    assert.equal(result.stopReason, 'error');
    assert.equal(result.structured, undefined, 'a failed outer cell must never deliver a staged structured result');
  } finally { await failed.dispose(); }
});
