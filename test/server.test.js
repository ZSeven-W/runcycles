const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { createServer } = require('../src/server.js');

function createBudgetPayload(overrides = {}) {
  return {
    agent: 'codex',
    task: 'ship README polish',
    budget_cents: 2500,
    ...overrides
  };
}

test('POST /runs reserves budget before execution', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload())
  });

  assert.equal(response.status, 201);
  const payload = await response.json();
  assert.equal(payload.status, 'reserved');
  assert.equal(payload.reserved_cents, 2500);
  assert.equal(payload.remaining_reserved_cents, 2500);
  assert.equal(payload.agent, 'codex');
  assert.match(payload.run_id, /^run_/);

  server.close();
  await once(server, 'close');
});

test('POST /runs/:id/settlements commits actual spend and releases the remainder', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const reserve = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({ budget_cents: 3000 }))
  });
  const reserved = await reserve.json();

  const settle = await fetch(`http://127.0.0.1:${port}/runs/${reserved.run_id}/settlements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ actual_cost_cents: 1200 })
  });

  assert.equal(settle.status, 200);
  const settled = await settle.json();
  assert.equal(settled.status, 'settled');
  assert.equal(settled.actual_cost_cents, 1200);
  assert.equal(settled.released_cents, 1800);
  assert.equal(settled.remaining_reserved_cents, 0);

  const summary = await fetch(`http://127.0.0.1:${port}/runs/${reserved.run_id}`);
  assert.equal(summary.status, 200);
  const run = await summary.json();
  assert.equal(run.status, 'settled');
  assert.equal(run.released_cents, 1800);

  server.close();
  await once(server, 'close');
});

test('rejects settlements that exceed the reserved budget', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const reserve = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({ budget_cents: 1500 }))
  });
  const reserved = await reserve.json();

  const settle = await fetch(`http://127.0.0.1:${port}/runs/${reserved.run_id}/settlements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ actual_cost_cents: 1900 })
  });

  assert.equal(settle.status, 409);
  const payload = await settle.json();
  assert.equal(payload.error, 'budget_exceeded');
  assert.equal(payload.reserved_cents, 1500);

  server.close();
  await once(server, 'close');
});

test('POST /runs/:id/cancellations releases reserved budget and records a cancellation event', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const poolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs team monthly budget',
      owner: 'docs',
      total_budget_cents: 5000,
      max_run_budget_cents: 3000
    })
  });
  const pool = await poolResponse.json();

  const reserve = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      budget_cents: 1800,
      budget_pool_id: pool.pool_id
    }))
  });
  const reserved = await reserve.json();

  const cancel = await fetch(`http://127.0.0.1:${port}/runs/${reserved.run_id}/cancellations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ reason: 'operator aborted' })
  });

  assert.equal(cancel.status, 200);
  const cancelled = await cancel.json();
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.released_cents, 1800);
  assert.equal(cancelled.remaining_reserved_cents, 0);
  assert.equal(cancelled.cancellation_reason, 'operator aborted');

  const poolAfterCancel = await fetch(`http://127.0.0.1:${port}/budget-pools/${pool.pool_id}`);
  assert.equal(poolAfterCancel.status, 200);
  const restoredPool = await poolAfterCancel.json();
  assert.equal(restoredPool.remaining_budget_cents, 5000);
  assert.equal(restoredPool.reserved_budget_cents, 0);
  assert.equal(restoredPool.spent_budget_cents, 0);

  const eventsResponse = await fetch(`http://127.0.0.1:${port}/events?resource_id=${reserved.run_id}`);
  assert.equal(eventsResponse.status, 200);
  const eventsPayload = await eventsResponse.json();
  assert.deepEqual(
    eventsPayload.events.map((event) => event.type),
    ['run.reserved', 'run.cancelled']
  );
  assert.equal(eventsPayload.events[1].released_cents, 1800);
  assert.equal(eventsPayload.events[1].cancellation_reason, 'operator aborted');

  server.close();
  await once(server, 'close');
});

test('budget pools enforce project ceilings before reservation and reconcile on settlement', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const poolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs team monthly budget',
      owner: 'docs',
      total_budget_cents: 5000,
      max_run_budget_cents: 3000
    })
  });

  assert.equal(poolResponse.status, 201);
  const pool = await poolResponse.json();
  assert.equal(pool.remaining_budget_cents, 5000);
  assert.equal(pool.max_run_budget_cents, 3000);

  const reserve = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      budget_cents: 2800,
      budget_pool_id: pool.pool_id
    }))
  });

  assert.equal(reserve.status, 201);
  const run = await reserve.json();
  assert.equal(run.budget_pool_id, pool.pool_id);

  const poolAfterReserve = await fetch(`http://127.0.0.1:${port}/budget-pools/${pool.pool_id}`);
  assert.equal(poolAfterReserve.status, 200);
  const reservedPool = await poolAfterReserve.json();
  assert.equal(reservedPool.remaining_budget_cents, 2200);
  assert.equal(reservedPool.reserved_budget_cents, 2800);

  const settle = await fetch(`http://127.0.0.1:${port}/runs/${run.run_id}/settlements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ actual_cost_cents: 1100 })
  });

  assert.equal(settle.status, 200);

  const poolAfterSettlement = await fetch(`http://127.0.0.1:${port}/budget-pools/${pool.pool_id}`);
  assert.equal(poolAfterSettlement.status, 200);
  const settledPool = await poolAfterSettlement.json();
  assert.equal(settledPool.remaining_budget_cents, 3900);
  assert.equal(settledPool.reserved_budget_cents, 0);
  assert.equal(settledPool.spent_budget_cents, 1100);

  server.close();
  await once(server, 'close');
});

test('budget pools reject reservations above the per-run policy limit', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const poolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Agentic growth experiments',
      owner: 'growth',
      total_budget_cents: 9000,
      max_run_budget_cents: 2000
    })
  });
  const pool = await poolResponse.json();

  const reserve = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      budget_cents: 2500,
      budget_pool_id: pool.pool_id
    }))
  });

  assert.equal(reserve.status, 409);
  const payload = await reserve.json();
  assert.equal(payload.error, 'budget_pool_limit_exceeded');
  assert.equal(payload.max_run_budget_cents, 2000);
  assert.equal(payload.requested_budget_cents, 2500);

  const poolAfterFailure = await fetch(`http://127.0.0.1:${port}/budget-pools/${pool.pool_id}`);
  const unchangedPool = await poolAfterFailure.json();
  assert.equal(unchangedPool.remaining_budget_cents, 9000);
  assert.equal(unchangedPool.reserved_budget_cents, 0);

  server.close();
  await once(server, 'close');
});

