/**
 * Owner CLI for ingest keys (local machine).
 *   npm run ingest-key -- create <name> [--rpm 120]
 *   npm run ingest-key -- list
 *   npm run ingest-key -- revoke <name|id>
 */
import { loadLocalEnvironmentFile } from '../config/runtimeConfig.js';
import { IngestKeyStore } from './ingestKeys.js';

loadLocalEnvironmentFile();
const store = new IngestKeyStore(process.env.JARVIS_INGEST_KEYS_PATH || './data/ingest-keys.json');
const [command, target, ...rest] = process.argv.slice(2);
try {
  if (command === 'create' && target) {
    const rpmIndex = rest.indexOf('--rpm');
    const { key, ingestKey } = store.create(target, rpmIndex >= 0 ? Number(rest[rpmIndex + 1]) : undefined);
    console.log(`Created ingest key "${key.name}" (id ${key.id}); scope ${key.scope}, ${key.requestsPerMinute}/min.`);
    console.log('\nIngest key (shown once; paste it into VS Code via "JARVIS: Set ingest key"):\n');
    console.log(ingestKey);
  } else if (command === 'list') {
    const keys = store.list();
    if (!keys.length) console.log('No ingest keys yet. Create one with: npm run ingest-key -- create <name>');
    for (const key of keys) {
      console.log(`${key.id}  ${key.name.padEnd(24)} ${key.revokedAt ? 'REVOKED ' + key.revokedAt : 'active'}  ${key.requestsPerMinute}/min  accepted ${key.usage.accepted}  rejected ${key.usage.rejected}`);
    }
  } else if (command === 'revoke' && target) {
    const key = store.revoke(target);
    console.log(`Revoked "${key.name}" (id ${key.id}). A running server rejects it on the next request.`);
  } else {
    console.log('Usage:\n  npm run ingest-key -- create <name> [--rpm N]\n  npm run ingest-key -- list\n  npm run ingest-key -- revoke <name|id>');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Ingest key command failed.');
  process.exitCode = 1;
}
