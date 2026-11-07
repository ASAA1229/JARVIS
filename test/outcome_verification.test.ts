import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  WindowsDesktopAgent,
  buildVerifiedPasteScript,
  classifyInsertion,
  parseReadback,
  type InsertionReadback,
} from '../src/adapters/windowsDesktopAgent.js';
import { OutcomeVerifier } from '../src/verification/verifier.js';
import { VerificationOutcome } from '../src/core/types.js';

const readback = (overrides: Partial<InsertionReadback> = {}): InsertionReadback => ({
  readable: true, beforeLength: 10, afterLength: 15, payloadLength: 5, containsPayload: true, containedBefore: false, ...overrides,
});

describe('US-016 classifyInsertion (white-box: every branch)', () => {
  test('no acknowledgement -> clean failure, nothing sent', () => {
    const verdict = classifyInsertion(false, readback());
    assert.equal(verdict.success, false);
    assert.equal(verdict.outcome, VerificationOutcome.VERIFIED_FAILURE);
    assert.equal(verdict.verification, 'not_sent');
  });

  test('acknowledged but unreadable destination -> PARTIAL, verification disclosed as unsupported', () => {
    for (const evidence of [null, readback({ readable: false })]) {
      const verdict = classifyInsertion(true, evidence);
      assert.equal(verdict.outcome, VerificationOutcome.PARTIAL_SUCCESS);
      assert.equal(verdict.verification, 'unsupported');
      assert.match(String(verdict.error), /could not be independently verified/);
    }
  });

  test('readback contains exactly the inserted text -> VERIFIED_SUCCESS', () => {
    const verdict = classifyInsertion(true, readback());
    assert.equal(verdict.success, true);
    assert.equal(verdict.outcome, VerificationOutcome.VERIFIED_SUCCESS);
    assert.equal(verdict.verification, 'readback_match');
  });

  test('text present but length changed differently (selection replaced) -> PARTIAL', () => {
    const verdict = classifyInsertion(true, readback({ afterLength: 12 }));
    assert.equal(verdict.outcome, VerificationOutcome.PARTIAL_SUCCESS);
    assert.equal(verdict.verification, 'readback_ambiguous');
  });

  test('text already present before the paste -> PARTIAL, never VERIFIED', () => {
    const verdict = classifyInsertion(true, readback({ containedBefore: true }));
    assert.equal(verdict.outcome, VerificationOutcome.PARTIAL_SUCCESS);
    assert.equal(verdict.verification, 'readback_ambiguous');
  });

  test('keys sent but text absent from the control -> UNCERTAIN, not a clean failure', () => {
    const verdict = classifyInsertion(true, readback({ containsPayload: false, afterLength: 10 }));
    assert.equal(verdict.success, false);
    assert.equal(verdict.outcome, VerificationOutcome.UNCERTAIN);
    assert.equal(verdict.verification, 'readback_mismatch');
  });
});

describe('US-016 readback parsing', () => {
  test('parses a well-formed READBACK line', () => {
    const parsed = parseReadback('PASTE_SENT\nREADBACK=' + JSON.stringify(readback()));
    assert.deepEqual(parsed, readback());
  });

  test('rejects missing, malformed or out-of-range readback', () => {
    assert.equal(parseReadback('PASTE_SENT'), null);
    assert.equal(parseReadback('READBACK={not json'), null);
    assert.equal(parseReadback('READBACK=' + JSON.stringify({ ...readback(), afterLength: -1 })), null);
    assert.equal(parseReadback('READBACK=' + JSON.stringify({ ...readback(), readable: 'yes' })), null);
  });
});

describe('US-016 verified paste script (white-box)', () => {
  test('literal text: blocks password fields, reads back before and after, reports lengths only', () => {
    const script = buildVerifiedPasteScript({ text: "it's" });
    assert.match(script, /IsPassword/);
    assert.match(script, /policy blocks writing to credential/);
    assert.match(script, /\$before = Get-JarvisFocusedText/);
    assert.match(script, /\$after = Get-JarvisFocusedText/);
    assert.match(script, /\$payload = 'it''s'/, 'single quotes are escaped');
    assert.match(script, /READBACK=/);
    // The control text itself must never be written to stdout.
    assert.doesNotMatch(script, /WriteLine\(\$after\)|WriteLine\(\$before\)/);
  });

  test('clipboard source refuses an empty clipboard and does not overwrite it', () => {
    const script = buildVerifiedPasteScript('clipboard');
    assert.match(script, /CLIPBOARD_EMPTY/);
    assert.doesNotMatch(script, /Clipboard\]::SetText/);
  });
});

