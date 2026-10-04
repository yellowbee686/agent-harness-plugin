import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, createUserMessage, createDeveloperMessage } from '@deepseek-ai/dsh-llm';
import SessionStore, { Session } from '@deepseek-ai/dsh-session';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner';
import * as Clm from '../index.mjs';
import { ContextMirror } from '../mirror.mjs';

class ScriptAdapter extends LlmAdapter {
  requests = [];
  constructor(script) { super(); this.script = script; }
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(options) {
    this.requests.push(options);
    const result = await this.script(options, this.requests.length);
    const block = typeof result === 'string'
      ? { type: 'text', text: result }
      : { type: 'tool-call', id: `call-${this.requests.length}`, name: result.name, arguments: JSON.stringify(result.args ?? {}) };
    yield { type: 'block-start', index: 0, blockType: block.type };
    if (block.type === 'text') yield { type: 'text-delta', index: 0, text: block.text };
    else yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: 'block-end', index: 0, block };
    yield { type: 'finish', reason: { kind: block.type === 'text' ? 'stop' : 'tool-calls' } };
  }
}

async function harness(t, script, clmConfig = { steering: 'off' }, beforeClm = async () => {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-clm-test-'));
  const ctx = new Context();
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) {
    await ctx.plugin(plugin);
  }
  await beforeClm(ctx);
  await ctx.plugin(Clm, clmConfig);
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new ScriptAdapter(script);
  ctx.llm.registerAdapter(['script'], adapter);
  const handles = [];
  t.after(async () => {
    for (const handle of handles) await handle.dispose();
    await ctx.fiber.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });
  async function create(id, seed, parentAgent) {
    const handle = await ctx.agents.create({ sessionId: id, parentAgent, meta: { cwd }, seed, agentOptions: { provider: 'script', model: 'script' } });
    handles.push(handle);
    return handle.agent;
  }
  return { ctx, cwd, adapter, create };
}

async function send(agent, text) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
  await agent.whenIdle();
}

function pathFrom(request) {
  const text = request.messages.filter(message => message.role === 'system').map(message => JSON.stringify(message)).join('');
  const match = text.match(/Your editable context mirror is (.*?)\. Read it/);
  assert.ok(match, 'the request contains the scoped CLM protocol and path');
  return match[1];
}

function edit(path, select, text) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const block = document.blocks.find(select);
  assert.ok(block, 'editable block exists');
  block.text = text;
  writeFileSync(path, JSON.stringify(document));
}

test('real AgentLoop sends accepted edits, preserves raw history, and replays them after restart', async t => {
  let path;
  const h = await harness(t, (request, number) => {
    path = pathFrom(request);
    if (number === 1) return 'LONG_OLD_EVIDENCE';
    if (number === 2) return { name: 'edit_context' };
    return 'done';
  });
  h.ctx.tools.register(defineContentToolFixture({
    name: 'edit_context', description: 'Edit the working context file', parameters: {},
    async execute() {
      edit(path, block => block.editable && block.text.includes('LONG_OLD_EVIDENCE'), 'KEPT_FINDING');
      return [{ type: 'text', text: 'context edited' }];
    },
  }));
  const agent = await h.create('main');
  await send(agent, 'original user task');
  await send(agent, 'compress the old evidence');
  assert.equal(h.adapter.requests.length, 3);
  const request = h.adapter.requests[2];
  assert.ok(Object.isFrozen(request.messages));
  assert.match(JSON.stringify(request.messages), /KEPT_FINDING/);
  assert.doesNotMatch(JSON.stringify(request.messages), /LONG_OLD_EVIDENCE/);
  assert.match(JSON.stringify(request.messages), /original user task/);
  const events = agent.session.snapshotEvents();
  assert.match(JSON.stringify(events), /LONG_OLD_EVIDENCE/);
  assert.equal(events.filter(event => event.surfaceOp?.op === 'replace' && event.data.source?.kind === 'dsh-clm').length, 1);
  const replay = Session.create('replayed', JSON.parse(JSON.stringify(events)));
  assert.match(JSON.stringify(replay.deriveMessages()), /KEPT_FINDING/);
  assert.doesNotMatch(JSON.stringify(replay.deriveMessages()), /LONG_OLD_EVIDENCE/);
  const fresh = await harness(t, () => 'resumed');
  const resumed = await fresh.create('main', JSON.parse(JSON.stringify(events)));
  await send(resumed, 'continue after process restart');
  assert.match(JSON.stringify(fresh.adapter.requests[0].messages), /KEPT_FINDING/);
  assert.doesNotMatch(JSON.stringify(fresh.adapter.requests[0].messages), /LONG_OLD_EVIDENCE/);
});

