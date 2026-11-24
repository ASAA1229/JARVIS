/**
 * Export owner-approved learning episodes as JSON lines for local training/evaluation sets.
 *
 *   npm run export-episodes -- [--out file.jsonl] [--include-assistant]
 *
 * Assistant-generated content (assistantGenerated: true) is EXCLUDED by default because AI providers' terms
 * restrict training models on their outputs. It is included only when the owner has set
 * allowAssistantContentInExport (POST /api/learning/settings) AND passes --include-assistant here.
 * Reads the encrypted store directly; needs JARVIS_OWNER_CONTROL_TOKEN in the environment and
 * JARVIS_EPISODES_PATH (default ./data/learning-episodes.enc).
 */
import { writeFileSync } from 'node:fs';
import { EpisodeStore, exportEpisodes } from '../src/learning/episodeStore.ts';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
const token = process.env.JARVIS_OWNER_CONTROL_TOKEN;
if (!token || token.length < 32) {
  console.error('JARVIS_OWNER_CONTROL_TOKEN must be set in the environment (the episode store is encrypted with it).');
  process.exit(1);
}
const store = new EpisodeStore(process.env.JARVIS_EPISODES_PATH || './data/learning-episodes.enc', token);
const allow = store.settings.allowAssistantContentInExport && args.includes('--include-assistant');
const lines = exportEpisodes(store.list(), allow).map((episode) => JSON.stringify(episode)).join('\n');
if (out) writeFileSync(out, lines + (lines ? '\n' : ''), { mode: 0o600 });
else if (lines) console.log(lines);
console.error(`Exported ${lines ? lines.split('\n').length : 0} approved episode(s); assistant-generated content ${allow ? 'INCLUDED' : 'excluded'}.`);
