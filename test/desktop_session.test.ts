import test from 'node:test';
import assert from 'node:assert';
import { detectDesktopSession, desktopSkip } from './helpers/desktopSession.js';

test('GitHub Actions hosted runners are not real desktop sessions', () => {
  const previousActions = process.env.GITHUB_ACTIONS;
  const previousRequireDesktop = process.env.JARVIS_REQUIRE_DESKTOP;

  try {
    process.env.GITHUB_ACTIONS = 'true';
    delete process.env.JARVIS_REQUIRE_DESKTOP;

    const info = detectDesktopSession();
    assert.strictEqual(info.interactive, false);
    assert.match(info.reason, /GitHub Actions hosted runner/);
    assert.match(desktopSkip() as string, /SKIPPED \(desktop acceptance\)/);
  } finally {
    if (previousActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previousActions;
    if (previousRequireDesktop === undefined) delete process.env.JARVIS_REQUIRE_DESKTOP;
    else process.env.JARVIS_REQUIRE_DESKTOP = previousRequireDesktop;
  }
});
