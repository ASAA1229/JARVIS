/**
 * Explicit, owner-approved repository connections (JARVIS-US-063).
 *
 * The developer assistant can only touch a repository the owner connected by
 * name, and only within the scopes granted at connection time:
 *   read      – file tree, bounded file reads, search, git status/log/diff
 *   suggest   – model-generated explanations and draft change suggestions
 *   git-write – apply a draft to the working tree, branch, commit, push
 *   ci        – read CI run status
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export type RepoScope = 'read' | 'suggest' | 'git-write' | 'ci';
export const REPO_SCOPES: readonly RepoScope[] = ['read', 'suggest', 'git-write', 'ci'];

export interface RepoConnection {
  name: string;
  path: string;
  scopes: RepoScope[];
  connectedAt: string;
}

interface RegistryFile {
  version: 1;
  repos: RepoConnection[];
}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
const MAX_REPOS = 50;

/** Paths and file names the assistant must never read, list, search or send to a model. */
const DENIED_SEGMENTS = new Set(['.git', 'node_modules', 'data', '.env', '.local-storage', '.jarvis-local-wakeword', '.wrangler']);
const DENIED_FILE = /(^\.env(\..*)?$)|(\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|kdbx)$)|(^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$)|(^\.npmrc$)|(^\.dev\.vars$)|(^credentials(\.json)?$)|(secrets?\.(json|ya?ml|env)$)/i;

export function isDeniedRepoPath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((part) => DENIED_SEGMENTS.has(part.toLowerCase()) || part.toLowerCase().startsWith('.env'))) return true;
  const file = parts[parts.length - 1] ?? '';
  return DENIED_FILE.test(file);
}

/**
 * Resolve a repo-relative path and refuse anything outside the repository or on
 * the deny list. Returns the absolute path and the normalized relative path.
 */
export function resolveInsideRepo(repo: RepoConnection, requested: string): { absolute: string; relative: string } {
  const cleaned = String(requested ?? '').trim().replace(/^["']|["']$/g, '') || '.';
  if (cleaned.includes('\0')) throw new Error('Invalid path.');
  const absolute = isAbsolute(cleaned) ? resolve(cleaned) : resolve(repo.path, cleaned);
  const rel = relative(repo.path, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('That path is outside the connected repository.');
  const normalized = rel.split(sep).join('/') || '.';
  if (normalized !== '.' && isDeniedRepoPath(normalized)) {
    throw new Error('That path is protected (secrets, dependencies, git internals or runtime data) and cannot be accessed.');
  }
  // Symbolic links / junctions must not smuggle an outside or protected target into the repo.
  let real: string | undefined;
  try { real = realpathSync(absolute); } catch { /* A not-yet-existing path has no link to follow. */ }
  if (real !== undefined) {
    const realRoot = (() => { try { return realpathSync(repo.path); } catch { return repo.path; } })();
    const realRel = relative(realRoot, real);
    if (realRel === '..' || realRel.startsWith('..' + sep) || isAbsolute(realRel)) throw new Error('That path resolves outside the connected repository through a symbolic link.');
    const realNormalized = realRel.split(sep).join('/') || '.';
    if (realNormalized !== '.' && isDeniedRepoPath(realNormalized)) {
      throw new Error('That path is protected (secrets, dependencies, git internals or runtime data) and cannot be accessed.');
    }
  }
  return { absolute, relative: normalized };
}

export class RepoRegistry {
  private repos: RepoConnection[] = [];

  constructor(private readonly filePath: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<RegistryFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.repos)) throw new Error('Developer repository registry is invalid.');
    this.repos = parsed.repos.filter((repo) =>
      repo && NAME_PATTERN.test(repo.name) && typeof repo.path === 'string' &&
      Array.isArray(repo.scopes) && repo.scopes.every((scope) => REPO_SCOPES.includes(scope)));
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, repos: this.repos } satisfies RegistryFile, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  list(): RepoConnection[] {
    return this.repos.map((repo) => ({ ...repo, scopes: [...repo.scopes] }));
  }

  get(name: string): RepoConnection | undefined {
    const repo = this.repos.find((item) => item.name === String(name ?? '').toLowerCase());
    return repo ? { ...repo, scopes: [...repo.scopes] } : undefined;
  }

  require(name: string, scope: RepoScope): RepoConnection {
    const repo = this.get(name);
    if (!repo) throw new Error(`No repository named "${name}" is connected. Connect it first with "connect repo <name> at <path>".`);
    if (!repo.scopes.includes(scope)) {
      throw new Error(`Repository "${repo.name}" is not connected with the "${scope}" scope.`);
    }
    if (!existsSync(repo.path)) throw new Error(`The connected path for "${repo.name}" no longer exists.`);
    return repo;
  }

  connect(name: string, path: string, scopes: RepoScope[]): RepoConnection {
    const normalizedName = String(name ?? '').toLowerCase();
    if (!NAME_PATTERN.test(normalizedName)) throw new Error('Repository name must be 2-41 lowercase letters, digits or hyphens.');
    const cleanedPath = String(path ?? '').trim().replace(/^["']|["']$/g, '');
    if (!cleanedPath || !isAbsolute(cleanedPath)) throw new Error('Give the full (absolute) path of the repository folder.');
    const absolute = resolve(cleanedPath);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error('That repository folder does not exist.');
    if (!existsSync(resolve(absolute, '.git'))) throw new Error('That folder is not a git repository (no .git found).');
    const uniqueScopes = [...new Set(scopes)].filter((scope): scope is RepoScope => REPO_SCOPES.includes(scope));
    if (!uniqueScopes.includes('read')) uniqueScopes.unshift('read');
    const existing = this.repos.findIndex((repo) => repo.name === normalizedName);
    if (existing < 0 && this.repos.length >= MAX_REPOS) throw new Error('Too many connected repositories.');
    const connection: RepoConnection = { name: normalizedName, path: absolute, scopes: uniqueScopes, connectedAt: new Date().toISOString() };
    if (existing >= 0) this.repos[existing] = connection;
    else this.repos.push(connection);
    this.persist();
    return { ...connection, scopes: [...connection.scopes] };
  }

  disconnect(name: string): boolean {
    const before = this.repos.length;
    this.repos = this.repos.filter((repo) => repo.name !== String(name ?? '').toLowerCase());
    if (this.repos.length === before) return false;
    this.persist();
    return true;
  }
}

export function parseScopes(text: string | undefined): RepoScope[] {
  if (!text) return ['read', 'suggest'];
  const scopes = text.toLowerCase().split(/[\s,]+/).map((scope) => scope.replace(/^git[_ ]?write$/, 'git-write')).filter(Boolean);
  const valid = scopes.filter((scope): scope is RepoScope => REPO_SCOPES.includes(scope as RepoScope));
  return valid.length ? valid : ['read', 'suggest'];
}
