/**
 * Owner CLI for JARVIS site API keys (local machine only; there is no HTTP route
 * that creates or lists keys).
 *
 *   npm run site-key -- create <site-name> [--rpm 20] [--max-tokens 800] [--profiles a,b]
 *   npm run site-key -- list
 *   npm run site-key -- revoke <site-name|id>
 */
import { loadLocalEnvironmentFile } from '../config/runtimeConfig.js';
import { SiteClientStore } from './siteClientStore.js';

loadLocalEnvironmentFile();
const store = new SiteClientStore(process.env.JARVIS_SITE_CLIENTS_PATH || './data/site-clients.json');
const [command, target, ...rest] = process.argv.slice(2);

function option(name: string): number | undefined {
  const index = rest.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(rest[index + 1]);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} needs an integer value.`);
  return value;
}

try {
  if (command === 'create' && target) {
    const rpm = option('--rpm');
    const maxTokens = option('--max-tokens');
    const profilesIndex = rest.indexOf('--profiles');
    const profiles = profilesIndex >= 0 ? String(rest[profilesIndex + 1] ?? '').split(',').map((item) => item.trim()).filter(Boolean) : undefined;
    const { client, apiKey } = store.create(target, {
      ...(rpm !== undefined ? { requestsPerMinute: rpm } : {}),
      ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
    }, profiles);
    if (client.allowedProfiles?.length) console.log(`Profile scope: ${client.allowedProfiles.join(', ')} (requests must send X-Jarvis-Profile).`);
    console.log(`Created site client "${client.name}" (id ${client.id}).`);
    console.log(`Limits: ${client.limits.requestsPerMinute} requests/min, ${client.limits.maxOutputTokens} max output tokens.`);
    console.log('\nAPI key (shown once — store it only in that site\'s server-side secrets):\n');
    console.log(apiKey);
  } else if (command === 'list') {
    const clients = store.list();
    if (!clients.length) console.log('No site clients yet. Create one with: npm run site-key -- create <site-name>');
    for (const client of clients) {
      console.log(`${client.id}  ${client.name.padEnd(24)} ${client.revokedAt ? 'REVOKED ' + client.revokedAt : 'active'}  ` +
        `${client.limits.requestsPerMinute}/min  max ${client.limits.maxOutputTokens} tokens  created ${client.createdAt}` +
        `  profiles ${client.allowedProfiles?.length ? client.allowedProfiles.join(',') : 'any'}  requests ${client.usage?.requests ?? 0}`);
    }
  } else if (command === 'revoke' && target) {
    const client = store.revoke(target);
    console.log(`Revoked "${client.name}" (id ${client.id}). A running gateway rejects it on the next request.`);
  } else {
    console.log('Usage:\n  npm run site-key -- create <site-name> [--rpm N] [--max-tokens N]\n  npm run site-key -- list\n  npm run site-key -- revoke <site-name|id>');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Site key command failed.');
  process.exitCode = 1;
}
