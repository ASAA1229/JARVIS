/**
 * Minimal JSON Schema validator for the subset the ASAA ecosystem contracts use
 * (type, const, enum, pattern, required, properties, additionalProperties, items, uniqueItems,
 * minLength/maxLength, format date-time/uuid). Used instead of a heavy dependency; returns a
 * list of human-readable problems (empty means valid).
 */
type Schema = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

export function validateSchema(schema: Schema, value: unknown, path = '$'): string[] {
  const problems: string[] = [];
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) problems.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => JSON.stringify(item) === JSON.stringify(value))) problems.push(`${path}: not one of ${JSON.stringify(schema.enum)}`);
  if (schema.type !== undefined) {
    const allowed = ([] as string[]).concat(schema.type as string | string[]);
    const actual = typeOf(value);
    if (!allowed.includes(actual) && !(actual === 'integer' && allowed.includes('number'))) problems.push(`${path}: expected ${allowed.join('|')}, got ${actual}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) problems.push(`${path}: does not match ${schema.pattern}`);
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) problems.push(`${path}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) problems.push(`${path}: longer than ${schema.maxLength}`);
    if (schema.format === 'uuid' && !UUID.test(value)) problems.push(`${path}: not a uuid`);
    if (schema.format === 'date-time' && (!DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) problems.push(`${path}: not a date-time`);
  }
  if (Array.isArray(value)) {
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) problems.push(`${path}: items are not unique`);
    if (schema.items && typeof schema.items === 'object') value.forEach((item, index) => problems.push(...validateSchema(schema.items as Schema, item, `${path}[${index}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const name of (schema.required as string[] | undefined) ?? []) if (!(name in record)) problems.push(`${path}: missing required "${name}"`);
    const properties = (schema.properties as Record<string, Schema> | undefined) ?? {};
    for (const [name, child] of Object.entries(record)) {
      if (name in properties) problems.push(...validateSchema(properties[name], child, `${path}.${name}`));
      else if (schema.additionalProperties === false) problems.push(`${path}: unexpected property "${name}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') problems.push(...validateSchema(schema.additionalProperties as Schema, child, `${path}.${name}`));
    }
  }
  return problems;
}
