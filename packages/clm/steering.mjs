import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadSteering(selection = process.env.DSH_CLM_STEERING ?? 'off', expectedHash = process.env.DSH_CLM_STEERING_SHA256) {
  if (selection === 'off') return undefined;
  if (!selection) throw new Error('CLM steering must be off, on, or a document path');
  const path = selection === 'on'
    ? fileURLToPath(new URL('./steering/efficient-context.md', import.meta.url))
    : resolve(selection);
  if (/[\r\n]/.test(path)) throw new Error('CLM steering path must be a single line');
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8').trim();
  if (!text) throw new Error(`CLM steering document is empty: ${path}`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedHash && expectedHash !== sha256) throw new Error('CLM steering content changed since the run was configured');
  return { path, text, sha256 };
}

// The launcher uses the same resolver as the plugin for experiment identity.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const doc = loadSteering(process.argv[2]);
    if (doc) process.stdout.write(`${doc.path}\n${doc.sha256}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