test('plugin unload removes its scoped prompt contribution', async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-clm-unload-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); rmSync(cwd, { recursive: true, force: true }); });
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, ToolRuntime, AgentRegistry]) await ctx.plugin(plugin);
  const fork = ctx.plugin(Clm, { steering: 'on' });
  await fork;
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new ScriptAdapter(() => 'done');
  ctx.llm.registerAdapter(['script'], adapter);
  const handle = await ctx.agents.create({ sessionId: 'unload', meta: { cwd }, agentOptions: { provider: 'script', model: 'script' } });
  await send(handle.agent, 'before unload');
  assert.match(JSON.stringify(adapter.requests[0].messages), /Your editable context mirror/);
  assert.match(JSON.stringify(adapter.requests[0].messages), /CLM context-management strategy/);
  await fork.dispose();
  await send(handle.agent, 'after unload');
  assert.doesNotMatch(JSON.stringify(adapter.requests[1].messages.filter(message => message.role === 'system')), /Your editable context mirror/);
  assert.doesNotMatch(JSON.stringify(adapter.requests[1].messages.filter(message => message.role === 'system')), /CLM context-management strategy/);
  await handle.dispose();
});

test('steering reaches main and child provider requests only when enabled', async t => {
  for (const steering of ['off', 'on']) {
    const h = await harness(t, () => 'done', { steering });
    const main = await h.create(`strategy-${steering}`);
    await send(main, 'main task');
    const child = await h.create(`child-${steering}`, undefined, main);
    await send(child, 'child task');
    for (const request of h.adapter.requests) {
      const system = JSON.stringify(request.messages.filter(m => m.role === 'system'));
      assert.equal(system.includes('CLM context-management strategy'), steering === 'on');
      if (steering === 'on') {
        assert.match(system, /SHA-256: [a-f0-9]{64}/);
        assert.equal(system.split('## CLM context-management strategy').length - 1, 1);
      }
    }
  }
});

