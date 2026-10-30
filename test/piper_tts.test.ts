import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PIPER_AUDIO_BYTES,
  validatePiperWav,
} from '../src/voice/piperTts.ts';

function makeWav(samples = Buffer.from([0, 0, 1, 0])): Buffer {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(22050, 4);
  fmt.writeUInt32LE(44100, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);

  const chunk = (id: string, payload: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.write(id, 0, 4, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload, payload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
  };
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('data', samples)]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

test('Piper WAV validation accepts a complete WAV without assuming one sample rate', () => {
  assert.equal(validatePiperWav(makeWav()), undefined);
});

test('Piper WAV validation rejects a mismatched RIFF size', () => {
  const wav = makeWav();
  wav.writeUInt32LE(wav.length, 4);
  assert.match(validatePiperWav(wav) ?? '', /invalid RIFF size/i);
});

test('Piper WAV validation rejects truncated chunk payloads', () => {
  const wav = makeWav();
  wav.writeUInt32LE(0xfffffff0, wav.length - 8);
  assert.match(validatePiperWav(wav) ?? '', /truncated WAV chunk/i);
});

test('Piper WAV validation rejects empty audio samples and oversized output', () => {
  assert.match(validatePiperWav(makeWav(Buffer.alloc(0))) ?? '', /incomplete WAV layout/i);
  assert.match(validatePiperWav(Buffer.alloc(MAX_PIPER_AUDIO_BYTES + 1)) ?? '', /size/i);
});
