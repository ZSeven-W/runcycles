const http = require('node:http');
const { URL } = require('node:url');

const { RunStore } = require('./store.js');

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function createServer({ store = new RunStore() } = {}) {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');

    try {
      if (request.method === 'POST' && url.pathname === '/policy-templates') {
        const payload = await readJson(request);
        const template = store.createPolicyTemplate(payload);
        return json(response, 201, template);
      }

      if (request.method === 'GET' && url.pathname === '/policy-templates') {
        return json(response, 200, {
          policy_templates: store.listPolicyTemplates({ owner: url.searchParams.get('owner') })
        });
      }

      if (request.method === 'GET' && /^\/policy-templates\/[^/]+$/.test(url.pathname)) {
        const policyTemplateId = url.pathname.split('/')[2];
        const template = store.getPolicyTemplate(policyTemplateId);
        if (!template) {
          return json(response, 404, { error: 'policy_template_not_found' });
        }

        return json(response, 200, template);
      }

      if (request.method === 'POST' && url.pathname === '/budget-pools') {
        const payload = await readJson(request);
        const pool = store.createBudgetPool(payload);
        return json(response, 201, pool);
      }

      if (request.method === 'GET' && url.pathname === '/budget-pools') {
        return json(response, 200, {
          budget_pools: store.listBudgetPools({ owner: url.searchParams.get('owner') })
        });
      }

      if (request.method === 'GET' && url.pathname === '/budget-pools/summary') {
        return json(response, 200, store.getBudgetPoolPortfolioSummary({
          owner: url.searchParams.get('owner'),
          attentionOnly: url.searchParams.get('attention_only') === 'true'
        }));
      }

      if (request.method === 'GET' && /^\/budget-pools\/[^/]+$/.test(url.pathname)) {
        const poolId = url.pathname.split('/')[2];
        const pool = store.getBudgetPool(poolId);
        if (!pool) {
          return json(response, 404, { error: 'budget_pool_not_found' });
        }

        return json(response, 200, pool);
      }

      if (request.method === 'GET' && /^\/budget-pools\/[^/]+\/summary$/.test(url.pathname)) {
        const poolId = url.pathname.split('/')[2];
        const poolSummary = store.getBudgetPoolSummary(poolId);
        if (!poolSummary) {
          return json(response, 404, { error: 'budget_pool_not_found' });
        }

        return json(response, 200, poolSummary);
      }

      if (request.method === 'GET' && url.pathname === '/owners/summary') {
        return json(response, 200, store.getOwnerPortfolioSummary({
          attentionOnly: url.searchParams.get('attention_only') === 'true'
        }));
      }

      if (request.method === 'GET' && url.pathname === '/agents/summary') {
        return json(response, 200, store.getAgentPortfolioSummary({
          attentionOnly: url.searchParams.get('attention_only') === 'true'
        }));
      }

      if (request.method === 'GET' && /^\/agents\/[^/]+\/summary$/.test(url.pathname)) {
        const agent = decodeURIComponent(url.pathname.split('/')[2]);
        const agentSummary = store.getAgentSummary(agent);
        if (!agentSummary) {
          return json(response, 404, { error: 'agent_not_found' });
        }

        return json(response, 200, agentSummary);
      }

      if (request.method === 'GET' && /^\/owners\/[^/]+\/summary$/.test(url.pathname)) {
        const owner = decodeURIComponent(url.pathname.split('/')[2]);
        const ownerSummary = store.getOwnerSummary(owner);
        if (!ownerSummary) {
          return json(response, 404, { error: 'owner_not_found' });
        }

        return json(response, 200, ownerSummary);
      }

      if (request.method === 'POST' && url.pathname === '/runs') {
        const payload = await readJson(request);
        const run = store.reserveRun(payload);
        return json(response, run.status === 'pending_approval' ? 202 : 201, run);
      }

      if (request.method === 'GET' && url.pathname === '/approval-requests/summary') {
        return json(response, 200, store.getApprovalRequestPortfolioSummary({
          status: url.searchParams.get('status'),
          owner: url.searchParams.get('owner'),
          budgetPoolId: url.searchParams.get('budget_pool_id'),
          agent: url.searchParams.get('agent'),
          attentionOnly: url.searchParams.get('attention_only') === 'true'
        }));
      }

      if (request.method === 'GET' && url.pathname === '/approval-requests') {
        return json(response, 200, {
          approval_requests: store.listApprovalRequests({
            status: url.searchParams.get('status'),
            owner: url.searchParams.get('owner'),
            budgetPoolId: url.searchParams.get('budget_pool_id'),
            agent: url.searchParams.get('agent')
          })
        });
      }

      if (request.method === 'GET' && /^\/approval-requests\/[^/]+$/.test(url.pathname)) {
        const approvalRequestId = url.pathname.split('/')[2];
        const approvalRequest = store.getApprovalRequest(approvalRequestId);
        if (!approvalRequest) {
          return json(response, 404, { error: 'approval_request_not_found' });
        }

        return json(response, 200, approvalRequest);
      }

      if (request.method === 'POST' && /^\/approval-requests\/[^/]+\/decisions$/.test(url.pathname)) {
        const approvalRequestId = url.pathname.split('/')[2];
        const payload = await readJson(request);
        const decision = store.decideApprovalRequest(approvalRequestId, payload);
        return json(response, decision.status === 'reserved' ? 201 : 200, decision);
      }

      if (request.method === 'GET' && url.pathname === '/runs') {
        return json(response, 200, {
          runs: store.listRuns({
            status: url.searchParams.get('status'),
            agent: url.searchParams.get('agent'),
            budgetPoolId: url.searchParams.get('budget_pool_id')
          })
        });
      }

      if (request.method === 'GET' && /^\/runs\/[^/]+$/.test(url.pathname)) {
        const runId = url.pathname.split('/')[2];
        const run = store.getRun(runId);
        if (!run) {
          return json(response, 404, { error: 'run_not_found' });
        }

        return json(response, 200, run);
      }

      if (request.method === 'GET' && url.pathname === '/events') {
        return json(response, 200, {
          events: store.listEvents({
            resourceId: url.searchParams.get('resource_id'),
            type: url.searchParams.get('type'),
            budgetPoolId: url.searchParams.get('budget_pool_id'),
            owner: url.searchParams.get('owner'),
            agent: url.searchParams.get('agent')
          })
        });
      }

      if (request.method === 'POST' && /^\/runs\/[^/]+\/settlements$/.test(url.pathname)) {
        const runId = url.pathname.split('/')[2];
        const payload = await readJson(request);
        const run = store.settleRun(runId, payload.actual_cost_cents);
        return json(response, 200, run);
      }

      if (request.method === 'POST' && /^\/runs\/[^/]+\/cancellations$/.test(url.pathname)) {
        const runId = url.pathname.split('/')[2];
        const payload = await readJson(request);
        const run = store.cancelRun(runId, payload.reason);
        return json(response, 200, run);
      }

      return json(response, 404, { error: 'not_found' });
    } catch (error) {
      if (error instanceof SyntaxError) {
        return json(response, 400, { error: 'invalid_json' });
      }

      if (error.code === 'invalid_run' || error.code === 'invalid_settlement' || error.code === 'invalid_cancellation' || error.code === 'invalid_budget_pool' || error.code === 'invalid_policy_template' || error.code === 'invalid_approval_decision') {
        return json(response, 400, { error: error.code });
      }

      if (error.code === 'run_not_found' || error.code === 'budget_pool_not_found' || error.code === 'policy_template_not_found' || error.code === 'approval_request_not_found' || error.code === 'owner_not_found') {
        return json(response, 404, { error: error.code });
      }

      if (error.code === 'budget_exceeded' || error.code === 'budget_pool_limit_exceeded' || error.code === 'budget_pool_exhausted' || error.code === 'approval_required' || error.code === 'approval_request_not_actionable') {
        return json(response, 409, {
          error: error.code,
          ...error.details
        });
      }

      if (error.code === 'run_not_settleable') {
        return json(response, 409, { error: error.code });
      }

      return json(response, 500, {
        error: 'internal_error',
        message: error.message
      });
    }
  });
}

function startServer(port = process.env.PORT || 4327) {
  const server = createServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`RunCycles listening on http://127.0.0.1:${port}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createServer,
  startServer
};
