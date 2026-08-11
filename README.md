# WebSG Custom — CMS IP Allowlist Self-Service API

Backend for the tenant self-service portal: tenants submit the list of IP addresses that
may reach their CMS, and the platform applies that list to their AWS WAF IPSet without a
service request.

**[ARCHITECTURE.md](ARCHITECTURE.md)** walks the whole system and gives a runnable `curl`
for every scenario it handles — shared IPSets, per-tenant IPSets, concurrent edits,
rejected input, manual WAF edits, sync failures and onboarding.
**[TESTING.md](TESTING.md)** maps the test suites to those behaviours.

## Approach

```
[ Portal ] ──> [ Allowlist API ] ──1. save the user's IPs──> [ DynamoDB table ]
                (Fastify, EKS)                                  │  one per tenant
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

- **Fast, safe writes** — the record is durable the moment it is stored. WAF throttling or a
  `WAFOptimisticLockException` never surfaces to a tenant.
- **Idempotent reconciliation** — the Lambda ignores the message contents and rebuilds the
  IPSet from a strongly consistent full table read. Retries, redeliveries and duplicate
  events all converge to the same result, and a drifted IPSet self-heals.
- **Serialised where it matters** — the FIFO queue groups by the list owner, so one user's
  edits stay ordered while other tenants reconcile in parallel.
- **A replayable DLQ** — a permanently failed message is parked with its payload intact and
  can be redriven back to the source queue with one API call.
- **One writer, one audit trail** — every WAF change is attributable to a DynamoDB record
  with its `ownerId`, `version` and `updatedAt`.

## Layout

```
backend/                        Fastify + TypeScript API (pod on the CMS EKS cluster)
├── src/
│   ├── config/                 env loading, policy limits, the user directory
│   ├── lib/                    framework-free logic: cidr validation, jwt, domain errors
│   ├── plugins/                cross-cutting Fastify wiring: auth, error mapping
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

lambda/                         SQS → WAF v2 sync worker
terraform/                      main.tf + prod.tfvars + five modules
iam/                            least-privilege policies (deploy role, backend, SCP)
Makefile                        state bucket, package, plan/apply, tests
.gitlab-ci.yml                  terraform plan on MR, manual apply from main
```

The layering rule is one-directional: `routes` (HTTP) → `service` (business rules) →
`repository` (AWS). `lib/` knows nothing about Fastify or the AWS SDK, which is why the
validation and service tests need no mocks beyond an in-memory repository. `app.ts` takes
its dependencies as arguments, so tests build the same app the pod runs.

## Running it

There is **no local DynamoDB**. The API talks to the real tables, so the order is:
`terraform apply` → read the outputs → put them in `.env` → run the API. A write then goes
through the whole pipeline and `syncStatus` flips to `APPLIED` within seconds, which is the
only way to see the system actually work.

You need Node 24 (`nvm use` — an `.nvmrc` is provided), Terraform ≥ 1.10, and AWS
credentials for an account you may create resources in.

### 1. Apply the infrastructure

Edit [terraform/prod.tfvars](terraform/prod.tfvars) first — the tenants you want, your real
break-glass ranges and a real alert address — then:

```bash
make state-bucket     # once per account: versioned, encrypted, public access blocked
make init
make plan             # builds the Lambda package first, uses -var-file=prod.tfvars
make apply
```

This creates one DynamoDB table and one WAF IPSet per tenant (both named
`websg-cms-allowlist-<tenant>`), the Pipes, the FIFO queue and DLQ, the sync Lambda, the
drift-check schedule and the alarms. `make state-bucket` needs `s3:CreateBucket`, which is
deliberately outside the deploy policy — run it once as an administrator.

If you use your own state bucket, set `bucket` in the backend block of
[terraform/providers.tf](terraform/providers.tf) and `STATE_BUCKET` in the
[Makefile](Makefile) before `make init`.

### 2. Fill `.env` from the outputs

```bash
cd backend
nvm use
npm install
cp .env.example .env
```

Then read the two values the API needs out of Terraform and put them in `.env`:

```bash
terraform -chdir=../terraform output -raw table_prefix   # → TABLE_PREFIX
terraform -chdir=../terraform output -raw region         # → AWS_REGION
```

Also set `JWT_SECRET` to any non-empty string — it signs and verifies the local access
tokens, and the API refuses to boot without it. Set `AWS_PROFILE` if the credentials you
want are not in your default profile; the SDK reads `~/.aws/credentials`, so never put keys
in `.env`. Those credentials need [iam/backend-api-policy.json](iam/backend-api-policy.json)
(`GetItem` + `PutItem` on `websg-cms-allowlist-*`).

Everything else in `.env.example` has a working default.

### 3. Run the API

```bash
npm run dev           # http://localhost:3000, watch mode
```

In a second terminal — `cd backend` again, since `npm run token` needs the package
scripts — mint a token and use it. Users come from
[src/config/users.ts](backend/src/config/users.ts) — the token proves who you are, the
directory decides which tenant you own, so a forged claim cannot reach another tenant:

| User | Tenant | Note |
| ---- | ------ | ---- |
| `user-a` | `tenant-a` | own table, own IPSet |
| `user-b` | `tenant-b` | own table, own IPSet |
| `user-c` | `tenant-shared` | shares a table and IPSet with `user-d` |
| `user-d` | `tenant-shared` | shares a table and IPSet with `user-c` |

```bash
export API=http://localhost:3000
export TOKEN=$(npm run token --silent -- user-a)

