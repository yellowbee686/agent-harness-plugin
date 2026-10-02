import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createUserMessage } from '@deepseek-ai/dsh-llm';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function snapshot(session) {
  return session.surface.nodes.map(seq => ({
    seq,
    message: session.deriveEventMessage(session.eventAt(seq)),
  }));
}

/** Only expose complete tool-call/result groups; never split a protected node. */
function blocksFor(rows) {
  const blocks = [];
  let group = [];
  let pending = new Set();
  const flush = () => {
    if (group.length && pending.size === 0) {
      blocks.push({
        seqs: group.map(row => row.seq),
        editable: !group.some(({ message }) => message.role === 'user' && message.source?.kind === 'user'),
        text: group.map(({ message }) => JSON.stringify(message)).join('\n'),
      });
    }
    group = [];
    pending = new Set();
  };
  for (const row of rows) {
    const message = row.message;
    if (!message || message.role === 'system' || message.role === 'developer') {
      flush();
      continue;
    }
    if (message.role === 'assistant') {
      if (pending.size) { flush(); }
      group.push(row);
      for (const part of message.content) {
        if (part.type === 'tool-call') pending.add(part.id);
      }
      if (!pending.size) flush();
    } else if (message.role === 'tool') {
      if (!pending.has(message.toolCallId)) { flush(); continue; }
      group.push(row);
      pending.delete(message.toolCallId);
      if (!pending.size) flush();
    } else {
      flush();
      group.push(row);
      flush();
    }
  }
  return blocks;
}

/** The file is disposable. Accepted projections live in the session event log. */
export class ContextMirror {
  constructor(path, maxBytes = 4 * 1024 * 1024) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.base = undefined;
    this.status = 'ready';
  }

  publish(session) {
    const rows = snapshot(session);
    this.rows = rows;
    this.base = {
      format: 'dsh-clm/1',
      sessionId: session.id,
      revision: randomUUID(),
      digest: hash(rows),
      status: this.status,
      blocks: blocksFor(rows),
    };
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.base, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }

  /** Validate the whole edit before appending any synchronous replacements. */
  accept(session) {
    if (!this.base) return 0;
    let edited;
    try {
      if (statSync(this.path).size > this.maxBytes) throw new Error('mirror exceeds maxBytes');
      edited = JSON.parse(readFileSync(this.path, 'utf8'));
      if (isDeepStrictEqual(edited, this.base)) return 0;
      if (!edited || !Array.isArray(edited.blocks)) throw new Error('invalid document');
      const immutable = structuredClone(edited);
      for (let index = 0; index < immutable.blocks.length; index++) {
        const block = immutable.blocks[index];
        const original = this.base.blocks[index];
        if (!original || typeof block?.text !== 'string') throw new Error('invalid block');
        if (!original.editable && block.text !== original.text) throw new Error('user task is protected');
        block.text = original.text;
      }
      if (!isDeepStrictEqual(immutable, this.base)) throw new Error('metadata, order and block membership are immutable');
      const current = snapshot(session);
      if (!isDeepStrictEqual(current.slice(0, this.rows.length), this.rows)) {
        throw new Error('stale mirror: source surface changed');
      }
    } catch (error) {
      this.status = `rejected: ${error.message}`;
      return 0;
    }
    const changes = edited.blocks.filter((block, index) => block.text !== this.base.blocks[index].text);
    // All mutations use DSH's append-only, replayable surface contract. An edited
    // tool group becomes user-role context, never forged assistant/tool messages.
    for (const block of changes) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: block.text || '[Context omitted by CLM]' }],
        source: { kind: 'dsh-clm', revision: this.base.revision },
      }), {
        surfaceOp: { op: 'replace', startSeq: block.seqs[0], endSeq: block.seqs.at(-1) },
        sourceEventSeqs: block.seqs,
      });
    }
    this.status = `accepted: ${changes.length} block(s)`;
    // Do not allow the same file to be applied twice if request admission fails.
    this.base = undefined;
    return changes.length;
  }
}
