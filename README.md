# WebSG Custom — CMS IP Allowlist Self-Service API

Tenants submit the IP addresses that may reach their CMS, and the platform applies that list
to their AWS WAF IPSet — no service request, no ticket.

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — a runnable `curl` per scenario.
- **[TESTING.md](TESTING.md)** — which test holds up which behaviour.
- **[terraform/README.md](terraform/README.md)** — infrastructure notes and the DLQ runbook.

## The architecture

```
                    ┌───────────────────────────────────────────┐
  portal user ─PUT─►│  Allowlist API   (Fastify, pod on EKS)    │
                    │  authenticate · validate · store          │
                    └────┬─────────────────────────┬────────────┘
     1. PutItem          │                         │  2. SendMessage
        (conditional     ▼                         │     group = tenantId
         on version) ┌─────────────────────┐       │
                     │  DynamoDB           │       │
                     │  websg-cms-allowlist│       │
                     │  PK tenantId        │       │
                     │  SK ownerId         │       │
                     └─────────────────────┘       │
                              ▲                    ▼
   sweep, every 15 min ───────┼──────────►  ┌────────────┐    ┌──────┐
   one message per tenant     │             │  SQS FIFO  │───►│ DLQ  │─► alarm ─► SNS
                              │             └─────┬──────┘    └──────┘
                    ┌─────────┴──────────────────────────────────┐
                    │  WAF Sync Lambda                           │
                    │  3. Query the partition (consistent)       │
                    │  4. UpdateIPSet · write syncedVersion back │
                    └──────┬──────────────────────┬──────────────┘
                           ▼                      ▼
                   ┌──────────────┐      ┌──────────────┐
                   │ IPSet        │      │ IPSet        │
                   │ tenant-a     │      │ tenant-shared│
                   │ (A)          │      │ (C ∪ D)      │
                   └──────────────┘      └──────────────┘
```

**The API never calls WAF.** It owns *desired state* in DynamoDB; the Lambda is the single
writer to WAF. Everything below follows from that split.

## How it works

| # | Step | Where |
| - | ---- | ----- |
| 1 | `PutItem`, conditional on `version`. **Durable here** — nothing in WAF yet | [repository.ts](backend/src/modules/ip-allowlist/repository.ts) |
| 2 | `SendMessage` with `MessageGroupId = tenantId`. The body is a signal, carrying no list data | [notifier.ts](backend/src/modules/ip-allowlist/notifier.ts) |
| 3 | Lambda `Query`s that one partition with `ConsistentRead`, unions every member's cidrs with the break-glass ranges | [index.ts](lambda/src/index.ts) |
| 4 | `UpdateIPSet`, then `syncedVersion` written back onto the item | [index.ts](lambda/src/index.ts) |
| 5 | The still-open request sees `syncedVersion == version` → **200 `APPLIED`**. If `SYNC_WAIT_MS` (15s) elapses first → **202 `PENDING`** | [service.ts](backend/src/modules/ip-allowlist/service.ts) |

The 15 seconds is a *wait budget*, not a delay: the caller normally gets a definitive `200`
in the same request rather than polling. The whole path takes seconds.

## The pieces

### DynamoDB — the desired state

One table, `websg-cms-allowlist`, one item per user:

```json
{ "tenantId": "tenant-a",   "ownerId": "user-a",
  "cidrs": ["198.51.100.0/24", "203.0.113.9/32"],
  "version": 3,  "updatedAt": "2026-08-11T09:12:00.000Z",
  "syncedVersion": 3, "syncedAt": "2026-08-11T09:12:04.000Z" }
```

| Field | Does |
| ----- | ---- |
| `tenantId` (PK) | A tenant is **one partition**, so the worker reads it with a `Query` bounded by that tenant's member count, never a `Scan` of the platform. |
| `ownerId` (SK) | Members of a shared tenant are **separate items**; the worker applies their union. Sharing an IPSet is a config choice, not a second code path. |
| `version` | The optimistic lock. `If-Match` becomes the DynamoDB condition, so a lost update is impossible rather than unlikely. |
| `syncedVersion` | Written **only** by the worker, after WAF accepts the change. `syncStatus` is *derived* from `syncedVersion == version`, never stored, so it cannot drift from the data it describes. |

A write is a `PutItem` that replaces the whole item, dropping `syncedVersion` — so a new
version starts `PENDING` by construction, not by a flag someone has to remember to clear.

The API has `GetItem` and `PutItem` only — **no `Query`, no `Scan`** — so a leaked credential
cannot enumerate another user's allowlist, let alone the whole platform's.

### SQS FIFO — the mutex

