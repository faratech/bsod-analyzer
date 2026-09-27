import test from 'node:test';
import assert from 'node:assert/strict';

// The module reads its config at import time.
process.env.FORUM_VALIDATE_URL = 'https://forum.example/validate';
process.env.WF_SSO_SECRET = 'test-sso-key';
const { resolveForumIdentityFromCookies } = await import('../services/forumIdentity.js');

function stubFetch(body) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => body };
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('cookie values that would add extra cookies are rejected without a request', async () => {
  const stub = stubFetch({ userId: 7, isPremium: true });
  try {
    for (const xf_session of ['abc; admin=1', 'abc admin=1', 'abc\r\nX: y']) {
      assert.equal(await resolveForumIdentityFromCookies({ xf_session }, '203.0.113.9'), null);
    }
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test('premium requires isPremium === true from the validator', async () => {
  const stub = stubFetch({ userId: 42, username: 'u', isPremium: 'false' });
  try {
    const identity = await resolveForumIdentityFromCookies({ xf_session: 'sess42', xf_user: '42,abc' }, '203.0.113.10');
    assert.equal(identity.tier, 'forum');
    assert.equal(identity.isPremium, false);
    assert.equal(stub.calls[0].init.headers.Cookie, 'xf_session=sess42; xf_user=42,abc');
  } finally {
    stub.restore();
  }
});
