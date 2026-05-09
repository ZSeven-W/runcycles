import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBudgetLedger,
  BudgetExceededError,
  ReservationNotFoundError,
  InvalidSettlementError,
} from '../src/budget-ledger.js';

test('reserveRun holds budget and reports remaining capacity', () => {
  const ledger = createBudgetLedger({ totalBudgetCents: 1000 });

  const reservation = ledger.reserveRun({
    runId: 'run-1',
    reservedCents: 400,
    qualityGate: 'tests-green',
  });

  assert.equal(reservation.status, 'reserved');
  assert.equal(reservation.remainingBudgetCents, 600);
  assert.equal(ledger.getSummary().reservedBudgetCents, 400);
});

test('reserveRun rejects reservations that exceed remaining budget', () => {
  const ledger = createBudgetLedger({ totalBudgetCents: 500 });
  ledger.reserveRun({ runId: 'run-1', reservedCents: 300, qualityGate: 'tests-green' });

  assert.throws(
    () => ledger.reserveRun({ runId: 'run-2', reservedCents: 250, qualityGate: 'docs-reviewed' }),
    BudgetExceededError,
  );
});

test('commitRun settles actual spend and releases unused budget', () => {
  const ledger = createBudgetLedger({ totalBudgetCents: 1200 });
  ledger.reserveRun({ runId: 'run-1', reservedCents: 500, qualityGate: 'tests-green' });

  const settlement = ledger.commitRun({ runId: 'run-1', actualCents: 320 });

  assert.equal(settlement.status, 'committed');
  assert.equal(settlement.releasedCents, 180);
  assert.equal(ledger.getSummary().spentBudgetCents, 320);
  assert.equal(ledger.getSummary().remainingBudgetCents, 880);
});

test('cancelRun releases the full reservation when work is abandoned', () => {
  const ledger = createBudgetLedger({ totalBudgetCents: 1200 });
  ledger.reserveRun({ runId: 'run-1', reservedCents: 500, qualityGate: 'tests-green' });

  const cancelled = ledger.cancelRun({ runId: 'run-1', reason: 'quality gate failed' });

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.releasedCents, 500);
  assert.equal(ledger.getSummary().remainingBudgetCents, 1200);
});

test('commitRun rejects actual spend above the reserved amount', () => {
  const ledger = createBudgetLedger({ totalBudgetCents: 1000 });
  ledger.reserveRun({ runId: 'run-1', reservedCents: 300, qualityGate: 'tests-green' });

  assert.throws(
    () => ledger.commitRun({ runId: 'run-1', actualCents: 350 }),
    InvalidSettlementError,
  );
});

test('unknown run operations raise ReservationNotFoundError', () => {
  const ledger = createBudgetLedger({ totalBudgetCents: 1000 });

  assert.throws(() => ledger.commitRun({ runId: 'missing', actualCents: 100 }), ReservationNotFoundError);
  assert.throws(() => ledger.cancelRun({ runId: 'missing', reason: 'missing' }), ReservationNotFoundError);
});