The queue is not transport; the API could invoke the Lambda directly. It is here because
`MessageGroupId` is the **tenant** on every producer, and FIFO allows one in-flight batch per
group. So:

- Two members of one tenant saving at once **reconcile in sequence**, never as two concurrent
  writers to one IPSet, so `WAFOptimisticLockException` cannot arise between two edits.
- Different tenants proceed in parallel.
- The 15-minute sweep is grouped the same way, so it queues *behind* a tenant's edits instead
  of colliding with them.
- `MessageDeduplicationId` is `tenant:owner:version` — per logical edit, so an SDK retry
  collapses to one message while a genuine second edit is never swallowed by the 5-minute
  dedup window.
- A permanently failed message parks on the **DLQ** with its payload intact and is replayed
  with one `start-message-move-task` call.

### The Lambda — the single writer

It **ignores the message contents** and rebuilds the IPSet from the table. That one decision
is what makes retries, redeliveries, duplicate messages and scheduled sweeps all converge on
the same result, and lets a drifted IPSet self-heal.

On failure it returns **only the failed tenants' message ids**
(`ReportBatchItemFailures`), so one tenant's WAF problem does not tick nine healthy tenants
toward the DLQ threshold.

### The 15-minute sweep

EventBridge `rate(15 minutes)` puts one message per tenant on the same queue. The worker
cannot tell it from an edit — same rebuild, same code path. It closes three gaps:

| Gap | Why the sweep covers it |
| --- | ----------------------- |
| The write and the send are **not atomic** | If the pod dies between `PutItem` and `SendMessage`, the edit is durable but unsignalled. 15 minutes bounds that, and it reads `PENDING` throughout. |
| **Drift** | A console edit is reverted, because desired state is the table, not WAF. |
| **Silent divergence** | Any partial failure the DLQ alarm would not catch self-heals. |

If the IPSet already matches, the worker skips the WAF write entirely — a quiet platform
costs nothing.

### Break-glass

`break_glass_cidrs` ([prod.tfvars](terraform/prod.tfvars)) is merged into **every** IPSet on
every sync, so an empty table can never lock the ops team out of the CMS. It is validated as
IPv4 because the IPSets are; a v6 range would apply cleanly in Terraform and then fail every
`UpdateIPSet`. A break-glass role is also exempt from the SCP that denies manual IPSet edits:
if the sync path is broken *and* the allowlist is wrong, someone still needs a way in.

### Why no stream or Pipe

Change-data-capture earns its place when you do not control the writer. Here the API is the
only writer and already knows the tenant id, so it sends the signal itself — removing a Pipe
per tenant, its IAM role, and the filter that stopped the worker's own acknowledgements
re-triggering it. The cost is the non-atomic write/send above, which the sweep bounds.

## Assumptions

| # | Assumption | Why |
| - | ---------- | --- |
| 1 | **Authentication is delegated.** | The portal signs users in against an IdP; this API only *verifies*. The HS256 secret and in-repo directory stand in for that — swapping in JWKS is a change to [jwt.ts](backend/src/lib/jwt.ts) alone. |
| 2 | **A user owns one list; a tenant owns one IPSet.** | Agencies sharing an IPSet share a tenant key as separate items; isolated agencies get their own key. One code path, not two modes. |
| 3 | **Terraform owns the IPSet; the app owns its addresses.** | `ignore_changes = [addresses]` — without it the next apply empties every IPSet and locks tenants out until the next sync. |
| 4 | **Eventual consistency is acceptable, and visible.** | The response says `APPLIED` or `PENDING` rather than implying enforcement it cannot confirm. |
| 5 | **Rebuild beats merge.** | Simpler and idempotent, bounded by tenant size not platform size. A tenant stays far inside WAF's 10,000-address limit (50 × 200 users). |
| 6 | **Full-list replacement, not add/remove.** | Matches how the portal edits a list, and removes the ambiguity of concurrent partial edits. |
| 7 | **Only public, routable ranges.** | Allowlisting RFC1918 space on an internet-facing WAF is meaningless at best, so it is rejected at the edge rather than silently ignored by WAF. |

### 8. IPv4 only — IPv6 is rejected, not ignored

WAF IPSets are **single-family**, and the ones this platform provisions are `IPV4`. A v6
range would be stored, reported `PENDING`, and never go live — the API promising something
the infrastructure cannot deliver. So it is a `400` with its own reason string, distinct from
"not a valid IP", because a typo and an unsupported address family are different problems for
the caller:

```json
{ "error": "Invalid IP allowlist",
  "reasons": ["\"2001:db8::/48\": IPv6 is not supported, use an IPv4 address or CIDR"] }
```

