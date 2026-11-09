import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('repository README contains no unresolved merge conflict markers', () => {
  const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
  assert.doesNotMatch(readme, /^(<<<<<<< |=======\s*$|>>>>>>> )/m);
});
