# Infrastructure

```
API (SendMessage, group = tenantId) -> SQS FIFO -> Lambda -> that tenant's IPSet
             schedule (drift, one message per tenant) ->  |
                                                          +-> DLQ -> alarm -> SNS
```

```
terraform/
├── providers.tf             required versions, the AWS provider, the S3 backend
├── main.tf                  the five modules wired together
├── variables.tf
├── outputs.tf
├── prod.tfvars              the tenants, break-glass ranges and alert addresses
└── modules/
    ├── dynamodb/            the allowlist table (one, for every tenant)
    ├── waf_ip_sets/         one IPSet per tenant
    ├── queue/               FIFO queue + FIFO DLQ + the drift-check schedule
    ├── lambda/              function + IAM + event source mapping
    └── monitoring/          SNS topic + CloudWatch alarms
```

One table for the platform, `PK = tenantId` / `SK = ownerId`, so the worker reads a tenant
with a `Query` on one partition. Each tenant's IPSet is `websg-cms-allowlist-<key>`.

The state bucket is created by the root Makefile, not Terraform — a bootstrap stack would
need its own state, which is the problem it is trying to solve.

## Apply

Day to day this runs in GitLab CI ([.gitlab-ci.yml](../.gitlab-ci.yml)): plan on every MR,
apply manually from `main`, credentials from GitLab OIDC. The pipeline applies the reviewed
plan file, so what was approved is what runs.

Locally, or for the first bootstrap:

```bash
make state-bucket              # once per account, as an administrator
make init
make plan                      # runs `make package`, uses -var-file=prod.tfvars
make apply
```

Before the first apply, edit `prod.tfvars` (real break-glass ranges, real alert addresses)
and set `bucket` in the backend block of `providers.tf`.

- `prod.tfvars` is committed — no secrets, and CI needs it. It is passed explicitly rather
  than auto-loaded, so a plan cannot pick up the wrong environment by accident.
- `make package` builds `lambda/build`, which `archive_file` zips at plan time. It runs
  before plan and apply automatically, because a stale package means Terraform sees no code
  change and silently deploys the old function.
- Deploy-role permissions: [iam/terraform-deploy-policy.json](../iam/README.md). Creating the
  state bucket is outside it — the pipeline should not reconfigure its own state.

## Why a queue between the API and the function

Not transport — the API could invoke the function directly. The queue is a **mutex**, and it
buys three things:

- **One writer per IPSet.** `MessageGroupId` is the tenant on every producer, and Lambda
  scales FIFO by group with one in-flight batch each. Two members of a tenant saving at once
  reconcile in sequence; different tenants proceed in parallel.
- **A real DLQ.** The failed *message* is parked, so redrive replays it in one API call.
- **Retries decoupled from the request.** A failing reconcile is redelivered by SQS rather
  than surfacing to a tenant whose write is already durable.

There is deliberately **no DynamoDB stream and no EventBridge Pipe**. CDC earns its place
when you do not control the writer; here the API is the only writer and knows the tenant id,
so it calls `SendMessage` itself — removing a Pipe per tenant, its IAM role, and the filter
that kept the worker's own acknowledgements from re-triggering it. The cost is that the write
and the send are not atomic: the write is durable, the sweep bounds the gap at 15 minutes,
and the tenant sees `PENDING` meanwhile.

### The sweep is grouped too

The drift check emits **one message per tenant**, each in that tenant's group — `for_each`
over the tenant ids on `aws_cloudwatch_event_target`, with a static `message_group_id` and
`input` per target.

This matters more than it looks: a sweep on its own group would be the one producer able to
run *concurrently with* a tenant edit and collide on exactly the lock token the rest of the
design protects.

EventBridge has no dedup-id field on an SQS target, hence `content_based_deduplication = true`
on the queue and an input transformer stamping the event time. The API does not rely on it —
it sends an explicit `MessageDeduplicationId` of `tenant:owner:version`, which takes
precedence: per logical edit, so a retry collapses while a genuine second edit is never
swallowed by the 5-minute window.

## Onboarding a tenant