Supporting it properly is three changes, none of them large: a **second IPSet per tenant**
(`IPV6` scope) in `modules/waf_ip_sets`, **family routing** in the worker so each address
lands in the matching set, and **both sets referenced** from the CMS WebACL rule. The API
change is one branch in [cidr.ts](backend/src/lib/cidr.ts) — `isIPv6` is already detected
there, it just refuses instead of dispatching. Until the WebACL side exists, rejecting is the
honest answer.

## Running it

There is **no local DynamoDB**: `terraform apply` → outputs → `.env` → run the API. A write
then goes through the whole pipeline and flips to `APPLIED` within seconds. Needs Node 24
(`nvm use`), Terraform ≥ 1.10, and AWS credentials.

```bash
# 1. Infrastructure. Edit terraform/prod.tfvars first: your tenants, real
#    break-glass ranges, a real alert address.
make state-bucket     # once per account, as an administrator
make init && make plan && make apply

# 2. Config
cd backend && nvm use && npm install && cp .env.example .env
terraform -chdir=../terraform output -raw table_name        # → TABLE_NAME
terraform -chdir=../terraform output -raw sync_queue_url    # → SYNC_QUEUE_URL
terraform -chdir=../terraform output -raw region            # → AWS_REGION

# 3. Run
npm run dev           # http://localhost:3000
```

Set `JWT_SECRET` to any non-empty string — the API refuses to boot without it. Use
`AWS_PROFILE` rather than putting keys in `.env`; those credentials need
[iam/backend-api-policy.json](iam/backend-api-policy.json). Everything else in `.env.example`
has a working default.

`make apply` creates the table, one IPSet per tenant, the FIFO queue and DLQ, the Lambda, the
drift schedule and the alarms. `make state-bucket` needs `s3:CreateBucket`, deliberately
outside the deploy policy.

### Using it

Users come from [src/config/users.ts](backend/src/config/users.ts) — `user-a`/`tenant-a`,
`user-b`/`tenant-b`, and `user-c`+`user-d` sharing `tenant-shared`. The token proves who you
are; the directory decides which tenant you own, so a forged claim cannot reach another
tenant.

```bash
export API=http://localhost:3000
export TOKEN=$(npm run token --silent -- user-a)   # run inside backend/

curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN"

curl -isX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'if-match: 0' -d '{"cidrs":["203.0.113.9","198.51.100.0/24"]}'
```

That returns `version: 1`, the normalised list `["198.51.100.0/24","203.0.113.9/32"]`, and an
`ETag` to use as the next `If-Match`.

**Adding or removing one IP** is a read, an edit, and a full `PUT` (assumption 6) — recipes
in [TESTING.md](TESTING.md#adding-and-removing-one-ip), which also covers the one trap:
removal is by exact string and the stored form is normalised, so subtracting `203.0.113.9`
from a list holding `203.0.113.9/32` removes nothing while still succeeding.

### Tests

```bash
make test                          # both suites, no AWS credentials, no server
cd backend && npm test             # 39 tests, node:test
cd ../lambda && npm test           # 19 tests
```

TypeScript runs under Node 24's type stripping — no `ts-node`, no bundler.

## API

Every `/v1` route needs a `Bearer` token. **No tenant or user id appears in any path**, so
cross-tenant access is impossible rather than merely rejected.

**`GET /v1/allowlist`** returns the caller's own record (see the DynamoDB item above, plus
`syncStatus`). A user who has never written gets an empty list at `version: 0`.

**`PUT /v1/allowlist`** is a full replacement. `If-Match` is mandatory — the version you last
read, or `0` for a list that does not exist yet.

| Code | Meaning |
| ---- | ------- |
| `200` | stored **and** confirmed live in WAF — `syncStatus: "APPLIED"` |
| `202` | stored and durable, not yet confirmed — `PENDING`, poll `GET` |
| `400` | invalid input, with a reason per rejected entry |
| `401` | bad or missing token, or a user not in the directory |
| `409` | stale `If-Match` — someone else wrote since you read |
| `428` | missing `If-Match` |

**`GET /healthz`, `GET /readyz`** — unauthenticated probes for Kubernetes and the ALB.

## Layout

```
backend/       Fastify + TypeScript API (pod on the CMS EKS cluster)
  src/config/                 env loading, policy limits, the user directory
  src/lib/                    framework-free: cidr validation, jwt, domain errors
  src/plugins/                cross-cutting Fastify wiring: auth, error mapping
  src/modules/ip-allowlist/   the feature: routes → service → repository
  src/app.ts                  composition root (dependencies injected, no globals)
lambda/        SQS → WAF v2 sync worker
terraform/     main.tf + prod.tfvars + five modules
iam/           least-privilege policies (deploy role, backend, SCP)
```