test('GET /events returns webhook-friendly lifecycle events for pool creation and run settlement', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const poolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs team monthly budget',
      owner: 'docs',
      total_budget_cents: 5000,
      max_run_budget_cents: 3000
    })
  });
  const pool = await poolResponse.json();

  const reserveResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      budget_cents: 2800,
      budget_pool_id: pool.pool_id
    }))
  });
  const run = await reserveResponse.json();

  const settleResponse = await fetch(`http://127.0.0.1:${port}/runs/${run.run_id}/settlements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ actual_cost_cents: 1100 })
  });
  assert.equal(settleResponse.status, 200);

  const eventsResponse = await fetch(`http://127.0.0.1:${port}/events?resource_id=${run.run_id}`);
  assert.equal(eventsResponse.status, 200);
  const payload = await eventsResponse.json();

  assert.equal(payload.events.length, 2);
  assert.deepEqual(
    payload.events.map((event) => event.type),
    ['run.reserved', 'run.settled']
  );
  assert.equal(payload.events[0].resource_id, run.run_id);
  assert.equal(payload.events[0].budget_pool_id, pool.pool_id);
  assert.equal(payload.events[0].reserved_cents, 2800);
  assert.equal(payload.events[1].resource_id, run.run_id);
  assert.equal(payload.events[1].actual_cost_cents, 1100);
  assert.equal(payload.events[1].released_cents, 1700);
  assert.match(payload.events[0].event_id, /^evt_/);
  assert.match(payload.events[1].occurred_at, /^\d{4}-\d{2}-\d{2}T/);

  const poolEventsResponse = await fetch(`http://127.0.0.1:${port}/events?resource_id=${pool.pool_id}`);
  const poolEventsPayload = await poolEventsResponse.json();
  assert.equal(poolEventsPayload.events.length, 1);
  assert.equal(poolEventsPayload.events[0].type, 'budget_pool.created');
  assert.equal(poolEventsPayload.events[0].resource_id, pool.pool_id);
  assert.equal(poolEventsPayload.events[0].remaining_budget_cents, 5000);

  server.close();
  await once(server, 'close');
});

test('GET /events supports type, pool, owner, and agent filters for inbox-style reviews', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const docsPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs team monthly budget',
      owner: 'docs',
      total_budget_cents: 5000,
      max_run_budget_cents: 3000
    })
  });
  const docsPool = await docsPoolResponse.json();

  const growthPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth team monthly budget',
      owner: 'growth',
      total_budget_cents: 7000,
      max_run_budget_cents: 4000
    })
  });
  const growthPool = await growthPoolResponse.json();

  const docsRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      budget_cents: 2100,
      budget_pool_id: docsPool.pool_id,
      task: 'publish docs refresh'
    }))
  });
  const docsRun = await docsRunResponse.json();

  const growthRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'hermes',
      budget_cents: 2600,
      budget_pool_id: growthPool.pool_id,
      task: 'launch partner experiment'
    }))
  });
  const growthRun = await growthRunResponse.json();

  const docsSettleResponse = await fetch(`http://127.0.0.1:${port}/runs/${docsRun.run_id}/settlements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ actual_cost_cents: 900 })
  });
  assert.equal(docsSettleResponse.status, 200);

  const growthCancelResponse = await fetch(`http://127.0.0.1:${port}/runs/${growthRun.run_id}/cancellations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ reason: 'partner window closed' })
  });
  assert.equal(growthCancelResponse.status, 200);

  const docsSettledEventsResponse = await fetch(
    `http://127.0.0.1:${port}/events?type=run.settled&budget_pool_id=${docsPool.pool_id}`
  );
  assert.equal(docsSettledEventsResponse.status, 200);
  const docsSettledEvents = await docsSettledEventsResponse.json();
  assert.equal(docsSettledEvents.events.length, 1);
  assert.equal(docsSettledEvents.events[0].resource_id, docsRun.run_id);
  assert.equal(docsSettledEvents.events[0].type, 'run.settled');

  const docsOwnerEventsResponse = await fetch(`http://127.0.0.1:${port}/events?owner=docs`);
  assert.equal(docsOwnerEventsResponse.status, 200);
  const docsOwnerEvents = await docsOwnerEventsResponse.json();
  assert.deepEqual(
    docsOwnerEvents.events.map((event) => event.type),
    ['budget_pool.created', 'run.reserved', 'run.settled']
  );

  const hermesEventsResponse = await fetch(`http://127.0.0.1:${port}/events?agent=hermes`);
  assert.equal(hermesEventsResponse.status, 200);
  const hermesEvents = await hermesEventsResponse.json();
  assert.deepEqual(
    hermesEvents.events.map((event) => event.type),
    ['run.reserved', 'run.cancelled']
  );
  assert.equal(hermesEvents.events[0].resource_id, growthRun.run_id);

  server.close();
  await once(server, 'close');
});

test('policy templates can be created and inspected for reuse', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const templateResponse = await fetch(`http://127.0.0.1:${port}/policy-templates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs default policy',
      owner: 'docs',
      total_budget_cents: 5000,
      max_run_budget_cents: 2000,
      approval_required_cents: 1500
    })
  });

  assert.equal(templateResponse.status, 201);
  const template = await templateResponse.json();
  assert.equal(template.owner, 'docs');
  assert.equal(template.max_run_budget_cents, 2000);
  assert.equal(template.approval_required_cents, 1500);
  assert.equal(template.created_sequence, undefined);
  assert.match(template.policy_template_id, /^policy_/);

  const fetchResponse = await fetch(`http://127.0.0.1:${port}/policy-templates/${template.policy_template_id}`);
  assert.equal(fetchResponse.status, 200);
  const fetchedTemplate = await fetchResponse.json();
  assert.equal(fetchedTemplate.name, 'Docs default policy');
  assert.equal(fetchedTemplate.total_budget_cents, 5000);

  server.close();
  await once(server, 'close');
});

