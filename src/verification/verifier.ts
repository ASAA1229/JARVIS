import { ExecutionResult, VerificationOutcome } from '../core/types.js';

export class OutcomeVerifier {
  /**
   * Evaluates raw adapter output and evidence against expectations.
   * Guarantees that an uncertain outcome is never reported as success.
   */
  public verify(
    expectedOutcome: string,
    result: ExecutionResult
  ): { honestOutcome: VerificationOutcome; verified: boolean; message: string } {
    if (result.interrupted) {
      return {
        honestOutcome: VerificationOutcome.UNCERTAIN,
        verified: false,
        message: 'Task was interrupted prior to outcome verification',
      };
    }

    if (!result.success && result.outcome === VerificationOutcome.UNCERTAIN) {
      // The adapter could not tell whether the side effect happened (for example a
      // timeout after keystrokes were sent). Reporting a clean failure would invite
      // a duplicate retry, so surface the uncertainty instead.
      return {
        honestOutcome: VerificationOutcome.UNCERTAIN,
        verified: false,
        message: (result.error || 'The outcome could not be confirmed') + ' Check the target before retrying.',
      };
    }

    if (!result.success) {
      return {
        honestOutcome: VerificationOutcome.VERIFIED_FAILURE,
        verified: true,
        message: result.error || 'Operation failed during execution',
      };
    }

    if (result.outcome === VerificationOutcome.UNCERTAIN) {
      return {
        honestOutcome: VerificationOutcome.UNCERTAIN,
        verified: false,
        message: 'Outcome could not be deterministically confirmed by host evidence',
      };
    }

    if (result.outcome === VerificationOutcome.PARTIAL_SUCCESS) {
      return {
        honestOutcome: VerificationOutcome.PARTIAL_SUCCESS,
        verified: false,
        message: 'Operation partially succeeded; some evidence was incomplete',
      };
    }

    return {
      honestOutcome: VerificationOutcome.VERIFIED_SUCCESS,
      verified: true,
      message: `Operation outcome successfully verified (${expectedOutcome})`,
    };
  }
}
