import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const envPath = '.env';
let content;
try {
  content = readFileSync(envPath, 'utf8');
} catch {
  console.error('Missing .env. Copy .env.example to .env first.');
  process.exit(1);
}

const tokenPattern = /^JARVIS_OWNER_CONTROL_TOKEN=([^\r\n]*)$/m;
const match = content.match(tokenPattern);
const current = match?.[1].trim() ?? '';
const isPlaceholder = !current || /^(?:REPLACE_|YOUR_|CHANGEME|PLACEHOLDER)/i.test(current);
const isValid = /^[A-Za-z0-9_-]{32,256}$/.test(current) && !isPlaceholder;

if (isValid) {
  console.log('JARVIS_OWNER_CONTROL_TOKEN is already configured; no change made.');
  process.exit(0);
}
if (current && !isPlaceholder) {
  console.error('An owner token value is present but invalid; refusing to replace it automatically. Review .env locally.');
  process.exit(1);
}

const tokenLine = `JARVIS_OWNER_CONTROL_TOKEN=${randomBytes(32).toString('hex')}`;
const updated = match
  ? content.replace(tokenPattern, tokenLine)
  : `${content}${content.endsWith('\n') || content.length === 0 ? '' : '\n'}${tokenLine}\n`;

try {
  writeFileSync(envPath, updated, 'utf8');
} catch {
  console.error('Could not update .env. Check local file permissions; the token was not displayed.');
  process.exit(1);
}

console.log('Generated and saved a random owner control token in .env. Its value was not displayed.');
