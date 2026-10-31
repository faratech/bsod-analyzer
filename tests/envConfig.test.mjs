import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePositiveIntEnv, parseBoolEnv, parseTrustProxyHops, readEnvSwitches } from '../server/envConfig.js';
import { createPeerIpResolver } from '../server/peerIp.js';
import { aiRequestDeadlineMs } from '../server/aiDeadline.js';

// Issue #292: env values are parsed strictly, in one place. A malformed value
// warns (env.invalid, naming the variable) and keeps the default instead of
// being truncated (`90s` -> 90) or flipping a switch by spelling.
function collect() {
  const warnings = [];
  return { warnings, warn: fields => warnings.push(fields) };
}

test('positive integers: digits with optional underscores, anything else warns and keeps the default', () => {
  const cases = [
    ['90s', 7], ['1.5M', 7], ['16k', 7], ['1e6', 7], ['abc', 7], ['0', 7], ['-1', 7], ['12 000', 7], ['_1', 7], ['1__0', 7],
    ['1', 1], ['90000', 90_000], ['1_500_000', 1_500_000], [' 45000 ', 45_000]
  ];
  for (const [value, expected] of cases) {
    const { warnings, warn } = collect();
    assert.equal(parsePositiveIntEnv({ X_LIMIT: value }, 'X_LIMIT', 7, { warn }), expected, `X_LIMIT=${value}`);
    assert.equal(warnings.length, expected === 7 ? 1 : 0, `warnings for ${value}`);
    if (warnings.length) {
      assert.equal(warnings[0].event, 'env.invalid');
      assert.equal(warnings[0].name, 'X_LIMIT');
    }
  }
  const { warnings, warn } = collect();
  assert.equal(parsePositiveIntEnv({}, 'X_LIMIT', 7, { warn }), 7);
  assert.equal(parsePositiveIntEnv({ X_LIMIT: '' }, 'X_LIMIT', 7, { warn }), 7);
  assert.equal(warnings.length, 0, 'an unset value is not a typo');
});

test('booleans accept 1/true/yes/on and 0/false/no/off case-insensitively', () => {
  for (const value of ['1', 'true', 'TRUE', 'Yes', 'on', ' On ']) {
    assert.equal(parseBoolEnv({ S: value }, 'S', false), true, value);
  }
  for (const value of ['0', 'false', 'False', 'NO', 'off', 'OFF']) {
    assert.equal(parseBoolEnv({ S: value }, 'S', true), false, value);
  }
  assert.equal(parseBoolEnv({}, 'S', true), true);
  assert.equal(parseBoolEnv({}, 'S', false), false);
  const { warnings, warn } = collect();
  assert.equal(parseBoolEnv({ S: 'enabled-ish' }, 'S', true, { invalid: false, warn }), false, 'unknown uses the safe side');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].name, 'S');
});

