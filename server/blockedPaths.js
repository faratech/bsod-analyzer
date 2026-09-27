// Source, config and map files that must never be served even if they end up
// under the static root. Matching runs on the percent-decoded path, the same
// form static serving resolves (server/fastifyCompat.js staticMiddleware), so
// `/%2Eenv` or `/app.js%2Emap` cannot slip past it.
const BLOCKED_PREFIXES = [
  '/public',
  '/src',
  '/components',
  '/pages',
  '/services',
  '/hooks',
  '/types',
  '/node_modules',
  '/.git',
  '/.env'
];

const BLOCKED_SUFFIXES = [
  '.ts',
  '.tsx',
  '.js.map',
  '.css.map',
  '.log',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  '.env'
];

// Returns 'blocked', 'invalid' (undecodable escape) or null.
export function classifyRequestPath(rawPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rawPath || ''));
  } catch {
    return 'invalid';
  }
  if (decoded.includes('\0')) return 'invalid';
  const pathname = decoded.toLowerCase();
  if (BLOCKED_PREFIXES.some(prefix => pathname.startsWith(prefix))) return 'blocked';
  if (BLOCKED_SUFFIXES.some(suffix => pathname.endsWith(suffix))) return 'blocked';
  return null;
}
