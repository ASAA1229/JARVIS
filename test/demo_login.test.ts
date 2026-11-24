import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-expect-error plain ESM script without type declarations
import { TEST_DATA_COMMENT, planDemoLogin } from '../scripts/demo-login.mjs';

const base = { JARVIS_ENVIRONMENT: 'development', DEMO_USER_EMAIL: 'demo@example.com', DEMO_USER_PASSWORD: 'Sup3r-Secret-Pass!' };

test('E3:D4.12 demo login refuses outside development and for production', () => {
  assert.equal(planDemoLogin({ ...base, JARVIS_ENVIRONMENT: 'production' }, '').ok, false);
  assert.equal(planDemoLogin({ ...base, JARVIS_ENVIRONMENT: '' }, '').ok, false);
  assert.equal(planDemoLogin({ ...base, NODE_ENV: 'production' }, '').ok, false);
});

test('E3:D4.12 demo login requires an email and a loopback identity provider', () => {
  assert.equal(planDemoLogin({ JARVIS_ENVIRONMENT: 'development' }, '').ok, false);
  assert.equal(planDemoLogin({ ...base, JARVIS_OIDC_ISSUER: 'https://idp.example.com/realms/asaa' }, '').ok, false);
});

test('E3:D4.12 demo login adds only missing SSO keys and never writes the password', () => {
  const plan = planDemoLogin(base, 'JARVIS_OIDC_CLIENT_ID=custom-client\n');
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changed.sort(), ['JARVIS_OIDC_ISSUER', 'JARVIS_OIDC_REQUIRED_ROLE']);
  assert.match(plan.text, /JARVIS_OIDC_CLIENT_ID=custom-client/);
  assert.equal(plan.text.includes('Sup3r-Secret-Pass'), false);
  assert.equal(plan.text.includes('demo@example.com'), false);
  assert.equal(JSON.stringify(plan).includes('Sup3r-Secret-Pass'), false);
});

test('E3:D4.14 demo login labels the keys it adds as TEMPORARY / TEST DATA, once', () => {
  assert.equal(TEST_DATA_COMMENT, '# TEMPORARY / TEST DATA – local demo admin login, never use in production');
  const plan = planDemoLogin(base, 'OTHER=1\n');
  assert.equal(plan.ok, true);
  const lines = plan.text.split('\n');
  assert.equal(lines[0], 'OTHER=1');
  assert.equal(lines[1], TEST_DATA_COMMENT);
  assert.match(lines[2], /^JARVIS_OIDC_/);
  assert.equal(plan.text.split(TEST_DATA_COMMENT).length, 2);
  const again = planDemoLogin(base, plan.text);
  assert.deepEqual(again.changed, []);
  assert.equal(again.text, plan.text);
  const partial = planDemoLogin(base, `${TEST_DATA_COMMENT}
JARVIS_OIDC_CLIENT_ID=x
`);
  assert.equal(partial.text.split(TEST_DATA_COMMENT).length, 2);
});