One entry in `prod.tfvars`, then apply. (Until a real IdP is wired in, a new *user* also needs
an entry in the `USERS` directory in `backend/src/config.ts` — see
[ARCHITECTURE.md](../ARCHITECTURE.md#scenario-10--onboarding-a-tenant).)

```hcl
tenants = {
  tenant-a      = { description = "Agency A CMS" }
  tenant-b      = { description = "Agency B CMS" }
  tenant-shared = { description = "Agencies C and D, one shared IPSet" }
}
```

Each key creates an IPSet, a sweep target in that tenant's message group, and a stuck-sync
alarm. The worker reads the mapping from `TENANTS`, so onboarding is **no code change** — a
diff a reviewer can read. No new table: the tenant is a partition key in the existing one.

| You want | Do this |
| -------- | ------- |
| Tenant gets its own IPSet | add a key |
| Agencies share one IPSet | put them in one key — separate items in that partition, union applied |
| Split a shared agency out later | add its own key and move its item |

Isolation is structural: one partition feeds one IPSet, and the worker's `Query` is scoped to
one `tenantId`, so a tenant's ranges cannot reach another's IPSet even if the API were wrong.

A single table also gives the *canonical* IAM mechanism, should the API ever get per-tenant
credentials: a `dynamodb:LeadingKeys` condition on the partition key. That is stronger than a
per-table boundary, which a shared API role could never have enforced anyway.

## Keeping WAF in the application's hands

Three layers, because no single one is enough:

| Layer | Does | Without it |
| ----- | ---- | ---------- |
| `ignore_changes = [addresses]` on every `aws_wafv2_ip_set` | Terraform owns the resource, the app owns its contents | the next `apply` resets each IPSet to the empty list and locks every tenant out until the next sync |
| The drift check, `rate(15 minutes)` | rebuilds from the table, so console changes are undone | drift on a quiet tenant survives until their next edit, which could be never |
| [deny-manual-ipset-edits.json](../iam/README.md) as an SCP | denies `wafv2:UpdateIPSet` to all but the worker and break-glass roles | a console edit succeeds and is only silently undone 15 minutes later |

Layer 3 prevents, layer 2 repairs, layer 1 stops your own pipeline from causing it. An
explicit `Deny` beats any `Allow`, including an administrator's.

## What this owns

- **Owns:** the allowlist table, the FIFO queue and DLQ, the drift schedule, the Lambda and
  its role, the alarms and the SNS topic.
- **Owns, with a caveat:** the per-tenant IPSets — the resources, never their `addresses`.
- **Does not own:** the WebACL, the EKS clusters, the ALB. The rules referencing these IPSets
  live wherever the CMS WebACL is declared.

## Concurrent triggers

Ten users saving at once produce ten messages. Three things keep that from corrupting an
IPSet:

1. **FIFO groups keyed by tenant** — one in-flight batch per tenant, so the ten arrive in a
   few sequential batches with no second concurrent writer to any IPSet, while different
   tenants proceed in parallel. This is the layer that makes collision *impossible* rather
   than merely recoverable.
2. **Full reconciliation** — the handler ignores message contents and rebuilds from a
   strongly consistent `Query`. Runs converge in any order because it is a rebuild, not an
   increment. This is what makes two agencies sharing a tenant safe: whoever runs second
   still writes the union.
3. **WAF lock token** — `GetIPSet` returns a token `UpdateIPSet` must present. With
   per-tenant grouping this should never fire between two edits; it remains as the guard
   against a console edit landing mid-update. The call fails, the message is redelivered, and
   the retry reconciles from a fresh read.

`ConsistentRead: true` is deliberate — an eventually consistent read can miss the very write
that triggered the run, publishing an IPSet that stays stale until the next edit.

### Partial batch failures

The event source mapping sets `function_response_types = ["ReportBatchItemFailures"]`, and
the handler returns the message ids of the tenants it could not reconcile instead of
throwing. Without it, one tenant's WAF problem returns all ten messages and ticks nine healthy
tenants toward the DLQ threshold on someone else's behalf.

## Confirming a change is live

After a successful `UpdateIPSet` the worker writes `syncedVersion` and `syncedAt` back to each
item it reconciled; the API derives `syncStatus` — `APPLIED` when `syncedVersion == version`,
`PENDING` otherwise. A write holds the request open up to `SYNC_WAIT_MS` for that
acknowledgement, so it normally answers **200 `APPLIED`**; if the window elapses, **202
`PENDING`** and the portal polls.

The status is derived, never stored, so it cannot drift. Two details make it trustworthy:

- The acknowledgement is **conditional on the version the worker actually read**. A tenant who
  saved again mid-sync fails that condition and correctly stays `PENDING` until their own
  message is processed.
- It runs after the WAF call *and* on the already-in-sync path — otherwise a retry following a
  successful `UpdateIPSet` would leave the tenant `PENDING` forever.

**The acknowledgement cannot re-trigger the worker.** Only the API sends to the queue, and
only on a tenant write, so the worker's `UpdateItem` has nowhere to loop back to. That is one
of the things dropping the stream bought: previously the acknowledgement landed on the same
stream that triggered the worker, and a Pipe filter was needed to break the loop, coupling the
whole sync path to the repository using `PutItem` rather than `UpdateItem`. The invariant
still matters for a different reason — a write must not inherit the previous version's
`syncedVersion` — so it stays pinned by the test `a write never carries the previous
acknowledgement`. But getting it wrong is now one visible bug rather than a silent stall of
the entire sync path.

If a change never applies, the message ends on the DLQ and the tenant stays `PENDING` while
the alarms fire — there is still no `FAILED` state on the API.

## Failure handling

A failed reconcile returns *that tenant's* messages to the queue. After `max_receive_count`
(5) deliveries SQS moves them to the FIFO DLQ and the alarm fires.

| Alarm | Fires when | Means |
| ----- | ---------- | ----- |
| `…-dlq-not-empty` | any message on the DLQ | changes are **not** reaching WAF |
| `…-sync-stuck-<tenant>` | that tenant's oldest unacknowledged edit is older than 5 min | edits are not going live, though nothing failed hard enough to be parked |
| `…-errors` | function errors in 5 minutes | failing but still retrying — catch it before the DLQ |

Nothing on the API side fails when sync stalls: tenants keep saving successfully while their
changes quietly stop reaching WAF. The alarms are the only signal, which is why there are
three.

### Slow or stuck

The DLQ alarm needs five failures, so it says nothing about a sync that is merely not
finishing. On every run the worker emits, per tenant, the age of its oldest unacknowledged
edit at the moment it read the partition:

```
Namespace  WebSG/Allowlist
Metric     OldestUnacknowledgedAgeSeconds
Dimension  Tenant
```

A few seconds is healthy — just the gap between the write and the worker picking it up. A
number climbing sweep after sweep is stuck.

Emitted as **embedded metric format** on stdout, so it costs a log line and no
`cloudwatch:PutMetricData`; emitted *before* reconciling, so a tenant whose sync keeps failing
still reports rather than going blind exactly when the signal is needed. The alarm period
matches the sweep interval, so there is one datapoint per tenant per sweep and `missing`
genuinely means the worker never ran. Worst-case detection is two sweeps — a backstop for the
DLQ alarm, not a first responder.

### Runbook: the DLQ alarm fired

1. Inspect: `aws sqs receive-message --queue-url $(terraform -chdir=terraform output -raw dlq_url)`
2. Check `/aws/lambda/websg-cms-allowlist-waf-sync` around that timestamp. Usual causes are
   WAF throttling or the IPSet hitting its address limit.
3. Fix the cause, then redrive: `aws sqs start-message-move-task --source-arn <dlq-arn>`
4. Often nothing needs replaying — the function rebuilds from a full read, so a later
   successful run already applied the parked change. Confirm the IPSet matches the table
   first, then purge instead.
5. To force a sync without waiting for an edit (message contents are ignored):
   `aws lambda invoke --function-name <name> --payload '{"Records":[]}' /dev/stdout`

## Notes

- Terraform `>= 1.10` for `use_lockfile` state locking; the DynamoDB lock table is deprecated.
- The queue's visibility timeout (120s) must stay above the function timeout (60s), or a slow
  run is redelivered while the first invocation is still working.
- No `node_modules` in the package — the nodejs24 runtime ships the AWS SDK v3.
- The IPSets are `IPV4`, so `break_glass_cidrs` is validated as IPv4 — a v6 range would apply
  cleanly and then fail every `UpdateIPSet` call. The API rejects IPv6 for the same reason.
- The API pod's IAM role is **not** in this stack. Add an IRSA role granting
  `dynamodb:GetItem` and `PutItem` on the table plus `sqs:SendMessage` on the queue when the
  pod is deployed — see [iam/backend-api-policy.json](../iam/backend-api-policy.json).
