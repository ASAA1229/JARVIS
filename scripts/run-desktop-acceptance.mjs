// Desktop acceptance suite: tests that need a real interactive Windows desktop. Run in an interactive session
// (not under a Jenkins service account). JARVIS_REQUIRE_DESKTOP=1 disables the automatic skip so a missing desktop fails loudly.
import { spawnSync } from 'node:child_process';

const files = ['test/core.test.ts', 'test/e2e_recovery.test.ts'];
const r = spawnSync(process.execPath, ['--test', '--test-name-pattern=FLOW-02: |E2E-LIVE-01', '--import', 'tsx', ...files], {
  stdio: 'inherit',
  env: { ...process.env, JARVIS_REQUIRE_DESKTOP: '1' },
});
process.exit(r.status ?? 1);
