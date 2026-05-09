# RunCycles

RunCycles is a local-first budget guard for agent execution loops. It reserves budget before work starts, commits only the amount actually spent, and releases the remainder when a run is cancelled.

The current MVP includes two local execution surfaces:

- a tiny Node HTTP API for reserving run budgets, enforcing pool policies, and handling approval workflows
- a file-backed Python ledger CLI for simple local budgeting experiments

## Node API

Start the local API:

```bash
npm start
```

Core endpoints:

- `POST /runs` — reserve budget before an agent/tool cycle starts
- `GET /runs` — list reserved/settled/cancelled runs newest-first, with optional `?status=...`, `?agent=...`, or `?budget_pool_id=...` filters
- `POST /runs/:id/settlements` — commit actual spend and release leftover budget
- `POST /runs/:id/cancellations` — cancel a reserved run and restore its held budget to the pool
- `GET /runs/:id` — inspect a single run
- `POST /budget-pools` / `GET /budget-pools/:id` — manage project/team budget pools
- `GET /budget-pools/:id/summary` — inspect pool health, run totals, spend/release aggregates, and approval backlog
- `GET /budget-pools/summary` — inspect cross-pool attention queues across the workspace, with optional `?owner=...` and `?attention_only=true`
- `GET /owners/:owner/summary` — inspect aggregate health across all pools owned by one team/person, including per-pool burn rate and attention queues
- `GET /owners/summary` — inspect cross-owner attention queues across the whole budget portfolio, with optional `?attention_only=true`
- `GET /agents/:agent/summary` — inspect one agent’s cross-owner budget footprint, including owner-level attention queues for the pools that agent touched
- `GET /agents/summary` — inspect cross-agent attention queues across the workspace, with optional `?attention_only=true`
- `GET /budget-pools?owner=...` — list budget pools newest-first, optionally filtered by owner
- `POST /policy-templates` / `GET /policy-templates/:id` — reuse policy defaults
- `GET /policy-templates?owner=...` — list policy templates newest-first, optionally filtered by owner
- `POST /approval-requests/:id/decisions` — approve or reject blocked runs
- `GET /approval-requests` — review the approval inbox, optionally filtered with `?status=...`, `?owner=...`, or `?budget_pool_id=...`
- `GET /events?resource_id=...` — inspect lifecycle events for runs, pools, and approvals
- `GET /events?type=...&budget_pool_id=...&owner=...&agent=...` — narrow the lifecycle feed for inbox-style reviews and webhook consumers

Example approval inbox flow:

```bash
curl -s http://127.0.0.1:4327/approval-requests?status=pending_approval
curl -s http://127.0.0.1:4327/approval-requests?owner=growth
curl -s 'http://127.0.0.1:4327/approval-requests?status=pending_approval&budget_pool_id=pool_123'
curl -s http://127.0.0.1:4327/policy-templates?owner=docs
curl -s http://127.0.0.1:4327/budget-pools?owner=growth
curl -s http://127.0.0.1:4327/budget-pools/pool_123/summary
curl -s http://127.0.0.1:4327/budget-pools/summary
curl -s 'http://127.0.0.1:4327/budget-pools/summary?owner=docs&attention_only=true'
curl -s http://127.0.0.1:4327/owners/docs/summary
curl -s http://127.0.0.1:4327/owners/summary
curl -s 'http://127.0.0.1:4327/owners/summary?attention_only=true'
curl -s http://127.0.0.1:4327/agents/codex/summary
curl -s http://127.0.0.1:4327/agents/summary
curl -s 'http://127.0.0.1:4327/agents/summary?attention_only=true'
curl -s http://127.0.0.1:4327/runs?status=settled&agent=codex
curl -s 'http://127.0.0.1:4327/events?type=run.settled&budget_pool_id=pool_123'
curl -s http://127.0.0.1:4327/events?owner=docs
curl -s http://127.0.0.1:4327/events?agent=hermes
```

Owner summaries now include `attention_pools` plus a full `budget_pools` breakdown so one response can answer which pools are blocked on approvals, carrying live reservations, or burning through budget fastest. Cross-owner portfolio summaries add `attention_owners` plus an ordered `owners` queue so operators can scan the whole workspace budget portfolio in one request. Agent summaries mirror that shape with `attention_owners` per agent and a top-level `agents` portfolio queue so operators can quickly see which agent loops are currently holding budget, waiting on approvals, or touching the hottest pools. Pool portfolio summaries now fill the gap between those layers with `GET /budget-pools/summary`, returning an ordered `attention_pools` queue and full `budget_pools` breakdown across the whole workspace or one owner slice.

## Python ledger CLI

```bash
python3 -m runcycles reserve --state ./budget.json --run-id run-123 --task "triage CI" --limit 25 --requested 7.5
python3 -m runcycles commit --state ./budget.json --reservation <id> --actual 5.25
python3 -m runcycles release --state ./budget.json --reservation <id> --reason "operator aborted"
python3 -m runcycles summary --state ./budget.json --run-id run-123
```

## Tests

```bash
npm test
python3 -m unittest discover -s tests -v
```
