import { defineTool } from '@deepseek-ai/dsh-tools';

// Bound retained input independently from the model-facing REPL preview. A
// partial text file must never masquerade as input suitable for JSON.parse.
export const MAX_READ_TEXT_BYTES = 8 * 1024 * 1024;

export function installReadText(ctx) {
  ctx.inject(['fs'], fsCtx => {
    fsCtx.tools.register(defineTool({
      name: 'read_text',
      description: 'Read a complete UTF-8 text file into a REPL variable for parsing or computation, without line truncation or line numbers. Maximum 8 MiB; oversized files fail explicitly. Bind the result and reduce it before displaying. For larger files use a streaming computation through the host shell.',
      parameters: { file_path: { type: 'string', required: true } },
      output: {
        schema: { type: 'string' },
        // The complete value goes to the Realm; direct completion displays only
        // this receipt. Explicit slices/aggregates still use ordinary REPL output.
        render: (_args, value) => [{ type: 'text', text: `Complete file retained (${Buffer.byteLength(value, 'utf8')} UTF-8 bytes). Bind the returned string, parse or reduce it in the REPL, and display the needed evidence.` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        if (!args.file_path.trim()) throw new Error('file_path must be non-empty');
        const target = await fsCtx.fs.resolve(args.file_path, {
          cwd: exec.agent?.session.header.cwd, signal: exec.signal,
        });
        const info = await fsCtx.fs.stat(target, exec.signal);
        if (!info) {
          fsCtx.emit('fs/observed', target, { kind: 'absent' }, exec);
          throw new Error(`cannot read "${target.displayPath}": not found`);
        }
        if (info.type !== 'file') throw new Error(`cannot read "${target.displayPath}": not a regular file`);
        const tooLarge = () => new Error(`read_text exceeds ${MAX_READ_TEXT_BYTES} bytes; use a streaming computation through the host shell. No partial text was returned.`);
        if (info.size > MAX_READ_TEXT_BYTES) throw tooLarge();
        const chunks = [];
        let bytes = 0;
        for await (const chunk of await fsCtx.fs.streamText(target, exec.signal)) {
          exec.signal.throwIfAborted();
          bytes += Buffer.byteLength(chunk, 'utf8');
          if (bytes > MAX_READ_TEXT_BYTES) throw tooLarge();
          chunks.push(chunk);
        }
        exec.signal.throwIfAborted();
        fsCtx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec);
        return chunks.join('');
      },
    }));
  });
  ctx.systemPrompt.section({
    name: 'agent-harness-plugin:complete-file-input', order: 655,
    text: ({ agent }) => ctx.tools.get('read_text', agent)
      ? 'For parsing a JSON/text file in the REPL, use `let text = await tools.read_text({ file_path }); let data = JSON.parse(text)`. Native `read` is a display window: its lines may be truncated at 2,000 characters before reaching the REPL, so joining them does not recover the original file. Do not parse those previews or repeatedly read the same truncated line. read_text returns the complete string or an explicit size error; retain it and print only selected evidence. If a large value is only previewed by the REPL, the bound variable still holds the returned text.'
      : '',
  });
}
