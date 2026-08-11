# WebSG Custom — CMS IP Allowlist Self-Service API

Backend for the tenant self-service portal: tenants submit the list of IP addresses that
may reach their CMS, and the platform applies that list to the shared AWS WAF IPSet
without a service request.

**[ARCHITECTURE.md](ARCHITECTURE.md)** walks the whole system and gives a runnable `curl`
for every scenario it handles — shared IPSets, per-tenant IPSets, admin reassignment,
concurrent edits, rejected input, manual WAF edits, sync failures and onboarding.

## Approach

```
[ Portal ] ──> [ Allowlist API ] ──1. save tenant IPs──> [ DynamoDB table ]
                (Fastify, EKS)                                  │
                                                                ▼ 2. change data capture
                                                        [ DynamoDB Stream ]
                                                                │
                                                                ▼ 3. managed hop, no glue code
                                                       [ EventBridge Pipe ]
                                                                │
                                                                ▼ 4. serialises + retries
                                                        [ SQS FIFO queue ] ──> [ DLQ ]
                                                                │
                                                                ▼ 5. triggers worker
                                                       [ WAF Sync Lambda ]
                                                                │
                                                                ▼ 6. reconciles state
                                                          [ AWS WAF v2 ]
```

The API never calls WAF. It only owns the *desired state* in DynamoDB; the stream is the
change-data-capture event and the Lambda is the single writer to WAF. That split gives:

- **Fast, safe writes** — the API returns as soon as the record is durable. WAF throttling
  or a `WAFOptimisticLockException` never surfaces to a tenant.
- **Idempotent reconciliation** — the Lambda ignores the message contents and rebuilds the
  IPSet from a strongly consistent full table read. Retries, redeliveries and duplicate
  events all converge to the same result, and a drifted IPSet self-heals on the next write.
