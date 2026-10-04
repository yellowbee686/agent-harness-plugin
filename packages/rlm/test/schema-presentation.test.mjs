import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderToolsSdk } from '@deepseek-ai/dsh-tools';
import { presentationSchema, repairSdk } from '../schema-presentation.mjs';

const bounded = {
  type: 'object', additionalProperties: false, required: ['room_ids'],
  properties: {
    room_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
    limit: { type: 'integer', minimum: 1, maximum: 2000, default: 100 },
    fields: { type: 'array', items: { type: 'string', enum: ['stats', 'metadata'] } },
    minimum: { type: 'number' },
  },
};

test('bounded MCP schemas retain shape, limits, enums and original validation schema', () => {
  const schema = { name: 'mcp__live__static', description: 'Preserve host guidance.', parameters: bounded, output: { type: 'string' } };
  const snapshot = structuredClone(schema);
  const original = renderToolsSdk([schema]);
  assert.match(original, /mcp__live__static: unknown;/);
  const repaired = repairSdk(original, [schema]);
  assert.match(repaired.text, /room_ids: string\[\]/);
  assert.match(repaired.text, /limit\?: number/);
  assert.match(repaired.text, /"stats" \| "metadata"/);
  assert.match(repaired.text, /minItems=1, maxItems=100/);
  assert.match(repaired.text, /minimum=1, maximum=2000/);
  assert.match(repaired.text, /minimum\?: number/);
  assert.match(repaired.text, /Preserve host guidance/);
  assert.deepEqual(repaired.fallbacks, []);
  assert.deepEqual(schema, snapshot);
});

test('schema-like keys in properties, defaults and examples are not stripped', () => {
  const input = { ...bounded, default: { minimum: 17, maxItems: 9 }, examples: [{ maximum: 5 }] };
  const copy = presentationSchema(input);
  assert.deepEqual(copy.default, input.default);
  assert.deepEqual(copy.examples, input.examples);
  assert.deepEqual(copy.properties.minimum, input.properties.minimum);
});

test('root constraints remain visible on a repaired argument declaration', () => {
  const schema = { name: 'root_array', description: '', parameters: { type: 'array', items: { type: 'string' }, maxItems: 3 }, output: { type: 'integer', minimum: 0 } };
  const repaired = repairSdk(renderToolsSdk([schema]), [schema]);
  assert.match(repaired.text, /Runtime constraints: maxItems=3/);
  assert.match(repaired.text, /root_array: string\[\]/);
  assert.match(repaired.text.split('interface ToolOutputMap')[1], /Runtime constraints: minimum=0/);
});

test('unsupported structural schemas have a visible original-schema fallback', () => {
  const schema = { name: 'dynamic-tool', description: '', parameters: { anyOf: [{ type: 'string' }, { type: 'number' }] }, output: {} };
  const result = repairSdk(renderToolsSdk([schema]), [schema]);
  assert.deepEqual(result.fallbacks, [{ tool: schema.name, field: 'parameters', schema: schema.parameters }]);
  assert.match(result.text, /"dynamic-tool": unknown;/);
  const forbidden = { ...schema, parameters: false };
  assert.deepEqual(repairSdk(renderToolsSdk([forbidden]), [forbidden]).fallbacks,
    [{ tool: schema.name, field: 'parameters', schema: false }]);
});

test('schema shape changes fail visibly instead of silently dropping declarations', () => {
  assert.throws(() => repairSdk('SDK changed', [{ name: 'tool' }]), /cannot locate unique ToolArgsMap/);
});