describe('US-016 adapter wiring with an injected runner (integration, mocked desktop)', () => {
  const agentReturning = (stdout: string) => {
    const scripts: string[] = [];
    const agent = new WindowsDesktopAgent(async (script) => {
      scripts.push(script);
      return stdout;
    });
    return { agent, scripts };
  };

  test('type_text is VERIFIED only when the readback matches; evidence holds no text', async () => {
    const { agent, scripts } = agentReturning('PASTE_SENT\nREADBACK=' + JSON.stringify(readback({ beforeLength: 0, afterLength: 11, payloadLength: 11 })));
    const result = await agent.execute({ operation: 'desktop:type_text', parameters: { text: 'Hello JARVIS', expectProcess: 'Notepad' } });
    assert.equal(result.outcome, VerificationOutcome.VERIFIED_SUCCESS);
    assert.equal(result.evidence?.verification, 'readback_match');
    assert.equal(JSON.stringify(result).includes('Hello JARVIS'), false);
    assert.match(scripts[0]!, /TARGET_MISMATCH/, 'foreground process pin is part of the guarded script');
  });

  test('acknowledgement-only output is never VERIFIED_SUCCESS', async () => {
    const { agent } = agentReturning('PASTE_SENT');
    const result = await agent.execute({ operation: 'desktop:paste_text', parameters: { text: 'x' } });
    assert.equal(result.outcome, VerificationOutcome.PARTIAL_SUCCESS);
    assert.equal(result.evidence?.verification, 'unsupported');
  });

  test('paste_clipboard uses the same readback verification', async () => {
    const { agent, scripts } = agentReturning('PASTE_SENT\nREADBACK=' + JSON.stringify(readback()));
    const result = await agent.execute({ operation: 'desktop:paste_clipboard', parameters: {} });
    assert.equal(result.outcome, VerificationOutcome.VERIFIED_SUCCESS);
    assert.match(scripts[0]!, /CLIPBOARD_EMPTY/);
  });

  test('empty clipboard and locked desktop fail closed with clear reasons', async () => {
    const failing = (stderr: string) => new WindowsDesktopAgent(async () => {
      throw Object.assign(new Error('Command failed'), { stderr, cmd: 'powershell' });
    });
    const empty = await failing('CLIPBOARD_EMPTY').execute({ operation: 'desktop:paste_clipboard', parameters: {} });
    assert.equal(empty.success, false);
    assert.match(String(empty.error), /clipboard has no text/);
    const locked = await failing('DESKTOP_LOCKED').execute({ operation: 'desktop:type_text', parameters: { text: 'x' } });
    assert.equal(locked.outcome, VerificationOutcome.VERIFIED_FAILURE);
    assert.equal(locked.failureKind, 'locked_session');
  });
});

describe('US-016 verifier mapping', () => {
  const verifier = new OutcomeVerifier();

  test('a failed follow-up after a real side effect is PARTIAL, not a clean failure', () => {
    const verdict = verifier.verify('desktop:launch_and_type', {
      success: false, outcome: VerificationOutcome.PARTIAL_SUCCESS, error: 'The application opened, but the text was not entered.',
    });
    assert.equal(verdict.honestOutcome, VerificationOutcome.PARTIAL_SUCCESS);
    assert.equal(verdict.verified, false);
  });

  test('acknowledgement-only success stays PARTIAL; only VERIFIED_SUCCESS is verified', () => {
    assert.equal(verifier.verify('x', { success: true, outcome: VerificationOutcome.PARTIAL_SUCCESS }).honestOutcome, VerificationOutcome.PARTIAL_SUCCESS);
    const ok = verifier.verify('x', { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS });
    assert.equal(ok.honestOutcome, VerificationOutcome.VERIFIED_SUCCESS);
    assert.equal(ok.verified, true);
  });
});
