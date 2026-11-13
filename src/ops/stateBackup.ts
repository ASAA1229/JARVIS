/**
 * Integrity-protected local backup/restore of JARVIS runtime state (JARVIS-GAP-017).
 *
 * State files are already AES-256-GCM encrypted by their owning stores, so the
 * backup carries ciphertext only (never plaintext). The archive adds per-file
 * SHA-256 digests and an HMAC keyed from the owner control token, so tampering,
 * truncation, file injection and path traversal are detected before any write.
 *
 * LIMIT: a backup is a point-in-time copy. Deleting a memory later does NOT reach
 * older backups. Delete old backups yourself; restoring one resurrects whatever it held.
 */
import { createHash, createHmac, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 200;

interface BackupFile { name: string; size: number; sha256: string; dataBase64: string }
interface BackupArchive { version: 1; createdAt: number; files: BackupFile[]; mac: string }

const macKey = (token: string) => {
  if (typeof token !== 'string' || token.length < 32) throw new Error('A backup requires the owner control token (at least 32 characters).');
  return scryptSync(token, 'JARVIS-STATE-BACKUP-V1', 32);
};
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const sign = (files: BackupFile[], createdAt: number, token: string) =>
  createHmac('sha256', macKey(token)).update(JSON.stringify({ version: 1, createdAt, files: files.map((f) => [f.name, f.size, f.sha256]) })).digest('hex');

/** Back up every file in `directory` whose name starts with `statePrefix` (e.g. "state.json"), skipping temp files. */
export function createBackup(directory: string, statePrefix: string, outputFile: string, token: string): { files: string[]; bytes: number } {
  if (!NAME.test(statePrefix)) throw new Error('Invalid state prefix.');
  const names = readdirSync(directory).filter((n) => n.startsWith(statePrefix) && NAME.test(n) && !/\.tmp-|\.tmp$/.test(n) && statSync(join(directory, n)).isFile()).sort();
  if (names.length === 0) throw new Error('No state files found to back up.');
  if (names.length > MAX_FILES) throw new Error('Too many state files.');
  let total = 0;
  const files: BackupFile[] = names.map((name) => {
    const data = readFileSync(join(directory, name));
    total += data.length;
    if (total > MAX_TOTAL_BYTES) throw new Error('State exceeds the 256 MB backup limit.');
    return { name, size: data.length, sha256: sha256(data), dataBase64: data.toString('base64') };
  });
  const createdAt = Date.now();
  const archive: BackupArchive = { version: 1, createdAt, files, mac: sign(files, createdAt, token) };
  mkdirSync(dirname(outputFile), { recursive: true });
  const tmp = `${outputFile}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(archive), { mode: 0o600 });
  renameSync(tmp, outputFile);
  return { files: names, bytes: total };
}

function readArchive(archiveFile: string): BackupArchive {
  const stat = statSync(archiveFile);
  if (!stat.isFile() || stat.size > MAX_TOTAL_BYTES * 2) throw new Error('Backup archive is not a regular file within size limits.');
  try { return JSON.parse(readFileSync(archiveFile, 'utf8')) as BackupArchive; } catch { throw new Error('Backup archive is not valid JSON.'); }
}

function verifyArchive(archive: BackupArchive, token: string): void {
  if (!archive || archive.version !== 1 || !Array.isArray(archive.files) || archive.files.length === 0 || archive.files.length > MAX_FILES ||
      typeof archive.mac !== 'string' || !Number.isFinite(archive.createdAt)) throw new Error('Backup archive structure is invalid.');
  const seen = new Set<string>();
  let total = 0;
  for (const file of archive.files) {
    if (!file || typeof file.name !== 'string' || !NAME.test(file.name) || basename(file.name) !== file.name || seen.has(file.name.toLowerCase())) {
      throw new Error('Backup archive contains an unsafe or duplicate file name.');
    }
    seen.add(file.name.toLowerCase());
    if (typeof file.dataBase64 !== 'string' || typeof file.sha256 !== 'string' || !Number.isInteger(file.size) || file.size < 0) throw new Error('Backup archive file entry is invalid.');
    total += file.size;
    if (total > MAX_TOTAL_BYTES) throw new Error('Backup archive exceeds the size limit.');
  }
  const expected = Buffer.from(sign(archive.files, archive.createdAt, token), 'hex');
  const actual = Buffer.from(archive.mac, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Backup authentication failed: wrong owner token or the archive was modified.');
  for (const file of archive.files) {
    const data = Buffer.from(file.dataBase64, 'base64');
    if (data.length !== file.size || sha256(data) !== file.sha256) throw new Error(`Backup file ${file.name} failed integrity verification.`);
  }
}

/** Verifies structure, names, digests and HMAC. Throws on any problem; returns the verified file list. */
export function verifyBackup(archiveFile: string, token: string): { createdAt: number; files: Array<{ name: string; size: number }> } {
  const archive = readArchive(archiveFile);
  verifyArchive(archive, token);
  return { createdAt: archive.createdAt, files: archive.files.map((f) => ({ name: f.name, size: f.size })) };
}

/** Restores a verified archive into `targetDirectory`. Refuses to overwrite existing files unless `force`. */
export function restoreBackup(archiveFile: string, targetDirectory: string, token: string, options: { force?: boolean } = {}): { restored: string[] } {
  const archive = readArchive(archiveFile);
  verifyArchive(archive, token); // authenticate everything before touching the target
  if (!options.force) {
    const clashes = archive.files.filter((f) => existsSync(join(targetDirectory, f.name))).map((f) => f.name);
    if (clashes.length) throw new Error(`Restore would overwrite existing state (${clashes.length} file(s)); pass force to replace it.`);
  }
  mkdirSync(targetDirectory, { recursive: true });
  const staged: Array<{ tmp: string; final: string }> = [];
  try {
    for (const file of archive.files) {
      const tmp = join(targetDirectory, `${file.name}.restore-${process.pid}.tmp`);
      writeFileSync(tmp, Buffer.from(file.dataBase64, 'base64'), { mode: 0o600 });
      staged.push({ tmp, final: join(targetDirectory, file.name) });
    }
    for (const item of staged) renameSync(item.tmp, item.final);
  } catch (error) {
    for (const item of staged) rmSync(item.tmp, { force: true });
    throw error;
  }
  return { restored: archive.files.map((f) => f.name) };
}