test('budget pools can inherit policy thresholds from a template and enforce approval ceilings', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const templateResponse = await fetch(`http://127.0.0.1:${port}/policy-templates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth experiments',
      owner: 'growth',
      total_budget_cents: 9000,
      max_run_budget_cents: 4000,
      approval_required_cents: 1800
    })
  });
  const template = await templateResponse.json();

  const poolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth April budget',
      owner: 'growth',
      policy_template_id: template.policy_template_id
    })
  });

  assert.equal(poolResponse.status, 201);
  const pool = await poolResponse.json();
  assert.equal(pool.policy_template_id, template.policy_template_id);
  assert.equal(pool.max_run_budget_cents, 4000);
  assert.equal(pool.approval_required_cents, 1800);
  assert.equal(pool.remaining_budget_cents, 9000);
  assert.equal(pool.created_sequence, undefined);

  const approvalRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      budget_pool_id: pool.pool_id,
      budget_cents: 2200
    }))
  });

  assert.equal(approvalRunResponse.status, 409);
  const approvalPayload = await approvalRunResponse.json();
  assert.equal(approvalPayload.error, 'approval_required');
  assert.equal(approvalPayload.approval_required_cents, 1800);
  assert.equal(approvalPayload.requested_budget_cents, 2200);

  server.close();
  await once(server, 'close');
});

test('approval requests can be created from blocked runs and approved later', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const templateResponse = await fetch(`http://127.0.0.1:${port}/policy-templates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth experiments',
      owner: 'growth',
      total_budget_cents: 9000,
      max_run_budget_cents: 4000,
      approval_required_cents: 1800
    })
  });
  const template = await templateResponse.json();

  const poolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth April budget',
      owner: 'growth',
      policy_template_id: template.policy_template_id
    })
  });
  const pool = await poolResponse.json();

  const approvalRequestResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      budget_pool_id: pool.pool_id,
      budget_cents: 2200,
      request_approval_on_block: true
    }))
  });

  assert.equal(approvalRequestResponse.status, 202);
  const approvalRequest = await approvalRequestResponse.json();
  assert.equal(approvalRequest.status, 'pending_approval');
  assert.equal(approvalRequest.requested_budget_cents, 2200);
  assert.equal(approvalRequest.budget_pool_id, pool.pool_id);
  assert.match(approvalRequest.approval_request_id, /^approval_/);

  const approveResponse = await fetch(`http://127.0.0.1:${port}/approval-requests/${approvalRequest.approval_request_id}/decisions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      decision: 'approved',
      decided_by: 'ops-oncall'
    })
  });

  assert.equal(approveResponse.status, 201);
  const approvedRun = await approveResponse.json();
  assert.equal(approvedRun.status, 'reserved');
  assert.equal(approvedRun.budget_pool_id, pool.pool_id);
  assert.equal(approvedRun.reserved_cents, 2200);
  assert.equal(approvedRun.approval_request_id, approvalRequest.approval_request_id);
  assert.equal(approvedRun.approved_by, 'ops-oncall');

  const approvalRecordResponse = await fetch(`http://127.0.0.1:${port}/approval-requests/${approvalRequest.approval_request_id}`);
  assert.equal(approvalRecordResponse.status, 200);
  const approvalRecord = await approvalRecordResponse.json();
  assert.equal(approvalRecord.status, 'approved');
  assert.equal(approvalRecord.decided_by, 'ops-oncall');
  assert.equal(approvalRecord.run_id, approvedRun.run_id);

  const poolAfterApproval = await fetch(`http://127.0.0.1:${port}/budget-pools/${pool.pool_id}`);
  assert.equal(poolAfterApproval.status, 200);
  const approvedPool = await poolAfterApproval.json();
  assert.equal(approvedPool.remaining_budget_cents, 6800);
  assert.equal(approvedPool.reserved_budget_cents, 2200);

  const approvalEventsResponse = await fetch(`http://127.0.0.1:${port}/events?resource_id=${approvalRequest.approval_request_id}`);
  assert.equal(approvalEventsResponse.status, 200);
  const approvalEvents = await approvalEventsResponse.json();
  assert.deepEqual(
    approvalEvents.events.map((event) => event.type),
    ['approval_request.created', 'approval_request.approved']
  );

  server.close();
  await once(server, 'close');
});

test('GET /approval-requests lists approval inbox items and supports status/owner/pool filtering', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const growthTemplateResponse = await fetch(`http://127.0.0.1:${port}/policy-templates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth experiments',
      owner: 'growth',
      total_budget_cents: 9000,
      max_run_budget_cents: 4000,
      approval_required_cents: 1800
    })
  });
  assert.equal(growthTemplateResponse.status, 201);
  const growthTemplate = await growthTemplateResponse.json();

  const growthPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth April budget',
      owner: 'growth',
      policy_template_id: growthTemplate.policy_template_id
    })
  });
  assert.equal(growthPoolResponse.status, 201);
  const growthPool = await growthPoolResponse.json();

  const docsTemplateResponse = await fetch(`http://127.0.0.1:${port}/policy-templates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs default policy',
      owner: 'docs',
      total_budget_cents: 5000,
      max_run_budget_cents: 2500,
      approval_required_cents: 1200
    })
  });
  assert.equal(docsTemplateResponse.status, 201);
  const docsTemplate = await docsTemplateResponse.json();

  const docsPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs April budget',
      owner: 'docs',
      policy_template_id: docsTemplate.policy_template_id
    })
  });
  assert.equal(docsPoolResponse.status, 201);
  const docsPool = await docsPoolResponse.json();

  const firstRequestResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      task: 'launch growth experiment',
      budget_pool_id: growthPool.pool_id,
      budget_cents: 2200,
      request_approval_on_block: true
    }))
  });
  assert.equal(firstRequestResponse.status, 202);
  const firstRequest = await firstRequestResponse.json();

  const secondRequestResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      task: 'launch second experiment',
      budget_pool_id: growthPool.pool_id,
      budget_cents: 2100,
      request_approval_on_block: true
    }))
  });
  assert.equal(secondRequestResponse.status, 202);
  const secondRequest = await secondRequestResponse.json();

  const thirdRequestResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'hermes',
      task: 'review docs budget exception',
      budget_pool_id: docsPool.pool_id,
      budget_cents: 1500,
      request_approval_on_block: true
    }))
  });
  assert.equal(thirdRequestResponse.status, 202);
  const thirdRequest = await thirdRequestResponse.json();

  const rejectResponse = await fetch(`http://127.0.0.1:${port}/approval-requests/${secondRequest.approval_request_id}/decisions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      decision: 'rejected',
      decided_by: 'ops-oncall'
    })
  });
  assert.equal(rejectResponse.status, 200);

  const inboxResponse = await fetch(`http://127.0.0.1:${port}/approval-requests`);
  assert.equal(inboxResponse.status, 200);
  const inbox = await inboxResponse.json();
  assert.equal(inbox.approval_requests.length, 3);
  assert.deepEqual(
    inbox.approval_requests.map((request) => request.approval_request_id),
    [thirdRequest.approval_request_id, secondRequest.approval_request_id, firstRequest.approval_request_id]
  );

  const pendingResponse = await fetch(`http://127.0.0.1:${port}/approval-requests?status=pending_approval`);
  assert.equal(pendingResponse.status, 200);
  const pending = await pendingResponse.json();
  assert.deepEqual(
    pending.approval_requests.map((request) => request.approval_request_id),
    [thirdRequest.approval_request_id, firstRequest.approval_request_id]
  );
  assert.equal(pending.approval_requests[0].status, 'pending_approval');

  const rejectedResponse = await fetch(`http://127.0.0.1:${port}/approval-requests?status=rejected`);
  assert.equal(rejectedResponse.status, 200);
  const rejected = await rejectedResponse.json();
  assert.deepEqual(
    rejected.approval_requests.map((request) => request.approval_request_id),
    [secondRequest.approval_request_id]
  );
  assert.equal(rejected.approval_requests[0].decided_by, 'ops-oncall');

  const growthOwnerResponse = await fetch(`http://127.0.0.1:${port}/approval-requests?owner=growth`);
  assert.equal(growthOwnerResponse.status, 200);
  const growthOwnerPayload = await growthOwnerResponse.json();
  assert.deepEqual(
    growthOwnerPayload.approval_requests.map((request) => request.approval_request_id),
    [secondRequest.approval_request_id, firstRequest.approval_request_id]
  );

  const docsPoolFilteredResponse = await fetch(`http://127.0.0.1:${port}/approval-requests?budget_pool_id=${docsPool.pool_id}`);
  assert.equal(docsPoolFilteredResponse.status, 200);
  const docsPoolFilteredPayload = await docsPoolFilteredResponse.json();
  assert.deepEqual(
    docsPoolFilteredPayload.approval_requests.map((request) => request.approval_request_id),
    [thirdRequest.approval_request_id]
  );

  const pendingDocsResponse = await fetch(`http://127.0.0.1:${port}/approval-requests?status=pending_approval&owner=docs&budget_pool_id=${docsPool.pool_id}`);
  assert.equal(pendingDocsResponse.status, 200);
  const pendingDocsPayload = await pendingDocsResponse.json();
  assert.deepEqual(
    pendingDocsPayload.approval_requests.map((request) => request.approval_request_id),
    [thirdRequest.approval_request_id]
  );

  server.close();
  await once(server, 'close');
});