test('RLM live bindings survive a CLM edit made through the real REPL worker', { timeout: 30000 }, async t => {
  const Rlm = await import('../../rlm/index.mjs');
  const Runtime = await import('../../rlm/runtime.mjs');
  const { default: LocalFileSystem } = await import('@deepseek-ai/dsh-fs-local');
  const FileTools = await import('@deepseek-ai/dsh-tool-fs');
  const cwd = mkdtempSync(join(tmpdir(), 'dsh-clm-rlm-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); rmSync(cwd, { recursive: true, force: true }); });
  for (const plugin of [LlmRuntime, SessionStore, SessionProjectionRegistry, SystemPrompt, AgentRegistry]) await ctx.plugin(plugin);
  await ctx.plugin(ToolRuntime, { mode: 'native' });
  await ctx.plugin(LocalFileSystem, { cwd });
  await ctx.plugin(FileTools, { readLimit: 10000, readMaxLineLength: 100000 });
  await ctx.plugin(AgentLoop, { agents: [] });
  await ctx.plugin(Runtime, { stateDirectory: join(cwd, 'rlm') });
  await ctx.plugin(Rlm, { stateDirectory: join(cwd, 'rlm'), requireOrchestrationTools: false });
  await ctx.plugin(Clm);
  ctx.tools.register(defineContentToolFixture({
    name: 'skill', description: 'Load a skill', parameters: {},
    execute: async () => [{ type: 'text', text: 'REPL_ACTIVE_SKILL_RULE' }],
  }));
  const results = [];
  ctx.on('tools/result', (exec, result) => { if (exec.name === 'repl') results.push(result); });
  const adapter = new ScriptAdapter((request, number) => {
    assert.deepEqual(request.tools.map(tool => tool.name), ['repl']);
    const path = pathFrom(request);
    if (number === 1) return { name: 'repl', args: { code: 'let retained = new Map([["answer", 42]]); "OLD_LARGE_RLM_EVIDENCE"' } };
    if (number === 2) return { name: 'repl', args: { code: `let mirrorPath = ${JSON.stringify(path)}; let read = await tools.read({file_path: mirrorPath}); let doc = JSON.parse(read.lines.map(line => line.text).join(String.fromCharCode(10))); doc.blocks.find(b => b.editable && b.text.includes('OLD_LARGE_RLM_EVIDENCE')).text = 'RLM_SUMMARY'; await tools.write({file_path: mirrorPath, content: JSON.stringify(doc)}); retained.get('answer')` } };
    if (number === 3) {
      assert.match(JSON.stringify(request.messages), /RLM_SUMMARY/);
      // The edit tool's code names the old marker, but the original result is gone.
      const oldResults = request.messages.filter(message => message.role === 'tool' && JSON.stringify(message.content).includes('OLD_LARGE_RLM_EVIDENCE'));
      assert.equal(oldResults.length, 0);
      return { name: 'repl', args: { code: 'await tools.skill({}); retained.get("answer")' } };
    }
    const skillBlock = JSON.parse(readFileSync(path)).blocks.find(b => b.text.includes('await tools.skill'));
    assert(skillBlock && !skillBlock.editable, 'actual nested skill dispatch protects its complete REPL group');
    return 'done';
  });
  ctx.llm.registerAdapter(['script'], adapter);
  const handle = await ctx.agents.create({ sessionId: 'combination', meta: { cwd }, agentOptions: { provider: 'script', model: 'script' } });
  await send(handle.agent, 'Collect evidence, edit context, and reuse retained state.');
  assert.equal(adapter.requests.length, 4, JSON.stringify({ results, tail: handle.agent.session.snapshotEvents().slice(-3) }));
  assert.equal(results.length, 3);
  assert.equal(results[1].value.result, 42);
  assert.equal(results[2].value.result, 42);
  assert.equal(handle.agent.session.snapshotEvents().filter(event => event.data.source?.kind === 'dsh-clm').length, 1);
  await handle.dispose();
});

test('concurrent sessions get isolated mirrors and malformed edits never affect requests', async t => {
  const paths = new Map();
  const h = await harness(t, request => {
    const path = pathFrom(request);
    paths.set(path, path);
    return 'UNCHANGED_EVIDENCE';
  });
  const [a, b] = await Promise.all([h.create('A'), h.create('B')]);
  await Promise.all([send(a, 'A task'), send(b, 'B task')]);
  await Promise.all([send(a, 'A again'), send(b, 'B again')]);
  assert.equal(paths.size, 2);
  const aPath = pathFrom(h.adapter.requests.find(request => JSON.stringify(request.messages).includes('A task')));
  writeFileSync(aPath, '{broken');
  await Promise.all([send(a, 'A after bad edit'), send(b, 'B unaffected')]);
  assert.match(JSON.parse(readFileSync(aPath)).status, /rejected/);
  assert.match(JSON.stringify(h.adapter.requests.at(-2).messages), /UNCHANGED_EVIDENCE/);
  assert.equal(a.session.surface.replaceGeneration, 0);
  assert.equal(b.session.surface.replaceGeneration, 0);
});

test('metadata, user tasks, protected instructions and stale revisions cannot be overwritten', async t => {
  const h = await harness(t, () => 'old assistant');
  const agent = await h.create('validation');
  await send(agent, 'protected task');
  agent.session.append('developer/message', {
    turn: 1, step: 1,
    message: createDeveloperMessage({ content: [{ type: 'text', text: 'PROTECTED_DEVELOPER_RULE' }], source: { kind: 'test' } }),
  }, { surfaceOp: 'append' });
  const mirror = new ContextMirror(join(h.cwd, 'validation.json'));
  mirror.publish(agent.session);
  assert.ok(mirror.base.blocks.every(block => !block.text.includes('Your editable context mirror')));
  assert.ok(mirror.base.blocks.every(block => !block.text.includes('PROTECTED_DEVELOPER_RULE')));
  edit(mirror.path, block => !block.editable, 'changed task');
  assert.equal(mirror.accept(agent.session), 0);
  assert.match(mirror.status, /protected/);
  mirror.publish(agent.session);
  const old = readFileSync(mirror.path, 'utf8');
  mirror.publish(agent.session);
  writeFileSync(mirror.path, old);
  assert.equal(mirror.accept(agent.session), 0);
  assert.match(mirror.status, /immutable/);
  mirror.publish(agent.session);
  edit(mirror.path, block => block.editable, 'new summary');
  const original = mirror.base.blocks.find(block => block.editable).seqs[0];
  agent.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'external compaction' }], source: { kind: 'test' } }), {
    surfaceOp: { op: 'replace', startSeq: original, endSeq: original }, sourceEventSeqs: [original],
  });
  assert.equal(mirror.accept(agent.session), 0);
  assert.match(mirror.status, /stale mirror/);
  assert.match(JSON.stringify(agent.session.deriveMessages()), /PROTECTED_DEVELOPER_RULE/);
});

