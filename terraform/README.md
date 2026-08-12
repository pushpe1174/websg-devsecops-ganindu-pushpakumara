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

One table for the whole platform, `PK = tenantId` / `SK = ownerId`, so the worker reads a
tenant with a `Query` on one partition. Each tenant's IPSet is named
`websg-cms-allowlist-<key>`.

The state bucket is created by the Makefile at the repo root, not by Terraform — a
bootstrap stack would need its own state, which is the problem it is trying to solve.

## Apply

Day to day this runs in GitLab CI ([.gitlab-ci.yml](../.gitlab-ci.yml)): plan on every merge
request, apply manually from `main`, credentials from GitLab OIDC. The pipeline applies the
reviewed plan file, so what was approved is exactly what runs.

Locally, or for the first bootstrap:

```bash
make state-bucket              # once per account, as an administrator
make init
make plan                      # runs `make package`, uses -var-file=prod.tfvars
make apply
```

`prod.tfvars` is committed — it holds no secrets and CI needs it. It is passed explicitly
rather than auto-loaded, so a plan cannot pick up the wrong environment by accident.

`make package` builds `lambda/build`, which `archive_file` zips at plan time. It runs
automatically before plan and apply, because a stale package means Terraform sees no code
change and silently deploys the old function.

Before the first apply, edit `terraform/prod.tfvars` (real break-glass ranges, real alert
addresses) and set `bucket` in the backend block of `providers.tf` to your bucket name.

The deploy role's permissions are in [iam/terraform-deploy-policy.json](../iam/README.md).
Creating the state bucket is deliberately outside that policy — the pipeline should not be
able to reconfigure its own state.

## Why a queue between the API and the function

Not for transport — the API could call the function directly. The queue is here as a
**mutex**, and it buys three things:

- **One writer per IPSet.** `MessageGroupId` is the tenant id on every producer, and Lambda
  scales FIFO by message group with one in-flight batch per group. So two members of a
  tenant saving at the same moment reconcile in sequence, and there is never a second
  concurrent writer to that tenant's IPSet. Different tenants proceed in parallel.
- **A real DLQ.** The failed *message* is parked, so SQS's start-message-move (redrive) API
  can replay it to the source queue in one call.
- **Retries decoupled from the request.** A failing reconcile is redelivered by SQS rather
  than surfacing to the tenant, whose write is already durable.

There is deliberately **no DynamoDB stream and no EventBridge Pipe**. Change-data-capture
earns its place when you do not control the writer; here the API is the only writer and
already knows the tenant id, so it calls `SendMessage` itself. That removes a Pipe per
tenant, the Pipe's IAM role, and the filter that kept the worker's own acknowledgement
writes from re-triggering it.

The cost is that the write and the send are not atomic. The write is the durable one, the
sweep bounds the gap at 15 minutes, and the tenant sees `PENDING` in the meantime.

### The sweep is grouped too

The drift check emits **one message per tenant**, each in that tenant's message group —
`for_each` over the tenant ids on `aws_cloudwatch_event_target`, with a static
`message_group_id` and a static `input` per target.

This matters more than it looks. A sweep on its own group would be the one producer able to
run *concurrently with* a tenant edit and collide on exactly the lock token the rest of the
design is arranged to protect.

EventBridge has no dedup-id field on an SQS target, which is why the queue keeps
`content_based_deduplication = true` and the input transformer stamps the event time. The
API does not rely on it: it sends an explicit `MessageDeduplicationId` of
`tenant:owner:version`, which takes precedence — per logical edit, so a retry collapses
while a genuine second edit is never swallowed by the 5-minute window.

## Onboarding a tenant