Layering is one-directional: `routes` (HTTP) → `service` (rules) → `repository` (AWS). `lib/`
knows nothing about Fastify or the AWS SDK, which is why its tests need no mocks. `app.ts`
takes dependencies as arguments, so tests build the app the pod runs.

## Security

| Control | Where |
| ------- | ----- |
| JWT verified with pinned issuer, audience and a fixed algorithm list — never trusts the token's `alg` | [jwt.ts](backend/src/lib/jwt.ts) |
| Tenant resolved from the server-side directory, never from a token claim | [users.ts](backend/src/config/users.ts) |
| No id in any route — a cross-tenant request cannot be expressed | [routes.ts](backend/src/modules/ip-allowlist/routes.ts) |
| Schema validation — types, bounds, `additionalProperties: false`, 64 KB body limit | [schemas.ts](backend/src/modules/ip-allowlist/schemas.ts) |
| Semantic IP validation — canonical CIDR, host-bit check, private/loopback/link-local/CGNAT/multicast rejected, max 50 entries, nothing broader than `/24` | [cidr.ts](backend/src/lib/cidr.ts) |
| Optimistic locking — `If-Match` plus a conditional write | [repository.ts](backend/src/modules/ip-allowlist/repository.ts) |
| Errors never leak stack traces or AWS errors | [error-handler.ts](backend/src/plugins/error-handler.ts) |
| SSE, PITR and deletion protection on the table; queue and topic encrypted | [terraform/modules/](terraform/modules/) |

Rate limiting and TLS termination belong to the ALB in front, not duplicated in application
code.

**Only the application writes IPSet addresses**, in three layers: `ignore_changes` stops
Terraform reverting the app, the 15-minute sweep undoes console edits, and an SCP denies
`wafv2:UpdateIPSet` to everyone but the worker and break-glass roles. Prevent, repair, and
don't self-inflict. Policies and the reasoning are in [iam/](iam/).

**Onboarding a tenant is one entry in `prod.tfvars`** — no code change, no redeploy, no new
table. Terraform renders the worker's `TENANTS` variable.

## Bonus

### 1. Tenant-specific IP allowlists — implemented

Not a proposal: `modules/waf_ip_sets` already creates an IPSet per tenant and the worker
reconciles each from its own partition. Both shapes work today and are the same code path:

| Shape | Config | Result |
| ----- | ------ | ------ |
| Dedicated | one tenant key per agency | full isolation; A's ranges never touch B's IPSet |
| Shared | several agencies on one tenant key | one IPSet holding the union; each still edits only its own list |

What remains is the WAF rule side, which lives with the CMS WebACL:

1. One rule per tenant — `Host == <tenant>.cms.websg.gov.sg AND NOT ip in <tenant IPSet>` →
   `Block`, with a default `Block` fallback. The `ip_sets` output exports the ids.
2. WebACL rules are capped at 1,500 WCU, so past roughly a hundred tenants those per-tenant
   rules move behind a **single rule backed by a CloudFront Function / Lambda@Edge** doing a
   `host + client IP` lookup against a DynamoDB or DAX-cached map — one rule, unbounded
   tenants.

Moving an agency between shared and dedicated is a `prod.tfvars` change plus moving its item.
No API or portal contract change.

### 2. A second self-service setting — HPA replicas

**Min/max replicas per tenant website.** Same shape as the IP list — a validated, bounded
value written to the same table, same `version` lock, same `PENDING`/`APPLIED` reporting — so
the API, the queue and the status model are reused unchanged. Only the *apply* step differs:

| | IP allowlist | HPA replicas |
| - | ------------ | ------------ |
| Stored | `cidrs: string[]` | `{ minReplicas, maxReplicas }` |
| Validated against | public routable IPv4, ≤ 50 entries, ≥ `/24` | the tenant's service tier (e.g. max 10) |
| Applied by | `wafv2:UpdateIPSet` | a **pull request against the GitOps manifests repo** |
| Live when | WAF accepts the update | ArgoCD syncs the merged PR |

The apply path is a PR rather than a direct write because Kubernetes state is GitOps-managed:
writing to the cluster behind ArgoCD's back would be reverted on the next reconcile, and it
would move the source of truth out of the repo. A PR keeps the repo authoritative and
preserves review for anything that costs money, while still removing the ticket. The tenant
sees `PENDING` until the PR merges, which is honest — the change genuinely is not live yet.

A lighter alternative with *exactly* the same plumbing as the IP list is the **WAF rate-limit
threshold** per tenant, applied to a rate-based rule: one more `UpdateWebACL` call in the same
worker, no new apply path at all.
