import test from 'node:test';
import assert from 'node:assert/strict';
import { runsForCommit } from '../src/developer/repoTools.js';

/** JARVIS-US-021: CI evidence must refer to the exact commit SHA. */
const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const runs = JSON.stringify([
  { headSha: OLD, status: 'completed', conclusion: 'success', name: 'JARVIS CI', url: 'https://github.com/o/r/actions/runs/1' },
  { headSha: HEAD, status: 'completed', conclusion: 'failure', name: 'JARVIS CI', url: 'https://github.com/o/r/actions/runs/2' },
  { headSha: HEAD, status: 'in_progress', conclusion: '', name: 'Android', url: 'https://github.com/o/r/actions/runs/3' },
]);

test('only runs for the exact HEAD commit are reported; a green run for an older commit is never presented as current', () => {
  const result = runsForCommit(runs, HEAD);
  assert.equal(result.matched, 2);
  assert.equal(result.otherCommitRuns, 1);
  assert.match(result.runs, /completed\/failure/);
  assert.match(result.runs, /in_progress\/pending/);
  assert.doesNotMatch(result.runs, /runs\/1/);
  const onlyOld = runsForCommit(runs, 'c'.repeat(40));
  assert.equal(onlyOld.matched, 0);
  assert.equal(onlyOld.otherCommitRuns, 3);
  assert.equal(onlyOld.runs, '');
});

test('malformed gh output and non-SHA input are handled safely', () => {
  assert.equal(runsForCommit('not json', HEAD).matched, 0);
  assert.equal(runsForCommit('{"a":1}', HEAD).matched, 0);
  assert.equal(runsForCommit('[null, 5, "x"]', HEAD).matched, 0);
  for (const bad of ['', 'abc', 'A'.repeat(40), HEAD.slice(1), 'main']) assert.throws(() => runsForCommit('[]', bad), /40-character/);
});
