# Architecture and scenarios

What the system is, what it handles today, and a runnable call for every scenario.

- [The shape of it](#the-shape-of-it)
- [Why it is split this way](#why-it-is-split-this-way)
- [Setup for the walkthroughs](#setup-for-the-walkthroughs)
- [Scenario 1 — Two agencies sharing one IPSet](#scenario-1--two-agencies-sharing-one-ipset)
- [Scenario 2 — Tenants with their own IPSet](#scenario-2--tenants-with-their-own-ipset)
- [Scenario 3 — Waiting for a change to go live](#scenario-3--waiting-for-a-change-to-go-live)
- [Scenario 4 — Two tenants editing at the same time](#scenario-4--two-tenants-editing-at-the-same-time)
- [Scenario 5 — Two tabs editing the same list](#scenario-5--two-tabs-editing-the-same-list)
- [Scenario 6 — Rejected input](#scenario-6--rejected-input)
- [Scenario 7 — Someone else's list, and no token at all](#scenario-7--someone-elses-list-and-no-token-at-all)
- [Scenario 8 — Someone edits WAF by hand](#scenario-8--someone-edits-waf-by-hand)
- [Scenario 9 — A sync fails](#scenario-9--a-sync-fails)
- [Scenario 10 — Onboarding a tenant](#scenario-10--onboarding-a-tenant)
- [What it does not do yet](#what-it-does-not-do-yet)

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

Two moving parts between the API and WAF: a queue and a function.

## Why it is split this way

**The API never calls WAF.** It owns *desired state* only. A WAF throttle or lock conflict
never surfaces to a tenant, and every WAF change is attributable to a stored record with its
`ownerId`, `version` and `updatedAt`.

**The worker reconciles, it does not apply deltas.** It ignores message contents and
rebuilds each IPSet from the table. Retries, redelivery, duplicate messages and the
scheduled sweep all converge on the same result. This is the load-bearing idea: because the
message carries no data, nothing downstream depends on delivery order or exactly-once.

**The API sends its own signal.** Change-data-capture exists to observe a writer you do not
control. Here there is exactly one writer, it is this API, and it already knows the tenant
id — so it calls `SendMessage` rather than routing a DynamoDB stream through an EventBridge
Pipe to say the same thing. That removes one Pipe per tenant, the Pipe's IAM role, and the
filter that stopped the worker's own acknowledgements re-triggering it.

The cost is that the write and the send are not atomic. The write is the durable one, the
gap is bounded at 15 minutes by the sweep, and it is visible as `PENDING` throughout — a
failed send is logged and answered `202`, never raised as an error.

**The queue is a mutex, not transport.** `MessageGroupId` is the tenant id on *every*
producer, the scheduled sweep included. FIFO allows one in-flight batch per group, so there
is never a second concurrent writer to a tenant's IPSet and `WAFOptimisticLockException`
cannot arise between two edits. The lock token remains as a guard against a manual console
edit landing mid-update.

**One partition feeds exactly one IPSet.** `PK = tenantId` means the worker reads a tenant
with a `Query` on one partition, so its cost is bounded by that tenant's member count rather
than by the size of the platform. Agencies that share an IPSet share a partition and are
separate items in it, so the union falls out of the rebuild — shared and per-tenant are the
same code path, not two modes.

**Onboarding is configuration.** Adding a tenant is an entry in `prod.tfvars` and an apply.
No code change to the worker, no redeploy.

## Setup for the walkthroughs

Follow [Running it](README.md#running-it) first: `make apply`, then `.env` filled from the
Terraform outputs, then `npm run dev`. Every call below runs against that server and hits
real AWS, so `syncStatus` really does flip to `APPLIED`.

```bash
cd backend
export API=http://localhost:3000

export TOKEN_A=$(npm run token --silent -- user-a)   # tenant-a
export TOKEN_B=$(npm run token --silent -- user-b)   # tenant-b
export TOKEN_C=$(npm run token --silent -- user-c)   # tenant-shared
export TOKEN_D=$(npm run token --silent -- user-d)   # tenant-shared
```

A helper for reading an IPSet straight from WAF, used to confirm the scenarios:

```bash
ipset() {   # usage: ipset tenant-a
  local name="websg-cms-allowlist-$1"
  aws wafv2 get-ip-set --scope REGIONAL --name "$name" \
    --id "$(terraform -chdir=../terraform output -json ip_sets | jq -r --arg n "$name" '.[$n].id')" \
    --query 'IPSet.Addresses' --output json
}
```

Every list below starts at `version: 0`; if you have already written one, read the current
version with `GET` and use that in `If-Match`.

---

## Scenario 1 — Two agencies sharing one IPSet

`user-c` and `user-d` are both mapped to `tenant-shared`, so they share one partition and one
IPSet. Each manages only its own list; the worker applies the union.

```bash
curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_C" -H 'content-type: application/json' \
  -H 'if-match: 0' -d '{"cidrs":["203.0.113.0/24"]}'

curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_D" -H 'content-type: application/json' \
  -H 'if-match: 0' -d '{"cidrs":["198.51.100.0/24"]}'

ipset tenant-shared
```

The IPSet ends up holding **both** ranges plus the break-glass ranges from `prod.tfvars`:

```
[ "112.134.158.144/32",   (break-glass)
  "198.51.100.0/24",      (user-d)
  "203.0.113.0/24" ]      (user-c)
```

Neither agency can see or remove the other's ranges — `GET` returns only the caller's own
list. When C edits, the worker still re-applies D's ranges, because it rebuilds from every
item in the tenant's partition rather than patching C's entries in.

---

## Scenario 2 — Tenants with their own IPSet

Full isolation: A's ranges never touch B's IPSet. Same API call, same worker, different
tenant key.

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

The same Lambda handled all four users across three IPSets in this and the previous
scenario, with no code change between them. A's edit does not even *read* B's IPSet: the
worker takes the affected tenant from the `tenantId` on the message. A tenant id it does not
recognise falls back to a full sweep — being slow beats silently skipping an IPSet.

---

## Scenario 3 — Waiting for a change to go live

A write waits up to `SYNC_WAIT_MS` for the worker's acknowledgement, so it usually answers
**200 with `syncStatus: "APPLIED"`** — confirmed live in WAF. If the window elapses first
the answer is **202 `PENDING`**: stored and durable, not yet enforced.

```bash
curl -isX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -H 'if-match: 1' -d '{"cidrs":["192.0.2.128/25","198.51.100.64/26"]}'
# HTTP/1.1 200 OK
# etag: 2
# {"version":2,"syncStatus":"APPLIED","syncedVersion":2,"syncedAt":"..."}
```

If it came back 202, poll until it lands:

```bash
until curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN_A" \
      | grep -q '"syncStatus":"APPLIED"'; do
  sleep 2
done
echo "live in WAF"
```

`syncStatus` is derived from `syncedVersion == version`, never stored, so it cannot claim
`APPLIED` for a version WAF does not hold. Set `SYNC_WAIT_MS=0` in `.env` to see the
`PENDING` path on demand.

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

Both succeed. Different tenants means different FIFO message groups, so the two reconcile in
parallel, and they target different IPSets.

Run the same pair as `user-c` and `user-d` and they target the *same* IPSet — and because
the message group is the **tenant**, not the owner, SQS holds the second message until the
first batch is done. The two reconcile in sequence, there is never a second concurrent
writer to that IPSet, and neither attempt is wasted losing a `LockToken` race.

That is the whole reason the queue is here. Grouping by owner would have let two members of
one tenant collide; grouping by tenant makes the collision structurally impossible rather
than eventually resolved.

The scheduled sweep is grouped the same way, one message per tenant in that tenant's group.
A sweep therefore queues *behind* a tenant's edits instead of running alongside them —
without that, the sweep would be the one producer able to collide on exactly the lock token
everything else is arranged to protect.

---

## Scenario 5 — Two tabs editing the same list

`If-Match` is the version last read. A stale one is rejected rather than silently winning:

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

The check is not just in the API: the write is a DynamoDB `PutItem` conditional on the
stored version, so two requests that pass the header check still cannot both land.

---

## Scenario 6 — Rejected input

```bash
curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -H 'if-match: 3' \
  -d '{"cidrs":["10.0.0.1","203.0.113.9/24","not-an-ip","203.0.0.0/8","2001:db8::/48"]}'
```

```json
{
  "error": "Invalid IP allowlist",
  "reasons": [
    "\"10.0.0.1\": private, loopback, link-local or reserved ranges are not allowed",
    "\"203.0.113.9/24\": host bits set, use the network address for /24",
    "\"not-an-ip\": not a valid IPv4 address",
    "\"203.0.0.0/8\": range too broad, use /24 or narrower",
    "\"2001:db8::/48\": IPv6 is not supported, use an IPv4 address or CIDR"
  ]
}
```

Every entry is reported at once, and **nothing is written** — a partial list is never
stored. Valid input is canonicalised: `203.0.113.9` becomes `203.0.113.9/32`, duplicates
collapse, and the list is sorted, so what WAF holds is exactly what the API returns.

**IPv6 is rejected deliberately, and named as its own reason** rather than lumped in with
malformed input. WAF IPSets are single-family and the ones this platform provisions are
`IPV4`, so accepting a v6 range would store an address that is reported `PENDING` and never
goes live — the API promising something the infrastructure cannot deliver. Supporting it
means a second IPSet per tenant, family routing in the worker, and both sets referenced from
the CMS WebACL; until that is done, the honest answer is a 400.

---

## Scenario 7 — Someone else's list, and no token at all

There is no id in the route, so "read another tenant's list" is not a request that can be
expressed. What is left is the token itself:

```bash
# No token
curl -s -o /dev/null -w 'no token:   %{http_code}\n' $API/v1/allowlist          # 401

# Tampered / wrong-key token
curl -s -o /dev/null -w 'bad token:  %{http_code}\n' $API/v1/allowlist \
  -H 'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.nope'                      # 401

# A user who is not in the directory cannot even be issued a token
npm run token --silent -- user-z          # Error: unknown user: user-z

# user-c and user-d resolve to the same tenant, but to different lists
curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN_C" | grep -o '"ownerId":"[^"]*"'
curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN_D" | grep -o '"ownerId":"[^"]*"'
```

The tenant is resolved from the server-side directory keyed by the token's `sub`, never from
a claim, so a forged `tenant_id` has nothing to attach to — and a `sub` that is not in the
directory is rejected with 401 even if the signature is valid. Isolation is enforced twice: the
API only ever addresses the caller's own item, and the worker only writes a table's contents
into that table's own IPSet.

---

## Scenario 8 — Someone edits WAF by hand

Say an operator adds `10.10.10.10/32` to tenant A's IPSet in the console.

1. **It should not be possible.** [iam/deny-manual-ipset-edits.json](iam/deny-manual-ipset-edits.json),
   attached as an SCP, denies `wafv2:UpdateIPSet` to every principal except the worker role
   and a break-glass role. An explicit `Deny` beats any `Allow`, including an
   administrator's.
2. **If it happened anyway**, the scheduled drift check (every 15 minutes) reconciles from
   the table and the extra range disappears. No API call is involved.
3. **Terraform will not fight it either way** — `ignore_changes = [addresses]` means
   `terraform apply` never resets the IPSet to an empty list.

To force the sweep immediately instead of waiting:

```bash
aws lambda invoke --function-name $(terraform -chdir=terraform output -raw function_name) \
  --payload '{"Records":[]}' /dev/stdout
```

An unrecognised payload means "full sweep", so this reconciles every IPSet — being slow
beats silently skipping one.

---

## Scenario 9 — A sync fails

WAF throttles, or an IPSet hits its address limit.

- The worker reconciles every tenant it can, then returns **only the message ids belonging
  to tenants that failed** (`ReportBatchItemFailures` on the event source mapping). The
  healthy tenants' messages are deleted from the queue as normal.
- That is what makes "one tenant's problem must not block every other tenant" true rather
  than aspirational. Failing the whole batch would return all ten messages and tick nine
  healthy tenants toward the DLQ threshold on someone else's behalf.
- The failed messages are redelivered up to 5 times. After that they land on the FIFO DLQ,
  the `dlq-not-empty` alarm fires to SNS, and the affected user's `syncStatus` stays
  `PENDING`.

Nothing on the API side fails while this is happening — writes keep succeeding. That is
exactly why the alarms exist.

**Slow or stuck?** The DLQ alarm only fires once something has failed five times. For the
quieter failure — edits not going live while nothing errors hard enough to be parked — the
worker reports, per tenant, how old its oldest unacknowledged edit was when it read the
partition:

```bash
aws cloudwatch get-metric-statistics \
  --namespace WebSG/Allowlist --metric-name OldestUnacknowledgedAgeSeconds \
  --dimensions Name=Tenant,Value=tenant-a \
  --start-time "$(date -u -v-2H +%FT%TZ)" --end-time "$(date -u +%FT%TZ)" \
  --period 900 --statistics Maximum
```

A few seconds is healthy. A number climbing sweep after sweep is stuck, and the
`sync-stuck-<tenant>` alarm fires above 5 minutes. It is emitted as embedded metric format
on stdout, so it costs a log line and no `cloudwatch:PutMetricData` permission — and it is
emitted *before* reconciling, so a tenant whose sync keeps failing still reports rather than
going blind exactly when the signal is needed.

```bash
aws sqs receive-message --queue-url $(terraform -chdir=terraform output -raw dlq_url)
# fix the cause, then replay:
aws sqs start-message-move-task --source-arn <dlq-arn>
```

Often no replay is needed: the worker rebuilds from a full read of the tenant's partition, so
a later successful run has already applied the parked change. Compare the IPSet with the
table first, then purge instead. The runbook is in [terraform/README.md](terraform/README.md#runbook-the-dlq-alarm-fired).

---

## Scenario 10 — Onboarding a tenant

One entry in [terraform/prod.tfvars](terraform/prod.tfvars), then apply:

```hcl
tenants = {
  tenant-a      = { description = "Agency A CMS" }
  tenant-b      = { description = "Agency B CMS" }
  tenant-shared = { description = "Agencies C and D, one shared IPSet" }
  tenant-e      = { description = "Agency E CMS" }   # new
}
```

```bash
make apply
```

That creates the IPSet, adds a sweep target in the new tenant's message group, adds its
stuck-sync alarm, and re-renders the worker's `TENANTS` variable — **no code change to the
worker**, and a Terraform diff a reviewer can read. There is no new table, no new stream and
no new Pipe: the tenant is a partition key in the existing table, so the diff is a handful
of resources rather than a module instance.

| You want | Do this |
| -------- | ------- |
| A tenant with its own IPSet | add a tenant key |
| Agencies sharing one IPSet | point their users at one tenant key — separate items, union applied |
| Split a shared agency out later | add its own key and move its item |

The one thing that is *not* configuration today is the user directory: because this build
stands in for the portal's IdP, a new user also needs an entry in
[backend/src/config/users.ts](backend/src/config/users.ts). With a real IdP that mapping
comes from the token exchange and onboarding is Terraform only.

---

## What it does not do yet

Stated plainly, because these are the questions worth asking next:

- **No IdP.** Tokens are HS256, signed and verified with a shared secret, and users live in
  a checked-in directory. Production wants JWKS verification against the portal's IdP and
  the user → tenant mapping from the directory service — a change to
  [jwt.ts](backend/src/lib/jwt.ts) and [users.ts](backend/src/config/users.ts), not to the
  routes, service or worker.
- **No `FAILED` status on the API.** A change that never applies stays `PENDING`. Operators
  can tell slow from stuck via the `OldestUnacknowledgedAgeSeconds` metric and the
  `sync-stuck-<tenant>` alarm, but the portal still cannot: surfacing it to the tenant means
  a real terminal state on the item, written by the worker when it gives up.
- **IPv6 is rejected, not supported.** The IPSets are `IPV4`, so a v6 range is a 400 rather
  than a promise that never goes live. Supporting it is a second IPSet per tenant, family
  routing in the worker, and both sets in the WebACL rule.
- **The WebACL rules are not in this repo.** The `ip_sets` output exports the ids; wiring
  `Host == <tenant>.cms.websg.gov.sg AND NOT ip in <IPSet>` lives with the CMS WebACL. Past
  ~100 tenants those per-tenant rules hit the 1,500 WCU cap and want a single rule backed by
  a CloudFront Function doing a host + IP lookup.
- **No audit trail endpoint.** Each item carries `ownerId`, `version` and `updatedAt`, but
  history needs a DynamoDB stream enabled on the table and archived somewhere. The table has
  no stream today — the sync path no longer needs one.
- **No OpenAPI document.** Two routes and a fixed schema shape did not justify the
  dependency; the schemas in
  [schemas.ts](backend/src/modules/ip-allowlist/schemas.ts) are the contract.
