import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const execFile = promisify(execFileCallback);
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 1_000_000;
const MAX_PDF_PAGES = 30;
const MAX_OCR_PAGES = 20;
const MIN_TEXT_CHARS = 40;

export interface ParsedDocument {
  text: string;
  format: 'pdf' | 'docx';
  extraction: 'text' | 'ocr' | 'text+ocr';
  pages?: number;
}

export type LocalCommandRunner = (command: string, args: string[], timeoutMs: number, maxBuffer: number) => Promise<string>;

const runLocalCommand: LocalCommandRunner = async (command, args, timeoutMs, maxBuffer) => {
  const result = await execFile(command, args, {
    encoding: 'utf8', timeout: timeoutMs, maxBuffer, windowsHide: true,
  });
  return result.stdout;
};

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)));
}

function extractDocxXml(xml: string): string {
  const textNodes = xml.replace(/<w:tab\\b[^>]*\\/>/g, '\\t').replace(/<w:br\\b[^>]*\\/>/g, '\\n')
    .replace(/<\\/w:p>/g, '\\n')
    .replace(/<w:t\\b[^>]*>([\\s\\S]*?)<\\/w:t>/g, (_match, value: string) => decodeXml(value))
    .replace(/<[^>]+>/g, '');
  return textNodes.replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
}

function readDocxMainXml(buffer: Buffer): string {
  const minimum = Math.max(0, buffer.length - 65_557);
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('DOCX archive directory is missing or malformed.');
  const entries = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  let cursor = buffer.readUInt32LE(eocd + 16);
  if (entries > 10_000 || cursor + directorySize > eocd) throw new Error('DOCX archive exceeds safe structural limits.');
  for (let index = 0; index < entries; index++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('DOCX archive entry is malformed.');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (name !== 'word/document.xml') continue;
    if (uncompressedSize > 5 * 1024 * 1024 || compressedSize === 0 || uncompressedSize > compressedSize * 100) {
      throw new Error('DOCX main document exceeds safe decompression limits.');
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('DOCX main document entry is malformed.');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > buffer.length) throw new Error('DOCX main document data is truncated.');
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let xml: Buffer;
    if (method === 0) xml = Buffer.from(compressed);
    else if (method === 8) xml = inflateRawSync(compressed, { maxOutputLength: 5 * 1024 * 1024 });
    else throw new Error('DOCX uses an unsupported compression method.');
    if (xml.length !== uncompressedSize) throw new Error('DOCX main document size validation failed.');
    return xml.toString('utf8');
  }
  throw new Error('DOCX does not contain word/document.xml.');
}

export class DocumentParser {
  constructor(private readonly runCommand: LocalCommandRunner = runLocalCommand) {}

  async parse(filename: string, bytes: Buffer, options: { ocr?: boolean } = {}): Promise<ParsedDocument> {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_FILE_BYTES) {
      throw new Error('Document must be a non-empty file no larger than 15 MB.');
    }
    const extension = filename.toLowerCase().slice(filename.lastIndexOf('.'));
    if (extension === '.docx') {
      if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('DOCX file signature is invalid.');
      const text = extractDocxXml(readDocxMainXml(bytes));
      if (!text) throw new Error('DOCX contains no extractable text.');
      if (text.length > MAX_EXTRACTED_CHARS) throw new Error('Extracted document text exceeds the 1 MB limit.');
      return { text, format: 'docx', extraction: 'text' };
    }
    if (extension !== '.pdf') throw new Error('Only PDF and DOCX files can use binary document parsing.');
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('PDF file signature is invalid.');
    return this.parsePdf(bytes, options.ocr === true);
  }

  private async parsePdf(bytes: Buffer, allowOcr: boolean): Promise<ParsedDocument> {
    const directory = await mkdtemp(join(tmpdir(), 'jarvis-document-'));
    const path = join(directory, 'input.pdf');
    const prefix = join(directory, 'page');
    try {
      await writeFile(path, bytes, { mode: 0o600 });
      let text = '';
      let textError: unknown;
      try {
        text = await this.runCommand('pdftotext', ['-layout', '-enc', 'UTF-8', path, '-'], 30_000, 4 * 1024 * 1024);
      } catch (error) { textError = error; }
      text = text.replace(/\f/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (text.length > MAX_EXTRACTED_CHARS) throw new Error('Extracted PDF text exceeds the 1 MB limit.');
      const pages = Math.max(1, text.split('\n\n').length);
      if (text.length >= MIN_TEXT_CHARS) return { text, format: 'pdf', extraction: 'text', pages };
      if (!allowOcr) {
        if (textError) throw new Error('PDF text extraction requires local Poppler (pdftotext). Install Poppler or enable local OCR.');
        throw new Error('PDF has no usable text layer. Enable OCR to process scanned pages.');
      }
      await this.runCommand('pdftoppm', ['-f', '1', '-l', String(MAX_OCR_PAGES), '-r', '160', '-png', path, prefix], 60_000, 1024 * 1024);
      const images = (await readdir(directory)).filter((name) => /^page-\d+\.png$/i.test(name)).sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]));
      if (!images.length) throw new Error('Local PDF rasterizer produced no OCR pages.');
      if (images.length > MAX_OCR_PAGES) throw new Error('PDF exceeds the 20-page OCR limit.');
      const recognized: string[] = [];
      for (const image of images) {
        const pageText = await this.runCommand('tesseract', [join(directory, image), 'stdout', '-l', 'eng', '--psm', '3'], 30_000, 1024 * 1024);
        recognized.push(pageText.trim());
      }
      const ocrText = recognized.filter(Boolean).join('\n\n').trim();
      const combined = [text, ocrText].filter(Boolean).join('\n\n');
      if (!combined) throw new Error('OCR completed but no readable text was found.');
      if (combined.length > MAX_EXTRACTED_CHARS) throw new Error('Extracted PDF text exceeds the 1 MB limit.');
      return { text: combined, format: 'pdf', extraction: text ? 'text+ocr' : 'ocr', pages: images.length };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
