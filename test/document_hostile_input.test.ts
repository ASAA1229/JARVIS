import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { DocumentParser, type LocalCommandRunner } from '../src/memory/documentParser.js';
import { DocumentRagStore } from '../src/memory/documentRagStore.js';

/** JARVIS-GAP-010: PDF/DOCX/OCR hostile-input behavior. */

interface ZipOptions { name?: string; method?: number; flags?: number; claimedUncompressed?: number; rawData?: Buffer; extraEntries?: Array<{ name: string; data: Buffer }> }

function zip(xml: string, options: ZipOptions = {}): Buffer {
  const entries = [
    { name: options.name ?? 'word/document.xml', data: options.rawData ?? deflateRawSync(Buffer.from(xml, 'utf8')), method: options.method ?? 8, uncompressed: options.claimedUncompressed ?? Buffer.byteLength(xml), flags: options.flags ?? 0 },
    ...(options.extraEntries ?? []).map((entry) => ({ name: entry.name, data: entry.data, method: 0, uncompressed: entry.data.length, flags: 0 })),
  ];
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(entry.flags, 6); local.writeUInt16LE(entry.method, 8);
    local.writeUInt32LE(entry.data.length, 18); local.writeUInt32LE(entry.uncompressed, 22); local.writeUInt16LE(name.length, 26);
    const record = Buffer.concat([local, name, entry.data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(entry.flags, 8); central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(entry.data.length, 20); central.writeUInt32LE(entry.uncompressed, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(record); centrals.push(Buffer.concat([central, name]));
    offset += record.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}
const body = (text: string) => `<w:document><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`;
const pdf = Buffer.from('%PDF-1.7\n% hostile fixture', 'ascii');

test('DOCX: path-traversal and look-alike entry names never satisfy the main document lookup', async () => {
  const parser = new DocumentParser();
  for (const name of ['../word/document.xml', '/word/document.xml', 'word\\document.xml', 'WORD/document.xml', 'word/document.xml.evil', '..\\..\\word\\document.xml']) {
    await assert.rejects(parser.parse('trap.docx', zip(body('secret text that must not be read'), { name })), /does not contain word\/document\.xml/, name);
  }
  // The real entry is still found when an attacker adds traversal entries beside it.
  const mixed = zip(body('Legitimate content'), { extraEntries: [{ name: '../../../evil.exe', data: Buffer.from('MZ') }] });
  assert.equal((await parser.parse('mixed.docx', mixed)).text, 'Legitimate content');
});

test('DOCX: lying size headers, truncated data, encryption and unsupported methods are rejected with safe messages', async () => {
  const parser = new DocumentParser();
  const bomb = deflateRawSync(Buffer.alloc(8 * 1024 * 1024, 0x41));
  // Header claims 1 KB but the stream inflates past the 5 MB cap.
  await assert.rejects(parser.parse('lie.docx', zip('', { rawData: bomb, claimedUncompressed: 1024 })), /decompression limits|corrupt/);
  // Declared size beyond the cap is refused before any inflate.
  await assert.rejects(parser.parse('big.docx', zip('', { rawData: bomb, claimedUncompressed: 6 * 1024 * 1024 })), /decompression limits/);
  // Garbage deflate stream does not leak a zlib stack/message.
  await assert.rejects(parser.parse('garbage.docx', zip('', { rawData: Buffer.from('this is not deflate data at all'), claimedUncompressed: 100 })), (error: Error) => {
    assert.match(error.message, /corrupt|decompression/);
    assert.doesNotMatch(error.message, /zlib|Z_DATA_ERROR/i);
    return true;
  });
  await assert.rejects(parser.parse('enc.docx', zip(body('x'), { flags: 1 })), /Encrypted DOCX/);
  await assert.rejects(parser.parse('method.docx', zip(body('x'), { method: 14 })), /unsupported compression/);
  const truncated = zip(body('Hello'));
  await assert.rejects(parser.parse('cut.docx', truncated.subarray(0, truncated.length - 30)), /archive directory|malformed|truncated/);
  await assert.rejects(parser.parse('empty.docx', zip(body(''))), /no extractable text/);
});

test('DOCX: hostile XML entities and tag soup are neutralized instead of throwing or executing', async () => {
  const parser = new DocumentParser();
  const hostile = body('A&#99999999999;B&#x110000;C&#xD800;D&#0;E&lt;script&gt;alert(1)&lt;/script&gt;') +
    '<!DOCTYPE lolz [<!ENTITY lol "lol">]><w:t>&lol;&lol;</w:t>';
  const result = await parser.parse('xml.docx', zip(hostile));
  assert.match(result.text, /A.*B.*C.*D.*E<script>alert\(1\)<\/script>/s);
  assert.doesNotMatch(result.text, /lollol/, 'external/internal DTD entities are never expanded');
});

test('DOCX: extracted-text size limit is enforced', async () => {
  const parser = new DocumentParser();
  const huge = body('word '.repeat(300_000)); // ~1.5M chars, highly compressible but under the 100x ratio gate
  await assert.rejects(parser.parse('large.docx', zip(huge)), /limit|decompression/);
});

test('PDF: missing Poppler yields a clear local-only error and never a cloud fallback', async () => {
  const seen: string[] = [];
  const enoent: LocalCommandRunner = async (command) => {
    seen.push(command);
    throw Object.assign(new Error('spawn pdftotext ENOENT C:\\Users\\secret\\path'), { code: 'ENOENT' });
  };
  await assert.rejects(new DocumentParser(enoent).parse('a.pdf', pdf), /requires local Poppler/);
  await assert.rejects(new DocumentParser(enoent).parse('a.pdf', pdf, { ocr: true }), (error: Error) => {
    assert.match(error.message, /Poppler \(pdftoppm\).*not installed.*No cloud fallback/);
    assert.doesNotMatch(error.message, /secret|C:\\/);
    return true;
  });
  assert.ok(seen.every((command) => ['pdftotext', 'pdftoppm', 'tesseract'].includes(command)), 'only local binaries are ever invoked');
});

test('PDF: missing Tesseract and tool timeouts map to safe errors and temp files are always removed', async () => {
  let workDirectory = '';
  const make = (failure: Record<string, unknown>): LocalCommandRunner => async (command, args) => {
    if (command === 'pdftotext') return '\f';
    if (command === 'pdftoppm') {
      workDirectory = dirname(args[args.length - 1]);
      await writeFile(join(workDirectory, 'page-1.png'), Buffer.from('img'));
      return '';
    }
    throw Object.assign(new Error('raw failure with /tmp/path details'), failure);
  };
  await assert.rejects(new DocumentParser(make({ code: 'ENOENT' })).parse('s.pdf', pdf, { ocr: true }), /Tesseract OCR, which is not installed.*No cloud fallback/);
  assert.equal(existsSync(workDirectory), false, 'temporary rasterized pages are deleted after failure');
  await assert.rejects(new DocumentParser(make({ killed: true, signal: 'SIGTERM' })).parse('s.pdf', pdf, { ocr: true }), /exceeded its processing time limit/);
  await assert.rejects(new DocumentParser(make({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })).parse('s.pdf', pdf, { ocr: true }), /safe size limit/);
  await assert.rejects(new DocumentParser(make({})).parse('s.pdf', pdf, { ocr: true }), (error: Error) => {
    assert.match(error.message, /failed to process this document/);
    assert.doesNotMatch(error.message, /tmp\/path/);
    return true;
  });
});

test('PDF: page, text-size and OCR-raster limits fail closed', async () => {
  const pages = (count: number): LocalCommandRunner => async (command) => {
    assert.equal(command, 'pdftotext');
    return `${'Readable text layer for the page. '.repeat(3)}\f`.repeat(count);
  };
  await assert.rejects(new DocumentParser(pages(31)).parse('long.pdf', pdf), /30-page/);
  const flood: LocalCommandRunner = async () => 'x'.repeat(1_000_001);
  await assert.rejects(new DocumentParser(flood).parse('flood.pdf', pdf), /1 MB/);
  const args: string[][] = [];
  const spy: LocalCommandRunner = async (_command, commandArgs) => { args.push(commandArgs); return 'Readable text layer for the page. '.repeat(3); };
  await new DocumentParser(spy).parse('ok.pdf', pdf);
  assert.ok(args[0].includes('-l') && args[0].includes('31'), 'pdftotext is bounded to one page beyond the limit');
  // A scanned PDF with more than 20 pages is not OCR'd.
  const scanned: LocalCommandRunner = async () => '\f'.repeat(25);
  await assert.rejects(new DocumentParser(scanned).parse('scan.pdf', pdf, { ocr: true }), /20-page OCR limit/);
  // Oversized rasterized pages are refused.
  const bigImage: LocalCommandRunner = async (command, commandArgs) => {
    if (command === 'pdftotext') return '\f';
    if (command === 'pdftoppm') { await writeFile(join(dirname(commandArgs[commandArgs.length - 1]), 'page-1.png'), Buffer.alloc(9 * 1024 * 1024)); return ''; }
    throw new Error('tesseract must not run');
  };
  await assert.rejects(new DocumentParser(bigImage).parse('img.pdf', pdf, { ocr: true }), /safe image storage limit/);
});

test('hostile filenames and signatures are rejected before any parser work', async () => {
  const parser = new DocumentParser(async () => { throw new Error('no command may run'); });
  for (const name of ['..\\evil.pdf', 'a/b.pdf', 'bad\u0000.pdf', 'tab\t.pdf', '', ' ', 'x'.repeat(241) + '.pdf']) {
    await assert.rejects(parser.parse(name, pdf), /plain filename/, JSON.stringify(name));
  }
  await assert.rejects(parser.parse('polyglot.pdf', Buffer.from('PK\u0003\u0004%PDF-1.7')), /signature is invalid/);
  await assert.rejects(parser.parse('a.docx', Buffer.from('%PDF-1.7')), /DOCX file signature is invalid/);
  await assert.rejects(parser.parse('empty.pdf', Buffer.alloc(0)), /non-empty/);
});

test('RAG store rejects traversal source names and hostile content never executes or escapes tenancy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-hostile-rag-'));
  try {
    const store = new DocumentRagStore(join(directory, 'docs.enc'), 'hostile-input-owner-token-0123456789abcdef');
    for (const name of ['..\\x.txt', '../x.txt', 'a/b.txt', 'x.exe', 'x.zip', 'noextension']) {
      assert.throws(() => store.ingest({ ownerDeviceId: 'd1', sourceName: name, content: 'hello' }), /plain filename|Unsupported/, name);
    }
    assert.equal(store.list('d1').length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
