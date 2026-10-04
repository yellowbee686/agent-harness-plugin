import { renderToolsSdk } from '@deepseek-ai/dsh-tools';

// These constraints refine values, not the TypeScript shape. Retain them as
// documentation in the presentation copy; never change registered schemas.
const VALUE_CONSTRAINTS = new Set([
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern',
  'format', 'minProperties', 'maxProperties',
]);

export function presentationSchema(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const copy = structuredClone(schema);
  const constraints = [];
  for (const key of VALUE_CONSTRAINTS) {
    if (!Object.hasOwn(copy, key)) continue;
    constraints.push(`${key}=${JSON.stringify(copy[key])}`);
    delete copy[key];
  }
  if (constraints.length) {
    copy.description = [copy.description, `Runtime constraints: ${constraints.join(', ')}.`].filter(Boolean).join(' ');
  }
  // Recurse only through schema positions. A property named "minimum", or a
  // constraint-like key inside a default/example, is application data.
  if (copy.properties) {
    copy.properties = Object.fromEntries(Object.entries(copy.properties).map(([key, value]) => [key, presentationSchema(value)]));
  }
  for (const key of ['items', 'additionalProperties']) {
    if (copy[key] && typeof copy[key] === 'object' && !Array.isArray(copy[key])) copy[key] = presentationSchema(copy[key]);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf', 'prefixItems']) {
    if (Array.isArray(copy[key])) copy[key] = copy[key].map(presentationSchema);
  }
  return copy;
}

function mapRange(text, map) {
  const startMarker = `interface ${map} {`;
  const start = text.indexOf(startMarker);
  const end = text.indexOf('\n}', start);
  if (start < 0 || end < 0 || text.indexOf(startMarker, start + 1) >= 0) {
    throw new Error(`dsh-rlm: cannot locate unique ${map} in the Prime SDK`);
  }
  return { start: start + startMarker.length, end };
}

function memberKey(name) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Repair only failed declarations, preserving Prime's instructions and aliases. */
export function repairSdk(text, schemas) {
  const fallbacks = [];
  for (const schema of schemas) {
    for (const [map, field] of [['ToolArgsMap', 'parameters'], ['ToolOutputMap', 'output']]) {
      const range = mapRange(text, map);
      const missing = `\n  ${memberKey(schema.name)}: unknown;`;
      const body = text.slice(range.start, range.end);
      if (!body.includes(missing)) continue;
      const projected = presentationSchema(schema[field]);
      const rootConstraints = Object.entries(schema[field] ?? {}).filter(([key]) => VALUE_CONSTRAINTS.has(key))
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
      const rendered = renderToolsSdk([{
        name: schema.name,
        description: rootConstraints.length ? `Runtime constraints: ${rootConstraints.join(', ')}.` : '',
        parameters: projected, output: projected,
      }]);
      // Both types are the same in this single-schema rendering. ArgsMap also
      // carries root constraint docs, including when repairing an output type.
      const generatedRange = mapRange(rendered, 'ToolArgsMap');
      const member = rendered.slice(generatedRange.start, generatedRange.end);
      if (member.trimEnd().endsWith(`  ${memberKey(schema.name)}: unknown;`)) {
        // A schema intentionally accepting arbitrary JSON needs no diagnostic.
        const original = schema[field];
        const unrestricted = original === undefined || original === true || (
          original !== null && typeof original === 'object' && !Array.isArray(original)
          && Object.keys(original).every(key => ['description', 'title', 'default', 'examples'].includes(key))
        );
        if (!unrestricted) {
          fallbacks.push({ tool: schema.name, field, schema: schema[field] });
        }
        continue;
      }
      text = text.slice(0, range.start) + body.replace(missing, member) + text.slice(range.end);
    }
  }
  return { text, fallbacks };
}

/** Cordis composition hook runs after Prime's assembly via waterfall unwind. */
export function installSchemaPresentation(ctx) {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const result = await next();
    if (!context.agent) return result;
    const section = result.sections.find(section => section.name === 'tools:sdk');
    if (!section) throw new Error('dsh-rlm: Prime SDK section is missing');
    const schemas = ctx.tools.schemas(context.agent).filter(schema => schema.name !== 'repl').map(schema => ({
      ...schema, output: ctx.tools.get(schema.name, context.agent).output.schema,
    }));
    const repaired = repairSdk(section.text, schemas);
    section.text = repaired.text;
    section.interpolate = false;
    if (repaired.fallbacks.length) {
      result.sections.push({
        name: 'agent-harness-plugin:schema-fallback',
        interpolate: false,
        text: 'Some tool schemas could not be expressed as TypeScript. Their unknown declarations are not evidence of unrestricted arguments. Use these original JSON Schemas; runtime validation remains authoritative.\n\n'
          + repaired.fallbacks.map(item => `${item.tool} (${item.field}):\n${JSON.stringify(item.schema, null, 2)}`).join('\n\n'),
      });
    }
    return result;
  });
}
