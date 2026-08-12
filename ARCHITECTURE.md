# Architecture and scenarios

What the system is, and a runnable call for every scenario it handles.

[Shape](#the-shape-of-it) · [Why this split](#why-this-split) · [Setup](#setup-for-the-walkthroughs) ·
[1 Shared IPSet](#scenario-1--two-agencies-sharing-one-ipset) ·
[2 Own IPSet](#scenario-2--tenants-with-their-own-ipset) ·
[3 Going live](#scenario-3--waiting-for-a-change-to-go-live) ·
[4 Two tenants at once](#scenario-4--two-tenants-editing-at-the-same-time) ·
[5 Two tabs](#scenario-5--two-tabs-editing-the-same-list) ·
[6 Rejected input](#scenario-6--rejected-input) ·
[7 Isolation](#scenario-7--someone-elses-list-and-no-token-at-all) ·
[8 Manual WAF edit](#scenario-8--someone-edits-waf-by-hand) ·
[9 Sync fails](#scenario-9--a-sync-fails) ·
[10 Onboarding](#scenario-10--onboarding-a-tenant) ·
[Not yet](#what-it-does-not-do-yet)

## The shape of it

```
                        ┌──────────────────────────────────────────────┐
  portal user  ──PUT──► │  Allowlist API  (Fastify, pod on CMS EKS)    │
                        │  authenticates, validates, writes desired    │
                        │  state to the caller's own item              │
                        └──────┬────────────────────────┬──────────────┘
        PutItem (conditional   │                        │  SendMessage
         on version)           ▼                        │  MessageGroupId = tenantId
                        ┌────────────────────────────┐  │  DedupId = tenant:owner:version
                        │  DynamoDB — one table      │  │
                        │   websg-cms-allowlist      │  │
                        │   PK tenantId · SK ownerId │  │
                        │   → cidrs, version         │  │
                        └────────────────────────────┘  │
                                    ▲                   ▼
   schedule (15 min) ───────────────┼───────►  ┌──────────────┐      ┌─────────┐
   one message per tenant,          │          │ SQS FIFO     │─────►│  DLQ    │──► alarm ──► SNS
   in that tenant's group           │          └──────┬───────┘      └─────────┘
                                    │                 ▼
                        ┌───────────┴──────────────────────────────────┐
                        │  WAF Sync Lambda  (single function)          │
                        │  rebuilds each affected tenant's IPSet from  │
                        │  a consistent Query of its partition;        │
                        │  returns per-message failures, not batches   │
                        └───────┬───────────────────┬──────────────────┘
                                ▼                   ▼
                        ┌───────────────┐   ┌───────────────┐
                        │ IPSet         │   │ IPSet         │   one call per IPSet,
                        │ tenant-shared │   │ tenant-a      │   lock-token guarded
                        │ (C ∪ D)       │   │ (A)           │
                        └───────────────┘   └───────────────┘
```

## Why this split

| Decision | Reasoning |
| -------- | --------- |
| **The API never calls WAF** | It owns desired state only, so a WAF throttle or lock conflict never surfaces to a tenant, and every WAF change traces to a stored record with its `ownerId`, `version` and `updatedAt`. |
| **The worker reconciles, not applies deltas** | It ignores message contents and rebuilds from the table, so retries, redelivery, duplicates and sweeps all converge. This is load-bearing: because the message carries no data, nothing depends on ordering or exactly-once. |
| **The API sends its own signal** | CDC exists to observe a writer you do not control. There is exactly one writer here and it knows the tenant id, so it calls `SendMessage` — removing a Pipe per tenant, its IAM role, and the filter that stopped acknowledgements re-triggering the worker. |
| **The queue is a mutex, not transport** | `MessageGroupId` is the tenant on *every* producer, sweep included. FIFO allows one in-flight batch per group, so a second concurrent writer to an IPSet cannot exist and `WAFOptimisticLockException` cannot arise between two edits. |
| **One partition feeds one IPSet** | `PK = tenantId` means a `Query` on one partition, bounded by the tenant's member count. Shared agencies are separate items in that partition, so the union falls out of the rebuild — shared and per-tenant are one code path. |
| **Onboarding is configuration** | A `prod.tfvars` entry and an apply. No worker change, no redeploy. |

The cost of the API sending its own signal is that the write and the send are not atomic. The
write is the durable one, the sweep bounds the gap at 15 minutes, and it reads `PENDING`
throughout — a failed send is logged and answered `202`, never raised.

## Setup for the walkthroughs

Follow [Running it](README.md#running-it) first. Every call below hits real AWS, so
`syncStatus` really does flip to `APPLIED`.

```bash
cd backend
export API=http://localhost:3000

export TOKEN_A=$(npm run token --silent -- user-a)   # tenant-a
export TOKEN_B=$(npm run token --silent -- user-b)   # tenant-b
export TOKEN_C=$(npm run token --silent -- user-c)   # tenant-shared
export TOKEN_D=$(npm run token --silent -- user-d)   # tenant-shared

ipset() {   # usage: ipset tenant-a
  local name="websg-cms-allowlist-$1"
  aws wafv2 get-ip-set --scope REGIONAL --name "$name" \
    --id "$(terraform -chdir=../terraform output -json ip_sets | jq -r --arg n "$name" '.[$n].id')" \
    --query 'IPSet.Addresses' --output json
}
```

Every list below starts at `version: 0`; if you have written one already, `GET` the current
version and use that in `If-Match`.

---

## Scenario 1 — Two agencies sharing one IPSet

`user-c` and `user-d` both map to `tenant-shared`: one partition, one IPSet, two lists.

```bash
curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_C" -H 'content-type: application/json' \
  -H 'if-match: 0' -d '{"cidrs":["203.0.113.0/24"]}'

curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_D" -H 'content-type: application/json' \
  -H 'if-match: 0' -d '{"cidrs":["198.51.100.0/24"]}'

ipset tenant-shared
```

```
[ "112.134.158.144/32",   (break-glass)
  "198.51.100.0/24",      (user-d)
  "203.0.113.0/24" ]      (user-c)
```

Neither agency can see or remove the other's ranges — `GET` returns only the caller's list.
When C edits, D's ranges survive, because the worker rebuilds from every item in the
partition rather than patching C's entries in.

---

## Scenario 2 — Tenants with their own IPSet

```bash
curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -H 'if-match: 0' -d '{"cidrs":["192.0.2.128/25"]}'

curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_B" -H 'content-type: application/json' \
  -H 'if-match: 0' -d '{"cidrs":["203.0.113.128/25"]}'

ipset tenant-a    # 192.0.2.128/25 + break-glass
ipset tenant-b    # 203.0.113.128/25 + break-glass
```

One Lambda handled four users across three IPSets in this and the previous scenario, with no
code change between them. A's edit does not even *read* B's IPSet: the affected tenant comes
from the `tenantId` on the message. An unrecognised id falls back to a full sweep — being
slow beats silently skipping an IPSet.

---

## Scenario 3 — Waiting for a change to go live

```bash
curl -isX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -H 'if-match: 1' -d '{"cidrs":["192.0.2.128/25","198.51.100.64/26"]}'
# HTTP/1.1 200 OK
# etag: 2
# {"version":2,"syncStatus":"APPLIED","syncedVersion":2,"syncedAt":"..."}
```

A write waits up to `SYNC_WAIT_MS` for the acknowledgement, so it usually answers **200
`APPLIED`**. If the window elapses first: **202 `PENDING`** — stored and durable, not yet
enforced. Poll until it lands:

```bash
until curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN_A" \
      | grep -q '"syncStatus":"APPLIED"'; do sleep 2; done
echo "live in WAF"
```

`syncStatus` is derived from `syncedVersion == version`, never stored, so it cannot claim
`APPLIED` for a version WAF does not hold. Set `SYNC_WAIT_MS=0` to see the `PENDING` path on
demand.

---

## Scenario 4 — Two tenants editing at the same time

```bash
curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -H 'if-match: 2' -d '{"cidrs":["192.0.2.128/25"]}' &

curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_B" -H 'content-type: application/json' \
  -H 'if-match: 1' -d '{"cidrs":["203.0.113.128/25"]}' &
wait
```

Both succeed — different tenants, different message groups, different IPSets, reconciled in
parallel.

Run the same pair as `user-c` and `user-d` and they target the *same* IPSet. Because the group
is the **tenant**, not the owner, SQS holds the second message until the first batch is done:
they reconcile in sequence, never as two concurrent writers, and neither attempt is wasted
losing a `LockToken` race. Grouping by owner would have let two members of one tenant collide;
grouping by tenant makes the collision structurally impossible.

The sweep is grouped the same way, so it queues *behind* a tenant's edits. Without that, the
sweep would be the one producer able to collide on exactly the lock token everything else is
arranged to protect.

---

## Scenario 5 — Two tabs editing the same list

```bash
V=$(curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN_A" \
    | sed 's/.*"version":\([0-9]*\).*/\1/')

curl -s -o /dev/null -w 'first:     %{http_code}\n' -X PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -H "if-match: $V" -d '{"cidrs":["192.0.2.128/25"]}'      # 200 or 202

curl -s -o /dev/null -w 'second:    %{http_code}\n' -X PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -H "if-match: $V" -d '{"cidrs":["203.0.113.0/24"]}'      # 409 - stale

curl -s -o /dev/null -w 'no header: %{http_code}\n' -X PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -d '{"cidrs":["203.0.113.0/24"]}'                        # 428 - required
```

The check is not only in the API: the write is a `PutItem` conditional on the stored version,
so two requests that pass the header check still cannot both land.

---

## Scenario 6 — Rejected input

```bash
curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -H 'if-match: 3' \
  -d '{"cidrs":["10.0.0.1","203.0.113.9/24","not-an-ip","203.0.0.0/8","2001:db8::/48"]}'
```

| Sent | Verdict |
| ---- | ------- |
| `10.0.0.1` | `private, loopback, link-local or reserved ranges are not allowed` |
| `203.0.113.9/24` | `host bits set, use the network address for /24` |
| `not-an-ip` | `not a valid IPv4 address` |
| `203.0.0.0/8` | `range too broad, use /24 or narrower` |
| `2001:db8::/48` | `IPv6 is not supported, use an IPv4 address or CIDR` |

All five come back at once in `reasons`, and **nothing is written** — a partial list is never
stored. Valid input is canonicalised: `203.0.113.9` → `203.0.113.9/32`, duplicates collapse,
the list is sorted, so what WAF holds is exactly what the API returns.

**IPv6 gets its own reason** rather than being lumped in with malformed input. The IPSets are
`IPV4`, so accepting v6 would store an address reported `PENDING` that never goes live —
promising something the infrastructure cannot deliver. Until there is a second IPSet per
tenant, family routing in the worker and both sets in the WebACL, the honest answer is a 400.

---

## Scenario 7 — Someone else's list, and no token at all

There is no id in the route, so "read another tenant's list" is not a request that can be
expressed. What is left is the token:

```bash
curl -s -o /dev/null -w 'no token:   %{http_code}\n' $API/v1/allowlist          # 401

curl -s -o /dev/null -w 'bad token:  %{http_code}\n' $API/v1/allowlist \
  -H 'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.nope'                      # 401

npm run token --silent -- user-z          # Error: unknown user: user-z

# user-c and user-d resolve to the same tenant, but to different lists
curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN_C" | grep -o '"ownerId":"[^"]*"'
curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN_D" | grep -o '"ownerId":"[^"]*"'
```

The tenant is resolved from the server-side directory keyed by the token's `sub`, never from
a claim, so a forged `tenant_id` has nothing to attach to — and an unknown `sub` is 401 even
with a valid signature. Isolation is enforced twice: the API only addresses the caller's own
item, and the worker only writes a partition's contents into that tenant's own IPSet.

---

## Scenario 8 — Someone edits WAF by hand

Say an operator adds `10.10.10.10/32` to tenant A's IPSet in the console.

1. **It should not be possible.** [iam/deny-manual-ipset-edits.json](iam/deny-manual-ipset-edits.json),
   attached as an SCP, denies `wafv2:UpdateIPSet` to every principal except the worker and a
   break-glass role. An explicit `Deny` beats any `Allow`, including an administrator's.
2. **If it happened anyway**, the 15-minute drift check reconciles from the table and the
   extra range disappears. No API call involved.
3. **Terraform will not fight it either way** — `ignore_changes = [addresses]`.

To force the sweep now:

```bash
aws lambda invoke --function-name $(terraform -chdir=terraform output -raw function_name) \
  --payload '{"Records":[]}' /dev/stdout
```

An unrecognised payload means "full sweep", so this reconciles every IPSet.

---

## Scenario 9 — A sync fails

WAF throttles, or an IPSet hits its address limit.

- The worker reconciles every tenant it can, then returns **only the message ids of the
  tenants that failed** (`ReportBatchItemFailures`). Healthy tenants' messages are deleted as
  normal — otherwise one tenant's problem would tick nine healthy ones toward the DLQ.
- Failed messages are redelivered up to 5 times, then land on the FIFO DLQ, the
  `dlq-not-empty` alarm fires to SNS, and that user's `syncStatus` stays `PENDING`.

Nothing on the API side fails while this happens — writes keep succeeding. That is exactly
why the alarms exist.

**Slow or stuck?** The DLQ alarm needs five failures. For the quieter failure — edits not
going live while nothing errors hard enough to be parked — the worker reports, per tenant,
the age of its oldest unacknowledged edit:

```bash
aws cloudwatch get-metric-statistics \
  --namespace WebSG/Allowlist --metric-name OldestUnacknowledgedAgeSeconds \
  --dimensions Name=Tenant,Value=tenant-a \
  --start-time "$(date -u -v-2H +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 900 --statistics Maximum
```

A few seconds is healthy; a number climbing sweep after sweep is stuck, and
`sync-stuck-<tenant>` fires above 5 minutes. It is embedded metric format on stdout, so it
costs a log line and no `cloudwatch:PutMetricData` — and it is emitted *before* reconciling,
so a tenant whose sync keeps failing still reports instead of going blind exactly when the
signal is needed.

```bash
aws sqs receive-message --queue-url $(terraform -chdir=terraform output -raw dlq_url)
aws sqs start-message-move-task --source-arn <dlq-arn>   # after fixing the cause
```

Often no replay is needed: the worker rebuilds from a full read, so a later successful run
has already applied the parked change. Compare the IPSet with the table first, then purge.
Runbook: [terraform/README.md](terraform/README.md#runbook-the-dlq-alarm-fired).

---

## Scenario 10 — Onboarding a tenant

```hcl
tenants = {
  tenant-a      = { description = "Agency A CMS" }
  tenant-b      = { description = "Agency B CMS" }
  tenant-shared = { description = "Agencies C and D, one shared IPSet" }
  tenant-e      = { description = "Agency E CMS" }   # new
}
```

`make apply` creates the IPSet, adds a sweep target in the new tenant's message group, adds
its stuck-sync alarm, and re-renders the worker's `TENANTS` variable — **no code change**,
and a diff a reviewer can read. No new table, stream or Pipe: the tenant is a partition key
in the existing table.

| You want | Do this |
| -------- | ------- |
| A tenant with its own IPSet | add a tenant key |
| Agencies sharing one IPSet | point their users at one key — separate items, union applied |
| Split a shared agency out later | add its own key and move its item |

The one thing that is *not* configuration today is the user directory: because this build
stands in for the portal's IdP, a new user also needs an entry in
[backend/src/config/users.ts](backend/src/config/users.ts). With a real IdP that mapping
comes from the token exchange and onboarding is Terraform only.

---

## What it does not do yet

| Gap | What closing it takes |
| --- | --------------------- |
| **No IdP** — HS256 with a shared secret, users in a checked-in directory | JWKS verification and the user → tenant mapping from the directory service: a change to [jwt.ts](backend/src/lib/jwt.ts) and [users.ts](backend/src/config/users.ts), not to routes, service or worker |
| **No `FAILED` status** — a change that never applies stays `PENDING` | Operators can tell slow from stuck via `OldestUnacknowledgedAgeSeconds`; the portal cannot. Surfacing it means a real terminal state on the item, written when the worker gives up |
| **IPv6 rejected, not supported** | A second IPSet per tenant, family routing in the worker, both sets in the WebACL rule |
| **WebACL rules are not in this repo** | The `ip_sets` output exports the ids; wiring `Host == <tenant>.cms.websg.gov.sg AND NOT ip in <IPSet>` lives with the CMS WebACL. Past ~100 tenants the 1,500 WCU cap wants a single rule backed by a CloudFront Function |
| **No audit trail endpoint** | Items carry `ownerId`, `version`, `updatedAt`, but history needs a DynamoDB stream enabled and archived. There is no stream today — the sync path no longer needs one |
| **No OpenAPI document** | Two routes and a fixed schema shape did not justify the dependency; [schemas.ts](backend/src/modules/ip-allowlist/schemas.ts) is the contract |
