import { getStatus } from '@medplum/core';
import type { OperationOutcome } from '@medplum/fhirtypes';
import { type LogValue, logError } from 'vintasend';

/**
 * `logError` with the HTTP status Medplum derives from an OperationOutcome.
 *
 * Use it in log lines instead of the error itself: Medplum's `OperationOutcomeError.message` and
 * `outcome.issue[].diagnostics` can quote the request and the resource it touched. Like `logError`,
 * this keeps only the error's name and status.
 *
 * @example
 * logger.error(log`Failed to read task ${logId(taskId)}: ${logMedplumError(error)}`);
 */
export function logMedplumError(error: unknown): LogValue {
  const outcome = getOperationOutcome(error);
  return outcome ? logError(error, { status: getStatus(outcome) }) : logError(error);
}

function getOperationOutcome(error: unknown): OperationOutcome | undefined {
  if (typeof error !== 'object' || error === null || !('outcome' in error)) {
    return undefined;
  }
  const outcome = (error as { outcome?: unknown }).outcome;
  if (
    typeof outcome === 'object' &&
    outcome !== null &&
    (outcome as { resourceType?: unknown }).resourceType === 'OperationOutcome'
  ) {
    return outcome as OperationOutcome;
  }
  return undefined;
}
