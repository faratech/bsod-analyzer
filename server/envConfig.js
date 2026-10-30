// Strict environment parsing, shared by server.js and the server modules
// (issue #292). parseInt truncated `90s` to 90 and `1.5M` to 1, and switches
// matched one literal, so `CLOUDFLARE_ONLY_INGRESS=1` turned the ingress gate
// off and `CORPUS_ENABLED=0` left corpus capture on. A malformed value now
// logs an `env.invalid` warning naming the variable and keeps the default (or,
// for a switch, its safe side).

function defaultWarn(fields) {
  try {
    process.stdout.write(JSON.stringify({ severity: 'WARNING', ...fields }) + '\n');
  } catch {
    // Logging must never stop the server from starting.
  }
}

function rawValue(env, name) {
  const value = env?.[name];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

// Digits only, with optional single underscores between digit groups
// (`1_500_000`); the value must be a positive safe integer.
const POSITIVE_INT = /^\d+(?:_\d+)*$/;

export function parsePositiveIntEnv(env, name, fallback, { warn = defaultWarn } = {}) {
  const text = rawValue(env, name);
  if (text === undefined) return fallback;
  if (POSITIVE_INT.test(text)) {
    const parsed = Number(text.replace(/_/g, ''));
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  warn({ event: 'env.invalid', name, value: text.slice(0, 64), expected: 'positive integer', using: fallback });
  return fallback;
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

// `fallback` applies when the variable is unset; `invalid` (default: the same)
// when it is set to something unrecognised, so a typo can land on the safe side.
export function parseBoolEnv(env, name, fallback, { invalid = fallback, warn = defaultWarn } = {}) {
  const text = rawValue(env, name);
  if (text === undefined) return fallback;
  const lower = text.toLowerCase();
  if (TRUE_VALUES.has(lower)) return true;
  if (FALSE_VALUES.has(lower)) return false;
  warn({ event: 'env.invalid', name, value: text.slice(0, 64), expected: '1/true/yes/on or 0/false/no/off', using: invalid });
  return invalid;
}

// Trusted proxy hops in front of the service (Cloudflare + Cloud Run = 2).
// Validated once and handed to both Fastify and server/peerIp.js.
export const DEFAULT_TRUST_PROXY_HOPS = 2;

export function parseTrustProxyHops(env = process.env, options = {}) {
  return parsePositiveIntEnv(env, 'TRUST_PROXY_HOPS', DEFAULT_TRUST_PROXY_HOPS, options);
}

// The on/off switches. Unrecognised values keep the safe side: the ingress
// gate stays on in production, and the capture/export switches turn off.
export function readEnvSwitches(env = process.env, options = {}) {
  const production = env.NODE_ENV === 'production';
  const capture = name => parseBoolEnv(env, name, true, { ...options, invalid: false });
  return {
    cloudflareOnlyIngress: parseBoolEnv(env, 'CLOUDFLARE_ONLY_INGRESS', production, { ...options, invalid: production }),
    statsEnabled: capture('STATS_ENABLED'),
    statsInsightEnabled: capture('STATS_INSIGHT_ENABLED'),
    forumRelatedEnabled: capture('FORUM_RELATED_ENABLED'),
    corpusEnabled: capture('CORPUS_ENABLED'),
    corpusPriorsEnabled: capture('CORPUS_PRIORS_ENABLED')
  };
}

// Variables of retired provider legs (issue #323, 2026-10-30): they no longer
// switch or size anything. A leftover one is reported once at boot, by name
// only (never its value), so an operator can remove it from the service.
const RETIRED_ENV_PREFIXES = ['EXPLABS_ARGON_'];

export function warnRetiredEnv(env = process.env, { warn = defaultWarn } = {}) {
  const names = Object.keys(env || {})
    .filter(name => RETIRED_ENV_PREFIXES.some(prefix => name.startsWith(prefix)))
    .sort();
  if (names.length > 0) warn({ event: 'env.ignored', names, reason: 'retired provider leg (issue #323)' });
  return names;
}
