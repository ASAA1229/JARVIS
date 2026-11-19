import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';
import { mock } from 'node:test';
import { CiIntegrationDisabledError, DisabledCiProvider, createCiProvider, manifestInputs, validateBuildIdentity } from '../src/release/ciProvider.js';

/** JARVIS-GAP-023 / JAR-E09: the Jenkins integration boundary fails closed. */
const root = resolve(import.meta.dirname, '..');
const identity = { gitCommit: 'a'.repeat(40), buildNumber: '42', runUrl: 'https://ci.example.com/job/jarvis/42/', repository: 'ASAA1229/JARVIS' };
const coordinates = { customer: 'acme', product: 'jarvis', version: '1.2.3', release: 'r1' };

test('the disabled provider refuses every call and contacts nothing', async () => {
  const connects: unknown[] = [];
  const real = net.Socket.prototype.connect;
  mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: unknown[]) { connects.push(args[0]); return (real as (...a: unknown[]) => net.Socket).apply(this, args); } as never);
  try {
    const provider = new DisabledCiProvider();
    assert.equal(provider.enabled, false);
    await assert.rejects(provider.getBuildIdentity('1'), CiIntegrationDisabledError);
    await assert.rejects(provider.triggerBuild({ BRANCH: 'main' }), /not enabled.*Nothing was contacted/);
    assert.deepEqual(connects, []);
  } finally { mock.restoreAll(); }
});

test('Jenkins-looking environment variables never enable the provider', async () => {
  for (const env of [{}, { JENKINS_URL: 'https://jenkins.example.com', JENKINS_API_TOKEN: 'token', JENKINS_USER: 'admin' }, { JARVIS_JENKINS_ENABLED: 'true', JENKINS_URL: 'https://jenkins.example.com' }]) {
    const provider = createCiProvider(env);
    assert.equal(provider.enabled, false);
    await assert.rejects(provider.triggerBuild({}), CiIntegrationDisabledError);
  }
});

test('build identity must be complete and explicit', () => {
  assert.deepEqual(validateBuildIdentity(identity).gitCommit, identity.gitCommit);
  for (const bad of [{ gitCommit: 'abc123' }, { gitCommit: 'A'.repeat(40) }, { buildNumber: '0' }, { buildNumber: 'x' }, { buildNumber: '' }, { runUrl: 'not a url' }, { runUrl: 'ftp://ci/x' }, { runUrl: 'https://user:pw@ci/x' }, { runUrl: 'https://ci/x?token=1' }, { repository: 'no-slash' }, { repository: '../x/y' }]) {
    assert.throws(() => validateBuildIdentity({ ...identity, ...bad }), /requires|must be/, JSON.stringify(bad));
  }
});

test('release coordinates are never inferred from branch names or defaults', () => {
  assert.equal(manifestInputs(identity, coordinates, 'new').customer, 'acme');
  assert.throws(() => manifestInputs(identity, undefined, 'release/acme'), /never inferred/);
  assert.throws(() => manifestInputs(identity, { ...coordinates, version: '' }), /"version" is missing or invalid/);
  assert.throws(() => manifestInputs(identity, { ...coordinates, customer: 'acme' }, 'origin/acme'), /derived from the branch name/);
  assert.throws(() => manifestInputs({ ...identity, gitCommit: 'short' }, coordinates), /40-character/);
  assert.throws(() => manifestInputs(identity, { ...coordinates, product: '../etc' }), /"product"/);
});

test('Jenkinsfile design contract: publication and signing are off by default, guarded and credential-scoped', () => {
  const file = readFileSync(resolve(root, 'Jenkinsfile'), 'utf8');
  assert.match(file, /booleanParam\(name: 'ENABLE_NEXUS_PUBLISH', defaultValue: false/);
  assert.match(file, /booleanParam\(name: 'ENABLE_POLICY_SIGNING', defaultValue: false/);
  assert.match(file, /REQUIRE_BUILD_PROVENANCE = 'true'/);
  const nexus = file.slice(file.indexOf("stage('Publish to Nexus (optional, release branches only)')"));
  assert.match(nexus.slice(0, 700), /when\s*\{/, 'the Nexus stage is guarded by a when condition');
  assert.match(nexus.slice(0, 700), /isReleaseBranch\(\)/, 'only main or release/* may publish');
  assert.match(nexus.slice(0, 700), /params\.ENABLE_NEXUS_PUBLISH/, 'needs the owner flag');
  assert.match(nexus.slice(0, 700), /NEXUS_RAW_REPOSITORY_URL/, 'needs an explicit repository URL');
  assert.match(nexus.slice(0, 900), /input\s*\{/, 'needs an explicit approval');
  const publisher = readFileSync(resolve(root, 'ci/jenkins/publish-nexus.ps1'), 'utf8');
  assert.match(publisher, /Refusing to overwrite existing Nexus release asset/, 'published coordinates are immutable');
  assert.match(publisher, /read-back/i, 'uploads are verified by read-back');
  assert.match(publisher, /must use HTTPS and must not contain embedded credentials/);
  assert.ok(!/(password|token|secret)\s*[:=]\s*['"][^'"$]{6,}['"]/i.test(file + publisher), 'no hard-coded secrets');
  for (const credential of file.match(/credentialsId: '([^']+)'/g) ?? []) assert.match(credential, /credentialsId: '(manifest-ignore-(private|public)-key|nexus-credentials)'/);
});
