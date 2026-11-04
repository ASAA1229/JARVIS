import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TranscriptWakePhrase,
  VoiceProviderRegistry,
  validateWav16kMono,
  type SpeechToTextProvider,
} from '../src/voice/providers.ts';

function makeWav(samples = Buffer.from([0, 0, 1, 0])): Buffer {
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); // PCM
  fmt.writeUInt16LE(1, 2); // mono
  fmt.writeUInt32LE(16000, 4);
  fmt.writeUInt32LE(32000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const chunk = (id: string, payload: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.write(id, 0, 4, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    const padding = payload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0);
    return Buffer.concat([header, payload, padding]);
  };
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), chunk('data', samples)]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

test('voice WAV validation accepts correctly sized 16 kHz mono PCM', () => {
  assert.equal(validateWav16kMono(makeWav()), undefined);
});

test('voice WAV validation rejects truncated data chunks before transcription', () => {
  const wav = makeWav();
  // Keep the physical buffer but claim that the data chunk extends beyond RIFF.
  wav.writeUInt32LE(0xfffffff0, wav.length - 8);
  assert.match(validateWav16kMono(wav) ?? '', /truncated WAV chunk/i);
});

test('voice WAV validation rejects inconsistent RIFF size and short format chunks', () => {
  const wrongRiffSize = makeWav();
  wrongRiffSize.writeUInt32LE(wrongRiffSize.length, 4);
  assert.match(validateWav16kMono(wrongRiffSize) ?? '', /invalid RIFF size/i);

  const shortFmt = makeWav();
  shortFmt.writeUInt32LE(4, 16); // fmt chunk declares four bytes instead of sixteen
  assert.match(validateWav16kMono(shortFmt) ?? '', /invalid WAV format chunk/i);
});

test('wake phrase matching requires a phrase boundary and returns only the following command', () => {
  const matcher = new TranscriptWakePhrase('Hey Jarvis');
  assert.equal(matcher.operatesOnAudio, false);
  assert.equal(matcher.match('HEY, JARVIS'), '');
  assert.equal(matcher.match('Hey Jarvis, open Notepad'), 'open notepad');
  assert.equal(matcher.match('Hey Jarvisian open Notepad'), undefined);
});

test('cloud speech providers are rejected unless explicitly enabled', () => {
  const registry = new VoiceProviderRegistry({ allowCloudSpeech: false });
  const cloudProvider: SpeechToTextProvider = {
    id: 'test-cloud',
    local: false,
    isAvailable: async () => true,
    transcribe: async () => ({ text: 'should not run', provider: 'test-cloud', local: false }),
  };
  assert.throws(() => registry.register(cloudProvider), /Cloud speech providers are disabled/i);
  const allowed = new VoiceProviderRegistry({ allowCloudSpeech: true });
  assert.doesNotThrow(() => allowed.register(cloudProvider));
});
