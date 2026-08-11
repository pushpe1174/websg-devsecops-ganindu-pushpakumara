# Infrastructure

```
DynamoDB stream -> EventBridge Pipe -> SQS FIFO -> Lambda -> WAF IPSet per tenant
                        schedule (drift) ->  |                (or shared)
                                             +-> DLQ -> alarm -> SNS
```

```
terraform/
├── main.tf                  provider, backend, the four modules wired together
├── variables.tf
├── outputs.tf
├── terraform.tfvars.example
└── modules/
    ├── tenants/             per-tenant IPSets + the tenant->IPSet mapping
    ├── dynamodb/            table + stream
    ├── queue/               EventBridge Pipe + FIFO queue + FIFO DLQ
    ├── lambda/              function + IAM + event source mapping
    └── monitoring/          SNS topic + CloudWatch alarms
```

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
addresses) and set `bucket` in the backend block of `main.tf` to your bucket name.

The deploy role's permissions are in [iam/terraform-deploy-policy.json](../iam/README.md).
Creating the state bucket is deliberately outside that policy — the pipeline should not be
able to reconfigure its own state.

## Why a queue between the stream and the function

DynamoDB Streams cannot target SQS directly, so an **EventBridge Pipe** does the hop. It is
a managed integration — no forwarder function to write, deploy or monitor.

The queue is FIFO with a **single message group**, which buys three things:

- **Serial processing.** Lambda scales FIFO queues by message group; one group means one
  invocation at a time. Concurrent tenant edits are applied one after another, with no
  reserved-concurrency cap needed.
- **A real DLQ.** The failed *message* is parked, not a pointer to a stream position, so
  SQS's start-message-move (redrive) API can replay it to the source queue in one call.
- **Retries decoupled from the stream.** A failing batch is redelivered by SQS instead of
  blocking a stream shard.

The cost is one more hop and Pipe request charges. The reconciliation itself does not need
ordering — it is a full rebuild — so the real win is serialisation plus the replayable DLQ.

## Onboarding a tenant

One entry in `prod.tfvars`, then apply:

```hcl
tenants = {
  agency-a = { ip_set_name = "websg-cms-allowlist-agency-a" }
  agency-b = { ip_set_name = "websg-cms-allowlist-agency-b" }
}
```

That creates the IPSet and writes a `tenantId -> ipSet` row to the mapping table. The worker
reads the mapping at runtime, so **no code change and no redeploy** — a new tenant is a
Terraform diff a reviewer can read.

| You want | Do this |
| -------- | ------- |
| Tenant gets its own IPSet | give it a unique `ip_set_name` |
| Tenants share one IPSet | give them the same `ip_set_name` — the worker applies the union of their lists |
| Adopt an IPSet created elsewhere | `create_ip_set = false` |
| Split a shared tenant out later | change its `ip_set_name` and apply |

The worker groups tenants by IPSet, so shared and per-tenant are the same code path rather
than two modes. A tenant with no mapping is logged and left `PENDING` — its ranges are never
applied to somebody else's IPSet.

Isolation is enforced twice: the API already refuses cross-tenant writes, and the worker
only ever puts a tenant's CIDRs into the IPSet its mapping names.

## Keeping WAF in the application's hands

Only the sync worker should ever change these IPSets. Three layers, because no single one
is enough:

1. **`ignore_changes = [addresses]`** on every `aws_wafv2_ip_set`. Terraform owns the
   resource, the application owns its contents. Without this, the next `terraform apply`
   resets each IPSet to the empty address list in the resource and locks every tenant out
   until the next sync.
2. **The scheduled drift check** (`rate(15 minutes)` by default) puts a message on the same
   FIFO queue. Because the worker rebuilds from the tables, anything changed in the console
   is reverted on the next run — without it, drift on a quiet tenant survives until their
   next edit, which could be never.
3. **[deny-manual-ipset-edits.json](../iam/README.md)**, attached as an SCP or permissions
   boundary, denies `wafv2:UpdateIPSet` to every principal except the worker's role and a
   break-glass role. An explicit `Deny` beats any `Allow`, including an administrator's, so
   the console edit fails outright instead of being silently undone 15 minutes later.

Layer 3 prevents it, layer 2 repairs it, layer 1 stops your own pipeline from causing it.

## What this owns

**Owns:** the allowlist table and stream, the tenant mapping table, the Pipe, the FIFO
queue and its DLQ, the drift-check schedule, the Lambda and its role, the alarms and the
SNS topic.

**Owns, with a caveat:** the per-tenant IPSets — the resources, but never their
`addresses`, which are ignored (see above). IPSets marked `create_ip_set = false` are read
only.

**Does not own:** the WebACL, the EKS clusters or the ALB. The WebACL rules that reference
these IPSets live wherever the CMS WebACL is declared.

## Concurrent triggers

Ten tenants saving at the same moment produce ten stream records. Four things keep that from
corrupting the IPSet:

