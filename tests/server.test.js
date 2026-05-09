import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../src/server.js';

async function request(listener, { method, path, body }) {
  const server = listener.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));

  return {
    status: response.status,
    json,
  };
}

test('POST /reservations creates a reservation snapshot', async () => {
  const app = buildApp({ totalBudgetCents: 1000 });

  const response = await request(app, {
    method: 'POST',
    path: '/reservations',
    body: {
      runId: 'run-1',
      reservedCents: 450,
      qualityGate: 'tests-green',
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.json.reservation.status, 'reserved');
  assert.equal(response.json.summary.remainingBudgetCents, 550);
});

test('POST /reservations/:runId/commit settles actual spend', async () => {
  const app = buildApp({ totalBudgetCents: 1000 });
  await request(app, {
    method: 'POST',
    path: '/reservations',
    body: { runId: 'run-1', reservedCents: 450, qualityGate: 'tests-green' },
  });

  const response = await request(app, {
    method: 'POST',
    path: '/reservations/run-1/commit',
    body: { actualCents: 200 },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.settlement.releasedCents, 250);
  assert.equal(response.json.summary.spentBudgetCents, 200);
});

test('POST /reservations/:runId/cancel releases a reservation', async () => {
  const app = buildApp({ totalBudgetCents: 1000 });
  await request(app, {
    method: 'POST',
    path: '/reservations',
    body: { runId: 'run-1', reservedCents: 450, qualityGate: 'tests-green' },
  });

  const response = await request(app, {
    method: 'POST',
    path: '/reservations/run-1/cancel',
    body: { reason: 'quality gate failed' },
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.cancellation.releasedCents, 450);
  assert.equal(response.json.summary.remainingBudgetCents, 1000);
});

test('GET /summary reports budget usage', async () => {
  const app = buildApp({ totalBudgetCents: 1000 });
  await request(app, {
    method: 'POST',
    path: '/reservations',
    body: { runId: 'run-1', reservedCents: 400, qualityGate: 'tests-green' },
  });

  const response = await request(app, {
    method: 'GET',
    path: '/summary',
  });

  assert.equal(response.status, 200);
  assert.equal(response.json.summary.reservedBudgetCents, 400);
  assert.equal(response.json.summary.committedRuns, 0);
});
