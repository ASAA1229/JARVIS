import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceManager, SpeechState } from '../src/voice/voiceManager.ts';

test('voice manager starts one bounded capture and rejects duplicate starts without losing transcript', () => {
  const manager = new VoiceManager();
  assert.deepEqual(manager.startPushToTalk(), { allowed: true });
  manager.updateTranscript('Open Notepad');

  const duplicate = manager.startPushToTalk();
  assert.equal(duplicate.allowed, false);
  assert.match(duplicate.reason ?? '', /already active/i);
  assert.equal(manager.getCurrentTranscript(), 'Open Notepad');
  assert.equal(manager.getState(), SpeechState.LISTENING);
  manager.dispose();
});

test('voice manager preserves transcript for review after explicit stop', () => {
  const manager = new VoiceManager();
  manager.startPushToTalk();
  manager.updateTranscript('  What is the OS version?  ');
  manager.stopPushToTalk();

  assert.equal(manager.getState(), SpeechState.CONFIRMING);
  assert.equal(manager.getCurrentTranscript(), 'What is the OS version?');
  assert.equal(manager.startPushToTalk().allowed, false);
  manager.dispose();
});

test('voice manager moves through transcription without extending capture deadline', () => {
  const manager = new VoiceManager();
  manager.startPushToTalk();
  assert.equal(manager.beginTranscription(), true);
  assert.equal(manager.getState(), SpeechState.TRANSCRIBING);
  manager.updateTranscript('Recognized command');
  assert.equal(manager.finishTranscription(), true);
  assert.equal(manager.getState(), SpeechState.CONFIRMING);
  manager.dispose();
});

test('voice manager bounds transcript length and ignores late updates after cancellation', () => {
  const manager = new VoiceManager();
  manager.startPushToTalk();
  manager.updateTranscript('x'.repeat(5000));
  assert.equal(manager.getCurrentTranscript().length, 1200);

  manager.cancelCapture();
  manager.updateTranscript('late callback');
  assert.equal(manager.getCurrentTranscript(), '');
  assert.equal(manager.getState(), SpeechState.IDLE);
  manager.dispose();
});

test('muting cancels capture, discards transcript and cannot be bypassed by cancel', () => {
  const manager = new VoiceManager();
  manager.startPushToTalk();
  manager.updateTranscript('Sensitive spoken text');

  assert.equal(manager.toggleMute(), true);
  assert.equal(manager.getState(), SpeechState.DISABLED);
  assert.equal(manager.getCurrentTranscript(), '');
  manager.cancelCapture();
  assert.equal(manager.getState(), SpeechState.DISABLED);
  assert.equal(manager.startPushToTalk().allowed, false);

  assert.equal(manager.toggleMute(), false);
  assert.equal(manager.getState(), SpeechState.IDLE);
  manager.dispose();
});

test('invalid capture duration fails closed', () => {
  const manager = new VoiceManager();
  manager.policy.maxCaptureDurationSeconds = 0;
  const result = manager.startPushToTalk();

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /duration/i);
  assert.equal(manager.getState(), SpeechState.IDLE);
  manager.dispose();
});

test('capture timeout fires once and stops listening before notifying the caller', async () => {
  const manager = new VoiceManager();
  manager.policy.maxCaptureDurationSeconds = 0.01;
  let calls = 0;
  let stateAtCallback: SpeechState | undefined;

  manager.startPushToTalk(() => {
    calls += 1;
    stateAtCallback = manager.getState();
  });
  manager.updateTranscript('Review this after timeout');

  await new Promise(resolve => setTimeout(resolve, 40));

  assert.equal(calls, 1);
  assert.equal(stateAtCallback, SpeechState.CONFIRMING);
  assert.equal(manager.getState(), SpeechState.CONFIRMING);
  assert.equal(manager.getCurrentTranscript(), 'Review this after timeout');
  manager.dispose();
});

test('cancelled capture timeout cannot fire into a later capture', async () => {
  const manager = new VoiceManager();
  manager.policy.maxCaptureDurationSeconds = 0.02;
  let staleTimeoutCalls = 0;

  manager.startPushToTalk(() => { staleTimeoutCalls += 1; });
  manager.cancelCapture();
  manager.policy.maxCaptureDurationSeconds = 0.08;
  manager.startPushToTalk();

  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(staleTimeoutCalls, 0);
  assert.equal(manager.getState(), SpeechState.LISTENING);

  manager.dispose();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(staleTimeoutCalls, 0);
});

test('timeout notification errors do not break privacy timeout enforcement', async () => {
  const manager = new VoiceManager();
  manager.policy.maxCaptureDurationSeconds = 0.01;
  manager.startPushToTalk(() => { throw new Error('notification failure'); });

  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(manager.getState(), SpeechState.IDLE);
  manager.dispose();
});


test('stalled transcription times out and preserves partial text for explicit review', async () => {
  const manager = new VoiceManager();
  manager.policy.maxTranscriptionDurationSeconds = 0.01;

  manager.startPushToTalk();
  assert.equal(manager.beginTranscription(), true);
  manager.updateTranscript('Open Notepad');

  await new Promise(resolve => setTimeout(resolve, 40));

  assert.equal(manager.getState(), SpeechState.CONFIRMING);
  assert.equal(manager.getCurrentTranscript(), 'Open Notepad');
  assert.equal(manager.startPushToTalk().allowed, false);
  manager.dispose();
});

test('empty stalled transcription returns to idle and allows a fresh capture', async () => {
  const manager = new VoiceManager();
  manager.policy.maxTranscriptionDurationSeconds = 0.01;

  manager.startPushToTalk();
  assert.equal(manager.beginTranscription(), true);

  await new Promise(resolve => setTimeout(resolve, 40));

  assert.equal(manager.getState(), SpeechState.IDLE);
  assert.equal(manager.getCurrentTranscript(), '');
  assert.equal(manager.startPushToTalk().allowed, true);
  manager.dispose();
});

test('completed transcription clears its timeout and cannot be changed by a stale timer', async () => {
  const manager = new VoiceManager();
  manager.policy.maxTranscriptionDurationSeconds = 0.03;

  manager.startPushToTalk();
  assert.equal(manager.beginTranscription(), true);
  manager.updateTranscript('Verified command');
  assert.equal(manager.finishTranscription(), true);

  await new Promise(resolve => setTimeout(resolve, 50));

  assert.equal(manager.getState(), SpeechState.CONFIRMING);
  assert.equal(manager.getCurrentTranscript(), 'Verified command');
  manager.dispose();
});

test('invalid transcription duration fails closed without leaving a stuck processing state', () => {
  const manager = new VoiceManager();
  manager.policy.maxTranscriptionDurationSeconds = 0;

  manager.startPushToTalk();
  assert.equal(manager.beginTranscription(), false);
  assert.equal(manager.getState(), SpeechState.ERROR);
  assert.equal(manager.startPushToTalk().allowed, true);
  manager.dispose();
});