test('GET /approval-requests/summary returns inbox totals, attention queue, and supports agent + attention_only filtering', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const docsPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs approvals',
      owner: 'docs',
      total_budget_cents: 6000,
      max_run_budget_cents: 3200,
      approval_required_cents: 1400
    })
  });
  assert.equal(docsPoolResponse.status, 201);
  const docsPool = await docsPoolResponse.json();

  const growthPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth approvals',
      owner: 'growth',
      total_budget_cents: 9000,
      max_run_budget_cents: 4200,
      approval_required_cents: 1800
    })
  });
  assert.equal(growthPoolResponse.status, 201);
  const growthPool = await growthPoolResponse.json();

  const firstRequestResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'codex',
      task: 'docs exception one',
      budget_pool_id: docsPool.pool_id,
      budget_cents: 2200,
      request_approval_on_block: true
    }))
  });
  assert.equal(firstRequestResponse.status, 202);
  const firstRequest = await firstRequestResponse.json();

  const secondRequestResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'codex',
      task: 'growth exception two',
      budget_pool_id: growthPool.pool_id,
      budget_cents: 2600,
      request_approval_on_block: true
    }))
  });
  assert.equal(secondRequestResponse.status, 202);
  const secondRequest = await secondRequestResponse.json();

  const thirdRequestResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'hermes',
      task: 'growth exception three',
      budget_pool_id: growthPool.pool_id,
      budget_cents: 2100,
      request_approval_on_block: true
    }))
  });
  assert.equal(thirdRequestResponse.status, 202);
  const thirdRequest = await thirdRequestResponse.json();

  const rejectResponse = await fetch(`http://127.0.0.1:${port}/approval-requests/${secondRequest.approval_request_id}/decisions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      decision: 'rejected',
      decided_by: 'ops-oncall'
    })
  });
  assert.equal(rejectResponse.status, 200);

  const summaryResponse = await fetch(`http://127.0.0.1:${port}/approval-requests/summary`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();

  assert.deepEqual(summary.approval_request_counts, {
    total: 3,
    pending_approval: 2,
    approved: 0,
    rejected: 1
  });
  assert.equal(summary.requested_budget_cents_total, 6900);
  assert.equal(summary.latest_approval_request.approval_request_id, thirdRequest.approval_request_id);
  assert.deepEqual(
    summary.attention_approval_requests.map((request) => request.approval_request_id),
    [thirdRequest.approval_request_id, firstRequest.approval_request_id]
  );
  assert.deepEqual(
    summary.approval_requests.map((request) => request.approval_request_id),
    [thirdRequest.approval_request_id, secondRequest.approval_request_id, firstRequest.approval_request_id]
  );

  const codexSummaryResponse = await fetch(`http://127.0.0.1:${port}/approval-requests/summary?agent=codex`);
  assert.equal(codexSummaryResponse.status, 200);
  const codexSummary = await codexSummaryResponse.json();
  assert.deepEqual(codexSummary.approval_request_counts, {
    total: 2,
    pending_approval: 1,
    approved: 0,
    rejected: 1
  });
  assert.equal(codexSummary.requested_budget_cents_total, 4800);
  assert.deepEqual(
    codexSummary.approval_requests.map((request) => request.approval_request_id),
    [secondRequest.approval_request_id, firstRequest.approval_request_id]
  );
  assert.deepEqual(
    codexSummary.attention_approval_requests.map((request) => request.approval_request_id),
    [firstRequest.approval_request_id]
  );

  const attentionOnlyResponse = await fetch(`http://127.0.0.1:${port}/approval-requests/summary?attention_only=true`);
  assert.equal(attentionOnlyResponse.status, 200);
  const attentionOnly = await attentionOnlyResponse.json();
  assert.deepEqual(attentionOnly.approval_request_counts, {
    total: 2,
    pending_approval: 2,
    approved: 0,
    rejected: 0
  });
  assert.equal(attentionOnly.requested_budget_cents_total, 4300);
  assert.deepEqual(
    attentionOnly.approval_requests.map((request) => request.approval_request_id),
    [thirdRequest.approval_request_id, firstRequest.approval_request_id]
  );

  server.close();
  await once(server, 'close');
});

test('GET /policy-templates lists templates newest-first and supports owner filtering', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const docsTemplateResponse = await fetch(`http://127.0.0.1:${port}/policy-templates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs default policy',
      owner: 'docs',
      total_budget_cents: 5000,
      max_run_budget_cents: 2000
    })
  });
  assert.equal(docsTemplateResponse.status, 201);
  const docsTemplate = await docsTemplateResponse.json();

  const growthTemplateResponse = await fetch(`http://127.0.0.1:${port}/policy-templates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth experiments',
      owner: 'growth',
      total_budget_cents: 9000,
      max_run_budget_cents: 4000,
      approval_required_cents: 1800
    })
  });
  assert.equal(growthTemplateResponse.status, 201);
  const growthTemplate = await growthTemplateResponse.json();

  const listResponse = await fetch(`http://127.0.0.1:${port}/policy-templates`);
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.deepEqual(
    listPayload.policy_templates.map((template) => template.policy_template_id),
    [growthTemplate.policy_template_id, docsTemplate.policy_template_id]
  );
  assert.equal(listPayload.policy_templates[0].created_sequence, undefined);

  const filteredResponse = await fetch(`http://127.0.0.1:${port}/policy-templates?owner=docs`);
  assert.equal(filteredResponse.status, 200);
  const filteredPayload = await filteredResponse.json();
  assert.deepEqual(
    filteredPayload.policy_templates.map((template) => template.policy_template_id),
    [docsTemplate.policy_template_id]
  );

  server.close();
  await once(server, 'close');
});

