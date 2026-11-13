import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { DocumentParser, type LocalCommandRunner } from '../src/memory/documentParser.js';

function makeDocx(xml: string): Buffer {
  const name = Buffer.from('word/document.xml');
  const data = deflateRawSync(Buffer.from(xml, 'utf8'));
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(Buffer.byteLength(xml), 22);
  local.writeUInt16LE(name.length, 26);
  const localRecord = Buffer.concat([local, name, data]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(Buffer.byteLength(xml), 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const centralRecord = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, eocd]);
}

const pdf = Buffer.from('%PDF-1.7\n% test fixture', 'ascii');

test('DOCX extracts text, paragraphs, tabs and XML entities without treating literal angle brackets as markup', async () => {
  const parser = new DocumentParser();
  const file = makeDocx('<w:document><w:body><w:p><w:r><w:t>First &amp; &lt;tag&gt;</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t><w:tab/><w:t>Column B</w:t></w:r></w:p></w:body></w:document>');
  const result = await parser.parse('guide.docx', file);
  assert.equal(result.format, 'docx');
  assert.equal(result.extraction, 'text');
  assert.match(result.text, /First & <tag>/);
  assert.match(result.text, /Second line\tColumn B/);
});

test('DOCX parser rejects malformed archives and decompression bombs', async () => {
  const parser = new DocumentParser();
  await assert.rejects(parser.parse('broken.docx', Buffer.from('PKbroken')), /archive directory/);
  const bomb = makeDocx('<w:document><w:body><w:p><w:r><w:t>' + 'A'.repeat(20_000) + '</w:t></w:r></w:p></w:body></w:document>');
  await assert.rejects(parser.parse('bomb.docx', bomb), /decompression limits/);
  await assert.rejects(parser.parse('wrong.docx', Buffer.from('not a zip')), /signature is invalid/);
});

test('PDF parser extracts a bounded text layer using local Poppler only', async () => {
  const calls: string[] = [];
  const runner: LocalCommandRunner = async (command) => {
    calls.push(command);
    assert.equal(command, 'pdftotext');
    return 'This is a sufficiently long PDF text layer for local retrieval and citations.\f';
  };
  const result = await new DocumentParser(runner).parse('manual.pdf', pdf);
  assert.equal(result.format, 'pdf');
  assert.equal(result.extraction, 'text');
  assert.equal(result.pages, 1);
  assert.match(result.text, /local retrieval/);
  assert.deepEqual(calls, ['pdftotext']);
});

test('scanned PDF OCR is opt-in and invokes only local rasterizer and Tesseract', async () => {
  const calls: string[] = [];
  const runner: LocalCommandRunner = async (command, args) => {
    calls.push(command);
    if (command === 'pdftotext') return '\f';
    if (command === 'pdftoppm') {
      const prefix = args[args.length - 1];
      await writeFile(join(dirname(prefix), 'page-1.png'), Buffer.from('local-test-image'));
      return '';
    }
    if (command === 'tesseract') return 'Scanned document text recognized locally.';
    throw new Error('Unexpected external command');
  };
  const result = await new DocumentParser(runner).parse('scan.pdf', pdf, { ocr: true });
  assert.equal(result.extraction, 'ocr');
  assert.match(result.text, /recognized locally/);
  assert.deepEqual(calls, ['pdftotext', 'pdftoppm', 'tesseract']);
});

test('PDF OCR is never silently enabled and invalid/unsupported files are rejected', async () => {
  const unavailable: LocalCommandRunner = async () => { throw new Error('tool missing'); };
  await assert.rejects(new DocumentParser(unavailable).parse('scan.pdf', pdf), /Install Poppler or enable local OCR/);
  await assert.rejects(new DocumentParser(unavailable).parse('scan.pdf', pdf, { ocr: true }), /Poppler [(]pdftoppm[)] failed/i);
  await assert.rejects(new DocumentParser().parse('bad.pdf', Buffer.from('not pdf')), /signature is invalid/);
  await assert.rejects(new DocumentParser().parse('archive.zip', Buffer.from('PK')), /Only PDF and DOCX/);
  await assert.rejects(new DocumentParser().parse('../escape.pdf', pdf), /plain filename/);
  await assert.rejects(new DocumentParser().parse('huge.pdf', Buffer.alloc(15 * 1024 * 1024 + 1)), /15 MB/);
});
