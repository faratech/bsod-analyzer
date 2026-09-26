import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMaintenanceMiddleware, isMaintenanceMode } from '../server/maintenance.js';

function fakeRes() {
  const res = {
    headers: {},
    statusCode: 200,
    body: null,
    set(headersOrName, value) {
      if (typeof headersOrName === 'string') this.headers[headersOrName] = value;
      else Object.assign(this.headers, headersOrName);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    }
  };
  return res;
}

function run(middleware, path) {
  const res = fakeRes();
  let nextCalled = false;
  middleware({ path }, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('isMaintenanceMode is true only for the exact string true', () => {
  assert.equal(isMaintenanceMode({ MAINTENANCE_MODE: 'true' }), true);
  assert.equal(isMaintenanceMode({}), false);
  assert.equal(isMaintenanceMode({ MAINTENANCE_MODE: '1' }), false);
  assert.equal(isMaintenanceMode({ MAINTENANCE_MODE: 'false' }), false);
  assert.equal(isMaintenanceMode({ MAINTENANCE_MODE: 'TRUE' }), false);
});

test('enabled mode serves 503 + Retry-After page and blocks next', () => {
  const middleware = createMaintenanceMiddleware({ enabled: () => true });
  const { res, nextCalled } = run(middleware, '/api/analyze');
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['Retry-After'], '3600');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.match(res.body, /offline for maintenance/);
  assert.match(res.body, /<!DOCTYPE html>/);
});

test('health check always passes through, even in maintenance mode', () => {
  const middleware = createMaintenanceMiddleware({ enabled: () => true });
  const { res, nextCalled } = run(middleware, '/health');
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body, null);
});

test('disabled mode passes every request through untouched', () => {
  const middleware = createMaintenanceMiddleware({ enabled: () => false });
  for (const path of ['/', '/api/analyze', '/stats']) {
    const { res, nextCalled } = run(middleware, path);
    assert.equal(nextCalled, true);
    assert.equal(res.body, null);
  }
});
