export type CommandClass = 'build' | 'test' | 'lint' | 'git' | 'other';

const LEADING_CD = /^\s*(?:cd|pushd|Set-Location)\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i;

/** Classify a shell command line as build/test/lint/git/other. */
export function classifyCommand(commandLine: string): CommandClass {
  let cmd = String(commandLine ?? '').trim();
  while (LEADING_CD.test(cmd)) cmd = cmd.replace(LEADING_CD, '');
  cmd = cmd.replace(/^(?:\w+=\S+\s+)+/, '').replace(/^\$env:\w+\s*=\s*\S+;\s*/i, '');
  if (/^git(?:\.exe)?\b/i.test(cmd)) return 'git';
  if (/\b(?:eslint|prettier|stylelint|tslint|flake8|pylint|ruff|rubocop|golangci-lint|clippy|biome)\b|\bnpm(?:\.cmd)?\s+(?:run\s+)?lint\b|\b(?:pnpm|yarn)\s+(?:run\s+)?lint\b|\btsc\b[^|;&]*--noEmit/i.test(cmd)) return 'lint';
  if (/\b(?:jest|vitest|mocha|pytest|playwright\s+test|karma|phpunit|rspec)\b|\bnode\s+(?:\S+\s+)*--test\b|\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?test(?::\S+)?\b|\bcargo\s+test\b|\bgo\s+test\b|\bdotnet\s+test\b|\bmvn\s+(?:\S+\s+)*test\b|\bgradle(?:w)?(?:\.bat)?\s+(?:\S+\s+)*test\b|\bctest\b/i.test(cmd)) return 'test';
  if (/\btsc\b|\bwebpack\b|\bvite\s+build\b|\brollup\b|\besbuild\b|\b(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:run\s+)?(?:build|compile|package)\b|\bcargo\s+build\b|\bgo\s+build\b|\bdotnet\s+build\b|\bmvn\s+(?:\S+\s+)*(?:package|compile|install)\b|\bgradle(?:w)?(?:\.bat)?\s+(?:\S+\s+)*(?:build|assemble)\b|\bmake\b|\bcmake\s+--build\b|\bmsbuild\b|\bnext\s+build\b|\bvsce\s+package\b/i.test(cmd)) return 'build';
  return 'other';
}

/** Commands too trivial to be worth learning from. */
export function isTrivialCommand(commandLine: string): boolean {
  const first = String(commandLine ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return first.length < 2 || ['cd', 'ls', 'dir', 'pwd', 'clear', 'cls', 'echo', 'exit', 'history'].includes(first);
}
