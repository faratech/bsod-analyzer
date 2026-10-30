// Strict command-line parsing for the operator scripts (issue #375).
//
// Accepts `--name=value` and `--name value`; boolean flags take no value.
// Unknown flags, single-dash flags, missing or repeated values, extra
// positionals and values that fail their type all throw ArgsError, so a typo
// or a dropped value can never silently turn into a default (an unbounded
// `--limit` once regenerated the whole corpus on a paid route).
//
// spec = { flags: { name: { type, choices? } }, positionals: maxCount (default 0) }
// types: string | boolean | positiveInteger | nonNegativeNumber | list
// Returns { flags, positionals }; only flags given on the command line are set.

export class ArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgsError';
  }
}

function convert(name, value, def) {
  switch (def.type) {
    case 'string':
      if (value === '') throw new ArgsError(`--${name} needs a value`);
      return value;
    case 'positiveInteger': {
      if (!/^[1-9]\d*$/.test(value)) throw new ArgsError(`--${name} must be a positive integer, got '${value}'`);
      const n = Number(value);
      if (!Number.isSafeInteger(n)) throw new ArgsError(`--${name} is too large`);
      return n;
    }
    case 'nonNegativeNumber': {
      if (!/^\d+(\.\d+)?$/.test(value)) throw new ArgsError(`--${name} must be a non-negative number, got '${value}'`);
      return Number(value);
    }
    case 'list': {
      const items = value.split(',').map(s => s.trim());
      if (items.some(item => !item)) throw new ArgsError(`--${name} needs a comma-separated list`);
      if (def.choices) {
        const unknown = items.filter(item => !def.choices.includes(item));
        if (unknown.length) throw new ArgsError(`--${name}: unknown ${unknown.join(', ')} (choose from ${def.choices.join(', ')})`);
      }
      return items;
    }
    default:
      throw new ArgsError(`--${name}: unsupported type ${def.type}`);
  }
}

export function parseArgs(argv, spec) {
  const defs = spec.flags || {};
  const maxPositionals = spec.positionals ?? 0;
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('-') || arg === '-') {
      if (positionals.length >= maxPositionals) throw new ArgsError(`unexpected argument '${arg}'`);
      positionals.push(arg);
      continue;
    }
    if (!arg.startsWith('--') || arg === '--') throw new ArgsError(`unknown option '${arg}'`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const def = Object.hasOwn(defs, name) ? defs[name] : null;
    if (!def) throw new ArgsError(`unknown option '--${name}'`);
    if (Object.hasOwn(flags, name)) throw new ArgsError(`--${name} given more than once`);
    if (def.type === 'boolean') {
      if (eq !== -1) throw new ArgsError(`--${name} takes no value`);
      flags[name] = true;
      continue;
    }
    let value;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new ArgsError(`--${name} needs a value`);
      value = next;
      i++;
    }
    flags[name] = convert(name, value, def);
  }
  return { flags, positionals };
}