One entry in `prod.tfvars`, then apply. (Until a real IdP is wired in, a new *user* also
needs an entry in `backend/src/config/users.ts` — see
[ARCHITECTURE.md](../ARCHITECTURE.md#scenario-10--onboarding-a-tenant).)

```hcl
tenants = {
  tenant-a      = { description = "Agency A CMS" }
  tenant-b      = { description = "Agency B CMS" }
  tenant-shared = { description = "Agencies C and D, one shared IPSet" }
}
```

Each key creates an IPSet named `websg-cms-allowlist-<key>`, a sweep target in that tenant's
message group, and a stuck-sync alarm. The worker reads the mapping from its `TENANTS`
environment variable, so onboarding is **no code change** — a Terraform diff a reviewer can
read. No new table: the tenant is a partition key in the existing one.

| You want | Do this |
| -------- | ------- |
| Tenant gets its own IPSet | add a key |
| Agencies share one IPSet | put them in one tenant key — separate items in that partition, union applied |
| Split a shared agency out later | add its own key and move its item |

Isolation is structural: one partition feeds exactly one IPSet, so a tenant's ranges cannot
reach another tenant's IPSet even if the API were wrong. The worker's `Query` is scoped to
one `tenantId`, so it cannot read across tenants even by accident.

A single table also gives the *canonical* mechanism for enforcing that in IAM, should the
API ever get per-tenant credentials: a `dynamodb:LeadingKeys` condition on the partition
key. That is stronger than a per-table boundary, which the shared API role could never have
enforced anyway.

## Keeping WAF in the application's hands

Only the sync worker should ever change these IPSets. Three layers, because no single one
is enough:

1. **`ignore_changes = [addresses]`** on every `aws_wafv2_ip_set`. Terraform owns the
   resource, the application owns its contents. Without this, the next `terraform apply`
   resets each IPSet to the empty address list in the resource and locks every tenant out
   until the next sync.
2. **The scheduled drift check** (`rate(15 minutes)` by default) puts one message per tenant
   on the same FIFO queue. Because the worker rebuilds from the table, anything changed in
   the console is reverted on the next run — without it, drift on a quiet tenant survives
   until their next edit, which could be never.
3. **[deny-manual-ipset-edits.json](../iam/README.md)**, attached as an SCP or permissions
   boundary, denies `wafv2:UpdateIPSet` to every principal except the worker's role and a
   break-glass role. An explicit `Deny` beats any `Allow`, including an administrator's, so
   the console edit fails outright instead of being silently undone 15 minutes later.

Layer 3 prevents it, layer 2 repairs it, layer 1 stops your own pipeline from causing it.

## What this owns

**Owns:** the allowlist table, the FIFO queue and its DLQ, the drift-check schedule, the
Lambda and its role, the alarms and the SNS topic.

**Owns, with a caveat:** the per-tenant IPSets — the resources, but never their
`addresses`, which are ignored (see above).

**Does not own:** the WebACL, the EKS clusters or the ALB. The WebACL rules that reference
these IPSets live wherever the CMS WebACL is declared.

## Concurrent triggers

Ten users saving at the same moment produce ten messages. Three things keep that from
corrupting an IPSet:

1. **FIFO message groups keyed by tenant** — one in-flight batch per tenant, so the ten
   messages are delivered in at most a few batches, in sequence, and there is never a second
   concurrent writer to a given IPSet. Different tenants proceed in parallel. This is the
   layer that makes the collision *impossible* rather than merely recoverable.
2. **Full reconciliation** — the handler ignores message contents and rebuilds the IPSet
   from a strongly consistent `Query` of the tenant's partition. Runs converge in any order,
   because the operation is a rebuild rather than an increment. This is what makes two
   agencies sharing a tenant safe: whoever runs second still writes the union.
3. **WAF lock token** — `GetIPSet` returns a `LockToken` that `UpdateIPSet` must present.
   With per-tenant grouping this should never fire between two edits; it remains as the
   guard against a manual console edit landing mid-update. The call fails, the message is
   redelivered, and the retry reconciles from a fresh read.

The `Query` uses `ConsistentRead: true` deliberately — a default eventually consistent read
can miss the very write that triggered the run, publishing an IPSet that stays stale until
the next edit.

### Partial batch failures

The event source mapping sets `function_response_types = ["ReportBatchItemFailures"]`, and
the handler returns the message ids of the tenants it could not reconcile instead of
throwing. Without it, one tenant's WAF problem returns all ten messages to the queue and
ticks nine healthy tenants toward the DLQ threshold on someone else's behalf.

## Confirming a change is live

After a successful `UpdateIPSet` the worker writes `syncedVersion` and `syncedAt` back to
each item it reconciled, and the API derives `syncStatus` from them — `APPLIED` when
`syncedVersion == version`, `PENDING` otherwise.

A write holds the request open for up to `SYNC_WAIT_MS` waiting for that acknowledgement, so
it normally answers **200** with `syncStatus: APPLIED`. If the window elapses first it
answers **202** with `PENDING` — stored and durable, not yet enforced — and the portal polls
GET until it reads `APPLIED`.

The status is derived, never stored, so it cannot drift from the data. Two details make it
trustworthy:

- The acknowledgement is **conditional on the version** the worker actually read. A tenant
  who saved again mid-sync fails that condition and correctly stays `PENDING` until their
  own message is processed.
- It runs after the WAF call, and also on the already-in-sync path — otherwise a retry
  following a successful `UpdateIPSet` would leave the tenant `PENDING` forever.

### Why the acknowledgement does not re-trigger the worker

It cannot. Only the API sends to the queue, and it sends on a tenant write — the worker's
`UpdateItem` write-back has nowhere to loop back to.

This is one of the things dropping the stream bought. Previously the acknowledgement landed
on the same stream that triggered the worker, and a Pipe filter (`syncedVersion.N` does not
exist) was needed to break the loop, coupling the whole sync path to the repository using
`PutItem` rather than `UpdateItem`.

That invariant still matters for a different reason — a write must not inherit the previous
version's `syncedVersion`, or an unapplied edit reports as already live — so it is still
pinned by the test `a write never carries the previous acknowledgement`. But getting it
wrong is now one visible bug rather than a silent stall of the entire sync path.

If a change never applies, the message ends on the DLQ and the tenant stays `PENDING` while
the alarms fire — there is still no `FAILED` state on the API. Operators can distinguish
slow from stuck (see below); the portal cannot, and giving it that means the worker writing
a real terminal state onto the item.

## Failure handling

A failed reconcile returns *that tenant's* messages to the queue. After `max_receive_count`
(5) deliveries SQS moves them to the FIFO DLQ, and the alarm fires.

| Alarm | Fires when | Means |
| ----- | ---------- | ----- |
| `…-dlq-not-empty` | any message on the DLQ | changes are **not** reaching WAF |
| `…-sync-stuck-<tenant>` | that tenant's oldest unacknowledged edit is older than 5 min | edits are not going live, even though nothing has failed hard enough to be parked |
| `…-errors` | function errors in 5 minutes | failing but still retrying — catch it before the DLQ |

Nothing on the API side fails when sync stalls: tenants keep saving successfully while their
changes quietly stop reaching WAF and `syncStatus` stays `PENDING`. The alarms are the only
signal, which is why there are three.

### Slow or stuck

The DLQ alarm only fires once something has failed five times, so it says nothing about a
sync that is merely not finishing. On every run the worker emits, per tenant, the age of its
oldest unacknowledged edit at the moment it read the partition:

```
Namespace  WebSG/Allowlist
Metric     OldestUnacknowledgedAgeSeconds
Dimension  Tenant
```

A few seconds is healthy — that is just the time between the API's write and the worker
picking it up. A number climbing sweep after sweep is stuck.

It is emitted as **embedded metric format** on stdout, so it costs a log line and needs no
`cloudwatch:PutMetricData`. It is emitted *before* reconciling, so a tenant whose sync keeps
failing still reports rather than going blind exactly when the signal is needed.

The alarm's period matches the sweep interval (15 min), so there is one datapoint per tenant
per sweep and `missing` genuinely means the worker never ran. Worst-case detection is
therefore two sweeps — this is a backstop for the DLQ alarm, not a first responder.

### Runbook: the DLQ alarm fired

1. Inspect: `aws sqs receive-message --queue-url $(terraform -chdir=terraform output -raw dlq_url)`
2. Check `/aws/lambda/websg-cms-allowlist-waf-sync` around that timestamp. Usual causes
   are WAF throttling or the IPSet hitting its address limit.
3. Fix the cause, then **redrive** — SQS replays the parked messages to the source queue:
   ```bash
   aws sqs start-message-move-task --source-arn <dlq-arn>
   ```
4. Often nothing needs replaying: the function rebuilds from a full read of the tenant's
   partition, so a later successful run already applied the parked change. Confirm the IPSet
   matches the table first, then purge instead.
5. To force a sync without waiting for a tenant edit — the function ignores message
   contents: `aws lambda invoke --function-name <name> --payload '{"Records":[]}' /dev/stdout`

## Notes

- Terraform `>= 1.10` for `use_lockfile` state locking; the DynamoDB lock table approach is
  deprecated.
- The queue's visibility timeout (120s) must stay above the function timeout (60s), or a
  slow run is redelivered while the first invocation is still working.
- No `node_modules` in the package — the nodejs24 runtime ships the AWS SDK v3.
- The IPSets are `IPV4`. `break_glass_cidrs` is validated as IPv4 for that reason — a v6
  range would apply cleanly and then fail every `UpdateIPSet` call. The API rejects IPv6 for
  the same reason.
- The API pod's IAM role is **not** in this stack. Add a small IRSA role granting
  `dynamodb:GetItem` and `PutItem` on the table plus `sqs:SendMessage` on the queue when the
  pod is deployed — see [iam/backend-api-policy.json](../iam/backend-api-policy.json).
