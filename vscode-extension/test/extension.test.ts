// TEMPORARY / TEST DATA: fictional fixtures and fake credentials only (E3:D4.17).
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { classifyCommand } from '../src/classify';
import { finalizeEpisode, lineDiffStat, matchesExclude, type Episode } from '../src/episodes';
import { filterDiff, isAssistantCommit, parseGitShow } from '../src/gitParse';
import { isLoopbackUrl, requireLoopbackBase } from '../src/loopback';
import { Pipeline } from '../src/pipeline';
import { OfflineQueue } from '../src/queue';
import { isExcludedPath, redactText } from '../src/redact';
import { claudeCodeParser } from '../src/transcripts/claudeCode';
import { tailTranscript } from '../src/transcripts/tail';
import { encodeProjectDir, selectProjectDirs } from '../src/transcripts/watcher';

const FIXTURE = join(__dirname, '..', '..', 'test', 'fixtures', 'claude-code-sample.jsonl');
const tmp = () => mkdtempSync(join(tmpdir(), 'jarvis-learn-test-'));

test('redaction covers every pattern', () => {
  const samples: Record<string, string> = {
    'sk-': 'key sk-' + 'abcdefghijklmnopqrstuv',
    ghp_: 'ghp_' + 'A'.repeat(36),
    gho_: 'gho_' + 'B'.repeat(36),
    xox: 'xoxb-1234567890-abcdefghij',
    AKIA: 'AKIA' + 'ABCDEFGHIJKLMNOP',
    jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
    bearer: 'Authorization: Bearer abcdefghijklmnopqrstuv',
    privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
    password: 'password=hunter2hunter2',
    secret: 'MY_SECRET: "topsecretvalue"',
    token: 'token=abcd1234efgh',
    connection: 'mongodb://admin:p4ssw0rd@db.example.test:27017/app',
    email: 'reach me at jane.doe@example.org',
    phone: 'call +44 20 7946 0958 or 415-555-0134',
  };
  for (const [name, sample] of Object.entries(samples)) {
    const out = redactText(sample);
    assert.match(out, /\[REDACTED/, `${name} not redacted: ${out}`);
  }
  assert.equal(redactText(samples['sk-']!).includes('abcdefghijklmnopqrstuv'), false);
  assert.equal(redactText(samples['connection']!).includes('p4ssw0rd'), false);
  assert.equal(redactText(samples['privateKey']!).includes('MIIEow'), false);
  assert.equal(redactText('plain build output: 12 passed in 3.4s'), 'plain build output: 12 passed in 3.4s');
  assert.equal(redactText('jane@example.org', { emails: false, phones: true }), 'jane@example.org');
  assert.equal(redactText('415-555-0134', { emails: true, phones: false }), '415-555-0134');
});

test('excluded paths are recognised', () => {
  for (const p of ['.env', 'app/.env.production', 'cert.pem', 'a/b/private.key', 'C:\\Users\\x\\.ssh\\id_ed25519', 'Token.txt', 'credentials.json', 'credentials']) assert.ok(isExcludedPath(p), p);
  for (const p of ['src/environment.ts', 'README.md', 'keyboard.ts']) assert.equal(isExcludedPath(p), false, p);
  assert.ok(matchesExclude('a/node_modules/x/y.js', ['node_modules']));
  assert.ok(matchesExclude('docs/private.txt', ['private.*']));
});

test('finalizeEpisode drops excluded steps and redacts', () => {
  const episode: Episode = {
    schemaVersion: 1, id: 'x'.repeat(10), source: 'terminal', startedAt: new Date().toISOString(), assistantGenerated: false,
    steps: [
      { kind: 'command', assistantGenerated: false, command: 'cat .env' },
      { kind: 'command', assistantGenerated: false, command: 'echo token=abcdefgh123', outputTail: 'mail a.b@example.com' },
      { kind: 'edit', assistantGenerated: true, path: 'config/server.pem' },
    ],
  };
  const out = finalizeEpisode(episode)!;
  assert.equal(out.steps.length, 1);
  assert.ok(!JSON.stringify(out).includes('abcdefgh123'));
  assert.ok(!JSON.stringify(out).includes('a.b@example.com'));
  assert.equal(finalizeEpisode({ ...episode, steps: [{ kind: 'edit', assistantGenerated: true, path: '.env' }] }), undefined);
});

test('claude code parser groups prompts with actions (fictional fixture)', () => {
  const dir = tmp();
  const file = join(dir, 's.jsonl');
  copyFileSync(FIXTURE, file);
  const first = tailTranscript(file, { offset: 0 }, { idle: false });
  // Prompt 1 is closed by prompt 2; prompt 2 is still open.
  assert.equal(first.episodes.length, 1);
  const ep = first.episodes[0]!;
  assert.equal(ep.source, 'claude-code');
  assert.match(ep.prompt!, /widget parser test/);
  assert.equal(ep.workspace, 'demo-app');
  assert.equal(ep.assistantGenerated, true);
  assert.deepEqual(ep.steps.map((s) => s.kind), ['edit', 'command', 'write']);
  const command = ep.steps.find((s) => s.kind === 'command')!;
  assert.equal(command.command, 'npm test');
  assert.equal(command.commandClass, 'test');
  assert.equal(command.exitCode, 0);
  assert.equal(ep.outcome?.status, 'success');
  assert.match(ep.assistantSummary!, /Fixed:/);
  // Cursor sits at the start of the open episode so nothing is lost or duplicated.
  const second = tailTranscript(file, first.cursor, { idle: true });
  assert.equal(second.episodes.length, 1);
  assert.match(second.episodes[0]!.prompt!, /linter/);
  assert.equal(second.episodes[0]!.outcome?.status, 'failure');
  assert.equal(second.episodes[0]!.steps[0]!.exitCode, 2);
  // Fully consumed: a further poll yields nothing.
  const third = tailTranscript(file, second.cursor, { idle: true });
  assert.equal(third.episodes.length, 0);
  // Redaction at the final gate drops the .env write and the token value.
  const clean = finalizeEpisode(ep)!;
  assert.equal(clean.steps.some((s) => s.path?.endsWith('.env')), false);
  assert.ok(!JSON.stringify(clean).includes('fake-test-value-123456'));
  rmSync(dir, { recursive: true, force: true });
});

test('incremental parse with a cursor appends only new lines and ids are stable', () => {
  const dir = tmp();
  const file = join(dir, 's.jsonl');
  const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean);
  writeFileSync(file, lines.slice(0, 7).join('\n') + '\n');
  const a = tailTranscript(file, { offset: 0 }, { idle: false });
  appendFileSync(file, lines.slice(7).join('\n') + '\n');
  const b = tailTranscript(file, a.cursor, { idle: true });
  const whole = tailTranscript(file, { offset: 0 }, { idle: true });
  assert.deepEqual([...a.episodes, ...b.episodes].map((e) => e.id), whole.episodes.map((e) => e.id));
  // A partial trailing line is not consumed.
  appendFileSync(file, '{"type":"user","uuid":"u9","message":{"role":"user","content":"partial');
  const c = tailTranscript(file, b.cursor, { idle: true });
  assert.equal(c.episodes.length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('unknown transcript formats are skipped gracefully', () => {
  const dir = tmp();
  const file = join(dir, 'other.jsonl');
  writeFileSync(file, '{"some":"other assistant"}\nnot json at all\n');
  const result = tailTranscript(file, { offset: 0 }, { idle: true });
  assert.equal(result.episodes.length, 0);
  assert.equal(result.cursor.unknown, true);
  assert.equal(claudeCodeParser.accepts('garbage'), false);
  rmSync(dir, { recursive: true, force: true });
});

test('project selection defaults to workspace folders only', () => {
  const available = ['c--work-demo-app', 'c--work-other', 'C--Users-me-secret-proj'];
  assert.equal(encodeProjectDir('c:\\work\\demo-app'), 'c--work-demo-app');
  assert.deepEqual(selectProjectDirs(available, ['C:\\work\\demo-app'], []), ['c--work-demo-app']);
  assert.deepEqual(selectProjectDirs(available, ['C:\\work\\demo-app'], ['c--work-other']), ['c--work-other']);
  assert.deepEqual(selectProjectDirs(available, [], []), []);
});

test('command classification', () => {
  const cases: Array<[string, string]> = [
    ['npm test', 'test'], ['node --test --import tsx test/a.test.ts', 'test'], ['pytest -q', 'test'], ['cargo test', 'test'], ['npx vitest run', 'test'],
    ['npm run build', 'build'], ['tsc -p .', 'build'], ['cargo build --release', 'build'], ['make all', 'build'], ['vsce package', 'build'],
    ['npm run lint', 'lint'], ['npx eslint .', 'lint'], ['tsc --noEmit', 'lint'], ['ruff check .', 'lint'],
    ['git status', 'git'], ['git commit -m "run tests"', 'git'], ['cd app && npm test', 'test'], ['ls -la', 'other'], ['docker compose up', 'other'],
  ];
  for (const [command, expected] of cases) assert.equal(classifyCommand(command), expected, command);
});

test('offline queue enforces its size cap, dropping oldest first, and persists', () => {
  const dir = tmp();
  const file = join(dir, 'q.json');
  const episode = (n: number) => ({ n, pad: 'x'.repeat(400) });
  const queue = new OfflineQueue(file, 2000);
  for (let i = 0; i < 10; i++) assert.equal(queue.enqueue(episode(i)), true);
  assert.ok(queue.totalBytes <= 2000);
  assert.ok(queue.length < 10 && queue.length >= 3);
  assert.equal((queue.list()[queue.length - 1]!.episode as { n: number }).n, 9);
  assert.equal((queue.list()[0]!.episode as { n: number }).n > 0, true);
  assert.ok(queue.droppedTotal > 0);
  assert.equal(queue.enqueue({ huge: 'y'.repeat(5000) }), false);
  const reloaded = new OfflineQueue(file, 2000);
  assert.equal(reloaded.length, queue.length);
  const smaller = new OfflineQueue(file, 900);
  assert.ok(smaller.totalBytes <= 900);
  rmSync(dir, { recursive: true, force: true });
});

test('loopback-only URL check', () => {
  for (const ok of ['http://127.0.0.1:3000', 'http://localhost:3000/', 'http://[::1]:3000', 'http://LOCALHOST']) assert.ok(isLoopbackUrl(ok), ok);
  for (const bad of ['https://127.0.0.1:3000', 'http://192.168.1.5:3000', 'http://example.com', 'http://localhost.evil.com', 'http://127.0.0.1.evil.com',
    'http://user:pw@127.0.0.1:3000', 'ftp://127.0.0.1', 'not a url', '', 'http://0.0.0.0:3000', 'http://127.0.0.2:3000']) assert.equal(isLoopbackUrl(bad), false, bad);
  assert.equal(requireLoopbackBase('http://localhost:3000/x/y'), 'http://localhost:3000');
  assert.throws(() => requireLoopbackBase('http://example.com'));
});

test('pipeline queues redacted episodes, keeps them while offline, and sends when JARVIS returns', async () => {
  const dir = tmp();
  const queue = new OfflineQueue(join(dir, 'q.json'), 1_000_000);
  let online = false;
  const posted: unknown[] = [];
  const pipeline = new Pipeline(queue, {
    baseUrl: () => 'http://127.0.0.1:1', ingestKey: async () => 'jli_abc', paused: () => false,
    finalize: () => ({ redaction: { emails: true, phones: true }, excludePaths: [] }),
  }, async (_url, _key, episode) => {
    if (!online) return { kind: 'retry', status: 0, error: 'ECONNREFUSED' };
    posted.push(episode);
    return { kind: 'ok', status: 201 };
  });
  const base: Episode = { schemaVersion: 1, id: 'abcdefgh01', source: 'terminal', startedAt: new Date().toISOString(), assistantGenerated: false,
    steps: [{ kind: 'command', assistantGenerated: false, command: 'echo password=hunter2hunter2' }] };
  await pipeline.submit(base);
  await pipeline.flush();
  assert.equal(pipeline.status, 'offline');
  assert.equal(queue.length, 1);
  assert.ok(!JSON.stringify(queue.list()).includes('hunter2hunter2'));
  online = true;
  await pipeline.flush();
  assert.equal(queue.length, 0);
  assert.equal(posted.length, 1);
  assert.equal(pipeline.status, 'capturing');
  // Paused: nothing is queued.
  const pausedPipeline = new Pipeline(queue, { baseUrl: () => 'http://127.0.0.1:1', ingestKey: async () => 'k', paused: () => true, finalize: () => ({ redaction: { emails: true, phones: true }, excludePaths: [] }) });
  assert.equal(await pausedPipeline.submit(base), false);
  assert.equal(queue.length, 0);
  // No ingest key: nothing is captured either.
  const keyless = new Pipeline(queue, { baseUrl: () => 'http://127.0.0.1:1', ingestKey: async () => undefined, paused: () => false, finalize: () => ({ redaction: { emails: true, phones: true }, excludePaths: [] }) });
  assert.equal(await keyless.submit(base), false);
  assert.equal(keyless.status, 'no-key');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
});

test('git output parsing, diff filtering and assistant-commit detection', () => {
  const parsed = parseGitShow('abc1234def\x1efix parser\n\nCo-Authored-By: Claude <x@example.test>\n\x1e\n\n3\t1\tsrc/a.ts\n-\t-\timg.png\n');
  assert.equal(parsed?.hash, 'abc1234def');
  assert.equal(parsed?.files.length, 2);
  assert.equal(parsed?.files[0]?.insertions, 3);
  assert.ok(isAssistantCommit(parsed!.message));
  assert.equal(isAssistantCommit('plain message'), false);
  const patch = 'diff --git a/src/a.ts b/src/a.ts\n+good\ndiff --git a/.env b/.env\n+SECRET=1\ndiff --git a/k.pem b/k.pem\n+KEY\n';
  const filtered = filterDiff(patch, [], 10_000);
  assert.ok(filtered.includes('+good'));
  assert.ok(!filtered.includes('SECRET') && !filtered.includes('KEY'));
  assert.ok(filterDiff('diff --git a/x b/x\n' + 'y'.repeat(500), [], 100).length < 130);
  assert.equal(filterDiff(patch, [], 0), '');
});

test('save diff statistics never contain content', () => {
  assert.deepEqual(lineDiffStat('a\nb\nc', 'a\nb2\nc\nd'), { insertions: 2, deletions: 1 });
});

// Real Claude Code transcripts interleave housekeeping records (api-request, mode, attachment, ai-title, ...) with
// messages, write one content block per assistant line, and wrap IDE prompts in context tags. Fictional data only.
test('current Claude Code transcript layout is recognised even when it starts with housekeeping records', () => {
  const dir = tmp();
  const file = join(dir, 'live.jsonl');
  const s = 'sess-test-0002';
  const rec = (o: Record<string, unknown>) => JSON.stringify({ sessionId: s, timestamp: '2026-01-02T10:00:00.000Z', ...o });
  writeFileSync(file, [
    rec({ type: 'api-request', id: 'r1', params: {} }),
    rec({ type: 'mode', mode: 'default' }),
    rec({ type: 'ai-title', aiTitle: 'TEMPORARY / TEST DATA' }),
    rec({ type: 'user', uuid: 'u1', cwd: 'C:\fictional\demo', message: { role: 'user', content: [
      { type: 'text', text: '<ide_opened_file>The user opened C:\fictional\demo\a.py</ide_opened_file>' },
      { type: 'text', text: 'TEMPORARY / TEST DATA: fix the crash in a.py' }] } }),
    rec({ type: 'attachment', attachment: { kind: 'note' } }),
    rec({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] } }),
    rec({ type: 'assistant', uuid: 'a2', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'python a.py' } }] } }),
    rec({ type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Exit code 1\nTypeError' }] } }),
    rec({ type: 'assistant', uuid: 'a3', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'C:\fictional\demo\a.py', old_string: 'x + 1', new_string: 'f"{x}"' } }] } }),
    rec({ type: 'user', uuid: 'u3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } }),
    rec({ type: 'assistant', uuid: 'a4', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'python a.py' } }] } }),
    rec({ type: 'user', uuid: 'u4', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'done' }] } }),
    rec({ type: 'assistant', uuid: 'a5', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed the crash.' }] } }),
    rec({ type: 'last-prompt', lastPrompt: 'x' }),
  ].join('\n') + '\n');
  const result = tailTranscript(file, { offset: 0 }, { idle: true });
  assert.equal(result.cursor.unknown, undefined);
  assert.equal(result.episodes.length, 1);
  const ep = result.episodes[0];
  assert.equal(ep.prompt, 'TEMPORARY / TEST DATA: fix the crash in a.py');
  assert.deepEqual(ep.steps.map((step) => `${step.kind}${step.exitCode === undefined ? '' : ':' + step.exitCode}`), ['command:1', 'edit', 'command:0']);
  assert.equal(ep.outcome?.status, 'success');
  assert.equal(ep.assistantSummary, 'Fixed the crash.');
  rmSync(dir, { recursive: true, force: true });
});

test('a file previously judged unknown is re-checked when new lines arrive', () => {
  const dir = tmp();
  const file = join(dir, 'resume.jsonl');
  writeFileSync(file, '{"note":"not a transcript line"}\n');
  const first = tailTranscript(file, { offset: 0 }, { idle: true });
  assert.equal(first.cursor.unknown, true);
  appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 's3', message: { role: 'user', content: 'TEMPORARY / TEST DATA: run tests' } }) + '\n' +
    JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: 's3', message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] } }) + '\n');
  const second = tailTranscript(file, first.cursor, { idle: true });
  assert.equal(second.cursor.unknown, undefined);
  assert.equal(second.episodes.length, 1);
  rmSync(dir, { recursive: true, force: true });
});