test('switches: natural spellings work and unknown values keep the safe side', () => {
  const quiet = { warn: () => {} };
  // Ingress gate: on in production by default, and kept on for a typo.
  assert.equal(readEnvSwitches({ NODE_ENV: 'production' }, quiet).cloudflareOnlyIngress, true);
  assert.equal(readEnvSwitches({ NODE_ENV: 'production', CLOUDFLARE_ONLY_INGRESS: '1' }, quiet).cloudflareOnlyIngress, true);
  assert.equal(readEnvSwitches({ NODE_ENV: 'production', CLOUDFLARE_ONLY_INGRESS: 'TRUE' }, quiet).cloudflareOnlyIngress, true);
  assert.equal(readEnvSwitches({ NODE_ENV: 'production', CLOUDFLARE_ONLY_INGRESS: 'ture' }, quiet).cloudflareOnlyIngress, true);
  assert.equal(readEnvSwitches({ NODE_ENV: 'production', CLOUDFLARE_ONLY_INGRESS: 'off' }, quiet).cloudflareOnlyIngress, false);
  assert.equal(readEnvSwitches({}, quiet).cloudflareOnlyIngress, false);
  assert.equal(readEnvSwitches({ CLOUDFLARE_ONLY_INGRESS: 'yes' }, quiet).cloudflareOnlyIngress, true);

  // Capture switches: on by default, off for any off spelling, off for a typo.
  const defaults = readEnvSwitches({}, quiet);
  for (const key of ['statsEnabled', 'statsInsightEnabled', 'forumRelatedEnabled', 'corpusEnabled', 'corpusPriorsEnabled']) {
    assert.equal(defaults[key], true, key);
  }
  const off = readEnvSwitches({
    STATS_ENABLED: '0', STATS_INSIGHT_ENABLED: 'off', FORUM_RELATED_ENABLED: 'No',
    CORPUS_ENABLED: 'False', CORPUS_PRIORS_ENABLED: 'OFF'
  }, quiet);
  for (const key of ['statsEnabled', 'statsInsightEnabled', 'forumRelatedEnabled', 'corpusEnabled', 'corpusPriorsEnabled']) {
    assert.equal(off[key], false, key);
  }
  const { warnings, warn } = collect();
  const typo = readEnvSwitches({ CORPUS_ENABLED: 'disable', STATS_ENABLED: 'maybe' }, { warn });
  assert.equal(typo.corpusEnabled, false);
  assert.equal(typo.statsEnabled, false);
  assert.deepEqual(warnings.map(w => w.name).sort(), ['CORPUS_ENABLED', 'STATS_ENABLED']);
  assert.equal(readEnvSwitches({ STATS_ENABLED: 'On' }, quiet).statsEnabled, true);

  // The BSOD AI chat is the one switch that is off by default: a new AI surface
  // is turned on deliberately, and a typo keeps it off.
  assert.equal(readEnvSwitches({}, quiet).bsodAiChatEnabled, false);
  assert.equal(readEnvSwitches({ BSOD_AI_CHAT_ENABLED: 'true' }, quiet).bsodAiChatEnabled, true);
  assert.equal(readEnvSwitches({ BSOD_AI_CHAT_ENABLED: 'On' }, quiet).bsodAiChatEnabled, true);
  assert.equal(readEnvSwitches({ BSOD_AI_CHAT_ENABLED: 'treu' }, quiet).bsodAiChatEnabled, false);
  assert.equal(readEnvSwitches({ BSOD_AI_CHAT_ENABLED: '0' }, quiet).bsodAiChatEnabled, false);
});

test('TRUST_PROXY_HOPS is validated once as an integer >= 1', () => {
  const quiet = { warn: () => {} };
  assert.equal(parseTrustProxyHops({}, quiet), 2);
  assert.equal(parseTrustProxyHops({ TRUST_PROXY_HOPS: '1' }, quiet), 1);
  assert.equal(parseTrustProxyHops({ TRUST_PROXY_HOPS: '3' }, quiet), 3);
  for (const value of ['abc', '0', '-1', '2.5', '2x']) {
    const { warnings, warn } = collect();
    assert.equal(parseTrustProxyHops({ TRUST_PROXY_HOPS: value }, { warn }), 2, value);
    assert.equal(warnings.length, 1, value);
  }
});

test('a resolver with no valid hop count never trusts X-Forwarded-For', () => {
  const forged = {
    headers: { 'x-forwarded-for': '104.16.0.1', 'cf-connecting-ip': '198.51.100.77' },
    socket: { remoteAddress: '203.0.113.9' }
  };
  for (const hops of [0, -1, NaN, undefined]) {
    const resolver = createPeerIpResolver({ trustProxyHops: hops });
    assert.equal(resolver.hasTrustedXffChain(forged), false, String(hops));
    assert.equal(resolver.isFromCloudflare(forged), false, String(hops));
    assert.equal(resolver.getClientIp(forged), '203.0.113.9', String(hops));
  }
});

test('the AI deadline uses the strict parser', () => {
  const quiet = { warn: () => {} };
  assert.equal(aiRequestDeadlineMs({ AI_REQUEST_DEADLINE_MS: '45s' }, quiet), 90_000);
  assert.equal(aiRequestDeadlineMs({ AI_REQUEST_DEADLINE_MS: '45_000' }, quiet), 45_000);
});
