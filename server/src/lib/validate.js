/** Tiny schema validator (no dependencies). Unknown keys are stripped. */
export class ValidationError extends Error {
  constructor(errors) {
    super('Validation failed');
    this.errors = errors;
  }
}

export const v = {
  string: (o = {}) => ({ t: 'string', ...o }),
  number: (o = {}) => ({ t: 'number', ...o }),
  boolean: (o = {}) => ({ t: 'boolean', ...o }),
  enum: (values, o = {}) => ({ t: 'enum', values, ...o }),
  object: (shape, o = {}) => ({ t: 'object', shape, ...o }),
  array: (item, o = {}) => ({ t: 'array', item, ...o }),
};

function check(schema, val, path, errors) {
  if (val === undefined || val === null) {
    if (schema.optional) return schema.default !== undefined ? schema.default : undefined;
    errors.push({ path, message: 'is required' });
    return undefined;
  }
  switch (schema.t) {
    case 'string': {
      if (typeof val !== 'string') { errors.push({ path, message: 'must be a string' }); return; }
      let s = schema.trim === false ? val : val.trim();
      if (schema.lower) s = s.toLowerCase();
      if (schema.min !== undefined && s.length < schema.min) errors.push({ path, message: `must be at least ${schema.min} characters` });
      if (schema.max !== undefined && s.length > schema.max) errors.push({ path, message: `must be at most ${schema.max} characters` });
      if (schema.pattern && !schema.pattern.test(s)) errors.push({ path, message: schema.patternMessage || 'has an invalid format' });
      return s;
    }
    case 'number': {
      if (typeof val !== 'number' || !Number.isFinite(val)) { errors.push({ path, message: 'must be a number' }); return; }
      if (schema.int && !Number.isInteger(val)) errors.push({ path, message: 'must be an integer' });
      if (schema.min !== undefined && val < schema.min) errors.push({ path, message: `must be >= ${schema.min}` });
      if (schema.max !== undefined && val > schema.max) errors.push({ path, message: `must be <= ${schema.max}` });
      return val;
    }
    case 'boolean':
      if (typeof val !== 'boolean') { errors.push({ path, message: 'must be true or false' }); return; }
      return val;
    case 'enum':
      if (!schema.values.includes(val)) { errors.push({ path, message: `must be one of: ${schema.values.join(', ')}` }); return; }
      return val;
    case 'array': {
      if (!Array.isArray(val)) { errors.push({ path, message: 'must be an array' }); return; }
      if (schema.max !== undefined && val.length > schema.max) errors.push({ path, message: `must have at most ${schema.max} items` });
      if (schema.min !== undefined && val.length < schema.min) errors.push({ path, message: `must have at least ${schema.min} items` });
      return val.map((x, i) => check(schema.item, x, `${path}[${i}]`, errors));
    }
    case 'object': {
      if (typeof val !== 'object' || Array.isArray(val)) { errors.push({ path, message: 'must be an object' }); return; }
      const out = {};
      if (schema.shape) {
        for (const [k, s] of Object.entries(schema.shape)) {
          const r = check(s, val[k], path ? `${path}.${k}` : k, errors);
          if (r !== undefined) out[k] = r;
        }
      } else if (schema.values) {
        for (const [k, x] of Object.entries(val)) {
          const r = check(schema.values, x, `${path}.${k}`, errors);
          if (r !== undefined) out[k] = r;
        }
      }
      return out;
    }
    default:
      return val;
  }
}

export function parse(schema, input) {
  const errors = [];
  const value = check(schema, input === undefined ? {} : input, '', errors);
  if (errors.length) throw new ValidationError(errors);
  return value;
}
