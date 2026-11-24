#!/usr/bin/env node
// Validate and merge owner-approved chat-format training data (JSONL) for an optional
// offline LoRA fine-tune. Local only: reads files you name, writes one local file.
//
//   node scripts/build-training-set.mjs --out data/studio/training/merged.jsonl data/studio/training
//   node scripts/build-training-set.mjs test/fixtures/training            (dry run: validate only)
//
// Options: --out <file>  write the merged JSONL (omit for a dry run)
//          --include-test-data  keep records labelled "TEMPORARY / TEST DATA" (excluded by default)
//          --strict  exit 1 if any record was rejected
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { mergeTrainingRecords, toJsonl } from '../src/studio/training.js';

function parseArgs(argv) {
  const options = { inputs: [], out: null, includeTestData: false, strict: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') options.out = argv[++index];
    else if (arg === '--include-test-data') options.includeTestData = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}`);
    else options.inputs.push(arg);
  }
  return options;
}

function jsonlFiles(path) {
  const full = resolve(path);
  if (!existsSync(full)) throw new Error(`Input not found: ${path}`);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full).filter((name) => name.endsWith('.jsonl')).sort().map((name) => join(full, name));
}

export function loadRecords(inputs) {
  const records = [];
  const problems = [];
  for (const input of inputs) {
    for (const file of jsonlFiles(input)) {
      readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, number) => {
        if (!line.trim()) return;
        try { records.push(JSON.parse(line)); } catch { problems.push({ file, line: number + 1, reason: 'not valid JSON' }); }
      });
    }
  }
  return { records, problems };
}

export function run(argv) {
  const options = parseArgs(argv);
  if (!options.inputs.length) throw new Error('Give at least one .jsonl file or folder. See the header of this script for usage.');
  const { records, problems } = loadRecords(options.inputs);
  const { kept, rejected } = mergeTrainingRecords(records, { includeTestData: options.includeTestData });
  const summary = { read: records.length, kept: kept.length, rejected: rejected.length + problems.length, parseErrors: problems.length, reasons: {} };
  for (const item of rejected) summary.reasons[item.reason] = (summary.reasons[item.reason] ?? 0) + 1;
  if (options.out) {
    const target = resolve(options.out);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, toJsonl(kept), { encoding: 'utf8', mode: 0o600 });
    summary.wrote = target;
  }
  return { summary, ok: !(options.strict && summary.rejected > 0) };
}

if (process.argv[1]?.replaceAll(String.fromCharCode(92), '/').endsWith('/build-training-set.mjs')) {
  try {
    const { summary, ok } = run(process.argv.slice(2));
    console.log(JSON.stringify(summary, null, 2));
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