1. **Pipe batching** — records are gathered for up to 5 seconds, so a burst usually becomes
   one message rather than ten.
2. **FIFO single message group** — SQS delivers one batch at a time and holds the rest,
   so the function never runs against itself.
3. **Full reconciliation** — the handler ignores message contents and rebuilds the IPSet
   from a strongly consistent `Scan` of the whole table. Runs converge in any order,
   because the operation is a rebuild rather than an increment.
4. **WAF lock token** — `GetIPSet` returns a `LockToken` that `UpdateIPSet` must present.
   Anything that changed in between causes `WAFOptimisticLockException`, so a concurrent
   writer can never silently clobber; the message returns to the queue and is redelivered.

Layers 3 and 4 are what make it *correct*; 1 and 2 are what make it cheap. The `Scan` uses
`ConsistentRead: true` deliberately — a default eventually consistent scan can miss the very
write that triggered the run, publishing an IPSet that stays stale until the next edit.

## Confirming a change is live

The API returns **202 Accepted** on a write: the list is stored, but not yet in WAF. After a
successful `UpdateIPSet` the worker writes `syncedVersion` and `syncedAt` back to each
tenant item, and the API derives `syncStatus` from them — `APPLIED` when
`syncedVersion == version`, `PENDING` otherwise. The portal polls GET until it reads
`APPLIED`.

The status is derived, never stored, so it cannot drift from the data. Two details make it
trustworthy:

- The acknowledgement is **conditional on the version** the worker actually read. A tenant
  who saved again mid-sync fails that condition and correctly stays `PENDING` until their
  own message is processed.
- It runs after the WAF call, and also on the already-in-sync path — otherwise a retry
  following a successful `UpdateIPSet` would leave the tenant `PENDING` forever.

### Why the acknowledgement does not re-trigger the worker

The write-back lands on the same stream that triggers the worker, so it would loop. The
Pipe filters it out:

```json
{ "dynamodb": { "NewImage": { "syncedVersion": { "N": [ { "exists": false } ] } } } }
```

The API replaces the whole item on every write, so a tenant edit never carries
`syncedVersion`; the worker's `UpdateItem` is the only thing that sets it. "No
`syncedVersion`" therefore means "tenant edit", and the acknowledgement never reaches the
queue. Filtered records are skipped at the source — the stream iterator advances past them
and nothing is billed downstream.

`exists` only works on leaf nodes, which is why the pattern matches `syncedVersion.N` and
not `syncedVersion`.

This couples the filter to the repository writing with `PutItem` rather than merging with
`UpdateItem`. If the API ever preserved `syncedVersion` on write, the worker would stop
seeing tenant changes entirely — so that invariant is pinned by a test
(`a write never carries the previous acknowledgement`) and commented at both ends.

If a change never applies, the message ends on the DLQ and the tenant stays `PENDING` while
the alarm fires — there is no `FAILED` state. Adding one means consuming the DLQ, which is
worth doing only if the portal needs to distinguish "slow" from "stuck" on its own.

## Failure handling

A failed run returns the batch to the queue. After `max_receive_count` (5) deliveries SQS
moves the message to the FIFO DLQ, and the alarm fires.

| Alarm | Fires when | Means |
| ----- | ---------- | ----- |
| `…-dlq-not-empty` | any message on the DLQ | changes are **not** reaching WAF |
| `…-errors` | function errors in 5 minutes | failing but still retrying — catch it before the DLQ |

The DLQ alarm is the important one: nothing on the API side fails when sync stalls. Tenants
keep getting `202`s while their changes quietly stop reaching WAF, and `syncStatus` stays
PENDING.

### Runbook: the DLQ alarm fired

1. Inspect: `aws sqs receive-message --queue-url $(terraform -chdir=terraform output -raw dlq_url)`
2. Check `/aws/lambda/websg-cms-ip-allowlist-waf-sync` around that timestamp. Usual causes
   are WAF throttling or the IPSet hitting its address limit.
3. Fix the cause, then **redrive** — SQS replays the parked messages to the source queue:
   ```bash
   aws sqs start-message-move-task --source-arn <dlq-arn>
   ```
4. Often nothing needs replaying: the function rebuilds from a full table read, so a later
   successful run already applied the parked change. Confirm the IPSet matches the table
   first, then purge instead.
5. To force a sync without waiting for a tenant edit — the function ignores message
   contents: `aws lambda invoke --function-name <name> --payload '{"Records":[]}' /dev/stdout`

## Notes

- Terraform `>= 1.10` for `use_lockfile` state locking; the DynamoDB lock table approach is
  deprecated.
- The queue's visibility timeout (120s) must stay above the function timeout (60s), or a
  slow run is redelivered while the first invocation is still working.
- No `node_modules` in the package — the nodejs24 runtime ships the AWS SDK v3.
- The API pod's IAM role is **not** in this stack. Add a small IRSA role granting
  `dynamodb:GetItem` and `PutItem` on `table_arn` when the pod is deployed.