test('GET /budget-pools lists pools newest-first and supports owner filtering', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const docsPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs April budget',
      owner: 'docs',
      total_budget_cents: 5000,
      max_run_budget_cents: 2000
    })
  });
  assert.equal(docsPoolResponse.status, 201);
  const docsPool = await docsPoolResponse.json();

  const growthPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth April budget',
      owner: 'growth',
      total_budget_cents: 9000,
      max_run_budget_cents: 4000,
      approval_required_cents: 1800
    })
  });
  assert.equal(growthPoolResponse.status, 201);
  const growthPool = await growthPoolResponse.json();

  const listResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`);
  assert.equal(listResponse.status, 200);
  const listPayload = await listResponse.json();
  assert.deepEqual(
    listPayload.budget_pools.map((pool) => pool.pool_id),
    [growthPool.pool_id, docsPool.pool_id]
  );
  assert.equal(listPayload.budget_pools[0].created_sequence, undefined);

  const filteredResponse = await fetch(`http://127.0.0.1:${port}/budget-pools?owner=growth`);
  assert.equal(filteredResponse.status, 200);
  const filteredPayload = await filteredResponse.json();
  assert.deepEqual(
    filteredPayload.budget_pools.map((pool) => pool.pool_id),
    [growthPool.pool_id]
  );
  assert.equal(filteredPayload.budget_pools[0].approval_required_cents, 1800);

  server.close();
  await once(server, 'close');
});

test('GET /runs lists runs newest-first and supports status/agent/pool filters', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const poolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs budget',
      owner: 'docs',
      total_budget_cents: 7000,
      max_run_budget_cents: 4000
    })
  });
  assert.equal(poolResponse.status, 201);
  const pool = await poolResponse.json();

  const firstRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'codex',
      budget_cents: 2200,
      budget_pool_id: pool.pool_id,
      task: 'stabilize release notes'
    }))
  });
  assert.equal(firstRunResponse.status, 201);
  const firstRun = await firstRunResponse.json();

  const secondRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'hermes',
      budget_cents: 1800,
      budget_pool_id: pool.pool_id,
      task: 'triage approval queue'
    }))
  });
  assert.equal(secondRunResponse.status, 201);
  const secondRun = await secondRunResponse.json();

  const settleResponse = await fetch(`http://127.0.0.1:${port}/runs/${firstRun.run_id}/settlements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ actual_cost_cents: 1200 })
  });
  assert.equal(settleResponse.status, 200);

  const filteredResponse = await fetch(`http://127.0.0.1:${port}/runs?status=reserved&budget_pool_id=${pool.pool_id}&agent=hermes`);
  assert.equal(filteredResponse.status, 200);
  const filteredPayload = await filteredResponse.json();
  assert.equal(filteredPayload.runs.length, 1);
  assert.equal(filteredPayload.runs[0].run_id, secondRun.run_id);
  assert.equal(filteredPayload.runs[0].status, 'reserved');
  assert.equal(filteredPayload.runs[0].agent, 'hermes');
  assert.equal(filteredPayload.runs[0].created_sequence, undefined);

  const newestFirstResponse = await fetch(`http://127.0.0.1:${port}/runs?budget_pool_id=${pool.pool_id}`);
  assert.equal(newestFirstResponse.status, 200);
  const newestFirstPayload = await newestFirstResponse.json();
  assert.deepEqual(
    newestFirstPayload.runs.map((run) => run.run_id),
    [secondRun.run_id, firstRun.run_id]
  );

  server.close();
  await once(server, 'close');
});

test('GET /budget-pools/:id/summary returns pool health, run totals, and approval backlog', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const templateResponse = await fetch(`http://127.0.0.1:${port}/policy-templates`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth experiments',
      owner: 'growth',
      total_budget_cents: 9000,
      max_run_budget_cents: 4000,
      approval_required_cents: 1800
    })
  });
  assert.equal(templateResponse.status, 201);
  const template = await templateResponse.json();

  const poolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth April budget',
      owner: 'growth',
      policy_template_id: template.policy_template_id
    })
  });
  assert.equal(poolResponse.status, 201);
  const pool = await poolResponse.json();

  const settledRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      task: 'refresh landing page',
      budget_pool_id: pool.pool_id,
      budget_cents: 1700
    }))
  });
  assert.equal(settledRunResponse.status, 201);
  const settledRun = await settledRunResponse.json();

  const settleResponse = await fetch(`http://127.0.0.1:${port}/runs/${settledRun.run_id}/settlements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ actual_cost_cents: 900 })
  });
  assert.equal(settleResponse.status, 200);

  const cancelledRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      task: 'cancel stale workflow',
      budget_pool_id: pool.pool_id,
      budget_cents: 1200
    }))
  });
  assert.equal(cancelledRunResponse.status, 201);
  const cancelledRun = await cancelledRunResponse.json();

  const cancelResponse = await fetch(`http://127.0.0.1:${port}/runs/${cancelledRun.run_id}/cancellations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ reason: 'quality gate failed' })
  });
  assert.equal(cancelResponse.status, 200);

  const approvalRequestResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      task: 'launch growth experiment',
      budget_pool_id: pool.pool_id,
      budget_cents: 2200,
      request_approval_on_block: true
    }))
  });
  assert.equal(approvalRequestResponse.status, 202);
  const approvalRequest = await approvalRequestResponse.json();

  const summaryResponse = await fetch(`http://127.0.0.1:${port}/budget-pools/${pool.pool_id}/summary`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();

  assert.equal(summary.budget_pool.pool_id, pool.pool_id);
  assert.deepEqual(summary.run_counts, {
    total: 2,
    reserved: 0,
    settled: 1,
    cancelled: 1
  });
  assert.deepEqual(summary.approval_request_counts, {
    total: 1,
    pending_approval: 1,
    approved: 0,
    rejected: 0
  });
  assert.deepEqual(summary.totals, {
    requested_cents: 2900,
    actual_cost_cents: 900,
    released_cents: 2000,
    open_reserved_cents: 0
  });
  assert.equal(summary.latest_run.run_id, cancelledRun.run_id);
  assert.equal(summary.latest_approval_request.approval_request_id, approvalRequest.approval_request_id);
  assert.equal(summary.latest_approval_request.status, 'pending_approval');

  const missingResponse = await fetch(`http://127.0.0.1:${port}/budget-pools/pool_missing/summary`);
  assert.equal(missingResponse.status, 404);

  server.close();
  await once(server, 'close');
});