# Read the current list (a new user gets an empty list at version 0)
curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN"

# Replace it. If-Match carries the version you last read - 0 here because the
# list above is new. It is required on every PUT; without it the answer is 428.
curl -isX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'if-match: 0' \
  -d '{"cidrs":["203.0.113.9","198.51.100.0/24"]}'
```

If `$TOKEN` is empty the API answers `{"error":"missing bearer token"}` — that means
`npm run token` ran outside `backend/`, not that the token was rejected.

The write returns the stored record with `version: 1` and the normalised list
`["198.51.100.0/24","203.0.113.9/32"]`, plus an `ETag` header carrying the new version —
send that as the next `If-Match`, so a write never needs a re-read:

```bash
V=$(curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN" | jq -r .version)
curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "if-match: $V" -d '{"cidrs":["203.0.113.0/24"]}'
```

### 4. Check the scenarios

[ARCHITECTURE.md](ARCHITECTURE.md) has a copy-pasteable walkthrough for each behaviour worth
proving: shared vs per-tenant IPSets, waiting for a change to go live, concurrent edits,
rejected input, tenant isolation, a manual WAF edit being reverted, a failed sync, and
onboarding a tenant. Run them against the server from step 3.

To confirm a change really landed in WAF:

```bash
aws wafv2 get-ip-set --scope REGIONAL \
  --name websg-cms-allowlist-tenant-a \
  --id $(terraform -chdir=terraform output -json ip_sets | \
         jq -r '."websg-cms-allowlist-tenant-a".id')
```

### Tests and checks

The suites need no AWS credentials and no running server — the backend uses an in-memory
repository and the Lambda stubs the SDK transport. **[TESTING.md](TESTING.md)** maps every
test to the behaviour it holds up, split into separate-IPSet isolation and shared-IPSet
union, and is honest about what sharing an IPSet costs you.

```bash
make test                      # both suites

cd backend && npm test         # 33 tests, node:test - no test framework dependency
npm run typecheck
npm run build                  # emits dist/ for the container image

cd ../lambda && npm test       # 12 tests
```

TypeScript runs directly under Node 24's built-in type stripping, so there is no `ts-node`
or bundler in the toolchain.

## API

Every route under `/v1` requires a `Bearer` token. **There is no tenant or user id in any
path** — a caller only ever addresses its own list, so cross-tenant access is impossible
rather than merely rejected.

### `GET /v1/allowlist`

```json
{ "ownerId": "user-a", "tenantId": "tenant-a", "cidrs": ["198.51.100.0/24"],
  "version": 3, "updatedAt": "2026-08-11T09:12:00.000Z",
  "syncStatus": "APPLIED", "syncedVersion": 3, "syncedAt": "2026-08-11T09:12:04.000Z" }
```

A user who has never submitted a list gets an empty list at `version: 0`.

### `PUT /v1/allowlist`

Full replacement — the portal always sends the complete set, so there is no partial-update
ordering problem.

```
If-Match: 3
Content-Type: application/json

{ "cidrs": ["203.0.113.9", "198.51.100.0/24"] }
```

`If-Match` is mandatory — there is no unconditional write. It must be a non-negative
integer: the version you last read, or `0` for the first write to a list that does not
exist yet. The value becomes the DynamoDB condition on the write
([repository.ts](backend/src/modules/ip-allowlist/repository.ts)), which is what makes a
lost update impossible rather than merely unlikely.

Responses:

| Code | Meaning |
| ---- | ------- |
| `200` | stored **and** confirmed live in WAF — `syncStatus: "APPLIED"` |
| `202` | stored and durable, not yet confirmed — `syncStatus: "PENDING"`, poll `GET` |
| `400` | invalid input, with a reason per rejected entry |
| `401` | bad or missing token, or a user not in the directory |
| `409` | stale `If-Match` — someone else wrote since you read |
| `428` | missing `If-Match` |

The write waits up to `SYNC_WAIT_MS` (15s) for the worker's acknowledgement so the caller
usually gets a definitive `200` instead of having to poll. If the window elapses the answer
is honestly `202`; the write is durable either way. `syncStatus` is derived from
`syncedVersion == version`, never stored, so it cannot drift from the data it describes.

### `GET /healthz`, `GET /readyz`

Unauthenticated probes for the Kubernetes deployment and ALB target group.

## Security controls

| Control | Where |
| ------- | ----- |
| JWT verified with a pinned issuer, audience and a fixed algorithm list — never trusts the token header's `alg` | [jwt.ts](backend/src/lib/jwt.ts) |
| The tenant comes from the server-side directory, never from a token claim | [users.ts](backend/src/config/users.ts) |
| No id in any route — a caller cannot even express a cross-tenant request | [routes.ts](backend/src/modules/ip-allowlist/routes.ts) |
| Schema validation — types, array/string bounds, `additionalProperties: false`, 64 KB body limit | [schemas.ts](backend/src/modules/ip-allowlist/schemas.ts) |
| Semantic IP validation — canonical CIDR, host-bit check, private/loopback/link-local/CGNAT/multicast rejected, max 50 entries, ranges broader than `/24` (v4) or `/48` (v6) rejected | [cidr.ts](backend/src/lib/cidr.ts) |
| Optimistic locking — `If-Match` plus a DynamoDB conditional write, so two portal tabs cannot silently overwrite each other | [repository.ts](backend/src/modules/ip-allowlist/repository.ts) |
| Error responses never leak stack traces or AWS errors | [error-handler.ts](backend/src/plugins/error-handler.ts) |
| Break-glass CIDRs merged into every sync, so an empty table can never lock the ops team out | [index.ts](lambda/src/index.ts) |
| Tables have SSE, PITR and deletion protection; the queue and SNS topic are encrypted | [terraform/modules/](terraform/modules/) |

Rate limiting and TLS termination are left to the API Gateway/ALB in front of the service
rather than duplicated in application code.

## Assumptions

1. **Authentication is delegated.** In production the portal signs users in against an
   existing IdP and this API only *verifies* tokens — no session, password or user store
   here. The HS256 secret and the in-repo user directory stand in for that IdP so the whole
   thing runs and tests without one; swapping in JWKS verification is a change to
   [jwt.ts](backend/src/lib/jwt.ts) alone.
2. **A user owns one list; a tenant owns one IPSet.** Agencies that must share an IPSet
   share a tenant key and are separate items in that tenant's table — the worker applies the
   union. Agencies that must be isolated get their own tenant key. Shared and per-tenant are
   one code path, not two modes.
3. **Terraform owns the IPSet resource; the application owns its addresses.**
   `ignore_changes = [addresses]` is what makes that safe — without it the next
   `terraform apply` empties every IPSet and locks tenants out until the next sync.
4. **Eventual consistency is acceptable, and visible.** Propagation takes seconds. The
   response says `APPLIED` or `PENDING` rather than implying enforcement it cannot confirm.
5. **Scale is small.** Tens to low hundreds of tenants, so the worker's full-table `Scan` is
   cheaper and simpler than incremental merging, and stays far inside the 10,000-address WAF
   IPSet limit (50 entries × 200 users).
6. **Full-list replacement, not add/remove.** Matches how the portal UI edits a list, and
   removes the ambiguity of concurrent partial edits.
7. **Tenants may only submit public, routable ranges.** Allowlisting RFC1918 space on an
   internet-facing WAF is meaningless at best and misleading at worst, so it is rejected at
   the edge rather than silently ignored by WAF.

## Infrastructure

Terraform lives in [terraform/](terraform/): a flat root (`main.tf`, `variables.tf`,
`outputs.tf`, `providers.tf`) wiring five modules. The state bucket is created by the
[Makefile](Makefile) rather than a bootstrap stack — that stack would need its own state,
which is the problem it exists to solve.

Day to day, Terraform runs in GitLab CI ([.gitlab-ci.yml](.gitlab-ci.yml)): plan on every
merge request, apply manually from `main`, credentials from GitLab OIDC — no long-lived AWS
keys. The apply consumes the reviewed plan file, so what was approved is what runs.

| Module | Creates |
| ------ | ------- |
| `modules/dynamodb` | one tenant's table — `ownerId` key, PITR, SSE, **stream** (`NEW_IMAGE`) |
| `modules/waf_ip_sets` | one **WAF IPSet** per tenant, addresses ignored |
| `modules/queue` | one **EventBridge Pipe** per stream, the **SQS FIFO queue**, its **DLQ**, the drift-check schedule |
| `modules/lambda` | the function, its least-privilege role, the event source mapping |
| `modules/monitoring` | SNS topic and the **CloudWatch alarms** |

**Onboarding a tenant is one entry in `prod.tfvars`** — no code change, no redeploy. The
worker reads the tenant → table → IPSet mapping from its `TENANTS` environment variable,
which Terraform renders.

**Only the application writes IPSet addresses**, enforced in three layers:
`ignore_changes = [addresses]` stops Terraform reverting the app; a scheduled drift check
re-reconciles every 15 minutes so console edits are undone; and an SCP denies
`wafv2:UpdateIPSet` to everyone but the worker role and a break-glass role. Prevent, repair,
and don't self-inflict.

[terraform/README.md](terraform/README.md) has the design notes and the DLQ runbook.

### Permissions

[iam/](iam/) holds three least-privilege policies: the deploy role GitLab CI assumes, the
backend's, and the SCP above. All name their resources rather than using `*`. Two details
worth calling out: `iam:PassRole` is conditioned on `iam:PassedToService`, because
create-a-role plus pass-it-anywhere is a privilege-escalation path; and creating the state
bucket is deliberately outside the deploy policy, so the pipeline cannot reconfigure its own
state.

The backend gets exactly `dynamodb:GetItem` and `PutItem` — no `Scan`, so a leaked local
credential cannot dump every user's allowlist. The same policy covers the pod's IRSA role
and local development.

Failure handling is the part worth reading. A failed run returns the batch to the queue;
after 5 deliveries SQS parks the message on the FIFO DLQ and the alarm fires. Any message
there matters, because **nothing on the API side fails when sync stalls** — tenants keep
getting successful writes and `syncStatus` simply stays `PENDING`. Recovery is a redrive
(`aws sqs start-message-move-task`), not a manual replay.

## Bonus

### Tenant-specific IP allowlists — implemented

This is built, not just proposed: `modules/waf_ip_sets` creates an IPSet per tenant and the
worker reconciles each from that tenant's own table. What remains is the WAF rule side,
which lives with the CMS WebACL:

1. One rule per tenant: `Host == <tenant>.cms.websg.gov.sg AND NOT ip in <tenant IPSet>` →
   `Block`, with a default `Block` fallback. The `ip_sets` output exports the ids to
   reference.
2. WebACL rules are capped (1,500 WCU), so past roughly a hundred tenants those per-tenant
   rules move behind a **single rule backed by a Lambda@Edge / CloudFront Function** doing a
   `host + client IP` lookup against a DynamoDB or DAX-cached map — one rule, unbounded
   tenants.

Moving an agency between a shared and a dedicated IPSet is a `prod.tfvars` change plus
moving its item. No API or portal contract change.

### Additional self-service setting

**HPA min/max replicas per tenant website**, which the brief lists as a common service
request. It fits the same shape — a validated, bounded value written to the same table — but
the apply path differs: Kubernetes state is GitOps-managed, so instead of a WAF call the
worker opens a **pull request against the manifests repo** (or writes a per-tenant values
file that ArgoCD reconciles). That keeps the GitOps repo as the single source of truth and
preserves review for anything that costs money, while still removing the ticket. Bounds
(e.g. max 10 replicas) are enforced by the API against the tenant's service tier.

A lighter alternative with exactly the same plumbing as the IP list is the **WAF rate-limit
threshold** per tenant, applied to a rate-based rule.
