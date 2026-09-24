/** Runtime validation of the JSON Schema subset used by the registry. */
function validateSchemaValue(value, schema, label) {
  const expected = schema?.type;
  const valid =
    expected === "array"
      ? Array.isArray(value)
      : expected === "object"
        ? value !== null && typeof value === "object" && !Array.isArray(value)
        : expected === "integer"
          ? Number.isInteger(value)
          : expected == null || typeof value === expected;
  if (!valid) return `${label} must be ${expected}`;

  if (typeof value === "string" && schema.minLength != null && value.length < schema.minLength) {
    return `${label} must not be empty`;
  }
  if (typeof value === "number" && schema.minimum != null && value < schema.minimum) {
    return `${label} must be at least ${schema.minimum}`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) return `${label} must contain at least ${schema.minItems} item`;
    for (let i = 0; i < value.length; i++) {
      const error = validateSchemaValue(value[i], schema.items ?? {}, `${label}[${i}]`);
      if (error) return error;
    }
  }
  if (expected === "object") {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) return `${label} is missing required argument: ${name}`;
    }
    for (const [name, child] of Object.entries(value)) {
      const childSchema = schema.properties?.[name];
      if (!childSchema) {
        if (schema.additionalProperties === false) return `${label} has unknown argument: ${name}`;
        continue;
      }
      const error = validateSchemaValue(child, childSchema, `${label}.${name}`);
      if (error) return error;
    }
  }
  return null;
}

/** Validate the model's arguments against the advertised schema and semantics. */
export function validateToolArgs(tool, args) {
  const error = validateSchemaValue(args, tool.parameters ?? { type: "object" }, `${tool.name} arguments`);
  if (error) return error;
  return tool.validate?.(args) ?? null;
}