test('GET /budget-pools/summary returns cross-pool attention queues and supports owner + attention_only filtering', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const docsPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs budget',
      owner: 'docs',
      total_budget_cents: 5000,
      max_run_budget_cents: 3000,
      approval_required_cents: 1800
    })
  });
  assert.equal(docsPoolResponse.status, 201);
  const docsPool = await docsPoolResponse.json();

  const opsPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Ops budget',
      owner: 'ops',
      total_budget_cents: 4000,
      max_run_budget_cents: 1500
    })
  });
  assert.equal(opsPoolResponse.status, 201);
  const opsPool = await opsPoolResponse.json();

  const docsRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'hermes',
      task: 'launch docs campaign',
      budget_pool_id: docsPool.pool_id,
      budget_cents: 2200,
      request_approval_on_block: true
    }))
  });
  assert.equal(docsRunResponse.status, 202);
  const docsApproval = await docsRunResponse.json();

  const opsRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'codex',
      task: 'ship ops automation',
      budget_pool_id: opsPool.pool_id,
      budget_cents: 900
    }))
  });
  assert.equal(opsRunResponse.status, 201);
  const opsRun = await opsRunResponse.json();

  const summaryResponse = await fetch(`http://127.0.0.1:${port}/budget-pools/summary`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();

  assert.deepEqual(summary.budget_pool_counts, {
    total: 2,
    needing_attention: 2
  });
  assert.deepEqual(summary.run_counts, {
    total: 1,
    reserved: 1,
    settled: 0,
    cancelled: 0
  });
  assert.deepEqual(summary.approval_request_counts, {
    total: 1,
    pending_approval: 1,
    approved: 0,
    rejected: 0
  });
  assert.deepEqual(summary.run_totals, {
    requested_cents: 900,
    actual_cost_cents: 0,
    released_cents: 0,
    open_reserved_cents: 900
  });
  assert.equal(summary.latest_budget_pool_summary.budget_pool.pool_id, docsPool.pool_id);
  assert.equal(summary.attention_pools.length, 2);
  assert.equal(summary.budget_pools[0].budget_pool.pool_id, docsPool.pool_id);
  assert.deepEqual(summary.budget_pools[0].attention_reasons, ['pending_approvals']);
  assert.equal(summary.budget_pools[0].latest_approval_request.approval_request_id, docsApproval.approval_request_id);
  assert.equal(summary.budget_pools[1].budget_pool.pool_id, opsPool.pool_id);
  assert.deepEqual(summary.budget_pools[1].attention_reasons, ['active_reservations']);
  assert.equal(summary.budget_pools[1].latest_run.run_id, opsRun.run_id);

  const ownerSummaryResponse = await fetch(`http://127.0.0.1:${port}/budget-pools/summary?owner=docs`);
  assert.equal(ownerSummaryResponse.status, 200);
  const ownerSummary = await ownerSummaryResponse.json();
  assert.equal(ownerSummary.owner, 'docs');
  assert.equal(ownerSummary.budget_pool_counts.total, 1);
  assert.equal(ownerSummary.budget_pools[0].budget_pool.pool_id, docsPool.pool_id);

  const attentionOnlyResponse = await fetch(`http://127.0.0.1:${port}/budget-pools/summary?owner=docs&attention_only=true`);
  assert.equal(attentionOnlyResponse.status, 200);
  const attentionOnly = await attentionOnlyResponse.json();
  assert.equal(attentionOnly.budget_pool_counts.total, 1);
  assert.equal(attentionOnly.attention_pools.length, 1);
  assert.equal(attentionOnly.budget_pools[0].budget_pool.pool_id, docsPool.pool_id);

  const quietOwnerResponse = await fetch(`http://127.0.0.1:${port}/budget-pools/summary?owner=growth&attention_only=true`);
  assert.equal(quietOwnerResponse.status, 200);
  const quietOwner = await quietOwnerResponse.json();
  assert.equal(quietOwner.budget_pool_counts.total, 0);
  assert.equal(quietOwner.attention_pools.length, 0);
  assert.equal(quietOwner.budget_pools.length, 0);

  server.close();
  await once(server, 'close');
});

test('GET /owners/:owner/summary returns cross-pool budget health for one owner', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const docsPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs April budget',
      owner: 'docs',
      total_budget_cents: 5000,
      max_run_budget_cents: 3000,
      approval_required_cents: 1800
    })
  });
  assert.equal(docsPoolResponse.status, 201);
  const docsPool = await docsPoolResponse.json();

  const docsOverflowResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs overflow budget',
      owner: 'docs',
      total_budget_cents: 3000,
      max_run_budget_cents: 2500,
      approval_required_cents: 1500
    })
  });
  assert.equal(docsOverflowResponse.status, 201);
  const docsOverflowPool = await docsOverflowResponse.json();

  const growthPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth budget',
      owner: 'growth',
      total_budget_cents: 9000,
      max_run_budget_cents: 4000
    })
  });
  assert.equal(growthPoolResponse.status, 201);

  const settledRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'hermes',
      task: 'refresh docs landing page',
      budget_pool_id: docsPool.pool_id,
      budget_cents: 1200
    }))
  });
  assert.equal(settledRunResponse.status, 201);
  const settledRun = await settledRunResponse.json();

  const settleResponse = await fetch(`http://127.0.0.1:${port}/runs/${settledRun.run_id}/settlements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ actual_cost_cents: 700 })
  });
  assert.equal(settleResponse.status, 200);

  const reservedRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'codex',
      task: 'prepare docs migration patch',
      budget_pool_id: docsOverflowPool.pool_id,
      budget_cents: 900
    }))
  });
  assert.equal(reservedRunResponse.status, 201);
  const reservedRun = await reservedRunResponse.json();

  const approvalRequestResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'hermes',
      task: 'launch docs growth push',
      budget_pool_id: docsPool.pool_id,
      budget_cents: 2200,
      request_approval_on_block: true
    }))
  });
  assert.equal(approvalRequestResponse.status, 202);
  const approvalRequest = await approvalRequestResponse.json();

  const summaryResponse = await fetch(`http://127.0.0.1:${port}/owners/docs/summary`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();

  assert.equal(summary.owner, 'docs');
  assert.deepEqual(summary.budget_pool_counts, { total: 2, needing_attention: 2 });
  assert.deepEqual(summary.budget_totals, {
    total_budget_cents: 8000,
    remaining_budget_cents: 6400,
    reserved_budget_cents: 900,
    spent_budget_cents: 700
  });
  assert.deepEqual(summary.run_counts, {
    total: 2,
    reserved: 1,
    settled: 1,
    cancelled: 0
  });
  assert.deepEqual(summary.approval_request_counts, {
    total: 1,
    pending_approval: 1,
    approved: 0,
    rejected: 0
  });
  assert.deepEqual(summary.run_totals, {
    requested_cents: 2100,
    actual_cost_cents: 700,
    released_cents: 500,
    open_reserved_cents: 900
  });
  assert.equal(summary.latest_budget_pool.pool_id, docsOverflowPool.pool_id);
  assert.equal(summary.latest_run.run_id, reservedRun.run_id);
  assert.equal(summary.latest_approval_request.approval_request_id, approvalRequest.approval_request_id);
  assert.equal(summary.attention_pools.length, 2);
  assert.deepEqual(summary.attention_pools.map((pool) => pool.budget_pool.pool_id), [docsOverflowPool.pool_id, docsPool.pool_id]);
  assert.deepEqual(summary.attention_pools[0].attention_reasons, ['active_reservations']);
  assert.deepEqual(summary.attention_pools[1].attention_reasons, ['pending_approvals']);
  assert.equal(summary.budget_pools.length, 2);
  assert.equal(summary.budget_pools[0].burn_rate_percent, 0);
  assert.equal(summary.budget_pools[1].burn_rate_percent, 14);

  const ownerMissingResponse = await fetch(`http://127.0.0.1:${port}/owners/finance/summary`);
  assert.equal(ownerMissingResponse.status, 404);

  server.close();
  await once(server, 'close');
});