- **Serialised by the queue** — the FIFO queue uses a single message group, so concurrent
  tenant edits are applied one at a time. See
  [concurrent triggers](terraform/README.md#concurrent-triggers).
- **A replayable DLQ** — a permanently failed message is parked with its payload intact and
  can be redriven back to the source queue with one API call.
- **One writer, one audit trail** — every WAF change is attributable to a DynamoDB record
  with `updatedBy` and `updatedAt`.

## Layout

```
backend/                        Fastify + TypeScript API (pod on the CMS EKS cluster)
├── src/
│   ├── config/                 env loading, policy limits, fail-fast boot validation
│   ├── lib/                    framework-free logic: cidr validation, jwt, domain errors
│   ├── plugins/                cross-cutting Fastify wiring: auth, errors, OpenAPI docs
│   ├── routes/                 health probes
│   ├── modules/ip-allowlist/   the feature: routes → service → repository + schemas
│   ├── app.ts                  composition root (dependencies injected, no globals)
│   └── server.ts               process concerns: listen, signals, shutdown
├── test/
│   ├── unit/                   pure logic and the service layer
│   ├── integration/            HTTP through the real app via fastify.inject
│   └── helpers/                token signing, in-memory repository, app factory
├── Dockerfile                  multi-stage, non-root, prod deps only
└── .env.example

lambda/                         DynamoDB Streams → WAF v2 sync worker
terraform/                      main.tf + prod.tfvars + modules
iam/                            least-privilege policies (deploy role, backend)
Makefile                        state bucket, package, plan/apply, tests
.gitlab-ci.yml                  terraform plan on MR, manual apply from main
```

The layering rule is one-directional: `routes` (HTTP) → `service` (business rules) →
`repository` (AWS). `lib/` knows nothing about Fastify or the AWS SDK, which is why the
validation and service tests need no mocks or test doubles beyond an in-memory repository.
`app.ts` takes its dependencies as arguments, so tests build the same app the pod runs.

## Running locally

Requires Node 24 (`nvm use` — an `.nvmrc` is provided) and Docker for local DynamoDB.

```bash
cd backend
nvm use
npm install
cp .env.example .env      # local defaults: HS256 secret + DynamoDB on localhost:8000

npm run dev:db            # start DynamoDB Local (docker compose)
npm run dev:table         # create the table (idempotent; Terraform does this in AWS)
npm run dev               # API on http://localhost:3000, watch mode
```

**Against the real deployed table instead:** delete the three `AWS_ENDPOINT_URL` /
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` lines from `.env`, set `AWS_PROFILE` to a
profile whose credentials carry [iam/backend-api-policy.json](iam/backend-api-policy.json),
and skip `dev:db` / `dev:table`. Nothing else changes — no code branches on environment, and
a real write goes through the full pipeline, so `syncStatus` flips to `APPLIED` within
seconds.

Then, in a second terminal:

```bash
TOKEN=$(npm run token --silent)          # tenant agency-a, read + write
# npm run token -- platform admin        # ops-team token, any tenant

curl -X PUT localhost:3000/v1/tenants/agency-a/ip-allowlist \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'if-match: 0' \
  -d '{"cidrs":["203.0.113.9","198.51.100.0/24"]}'

curl localhost:3000/v1/tenants/agency-a/ip-allowlist -H "authorization: Bearer $TOKEN"
```

The write returns the stored record with `version: 1` and the normalised list
`["198.51.100.0/24","203.0.113.9/32"]`; send that version as the next `If-Match`. Swagger
UI is at <http://localhost:3000/docs>.

`.env` is read by Node's built-in `--env-file-if-exists`, so there is no dotenv dependency.
The AWS SDK picks up `AWS_ENDPOINT_URL` from it to reach DynamoDB Local — in AWS those
lines are absent and the pod uses its IRSA role instead. Stop the database with
`docker compose down`.

### Tests and checks

```bash
npm test          # 30 tests, node:test — no test framework dependency
npm run typecheck
npm run build     # emits dist/ for the container image

cd ../lambda && npm install && npm test
```

TypeScript runs directly under Node 24's built-in type stripping, so there is no `ts-node`
or bundler in the toolchain.

## API

All routes require a `Bearer` access token issued by the portal's identity provider.

### `GET /v1/tenants/{tenantId}/ip-allowlist`

```json
{ "tenantId": "agency-a", "cidrs": ["198.51.100.0/24"], "version": 3,
  "updatedAt": "2026-08-11T09:12:00.000Z", "updatedBy": "user-1" }
```

A tenant that has never submitted a list gets an empty list at `version: 0`.

### `PUT /v1/tenants/{tenantId}/ip-allowlist`

Full replacement of the list — the portal always sends the complete set, so there is no
partial-update ordering problem.

```
If-Match: 3
Content-Type: application/json

{ "cidrs": ["203.0.113.9", "198.51.100.0/24"] }
```

Responses: **`202 Accepted`** with the stored record and an `ETag` of the new version,
`400` invalid input (with a reason per rejected entry), `401` bad/missing token, `403` wrong
tenant or missing scope, `409` stale `If-Match`, `428` missing `If-Match`.

`202` rather than `200` is deliberate: the list is stored and durable, but not yet enforced.
The response carries `syncStatus: "PENDING"`; poll GET until it reads `APPLIED`, which the
sync worker sets once that exact version is live in WAF.

```json
{ "tenantId": "agency-a", "cidrs": ["198.51.100.0/24"], "version": 4,
  "syncStatus": "APPLIED", "syncedVersion": 4, "syncedAt": "2026-08-11T09:12:04.000Z" }
```

`syncStatus` is derived from `syncedVersion == version`, never stored, so it cannot drift
from the data it describes.

### Admin — `/v1/admin/...` (requires `platform:admin`)

| Route | Purpose |
| ----- | ------- |
| `GET /v1/admin/ip-set-assignments` | list every tenant → IPSet assignment |
| `GET /v1/admin/tenants/{tenantId}/ip-set` | read one assignment |
| `PUT /v1/admin/tenants/{tenantId}/ip-set` | assign or move a tenant to an IPSet |
| `DELETE /v1/admin/tenants/{tenantId}/ip-set` | detach a tenant |

Point two tenants at the same IPSet and they share it (union of their lists); give them
different IPSets for full isolation. A reassignment marks the tenant `PENDING` and triggers
the re-sync. Tenants cannot read or change this mapping — it is platform data.

### `GET /healthz`, `GET /readyz`

Unauthenticated probes for the Kubernetes deployment and ALB target group.

### Swagger UI — `GET /docs`, spec at `GET /docs/json`

The OpenAPI 3 document is generated from the same JSON schemas Fastify validates requests
against ([docs.ts](backend/src/plugins/docs.ts)), so it cannot drift from the
implementation — a route that changes its schema changes the published spec in the same
commit. Every operation carries its scope requirement, its error responses and the bearer
security scheme, so the portal team can generate a client from it.

Enabled by default outside production and controlled by `DOCS_ENABLED`. It is **off in
production**: an internal API has no reason to serve an interactive console, and the
portal team can pull the spec from CI instead. Run `DOCS_ENABLED=true npm run dev` and open
<http://localhost:3000/docs>.

## Security controls

| Control | Where |
| ------- | ----- |
| JWT verified against the Cognito JWKS, pinned issuer + audience, fixed algorithm list (never trusts the token's `alg`) | [jwt.ts](backend/src/lib/jwt.ts) |
| Scope check — `ip-allowlist:read` / `ip-allowlist:write`, `platform:admin` for the ops team | [auth.ts](backend/src/plugins/auth.ts) |
| Tenant isolation — the `tenantId` claim must match the path; cross-tenant attempts are logged and rejected with 403 | [auth.ts](backend/src/plugins/auth.ts) |
| Schema validation — types, array/string bounds, tenant id pattern, `additionalProperties: false`, 64 KB body limit | [schemas.ts](backend/src/modules/ip-allowlist/schemas.ts) |
| Semantic IP validation — canonical CIDR, host-bit check, private/loopback/link-local/CGNAT/multicast rejected, max 50 entries, ranges broader than `/24` (v4) or `/48` (v6) rejected | [cidr.ts](backend/src/lib/cidr.ts) |
| Optimistic locking — `If-Match` plus a DynamoDB conditional write, so two portal tabs cannot silently overwrite each other | [repository.ts](backend/src/modules/ip-allowlist/repository.ts) |
| Error responses never leak stack traces or AWS errors | [error-handler.ts](backend/src/plugins/error-handler.ts) |
| Break-glass CIDRs are merged into every sync, so an empty table can never lock the ops team out of the CMS | [index.ts](lambda/src/index.ts) |

Rate limiting and TLS termination are left to the API Gateway/ALB in front of the service
rather than duplicated in application code.

## Assumptions

1. **Authentication is delegated.** The portal signs users in against an existing IdP
   (assumed Cognito) and the API only *verifies* access tokens. Consequence: no session,
   password or user store in this service. Tokens carry `sub`, `tenant_id` and `scope`;
   `JWT_SECRET` with HS256 is a local/test fallback so the suite runs without network.
2. **The whitelist is shared today.** Per the brief, one IPSet is used by all tenants, so
   the Lambda writes the *union* of all tenant lists. Per-tenant records are stored from
   day one, which is what makes the future split (below) a WAF change only.
3. **The IPSet already exists in Terraform.** Nothing here provisions AWS. Terraform must
   declare the IPSet with `lifecycle { ignore_changes = [addresses] }`, otherwise the next
   `terraform apply` reverts every tenant change. Terraform owns the resource; the Lambda
   owns its contents.
4. **Eventual consistency is acceptable, and visible.** Propagation takes a few seconds. The
   write returns `202` with `syncStatus: PENDING`, and the worker flips it to `APPLIED` once
   the version is live in WAF, so the portal can show real progress instead of guessing.
5. **Scale is small.** Tens to low hundreds of tenants, so the Lambda's full-table `Scan`
   is cheaper and simpler than incremental merging, and stays far inside the 10,000-address
   WAF IPSet limit (50 entries × 200 tenants).
6. **Full-list replacement, not add/remove.** Matches how the portal UI edits a list, and
   removes the ambiguity of concurrent partial edits.
7. **Tenants may only submit public, routable ranges.** Whitelisting RFC1918 space on an
   internet-facing WAF is meaningless at best and misleading at worst, so it is rejected at
   the edge rather than silently ignored by WAF.

## Infrastructure

Terraform lives in [terraform/](terraform/): a flat root (`main.tf`, `variables.tf`,
`outputs.tf`, `terraform.tfvars`) wiring three modules. The state bucket is created by the
[Makefile](Makefile) rather than a bootstrap stack — that stack would need its own state,
which is the problem it exists to solve.

Day to day, Terraform runs in GitLab CI ([.gitlab-ci.yml](.gitlab-ci.yml)): plan on every
merge request, apply manually from `main`, credentials from GitLab OIDC — no long-lived AWS
keys. The apply consumes the reviewed plan file, so what was approved is what runs.

Bootstrap and local runs:

```bash
make state-bucket     # once per account: versioned, encrypted, public access blocked
make init
make plan             # builds the Lambda package first, uses -var-file=prod.tfvars
make apply
```

`terraform/prod.tfvars` is committed (no secrets, and CI needs it) and passed explicitly, so
a plan cannot pick up the wrong environment by accident.

| Module | Creates |
| ------ | ------- |
| `modules/tenants` | **per-tenant WAF IPSets** and the tenant→IPSet mapping table |
| `modules/dynamodb` | table, `tenantId` key, PITR, SSE, **stream enabled** (`NEW_IMAGE`) |
| `modules/queue` | **EventBridge Pipe**, **SQS FIFO queue** and its **FIFO DLQ** |
| `modules/lambda` | function, least-privilege role, event source mapping |
| `modules/monitoring` | SNS topic and the **CloudWatch alarms** |

**Onboarding a tenant is one entry in `prod.tfvars`** — no code change, no redeploy. Same
`ip_set_name` for two tenants means they share an IPSet and get the union of their lists;
different names mean full isolation. The worker groups tenants by IPSet, so shared and
per-tenant are one code path rather than two modes.

**Only the application writes IPSet addresses**, enforced in three layers: `ignore_changes =
[addresses]` stops Terraform reverting the app; a scheduled drift check re-reconciles every
15 minutes so console edits are undone; and an SCP denies `wafv2:UpdateIPSet` to everyone
but the worker role and a break-glass role. Prevent, repair, and don't self-inflict.

### Permissions

[iam/](iam/) holds two least-privilege policies: the deploy role GitLab CI assumes, and the
backend's. Both name their resources rather than using `*`. Two details worth calling out:
`iam:PassRole` is conditioned on `iam:PassedToService`, because create-a-role plus
pass-it-anywhere is a privilege-escalation path; and creating the state bucket is
deliberately outside the deploy policy, so the pipeline cannot reconfigure its own state.

The backend gets exactly `dynamodb:GetItem` and `PutItem` on one table — no `Scan`, so a
leaked local credential cannot dump every tenant's allowlist. The same policy covers the
pod's IRSA role and local development against real AWS.

Failure handling is the part worth reading. A failed run returns the batch to the queue;
after 5 deliveries SQS parks the message on the FIFO DLQ and the alarm fires. Any message
there matters, because nothing on the API side fails when sync stalls — tenants keep getting
`202`s and `syncStatus` simply stays PENDING. Recovery is a redrive
(`aws sqs start-message-move-task`), not a manual replay.
[terraform/README.md](terraform/README.md) has the runbook.

## Bonus

### Tenant-specific IP whitelists — implemented

This is built, not just proposed: `modules/tenants` creates an IPSet per tenant and the
worker reconciles each from the same table. What remains is the WAF rule side, which lives
with the CMS WebACL:

1. One rule per tenant: `Host == <tenant>.cms.websg.gov.sg AND NOT ip in <tenant IPSet>` →
   `Block`, with a default `Block` fallback. `module.tenants.ip_sets` exports the ids to
   reference.
2. WebACL rules are capped (1,500 WCU), so past roughly a hundred tenants those per-tenant
   rules move behind a **single rule backed by a Lambda@Edge / CloudFront Function** doing a
   `host + client IP` lookup against a DynamoDB or DAX-cached map — one rule, unbounded
   tenants.

Migrating a tenant off the shared IPSet is a `ip_set_name` change in `prod.tfvars`. No API
or portal contract change.

### Additional self-service setting

**HPA min/max replicas per tenant website**, which the brief lists as a common service
request. It fits the same shape — a validated, bounded value written to the same table —
but the apply path differs: Kubernetes state is GitOps-managed, so instead of a WAF call
the worker opens a **pull request against the manifests repo** (or writes to a per-tenant
values file that ArgoCD reconciles). That keeps the GitOps repo as the single source of
truth and preserves review for anything that costs money, while still removing the ticket.
Bounds (e.g. max 10 replicas) are enforced by the API against the tenant's service tier.

A lighter alternative with the same plumbing as the IP list is the **WAF rate-limit
threshold** per tenant, applied to a rate-based rule.