test('a child agent shadows the parent mirror path and has independent editable state', async t => {
  const h = await harness(t, () => 'private assistant evidence');
  const parent = await h.create('parent');
  const child = await h.create('child', undefined, parent);
  await Promise.all([send(parent, 'PARENT_TASK'), send(child, 'CHILD_TASK')]);
  const parentRequest = h.adapter.requests.find(request => JSON.stringify(request.messages).includes('PARENT_TASK'));
  const childRequest = h.adapter.requests.find(request => JSON.stringify(request.messages).includes('CHILD_TASK'));
  const parentPath = pathFrom(parentRequest);
  const childPath = pathFrom(childRequest);
  assert.notEqual(parentPath, childPath);
  assert.doesNotMatch(JSON.stringify(childRequest.messages), /PARENT_TASK/);
  const system = JSON.stringify(childRequest.messages.filter(message => message.role === 'system'));
  assert.equal(system.split('Your editable context mirror is').length - 1, 1);
  assert.ok(!system.includes(parentPath));
  writeFileSync(childPath, '{broken child edit');
  await Promise.all([send(parent, 'parent continues'), send(child, 'child continues')]);
  assert.equal(parent.session.surface.replaceGeneration, 0);
  assert.equal(child.session.surface.replaceGeneration, 0);
  assert.match(JSON.parse(readFileSync(childPath, 'utf8')).status, /rejected/);
  assert.equal(JSON.parse(readFileSync(parentPath, 'utf8')).status, 'ready');
});

test('complete tool groups remain paired, and repeated projections can grow or clear text', async t => {
  const h = await harness(t, (_request, number) => number === 1 ? { name: 'evidence' } : 'finished');
  h.ctx.tools.register(defineContentToolFixture({
    name: 'evidence', description: 'Return evidence', parameters: {},
    async execute() { return [{ type: 'text', text: 'raw tool evidence' }]; },
  }));
  const agent = await h.create('pairing');
  await send(agent, 'task');
  const mirror = new ContextMirror(join(h.cwd, 'pairing.json'));
  mirror.publish(agent.session);
  const pair = mirror.base.blocks.find(block => block.text.includes('raw tool evidence'));
  assert.equal(pair.seqs.length, 2);
  edit(mirror.path, block => block.text.includes('raw tool evidence'), 'expanded finding '.repeat(100));
  assert.equal(mirror.accept(agent.session), 1);
  let messages = agent.session.deriveMessages();
  assert.equal(messages.filter(message => message.role === 'tool').length, 0);
  assert.ok(!messages.some(message => message.content?.some(part => part.type === 'tool-call')));
  mirror.publish(agent.session);
  edit(mirror.path, block => block.text.includes('expanded finding'), '');
  assert.equal(mirror.accept(agent.session), 1);
  messages = agent.session.deriveMessages();
  assert.match(JSON.stringify(messages), /Context omitted by CLM/);
  assert.match(JSON.stringify(agent.session.snapshotEvents()), /raw tool evidence/);
  await send(agent, 'check the projected context');
  assert.match(JSON.stringify(h.adapter.requests.at(-1).messages), /Context omitted by CLM/);
  assert.doesNotMatch(JSON.stringify(h.adapter.requests.at(-1).messages), /raw tool evidence/);
});

test('oversized edits and forged roles are rejected before surface mutation', async t => {
  const h = await harness(t, () => 'editable evidence');
  const agent = await h.create('limits');
  await send(agent, 'task');
  const mirror = new ContextMirror(join(h.cwd, 'limits.json'), 8192);
  mirror.publish(agent.session);
  edit(mirror.path, block => block.editable, 'x'.repeat(8193));
  assert.equal(mirror.accept(agent.session), 0);
  assert.match(mirror.status, /maxBytes/);
  mirror.publish(agent.session);
  const document = JSON.parse(readFileSync(mirror.path, 'utf8'));
  document.blocks.find(block => block.editable).role = 'system';
  writeFileSync(mirror.path, JSON.stringify(document));
  assert.equal(mirror.accept(agent.session), 0);
  assert.match(mirror.status, /immutable/);
  assert.equal(agent.session.surface.replaceGeneration, 0);
});