test('GET /owners/summary returns cross-owner attention queues and supports attention_only filtering', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();

  const docsPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs monthly budget',
      owner: 'docs',
      total_budget_cents: 5000,
      max_run_budget_cents: 3000,
      approval_required_cents: 1500
    })
  });
  assert.equal(docsPoolResponse.status, 201);
  const docsPool = await docsPoolResponse.json();

  const growthPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth experiments',
      owner: 'growth',
      total_budget_cents: 7000,
      max_run_budget_cents: 4000
    })
  });
  assert.equal(growthPoolResponse.status, 201);
  const growthPool = await growthPoolResponse.json();

  const opsPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Ops maintenance',
      owner: 'ops',
      total_budget_cents: 9000,
      max_run_budget_cents: 5000
    })
  });
  assert.equal(opsPoolResponse.status, 201);
  const opsPool = await opsPoolResponse.json();

  const docsApprovalResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'hermes',
      task: 'launch docs translation push',
      budget_pool_id: docsPool.pool_id,
      budget_cents: 2200,
      request_approval_on_block: true
    }))
  });
  assert.equal(docsApprovalResponse.status, 202);

  const growthReserveResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'codex',
      task: 'run partner outreach experiment',
      budget_pool_id: growthPool.pool_id,
      budget_cents: 1800
    }))
  });
  assert.equal(growthReserveResponse.status, 201);
  const growthRun = await growthReserveResponse.json();

  const opsReserveResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'hermes',
      task: 'rotate weekly ledger snapshot',
      budget_pool_id: opsPool.pool_id,
      budget_cents: 1400
    }))
  });
  assert.equal(opsReserveResponse.status, 201);
  const opsRun = await opsReserveResponse.json();

  const opsSettleResponse = await fetch(`http://127.0.0.1:${port}/runs/${opsRun.run_id}/settlements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ actual_cost_cents: 900 })
  });
  assert.equal(opsSettleResponse.status, 200);

  const summaryResponse = await fetch(`http://127.0.0.1:${port}/owners/summary`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();

  assert.deepEqual(summary.owner_counts, { total: 3, needing_attention: 2 });
  assert.deepEqual(summary.budget_totals, {
    total_budget_cents: 21000,
    remaining_budget_cents: 18300,
    reserved_budget_cents: 1800,
    spent_budget_cents: 900
  });
  assert.deepEqual(summary.run_counts, {
    total: 2,
    reserved: 1,
    settled: 1,
    cancelled: 0
  });
  assert.deepEqual(summary.approval_request_counts, {
    total: 1,
    pending_approval: 1,
    approved: 0,
    rejected: 0
  });
  assert.deepEqual(summary.run_totals, {
    requested_cents: 3200,
    actual_cost_cents: 900,
    released_cents: 500,
    open_reserved_cents: 1800
  });
  assert.equal(summary.latest_owner_summary.owner, 'docs');
  assert.deepEqual(summary.attention_owners.map((owner) => owner.owner), ['docs', 'growth']);
  assert.deepEqual(summary.owners.map((owner) => owner.owner), ['docs', 'growth', 'ops']);
  assert.equal(summary.owners[0].approval_request_counts.pending_approval, 1);
  assert.equal(summary.owners[1].run_totals.open_reserved_cents, 1800);
  assert.equal(summary.owners[2].budget_totals.spent_budget_cents, 900);
  assert.equal(summary.owners[1].latest_run.run_id, growthRun.run_id);

  const attentionOnlyResponse = await fetch(`http://127.0.0.1:${port}/owners/summary?attention_only=true`);
  assert.equal(attentionOnlyResponse.status, 200);
  const attentionOnly = await attentionOnlyResponse.json();
  assert.deepEqual(attentionOnly.owner_counts, { total: 2, needing_attention: 2 });
  assert.deepEqual(attentionOnly.owners.map((owner) => owner.owner), ['docs', 'growth']);
  assert.equal(attentionOnly.latest_owner_summary.owner, 'docs');

  server.close();
  await once(server, 'close');
});

