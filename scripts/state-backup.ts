/**
 * Usage (owner token read from JARVIS_OWNER_CONTROL_TOKEN, never from argv):
 *   npx tsx scripts/state-backup.ts create  <stateDir> <statePrefix> <archive>
 *   npx tsx scripts/state-backup.ts verify  <archive>
 *   npx tsx scripts/state-backup.ts restore <archive> <targetDir> [--force]
 */
import { createBackup, restoreBackup, verifyBackup } from '../src/ops/stateBackup.js';

const [command, ...rest] = process.argv.slice(2);
const token = process.env.JARVIS_OWNER_CONTROL_TOKEN ?? '';
try {
  if (command === 'create' && rest.length === 3) console.log(JSON.stringify(createBackup(rest[0], rest[1], rest[2], token)));
  else if (command === 'verify' && rest.length === 1) console.log(JSON.stringify(verifyBackup(rest[0], token)));
  else if (command === 'restore' && rest.length >= 2) console.log(JSON.stringify(restoreBackup(rest[0], rest[1], token, { force: rest.includes('--force') })));
  else { console.error('Usage: state-backup.ts create|verify|restore ...'); process.exitCode = 2; }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Backup operation failed.');
  process.exitCode = 1;
}
