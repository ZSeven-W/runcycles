const { randomUUID } = require('node:crypto');

class RunStore {
  constructor() {
    this.runs = new Map();
    this.budgetPools = new Map();
    this.policyTemplates = new Map();
    this.approvalRequests = new Map();
    this.approvalRequestSequence = 0;
    this.policyTemplateSequence = 0;
    this.budgetPoolSequence = 0;
    this.runSequence = 0;
    this.events = [];
  }

  #toPublicPolicyTemplate(template) {
    const { created_sequence: _createdSequence, ...publicTemplate } = template;
    return { ...publicTemplate };
  }

  #toPublicBudgetPool(pool) {
    const { created_sequence: _createdSequence, ...publicPool } = pool;
    return { ...publicPool };
  }

  recordEvent(type, payload) {
    const event = {
      event_id: `evt_${randomUUID()}`,
      type,
      occurred_at: new Date().toISOString(),
      ...payload
    };

    this.events.push(event);
    return event;
  }

  listEvents({ resourceId = null, type = null, budgetPoolId = null, owner = null, agent = null } = {}) {
    return this.events
      .filter((event) => (resourceId ? event.resource_id === resourceId : true))
      .filter((event) => (type ? event.type === type : true))
      .filter((event) => (budgetPoolId ? event.budget_pool_id === budgetPoolId : true))
      .filter((event) => (agent ? event.agent === agent : true))
      .filter((event) => {
        if (!owner) {
          return true;
        }

        if (event.owner) {
          return event.owner === owner;
        }

        if (!event.budget_pool_id) {
          return false;
        }

        const pool = this.budgetPools.get(event.budget_pool_id);
        return pool ? pool.owner === owner : false;
      })
      .map((event) => ({ ...event }));
  }

  createPolicyTemplate({
    name,
    owner,
    total_budget_cents: totalBudgetCents,
    max_run_budget_cents: maxRunBudgetCents = null,
    approval_required_cents: approvalRequiredCents = null
  }) {
    const hasValidMaxRunBudget = maxRunBudgetCents === null || (Number.isInteger(maxRunBudgetCents) && maxRunBudgetCents > 0);
    const hasValidApprovalThreshold = approvalRequiredCents === null || (Number.isInteger(approvalRequiredCents) && approvalRequiredCents > 0);
    const approvalWithinBudget = approvalRequiredCents === null || approvalRequiredCents <= totalBudgetCents;
    const approvalWithinRunBudget = maxRunBudgetCents === null || approvalRequiredCents === null || approvalRequiredCents <= maxRunBudgetCents;
    if (!name || !owner || !Number.isInteger(totalBudgetCents) || totalBudgetCents <= 0 || !hasValidMaxRunBudget || !hasValidApprovalThreshold || !approvalWithinBudget || !approvalWithinRunBudget) {
      const error = new Error('invalid_policy_template');
      error.code = 'invalid_policy_template';
      throw error;
    }

    const template = {
      policy_template_id: `policy_${randomUUID()}`,
      name,
      owner,
      total_budget_cents: totalBudgetCents,
      max_run_budget_cents: maxRunBudgetCents,
      approval_required_cents: approvalRequiredCents,
      created_at: new Date().toISOString(),
      created_sequence: ++this.policyTemplateSequence
    };

    this.policyTemplates.set(template.policy_template_id, template);
    this.recordEvent('policy_template.created', {
      resource_id: template.policy_template_id,
      owner: template.owner,
      total_budget_cents: template.total_budget_cents,
      max_run_budget_cents: template.max_run_budget_cents,
      approval_required_cents: template.approval_required_cents
    });
    return this.#toPublicPolicyTemplate(template);
  }

  getPolicyTemplate(policyTemplateId) {
    const template = this.policyTemplates.get(policyTemplateId);
    if (!template) {
      return null;
    }

    return this.#toPublicPolicyTemplate(template);
  }

  listPolicyTemplates({ owner = null } = {}) {
    return Array.from(this.policyTemplates.values())
      .filter((template) => (owner ? template.owner === owner : true))
      .sort((left, right) => right.created_sequence - left.created_sequence)
      .map((template) => this.#toPublicPolicyTemplate(template));
  }

  createBudgetPool({
    name,
    owner,
    total_budget_cents: providedTotalBudgetCents,
    max_run_budget_cents: providedMaxRunBudgetCents = null,
    approval_required_cents: providedApprovalRequiredCents = null,
    policy_template_id: policyTemplateId = null
  }) {
    const policyTemplate = policyTemplateId ? this.policyTemplates.get(policyTemplateId) : null;
    if (policyTemplateId && !policyTemplate) {
      const error = new Error('policy_template_not_found');
      error.code = 'policy_template_not_found';
      throw error;
    }

    const totalBudgetCents = providedTotalBudgetCents ?? (policyTemplate ? policyTemplate.total_budget_cents : undefined);
    const maxRunBudgetCents = providedMaxRunBudgetCents ?? (policyTemplate ? policyTemplate.max_run_budget_cents : null);
    const approvalRequiredCents = providedApprovalRequiredCents ?? (policyTemplate ? policyTemplate.approval_required_cents : null);
    const hasValidMaxRunBudget = maxRunBudgetCents === null || (Number.isInteger(maxRunBudgetCents) && maxRunBudgetCents > 0);
    const hasValidApprovalThreshold = approvalRequiredCents === null || (Number.isInteger(approvalRequiredCents) && approvalRequiredCents > 0);
    const approvalWithinBudget = approvalRequiredCents === null || approvalRequiredCents <= totalBudgetCents;
    const approvalWithinRunBudget = maxRunBudgetCents === null || approvalRequiredCents === null || approvalRequiredCents <= maxRunBudgetCents;
    if (!name || !owner || !Number.isInteger(totalBudgetCents) || totalBudgetCents <= 0 || !hasValidMaxRunBudget || !hasValidApprovalThreshold || !approvalWithinBudget || !approvalWithinRunBudget) {
      const error = new Error('invalid_budget_pool');
      error.code = 'invalid_budget_pool';
      throw error;
    }

    const pool = {
      pool_id: `pool_${randomUUID()}`,
      name,
      owner,
      policy_template_id: policyTemplateId,
      total_budget_cents: totalBudgetCents,
      remaining_budget_cents: totalBudgetCents,
      reserved_budget_cents: 0,
      spent_budget_cents: 0,
      max_run_budget_cents: maxRunBudgetCents,
      approval_required_cents: approvalRequiredCents,
      created_at: new Date().toISOString(),
      created_sequence: ++this.budgetPoolSequence
    };

    this.budgetPools.set(pool.pool_id, pool);
    this.recordEvent('budget_pool.created', {
      resource_id: pool.pool_id,
      owner: pool.owner,
      policy_template_id: pool.policy_template_id,
      total_budget_cents: pool.total_budget_cents,
      remaining_budget_cents: pool.remaining_budget_cents,
      max_run_budget_cents: pool.max_run_budget_cents,
      approval_required_cents: pool.approval_required_cents
    });
    return this.#toPublicBudgetPool(pool);
  }

  getBudgetPool(poolId) {
    const pool = this.budgetPools.get(poolId);
    if (!pool) {
      return null;
    }

    return this.#toPublicBudgetPool(pool);
  }

  #buildRunCounts(runs) {
    return {
      total: runs.length,
      reserved: runs.filter((run) => run.status === 'reserved').length,
      settled: runs.filter((run) => run.status === 'settled').length,
      cancelled: runs.filter((run) => run.status === 'cancelled').length
    };
  }

  #buildApprovalRequestCounts(approvalRequests) {
    return {
      total: approvalRequests.length,
      pending_approval: approvalRequests.filter((approvalRequest) => approvalRequest.status === 'pending_approval').length,
      approved: approvalRequests.filter((approvalRequest) => approvalRequest.status === 'approved').length,
      rejected: approvalRequests.filter((approvalRequest) => approvalRequest.status === 'rejected').length
    };
  }

  #buildRunTotals(runs) {
    return runs.reduce((summary, run) => ({
      requested_cents: summary.requested_cents + run.reserved_cents,
      actual_cost_cents: summary.actual_cost_cents + run.actual_cost_cents,
      released_cents: summary.released_cents + run.released_cents,
      open_reserved_cents: summary.open_reserved_cents + run.remaining_reserved_cents
    }), {
      requested_cents: 0,
      actual_cost_cents: 0,
      released_cents: 0,
      open_reserved_cents: 0
    });
  }

  #buildBudgetTotals(pools) {
    return pools.reduce((summary, pool) => ({
      total_budget_cents: summary.total_budget_cents + pool.total_budget_cents,
      remaining_budget_cents: summary.remaining_budget_cents + pool.remaining_budget_cents,
      reserved_budget_cents: summary.reserved_budget_cents + pool.reserved_budget_cents,
      spent_budget_cents: summary.spent_budget_cents + pool.spent_budget_cents
    }), {
      total_budget_cents: 0,
      remaining_budget_cents: 0,
      reserved_budget_cents: 0,
      spent_budget_cents: 0
    });
  }

  #toPublicApprovalRequest(approvalRequest) {
    if (!approvalRequest) {
      return null;
    }

    const { requested_sequence: _requestedSequence, ...publicApprovalRequest } = approvalRequest;
    return { ...publicApprovalRequest };
  }

  #sortOwnerSummaries(summaries) {
    return summaries.sort((left, right) => {
      const leftAttention = left.budget_pool_counts.needing_attention > 0 ? 1 : 0;
      const rightAttention = right.budget_pool_counts.needing_attention > 0 ? 1 : 0;
      if (leftAttention !== rightAttention) {
        return rightAttention - leftAttention;
      }

      if (left.approval_request_counts.pending_approval !== right.approval_request_counts.pending_approval) {
        return right.approval_request_counts.pending_approval - left.approval_request_counts.pending_approval;
      }

      if (left.run_totals.open_reserved_cents !== right.run_totals.open_reserved_cents) {
        return right.run_totals.open_reserved_cents - left.run_totals.open_reserved_cents;
      }

      if (left.budget_totals.spent_budget_cents !== right.budget_totals.spent_budget_cents) {
        return right.budget_totals.spent_budget_cents - left.budget_totals.spent_budget_cents;
      }

      return left.owner.localeCompare(right.owner);
    });
  }

  #sortAgentSummaries(summaries) {
    return summaries.sort((left, right) => {
      const leftAttention = left.owner_counts.needing_attention > 0 ? 1 : 0;
      const rightAttention = right.owner_counts.needing_attention > 0 ? 1 : 0;
      if (leftAttention !== rightAttention) {
        return rightAttention - leftAttention;
      }

      if (left.approval_request_counts.pending_approval !== right.approval_request_counts.pending_approval) {
        return right.approval_request_counts.pending_approval - left.approval_request_counts.pending_approval;
      }

      if (left.run_totals.open_reserved_cents !== right.run_totals.open_reserved_cents) {
        return right.run_totals.open_reserved_cents - left.run_totals.open_reserved_cents;
      }

      if (left.budget_totals.spent_budget_cents !== right.budget_totals.spent_budget_cents) {
        return right.budget_totals.spent_budget_cents - left.budget_totals.spent_budget_cents;
      }

      return left.agent.localeCompare(right.agent);
    });
  }

  #sortBudgetPoolSummaries(summaries) {
    return summaries.sort((left, right) => {
      const leftAttention = left.attention_reasons.length > 0 ? 1 : 0;
      const rightAttention = right.attention_reasons.length > 0 ? 1 : 0;
      if (leftAttention !== rightAttention) {
        return rightAttention - leftAttention;
      }

      if (left.approval_request_counts.pending_approval !== right.approval_request_counts.pending_approval) {
        return right.approval_request_counts.pending_approval - left.approval_request_counts.pending_approval;
      }

      if (left.totals.open_reserved_cents !== right.totals.open_reserved_cents) {
        return right.totals.open_reserved_cents - left.totals.open_reserved_cents;
      }

      if (left.burn_rate_percent !== right.burn_rate_percent) {
        return right.burn_rate_percent - left.burn_rate_percent;
      }

      if (left.budget_pool.owner !== right.budget_pool.owner) {
        return left.budget_pool.owner.localeCompare(right.budget_pool.owner);
      }

      return left.budget_pool.name.localeCompare(right.budget_pool.name);
    });
  }

  #buildBudgetPoolSummary(pool, { runs, approvalRequests }) {
    const runCounts = this.#buildRunCounts(runs);
    const approvalRequestCounts = this.#buildApprovalRequestCounts(approvalRequests);
    const totals = this.#buildRunTotals(runs);
    const budgetPool = this.#toPublicBudgetPool(pool);
    const attentionReasons = [];
    const burnRate = pool.total_budget_cents > 0
      ? Number(((pool.spent_budget_cents / pool.total_budget_cents) * 100).toFixed(1))
      : 0;

    if (approvalRequestCounts.pending_approval > 0) {
      attentionReasons.push('pending_approvals');
    }
    if (totals.open_reserved_cents > 0) {
      attentionReasons.push('active_reservations');
    }
    if (pool.remaining_budget_cents <= Math.floor(pool.total_budget_cents * 0.2)) {
      attentionReasons.push('low_remaining_budget');
    }

    return {
      budget_pool: budgetPool,
      run_counts: runCounts,
      approval_request_counts: approvalRequestCounts,
      totals,
      latest_run: runs[0] ? this.#toPublicRun(runs[0]) : null,
      latest_approval_request: this.#toPublicApprovalRequest(approvalRequests[0]),
      burn_rate_percent: burnRate,
      attention_reasons: attentionReasons
    };
  }

  #buildOwnerSummary({ owner, pools, runs, approvalRequests }) {
    if (!owner || pools.length === 0) {
      return null;
    }

    const poolSummaries = pools.map((pool) => this.#buildBudgetPoolSummary(pool, {
      runs: runs.filter((run) => run.budget_pool_id === pool.pool_id),
      approvalRequests: approvalRequests.filter((approvalRequest) => approvalRequest.budget_pool_id === pool.pool_id)
    }));
    const attentionPools = poolSummaries.filter((summary) => summary.attention_reasons.length > 0);

    return {
      owner,
      budget_pool_counts: {
        total: pools.length,
        needing_attention: attentionPools.length
      },
      budget_totals: this.#buildBudgetTotals(pools),
      run_counts: this.#buildRunCounts(runs),
      approval_request_counts: this.#buildApprovalRequestCounts(approvalRequests),
      run_totals: this.#buildRunTotals(runs),
      latest_budget_pool: this.#toPublicBudgetPool(pools[0]),
      latest_run: runs[0] ? this.#toPublicRun(runs[0]) : null,
      latest_approval_request: this.#toPublicApprovalRequest(approvalRequests[0]),
      attention_pools: attentionPools,
      budget_pools: poolSummaries
    };
  }

  getBudgetPoolSummary(poolId) {
    const pool = this.budgetPools.get(poolId);
    if (!pool) {
      return null;
    }

    const runs = Array.from(this.runs.values())
      .filter((run) => run.budget_pool_id === pool.pool_id)
      .sort((left, right) => right.created_sequence - left.created_sequence);
    const approvalRequests = Array.from(this.approvalRequests.values())
      .filter((approvalRequest) => approvalRequest.budget_pool_id === pool.pool_id)
      .sort((left, right) => right.requested_sequence - left.requested_sequence);

    return this.#buildBudgetPoolSummary(pool, { runs, approvalRequests });
  }

  listBudgetPoolSummaries({ owner = null, attentionOnly = false } = {}) {
    const summaries = this.#sortBudgetPoolSummaries(
      Array.from(this.budgetPools.values())
        .filter((pool) => (owner ? pool.owner === owner : true))
        .map((pool) => this.getBudgetPoolSummary(pool.pool_id))
        .filter(Boolean)
    );

    return attentionOnly
      ? summaries.filter((summary) => summary.attention_reasons.length > 0)
      : summaries;
  }

  getBudgetPoolPortfolioSummary({ owner = null, attentionOnly = false } = {}) {
    const budgetPoolSummaries = this.listBudgetPoolSummaries({ owner, attentionOnly });
    const pools = budgetPoolSummaries
      .map((summary) => this.budgetPools.get(summary.budget_pool.pool_id))
      .filter(Boolean);
    const attentionPools = budgetPoolSummaries.filter((summary) => summary.attention_reasons.length > 0);

    return {
      owner,
      budget_pool_counts: {
        total: budgetPoolSummaries.length,
        needing_attention: attentionPools.length
      },
      budget_totals: this.#buildBudgetTotals(pools),
      run_counts: budgetPoolSummaries.reduce((summary, budgetPoolSummary) => ({
        total: summary.total + budgetPoolSummary.run_counts.total,
        reserved: summary.reserved + budgetPoolSummary.run_counts.reserved,
        settled: summary.settled + budgetPoolSummary.run_counts.settled,
        cancelled: summary.cancelled + budgetPoolSummary.run_counts.cancelled
      }), {
        total: 0,
        reserved: 0,
        settled: 0,
        cancelled: 0
      }),
      approval_request_counts: budgetPoolSummaries.reduce((summary, budgetPoolSummary) => ({
        total: summary.total + budgetPoolSummary.approval_request_counts.total,
        pending_approval: summary.pending_approval + budgetPoolSummary.approval_request_counts.pending_approval,
        approved: summary.approved + budgetPoolSummary.approval_request_counts.approved,
        rejected: summary.rejected + budgetPoolSummary.approval_request_counts.rejected
      }), {
        total: 0,
        pending_approval: 0,
        approved: 0,
        rejected: 0
      }),
      run_totals: budgetPoolSummaries.reduce((summary, budgetPoolSummary) => ({
        requested_cents: summary.requested_cents + budgetPoolSummary.totals.requested_cents,
        actual_cost_cents: summary.actual_cost_cents + budgetPoolSummary.totals.actual_cost_cents,
        released_cents: summary.released_cents + budgetPoolSummary.totals.released_cents,
        open_reserved_cents: summary.open_reserved_cents + budgetPoolSummary.totals.open_reserved_cents
      }), {
        requested_cents: 0,
        actual_cost_cents: 0,
        released_cents: 0,
        open_reserved_cents: 0
      }),
      latest_budget_pool_summary: budgetPoolSummaries[0] ?? null,
      attention_pools: attentionPools,
      budget_pools: budgetPoolSummaries
    };
  }

  getOwnerSummary(owner) {
    if (!owner) {
      return null;
    }

    const pools = Array.from(this.budgetPools.values())
      .filter((pool) => pool.owner === owner)
      .sort((left, right) => right.created_sequence - left.created_sequence);

    if (pools.length === 0) {
      return null;
    }

    const poolIds = new Set(pools.map((pool) => pool.pool_id));
    const runs = Array.from(this.runs.values())
      .filter((run) => run.budget_pool_id && poolIds.has(run.budget_pool_id))
      .sort((left, right) => right.created_sequence - left.created_sequence);
    const approvalRequests = Array.from(this.approvalRequests.values())
      .filter((approvalRequest) => approvalRequest.budget_pool_id && poolIds.has(approvalRequest.budget_pool_id))
      .sort((left, right) => right.requested_sequence - left.requested_sequence);

    return this.#buildOwnerSummary({ owner, pools, runs, approvalRequests });
  }

  listOwnerSummaries({ attentionOnly = false } = {}) {
    const owners = Array.from(new Set(Array.from(this.budgetPools.values()).map((pool) => pool.owner)));
    const summaries = this.#sortOwnerSummaries(owners
      .map((owner) => this.getOwnerSummary(owner))
      .filter(Boolean));

    return attentionOnly
      ? summaries.filter((summary) => summary.budget_pool_counts.needing_attention > 0)
      : summaries;
  }

  getOwnerPortfolioSummary({ attentionOnly = false } = {}) {
    const ownerSummaries = this.listOwnerSummaries({ attentionOnly });
    const attentionOwners = ownerSummaries.filter((summary) => summary.budget_pool_counts.needing_attention > 0);
    const poolIds = new Set(ownerSummaries.flatMap((ownerSummary) => ownerSummary.budget_pools.map((poolSummary) => poolSummary.budget_pool.pool_id)));
    const pools = Array.from(poolIds)
      .map((poolId) => this.budgetPools.get(poolId))
      .filter(Boolean);

    return {
      owner_counts: {
        total: ownerSummaries.length,
        needing_attention: attentionOwners.length
      },
      budget_totals: this.#buildBudgetTotals(pools),
      run_counts: ownerSummaries.reduce((summary, ownerSummary) => ({
        total: summary.total + ownerSummary.run_counts.total,
        reserved: summary.reserved + ownerSummary.run_counts.reserved,
        settled: summary.settled + ownerSummary.run_counts.settled,
        cancelled: summary.cancelled + ownerSummary.run_counts.cancelled
      }), {
        total: 0,
        reserved: 0,
        settled: 0,
        cancelled: 0
      }),
      approval_request_counts: ownerSummaries.reduce((summary, ownerSummary) => ({
        total: summary.total + ownerSummary.approval_request_counts.total,
        pending_approval: summary.pending_approval + ownerSummary.approval_request_counts.pending_approval,
        approved: summary.approved + ownerSummary.approval_request_counts.approved,
        rejected: summary.rejected + ownerSummary.approval_request_counts.rejected
      }), {
        total: 0,
        pending_approval: 0,
        approved: 0,
        rejected: 0
      }),
      run_totals: ownerSummaries.reduce((summary, ownerSummary) => ({
        requested_cents: summary.requested_cents + ownerSummary.run_totals.requested_cents,
        actual_cost_cents: summary.actual_cost_cents + ownerSummary.run_totals.actual_cost_cents,
        released_cents: summary.released_cents + ownerSummary.run_totals.released_cents,
        open_reserved_cents: summary.open_reserved_cents + ownerSummary.run_totals.open_reserved_cents
      }), {
        requested_cents: 0,
        actual_cost_cents: 0,
        released_cents: 0,
        open_reserved_cents: 0
      }),
      latest_owner_summary: ownerSummaries[0] ?? null,
      attention_owners: attentionOwners,
      owners: ownerSummaries
    };
  }

  getAgentSummary(agent) {
    if (!agent) {
      return null;
    }

    const runs = Array.from(this.runs.values())
      .filter((run) => run.agent === agent)
      .sort((left, right) => right.created_sequence - left.created_sequence);
    const approvalRequests = Array.from(this.approvalRequests.values())
      .filter((approvalRequest) => approvalRequest.agent === agent)
      .sort((left, right) => right.requested_sequence - left.requested_sequence);

    if (runs.length === 0 && approvalRequests.length === 0) {
      return null;
    }

    const poolIds = new Set([
      ...runs.map((run) => run.budget_pool_id),
      ...approvalRequests.map((approvalRequest) => approvalRequest.budget_pool_id)
    ].filter(Boolean));
    const pools = Array.from(poolIds)
      .map((poolId) => this.budgetPools.get(poolId))
      .filter(Boolean)
      .sort((left, right) => right.created_sequence - left.created_sequence);
    const owners = Array.from(new Set(pools.map((pool) => pool.owner)));
    const ownerSummaries = this.#sortOwnerSummaries(owners
      .map((owner) => {
        const ownerPools = pools.filter((pool) => pool.owner === owner);
        const ownerPoolIds = new Set(ownerPools.map((pool) => pool.pool_id));
        return this.#buildOwnerSummary({
          owner,
          pools: ownerPools,
          runs: runs.filter((run) => run.budget_pool_id && ownerPoolIds.has(run.budget_pool_id)),
          approvalRequests: approvalRequests.filter((approvalRequest) => approvalRequest.budget_pool_id && ownerPoolIds.has(approvalRequest.budget_pool_id))
        });
      })
      .filter(Boolean));
    const attentionOwners = ownerSummaries.filter((summary) => summary.budget_pool_counts.needing_attention > 0);

    return {
      agent,
      owner_counts: {
        total: ownerSummaries.length,
        needing_attention: attentionOwners.length
      },
      budget_totals: this.#buildBudgetTotals(pools),
      run_counts: this.#buildRunCounts(runs),
      approval_request_counts: this.#buildApprovalRequestCounts(approvalRequests),
      run_totals: this.#buildRunTotals(runs),
      latest_owner_summary: ownerSummaries[0] ?? null,
      latest_run: runs[0] ? this.#toPublicRun(runs[0]) : null,
      latest_approval_request: this.#toPublicApprovalRequest(approvalRequests[0]),
      attention_owners: attentionOwners,
      owners: ownerSummaries
    };
  }

  listAgentSummaries({ attentionOnly = false } = {}) {
    const agents = Array.from(new Set([
      ...Array.from(this.runs.values()).map((run) => run.agent),
      ...Array.from(this.approvalRequests.values()).map((approvalRequest) => approvalRequest.agent)
    ]));
    const summaries = this.#sortAgentSummaries(agents
      .map((agent) => this.getAgentSummary(agent))
      .filter(Boolean));

    return attentionOnly
      ? summaries.filter((summary) => summary.owner_counts.needing_attention > 0)
      : summaries;
  }

  getAgentPortfolioSummary({ attentionOnly = false } = {}) {
    const agentSummaries = this.listAgentSummaries({ attentionOnly });
    const attentionAgents = agentSummaries.filter((summary) => summary.owner_counts.needing_attention > 0);
    const poolIds = new Set(agentSummaries.flatMap((agentSummary) => agentSummary.owners.flatMap((ownerSummary) => ownerSummary.budget_pools.map((poolSummary) => poolSummary.budget_pool.pool_id))));
    const pools = Array.from(poolIds)
      .map((poolId) => this.budgetPools.get(poolId))
      .filter(Boolean);

    return {
      agent_counts: {
        total: agentSummaries.length,
        needing_attention: attentionAgents.length
      },
      budget_totals: this.#buildBudgetTotals(pools),
      run_counts: agentSummaries.reduce((summary, agentSummary) => ({
        total: summary.total + agentSummary.run_counts.total,
        reserved: summary.reserved + agentSummary.run_counts.reserved,
        settled: summary.settled + agentSummary.run_counts.settled,
        cancelled: summary.cancelled + agentSummary.run_counts.cancelled
      }), {
        total: 0,
        reserved: 0,
        settled: 0,
        cancelled: 0
      }),
      approval_request_counts: agentSummaries.reduce((summary, agentSummary) => ({
        total: summary.total + agentSummary.approval_request_counts.total,
        pending_approval: summary.pending_approval + agentSummary.approval_request_counts.pending_approval,
        approved: summary.approved + agentSummary.approval_request_counts.approved,
        rejected: summary.rejected + agentSummary.approval_request_counts.rejected
      }), {
        total: 0,
        pending_approval: 0,
        approved: 0,
        rejected: 0
      }),
      run_totals: agentSummaries.reduce((summary, agentSummary) => ({
        requested_cents: summary.requested_cents + agentSummary.run_totals.requested_cents,
        actual_cost_cents: summary.actual_cost_cents + agentSummary.run_totals.actual_cost_cents,
        released_cents: summary.released_cents + agentSummary.run_totals.released_cents,
        open_reserved_cents: summary.open_reserved_cents + agentSummary.run_totals.open_reserved_cents
      }), {
        requested_cents: 0,
        actual_cost_cents: 0,
        released_cents: 0,
        open_reserved_cents: 0
      }),
      latest_agent_summary: agentSummaries[0] ?? null,
      attention_agents: attentionAgents,
      agents: agentSummaries
    };
  }

  listBudgetPools({ owner = null } = {}) {
    return Array.from(this.budgetPools.values())
      .filter((pool) => (owner ? pool.owner === owner : true))
      .sort((left, right) => right.created_sequence - left.created_sequence)
      .map((pool) => this.#toPublicBudgetPool(pool));
  }

  reserveRun({
    agent,
    task,
    budget_cents: budgetCents,
    budget_pool_id: budgetPoolId = null,
    request_approval_on_block: requestApprovalOnBlock = false
  }) {
    const { pool, approvalBlock } = this.#validateRunReservation({ agent, task, budgetCents, budgetPoolId });

    if (approvalBlock) {
      if (!requestApprovalOnBlock) {
        const error = new Error('approval_required');
        error.code = 'approval_required';
        error.details = approvalBlock;
        throw error;
      }

      return this.#createApprovalRequest({
        agent,
        task,
        budgetCents,
        budgetPoolId,
        approvalRequiredCents: approvalBlock.approval_required_cents
      });
    }

    return this.#createReservedRun({ agent, task, budgetCents, budgetPoolId, pool });
  }

  getApprovalRequest(approvalRequestId) {
    const approvalRequest = this.approvalRequests.get(approvalRequestId);
    return approvalRequest ? { ...approvalRequest } : null;
  }

  listApprovalRequests({ status = null, owner = null, budgetPoolId = null } = {}) {
    return Array.from(this.approvalRequests.values())
      .filter((approvalRequest) => (status ? approvalRequest.status === status : true))
      .filter((approvalRequest) => (budgetPoolId ? approvalRequest.budget_pool_id === budgetPoolId : true))
      .filter((approvalRequest) => {
        if (!owner) {
          return true;
        }

        if (!approvalRequest.budget_pool_id) {
          return false;
        }

        const pool = this.budgetPools.get(approvalRequest.budget_pool_id);
        return pool ? pool.owner === owner : false;
      })
      .sort((left, right) => right.requested_sequence - left.requested_sequence)
      .map(({ requested_sequence: _requestedSequence, ...approvalRequest }) => ({ ...approvalRequest }));
  }

  decideApprovalRequest(approvalRequestId, { decision, decided_by: decidedBy }) {
    const approvalRequest = this.approvalRequests.get(approvalRequestId);
    if (!approvalRequest) {
      const error = new Error('approval_request_not_found');
      error.code = 'approval_request_not_found';
      throw error;
    }

    if (approvalRequest.status !== 'pending_approval') {
      const error = new Error('approval_request_not_actionable');
      error.code = 'approval_request_not_actionable';
      throw error;
    }

    if (!decidedBy || !['approved', 'rejected'].includes(decision)) {
      const error = new Error('invalid_approval_decision');
      error.code = 'invalid_approval_decision';
      throw error;
    }

    approvalRequest.status = decision;
    approvalRequest.decided_by = decidedBy;
    approvalRequest.decided_at = new Date().toISOString();

    if (decision === 'approved') {
      const pool = approvalRequest.budget_pool_id ? this.budgetPools.get(approvalRequest.budget_pool_id) : null;
      const run = this.#createReservedRun({
        agent: approvalRequest.agent,
        task: approvalRequest.task,
        budgetCents: approvalRequest.requested_budget_cents,
        budgetPoolId: approvalRequest.budget_pool_id,
        pool,
        approvalRequestId: approvalRequest.approval_request_id,
        approvedBy: decidedBy
      });
      approvalRequest.run_id = run.run_id;
      this.recordEvent('approval_request.approved', {
        resource_id: approvalRequest.approval_request_id,
        budget_pool_id: approvalRequest.budget_pool_id,
        requested_budget_cents: approvalRequest.requested_budget_cents,
        decided_by: decidedBy,
        run_id: run.run_id
      });
      return run;
    }

    this.recordEvent('approval_request.rejected', {
      resource_id: approvalRequest.approval_request_id,
      budget_pool_id: approvalRequest.budget_pool_id,
      requested_budget_cents: approvalRequest.requested_budget_cents,
      decided_by: decidedBy
    });
    return { ...approvalRequest };
  }

  #validateRunReservation({ agent, task, budgetCents, budgetPoolId }) {
    if (!agent || !task || !Number.isInteger(budgetCents) || budgetCents <= 0) {
      const error = new Error('invalid_run');
      error.code = 'invalid_run';
      throw error;
    }

    let pool = null;
    if (budgetPoolId !== null) {
      pool = this.budgetPools.get(budgetPoolId);
      if (!pool) {
        const error = new Error('budget_pool_not_found');
        error.code = 'budget_pool_not_found';
        throw error;
      }

      if (pool.max_run_budget_cents !== null && budgetCents > pool.max_run_budget_cents) {
        const error = new Error('budget_pool_limit_exceeded');
        error.code = 'budget_pool_limit_exceeded';
        error.details = {
          budget_pool_id: budgetPoolId,
          max_run_budget_cents: pool.max_run_budget_cents,
          requested_budget_cents: budgetCents
        };
        throw error;
      }

      if (budgetCents > pool.remaining_budget_cents) {
        const error = new Error('budget_pool_exhausted');
        error.code = 'budget_pool_exhausted';
        error.details = {
          budget_pool_id: budgetPoolId,
          remaining_budget_cents: pool.remaining_budget_cents,
          requested_budget_cents: budgetCents
        };
        throw error;
      }

      if (pool.approval_required_cents !== null && budgetCents > pool.approval_required_cents) {
        return {
          pool,
          approvalBlock: {
            budget_pool_id: budgetPoolId,
            approval_required_cents: pool.approval_required_cents,
            requested_budget_cents: budgetCents
          }
        };
      }
    }

    return { pool, approvalBlock: null };
  }

  #createApprovalRequest({ agent, task, budgetCents, budgetPoolId, approvalRequiredCents }) {
    const approvalRequest = {
      approval_request_id: `approval_${randomUUID()}`,
      status: 'pending_approval',
      agent,
      task,
      budget_pool_id: budgetPoolId,
      requested_budget_cents: budgetCents,
      approval_required_cents: approvalRequiredCents,
      requested_at: new Date().toISOString(),
      requested_sequence: ++this.approvalRequestSequence
    };

    this.approvalRequests.set(approvalRequest.approval_request_id, approvalRequest);
    this.recordEvent('approval_request.created', {
      resource_id: approvalRequest.approval_request_id,
      budget_pool_id: approvalRequest.budget_pool_id,
      requested_budget_cents: approvalRequest.requested_budget_cents,
      approval_required_cents: approvalRequest.approval_required_cents,
      agent: approvalRequest.agent,
      task: approvalRequest.task
    });

    return { ...approvalRequest };
  }

  #createReservedRun({ agent, task, budgetCents, budgetPoolId, pool = null, approvalRequestId = null, approvedBy = null }) {
    const run = {
      run_id: `run_${randomUUID()}`,
      agent,
      task,
      budget_pool_id: budgetPoolId,
      approval_request_id: approvalRequestId,
      approved_by: approvedBy,
      status: 'reserved',
      reserved_cents: budgetCents,
      remaining_reserved_cents: budgetCents,
      actual_cost_cents: 0,
      released_cents: 0,
      created_at: new Date().toISOString(),
      created_sequence: ++this.runSequence
    };

    if (pool) {
      pool.remaining_budget_cents -= budgetCents;
      pool.reserved_budget_cents += budgetCents;
    }

    this.runs.set(run.run_id, run);
    this.recordEvent('run.reserved', {
      resource_id: run.run_id,
      agent: run.agent,
      task: run.task,
      budget_pool_id: run.budget_pool_id,
      approval_request_id: run.approval_request_id,
      reserved_cents: run.reserved_cents,
      remaining_reserved_cents: run.remaining_reserved_cents
    });
    return this.#toPublicRun(run);
  }

  #toPublicRun(run) {
    const { created_sequence: _createdSequence, ...publicRun } = run;
    return { ...publicRun };
  }

  getRun(runId) {
    const run = this.runs.get(runId);
    return run ? this.#toPublicRun(run) : null;
  }

  listRuns({ status = null, agent = null, budgetPoolId = null } = {}) {
    return Array.from(this.runs.values())
      .filter((run) => (status ? run.status === status : true))
      .filter((run) => (agent ? run.agent === agent : true))
      .filter((run) => (budgetPoolId ? run.budget_pool_id === budgetPoolId : true))
      .sort((left, right) => right.created_sequence - left.created_sequence)
      .map((run) => this.#toPublicRun(run));
  }

  cancelRun(runId, reason) {
    const run = this.runs.get(runId);
    if (!run) {
      const error = new Error('run_not_found');
      error.code = 'run_not_found';
      throw error;
    }

    if (run.status !== 'reserved' || !reason) {
      const error = new Error('invalid_cancellation');
      error.code = 'invalid_cancellation';
      throw error;
    }

    run.status = 'cancelled';
    run.actual_cost_cents = 0;
    run.released_cents = run.remaining_reserved_cents;
    run.remaining_reserved_cents = 0;
    run.cancellation_reason = reason;
    run.cancelled_at = new Date().toISOString();

    if (run.budget_pool_id) {
      const pool = this.budgetPools.get(run.budget_pool_id);
      if (pool) {
        pool.reserved_budget_cents -= run.reserved_cents;
        pool.remaining_budget_cents += run.released_cents;
      }
    }

    this.recordEvent('run.cancelled', {
      resource_id: run.run_id,
      agent: run.agent,
      task: run.task,
      budget_pool_id: run.budget_pool_id,
      reserved_cents: run.reserved_cents,
      released_cents: run.released_cents,
      cancellation_reason: run.cancellation_reason
    });

    return { ...run };
  }

  settleRun(runId, actualCostCents) {
    const run = this.runs.get(runId);
    if (!run) {
      const error = new Error('run_not_found');
      error.code = 'run_not_found';
      throw error;
    }

    if (run.status !== 'reserved') {
      const error = new Error('run_not_settleable');
      error.code = 'run_not_settleable';
      throw error;
    }

    if (!Number.isInteger(actualCostCents) || actualCostCents < 0) {
      const error = new Error('invalid_settlement');
      error.code = 'invalid_settlement';
      throw error;
    }

    if (actualCostCents > run.reserved_cents) {
      const error = new Error('budget_exceeded');
      error.code = 'budget_exceeded';
      error.details = {
        reserved_cents: run.reserved_cents,
        actual_cost_cents: actualCostCents
      };
      throw error;
    }

    run.status = 'settled';
    run.actual_cost_cents = actualCostCents;
    run.released_cents = run.reserved_cents - actualCostCents;
    run.remaining_reserved_cents = 0;
    run.settled_at = new Date().toISOString();

    if (run.budget_pool_id) {
      const pool = this.budgetPools.get(run.budget_pool_id);
      if (pool) {
        pool.reserved_budget_cents -= run.reserved_cents;
        pool.remaining_budget_cents += run.released_cents;
        pool.spent_budget_cents += actualCostCents;
      }
    }

    this.recordEvent('run.settled', {
      resource_id: run.run_id,
      agent: run.agent,
      task: run.task,
      budget_pool_id: run.budget_pool_id,
      actual_cost_cents: run.actual_cost_cents,
      released_cents: run.released_cents,
      reserved_cents: run.reserved_cents
    });

    return { ...run };
  }
}

module.exports = {
  RunStore
};