test('GET /agents/:agent/summary returns cross-owner budget health for one agent', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const docsPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs pool',
      owner: 'docs',
      total_budget_cents: 7000,
      max_run_budget_cents: 3000,
      approval_required_cents: 2200
    })
  });
  const docsPool = await docsPoolResponse.json();

  const growthPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth pool',
      owner: 'growth',
      total_budget_cents: 9000,
      max_run_budget_cents: 4000,
      approval_required_cents: 2500
    })
  });
  const growthPool = await growthPoolResponse.json();

  const docsRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'codex',
      task: 'refresh docs examples',
      budget_cents: 1800,
      budget_pool_id: docsPool.pool_id
    }))
  });
  const docsRun = await docsRunResponse.json();

  const growthRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'codex',
      task: 'launch experiment',
      budget_cents: 1400,
      budget_pool_id: growthPool.pool_id
    }))
  });
  const growthRun = await growthRunResponse.json();

  const growthSettleResponse = await fetch(`http://127.0.0.1:${port}/runs/${growthRun.run_id}/settlements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ actual_cost_cents: 900 })
  });
  assert.equal(growthSettleResponse.status, 200);

  const pendingApprovalResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'codex',
      task: 'oversized launch plan',
      budget_cents: 3200,
      budget_pool_id: growthPool.pool_id,
      request_approval_on_block: true
    }))
  });
  const pendingApproval = await pendingApprovalResponse.json();

  const hermesRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'hermes',
      task: 'ops cleanup',
      budget_cents: 800,
      budget_pool_id: growthPool.pool_id
    }))
  });
  assert.equal(hermesRunResponse.status, 201);

  const summaryResponse = await fetch(`http://127.0.0.1:${port}/agents/codex/summary`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();

  assert.equal(summary.agent, 'codex');
  assert.deepEqual(summary.owner_counts, { total: 2, needing_attention: 2 });
  assert.deepEqual(summary.budget_totals, {
    total_budget_cents: 16000,
    remaining_budget_cents: 12500,
    reserved_budget_cents: 2600,
    spent_budget_cents: 900
  });
  assert.deepEqual(summary.run_counts, {
    total: 2,
    reserved: 1,
    settled: 1,
    cancelled: 0
  });
  assert.deepEqual(summary.approval_request_counts, {
    total: 1,
    pending_approval: 1,
    approved: 0,
    rejected: 0
  });
  assert.deepEqual(summary.run_totals, {
    requested_cents: 3200,
    actual_cost_cents: 900,
    released_cents: 500,
    open_reserved_cents: 1800
  });
  assert.equal(summary.latest_run.run_id, growthRun.run_id);
  assert.equal(summary.latest_approval_request.approval_request_id, pendingApproval.approval_request_id);
  assert.deepEqual(summary.attention_owners.map((owner) => owner.owner), ['growth', 'docs']);
  assert.deepEqual(summary.owners.map((owner) => owner.owner), ['growth', 'docs']);
  assert.equal(summary.owners[0].budget_pool_counts.needing_attention, 1);
  assert.equal(summary.owners[1].run_totals.open_reserved_cents, 1800);
  assert.equal(summary.latest_owner_summary.owner, 'growth');
  assert.equal(docsRun.run_id.startsWith('run_'), true);

  const missingResponse = await fetch(`http://127.0.0.1:${port}/agents/claude/summary`);
  assert.equal(missingResponse.status, 404);

  server.close();
  await once(server, 'close');
});

test('GET /agents/summary returns cross-agent attention queues and supports attention_only filtering', async () => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const { port } = server.address();
  const docsPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Docs pool',
      owner: 'docs',
      total_budget_cents: 8000,
      max_run_budget_cents: 4000,
      approval_required_cents: 1500
    })
  });
  const docsPool = await docsPoolResponse.json();

  const growthPoolResponse = await fetch(`http://127.0.0.1:${port}/budget-pools`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      name: 'Growth pool',
      owner: 'growth',
      total_budget_cents: 6000,
      max_run_budget_cents: 3000,
      approval_required_cents: 2000
    })
  });
  const growthPool = await growthPoolResponse.json();

  const codexDocsRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'codex',
      task: 'docs refresh',
      budget_cents: 1200,
      budget_pool_id: docsPool.pool_id
    }))
  });
  const codexDocsRun = await codexDocsRunResponse.json();

  const codexGrowthRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'codex',
      task: 'growth cleanup',
      budget_cents: 1500,
      budget_pool_id: growthPool.pool_id
    }))
  });
  const codexGrowthRun = await codexGrowthRunResponse.json();

  const codexSettleResponse = await fetch(`http://127.0.0.1:${port}/runs/${codexGrowthRun.run_id}/settlements`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ actual_cost_cents: 900 })
  });
  assert.equal(codexSettleResponse.status, 200);

  const hermesPendingResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'hermes',
      task: 'launch review',
      budget_cents: 2600,
      budget_pool_id: growthPool.pool_id,
      request_approval_on_block: true
    }))
  });
  assert.equal(hermesPendingResponse.status, 202);

  const claudeRunResponse = await fetch(`http://127.0.0.1:${port}/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(createBudgetPayload({
      agent: 'claude',
      task: 'ops sync',
      budget_cents: 700,
      budget_pool_id: docsPool.pool_id
    }))
  });
  const claudeRun = await claudeRunResponse.json();
  assert.equal(claudeRunResponse.status, 201);

  const claudeCancelResponse = await fetch(`http://127.0.0.1:${port}/runs/${claudeRun.run_id}/cancellations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify({ reason: 'ops work deferred' })
  });
  assert.equal(claudeCancelResponse.status, 200);

  const summaryResponse = await fetch(`http://127.0.0.1:${port}/agents/summary`);
  assert.equal(summaryResponse.status, 200);
  const summary = await summaryResponse.json();

  assert.deepEqual(summary.agent_counts, { total: 3, needing_attention: 2 });
  assert.deepEqual(summary.budget_totals, {
    total_budget_cents: 14000,
    remaining_budget_cents: 11900,
    reserved_budget_cents: 1200,
    spent_budget_cents: 900
  });
  assert.deepEqual(summary.run_counts, {
    total: 3,
    reserved: 1,
    settled: 1,
    cancelled: 1
  });
  assert.deepEqual(summary.approval_request_counts, {
    total: 1,
    pending_approval: 1,
    approved: 0,
    rejected: 0
  });
  assert.deepEqual(summary.run_totals, {
    requested_cents: 3400,
    actual_cost_cents: 900,
    released_cents: 1300,
    open_reserved_cents: 1200
  });
  assert.equal(summary.latest_agent_summary.agent, 'hermes');
  assert.deepEqual(summary.attention_agents.map((agent) => agent.agent), ['hermes', 'codex']);
  assert.deepEqual(summary.agents.map((agent) => agent.agent), ['hermes', 'codex', 'claude']);
  assert.equal(summary.agents[0].approval_request_counts.pending_approval, 1);
  assert.equal(summary.agents[1].run_totals.open_reserved_cents, 1200);
  assert.equal(summary.agents[2].budget_totals.spent_budget_cents, 0);
  assert.equal(summary.agents[1].latest_run.run_id, codexGrowthRun.run_id);
  assert.equal(summary.agents[1].owners[0].owner, 'docs');
  assert.equal(codexDocsRun.run_id.startsWith('run_'), true);

  const attentionOnlyResponse = await fetch(`http://127.0.0.1:${port}/agents/summary?attention_only=true`);
  assert.equal(attentionOnlyResponse.status, 200);
  const attentionOnly = await attentionOnlyResponse.json();
  assert.deepEqual(attentionOnly.agent_counts, { total: 2, needing_attention: 2 });
  assert.deepEqual(attentionOnly.agents.map((agent) => agent.agent), ['hermes', 'codex']);
  assert.equal(attentionOnly.latest_agent_summary.agent, 'hermes');

  server.close();
  await once(server, 'close');
});
