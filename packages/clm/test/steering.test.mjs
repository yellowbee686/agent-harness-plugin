import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSteering } from '../steering.mjs';

test('steering opt-in, exact byte identity, and fail-closed document loading', t => {
  assert.equal(loadSteering('off'), undefined);
  const bundled = loadSteering('on');
  assert.match(bundled.text, /never print the entire mirror/);
  const root = mkdtempSync(join(tmpdir(), 'clm steering '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'custom.md');
  writeFileSync(path, 'Custom strategy ${literal}\n');
  const first = loadSteering(path);
  assert.equal(loadSteering(path, first.sha256).sha256, first.sha256);
  writeFileSync(path, 'Changed strategy\n');
  assert.throws(() => loadSteering(path, first.sha256), /content changed/);
  writeFileSync(path, '  \n');
  assert.throws(() => loadSteering(path), /empty/);
  assert.throws(() => loadSteering(''), /must be/);
  assert.throws(() => loadSteering(join(root, 'missing.md')), /ENOENT/);
});
