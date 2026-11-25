/**
 * Owner CLI for browser keys (local machine).
 *   npm run browser-key -- create <name> [--rpm 60]
 *   npm run browser-key -- list
 *   npm run browser-key -- revoke <name|id>
 */
import { loadLocalEnvironmentFile } from '../config/runtimeConfig.js';
import { BrowserKeyStore } from './browserKeys.js';

loadLocalEnvironmentFile();
const store = new BrowserKeyStore(process.env.JARVIS_BROWSER_KEYS_PATH || './data/browser-keys.json');
const [command, target, ...rest] = process.argv.slice(2);
try {
  if (command === 'create' && target) {
    const rpmIndex = rest.indexOf('--rpm');
    const { key, browserKey } = store.create(target, rpmIndex >= 0 ? Number(rest[rpmIndex + 1]) : undefined);
    console.log(`Created browser key "${key.name}" (id ${key.id}); scope ${key.scope}, ${key.requestsPerMinute}/min.`);
    console.log('\nBrowser key (shown once; paste it into the JARVIS browser extension settings):\n');
    console.log(browserKey);
  } else if (command === 'list') {
    const keys = store.list();
    if (!keys.length) console.log('No browser keys yet. Create one with: npm run browser-key -- create <name>');
    for (const key of keys) {
      console.log(`${key.id}  ${key.name.padEnd(24)} ${key.revokedAt ? 'REVOKED ' + key.revokedAt : 'active'}  ${key.requestsPerMinute}/min  accepted ${key.usage.accepted}  rejected ${key.usage.rejected}`);
    }
  } else if (command === 'revoke' && target) {
    const key = store.revoke(target);
    console.log(`Revoked "${key.name}" (id ${key.id}). A running server rejects it on the next request.`);
  } else {
    console.log('Usage:\n  npm run browser-key -- create <name> [--rpm N]\n  npm run browser-key -- list\n  npm run browser-key -- revoke <name|id>');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Browser key command failed.');
  process.exitCode = 1;
}