test('host user-role instructions and native/REPL skill loads are immutable, including after replay', async t => {
  const h = await harness(t, (_request, number) => number === 1 ? { name: 'skill' } : 'analysis');
  h.ctx.tools.register(defineContentToolFixture({
    name: 'skill', description: 'Load instructions', parameters: {},
    execute: async () => [{ type: 'text', text: 'ACTIVE_SKILL_RULE' }],
  }));
  const agent = await h.create('instruction-protection');
  await send(agent, 'task');
  const kinds = ['agent-instructions', 'runtime-context', 'skill-catalog', 'tool-registry', 'unknown-host-source'];
  for (const kind of kinds) {
    agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `RULE_${kind}` }], ...(kind ? { source: { kind } } : {}),
    }), { surfaceOp: 'append' });
  }
  // Native PTC provenance records a skill load hidden inside an outer call.
  // Reuse a real completed group so the persisted pairing stays valid.
  const events = JSON.parse(JSON.stringify(agent.session.snapshotEvents()));
  const call = events.find(e => e.type === 'assistant/message').data.message.content.find(b => b.type === 'tool-call');
  call.name = 'repl';
  const replay = Session.create('instruction-replay', events);
  replay.append('tool/ptc-dispatch', { name: 'skill', subCallId: 'inner-skill', parentCallId: call.id, rootCallId: call.id, arguments: {}, content: [], isError: false });
  for (const session of [agent.session, Session.create('second-replay', JSON.parse(JSON.stringify(replay.snapshotEvents())))]) {
    const mirror = new ContextMirror(join(h.cwd, `${session.id}.json`));
    mirror.publish(session);
    const protectedBlocks = mirror.base.blocks.filter(b => /ACTIVE_SKILL_RULE|RULE_/.test(b.text));
    assert.equal(protectedBlocks.length, kinds.length + 1);
    assert(protectedBlocks.every(b => !b.editable));
    const before = session.snapshotEvents().length;
    for (const block of protectedBlocks) {
      mirror.publish(session);
      edit(mirror.path, b => b.seqs[0] === block.seqs[0], 'business summary replacing instructions');
      assert.equal(mirror.accept(session), 0);
      assert.match(mirror.status, /protected/);
      assert.equal(session.snapshotEvents().length, before);
    }
    mirror.publish(session);
    edit(mirror.path, b => b.editable && b.text.includes('analysis'), 'valid working note');
    assert.equal(mirror.accept(session), 1);
    assert.match(JSON.stringify(session.deriveMessages()), /ACTIVE_SKILL_RULE/);
  }
});

test('pending edits commit before the host pruner, leaving unedited tools subject to pruning', async t => {
  let path;
  let pruneEnabled = false;
  const h = await harness(t, (request, number) => {
    path = pathFrom(request);
    if (number <= 2) return { name: 'evidence', args: { label: number === 1 ? 'EDIT_ME' : 'KEEP_ME' } };
    if (number === 3) return { name: 'edit_context' };
    return 'done';
  }, { steering: 'off' }, async ctx => {
    await ctx.plugin(TokenMeter);
    await ctx.plugin(ToolResultPruner, { thresholdChars: 100, headChars: 25, tailChars: 10 });
    // Same ordering as compaction-basic: mutate the surface before next().
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (pruneEnabled) ctx.toolResultPruner.pruneSession(agent.session);
      return next();
    });
  });
  h.ctx.tools.register(defineContentToolFixture({
    name: 'evidence', description: 'Evidence', parameters: { label: { type: 'string' } },
    execute: async args => [{ type: 'text', text: `${args.label} ${'raw evidence '.repeat(100)}` }],
  }));
  h.ctx.tools.register(defineContentToolFixture({
    name: 'edit_context', description: 'Edit', parameters: {},
    execute: async () => {
      edit(path, b => b.text.includes('EDIT_ME'), 'RETAINED_FINDING');
      pruneEnabled = true;
      return [{ type: 'text', text: 'edited' }];
    },
  }));
  const agent = await h.create('prune-order');
  await send(agent, 'Use the evidence');
  const events = agent.session.snapshotEvents();
  const accepted = events.find(e => e.data.source?.kind === 'dsh-clm');
  const pruned = events.find(e => e.type === 'compaction/prune');
  assert(accepted && pruned);
  assert(accepted.seq < pruned.seq);
  assert.match(JSON.stringify(h.adapter.requests.at(-1).messages), /RETAINED_FINDING/);
  assert.match(JSON.stringify(h.adapter.requests.at(-1).messages), /tool result middle pruned/);
  assert.match(JSON.parse(readFileSync(path)).status, /accepted: 1/);
  const replay = Session.create('pruned-replay', JSON.parse(JSON.stringify(events)));
  assert.match(JSON.stringify(replay.deriveMessages()), /RETAINED_FINDING/);
});
