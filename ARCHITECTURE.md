# Architecture and scenarios

What the system is, what it can handle today, and a runnable call for every scenario.

- [The shape of it](#the-shape-of-it)
- [Why it is split this way](#why-it-is-split-this-way)
- [Setup for the walkthroughs](#setup-for-the-walkthroughs)
- [Scenario 1 — Tenants A and B share one IPSet](#scenario-1--tenants-a-and-b-share-one-ipset)
- [Scenario 2 — Tenants C and D each get their own IPSet](#scenario-2--tenants-c-and-d-each-get-their-own-ipset)
- [Scenario 3 — Admin assigns, moves and detaches an IPSet](#scenario-3--admin-assigns-moves-and-detaches-an-ipset)
- [Scenario 4 — Waiting for a change to go live](#scenario-4--waiting-for-a-change-to-go-live)
- [Scenario 5 — Two tenants editing at the same time](#scenario-5--two-tenants-editing-at-the-same-time)
- [Scenario 6 — Two admins editing the same tenant](#scenario-6--two-admins-editing-the-same-tenant)
- [Scenario 7 — Rejected input](#scenario-7--rejected-input)
- [Scenario 8 — Cross-tenant access](#scenario-8--cross-tenant-access)
- [Scenario 9 — Someone edits WAF by hand](#scenario-9--someone-edits-waf-by-hand)
- [Scenario 10 — A sync fails](#scenario-10--a-sync-fails)
- [Scenario 11 — Onboarding a new tenant](#scenario-11--onboarding-a-new-tenant)
- [What it does not do yet](#what-it-does-not-do-yet)

## The shape of it

```
                        ┌──────────────────────────────────────────────┐
  tenant user  ──PUT──► │  Allowlist API  (Fastify, pod on CMS EKS)    │
  admin user   ──PUT──► │  validates, authorises, writes desired state │
                        └───────────────────┬──────────────────────────┘
                                            │ PutItem / UpdateItem
                                            ▼
                        ┌──────────────────────────────────────────────┐
                        │  DynamoDB                                    │
                        │   • allowlist table   (tenantId → CIDRs)     │
                        │   • mapping table     (tenantId → IPSet)     │
                        └───────────────────┬──────────────────────────┘
                                            │ stream (NEW_IMAGE)
                                            ▼
                        ┌──────────────────────────────────────────────┐
                        │  EventBridge Pipe                            │
                        │   • filters out the worker's own writes      │
                        │   • MessageGroupId = tenantId                │
                        └───────────────────┬──────────────────────────┘
                                            ▼
   schedule (15 min) ─────────────►  ┌──────────────┐      ┌─────────┐
                                     │ SQS FIFO     │─────►│  DLQ    │──► alarm ──► SNS
                                     └──────┬───────┘      └─────────┘
                                            ▼
                        ┌──────────────────────────────────────────────┐
                        │  WAF Sync Lambda  (single function)          │
                        │   reads both tables, groups tenants by IPSet │
                        └───────┬───────────────────┬──────────────────┘
                                ▼                   ▼
                        ┌───────────────┐   ┌───────────────┐
                        │ IPSet shared  │   │ IPSet per     │   ... one call per IPSet,
                        │ (A + B union) │   │ tenant (C, D) │       lock-token guarded
                        └───────────────┘   └───────────────┘
```

## Why it is split this way

**The API never calls WAF.** It owns *desired state* only. A WAF throttle or lock conflict
never surfaces to a tenant, and every WAF change is attributable to a stored record with
`updatedBy` and `updatedAt`.

**The worker reconciles, it does not apply deltas.** It ignores message contents and
rebuilds each IPSet from the tables. Retries, redelivery, duplicate messages and the
scheduled sweep all converge on the same result. This is why swapping the transport from
DynamoDB Streams to SQS changed one type annotation.

**One Lambda, many IPSets.** Tenants are grouped by the IPSet their mapping names. Same
IPSet → union of their lists. Different IPSets → separate `UpdateIPSet` calls, each with
its own lock token. Shared and per-tenant are the same code path, not two modes.

**Onboarding is configuration.** Adding a tenant is a Terraform entry or an admin API call.
No code change, no redeploy.

## Setup for the walkthroughs

```bash
cd backend
cp .env.example .env
npm install && npm run dev:db && npm run dev:table && npm run dev
```

Tokens (local HS256; in AWS these come from the portal's IdP):

```bash
export API=http://localhost:3000

export TOKEN_A=$(npm run token --silent -- agency-a)
export TOKEN_B=$(npm run token --silent -- agency-b)
export TOKEN_C=$(npm run token --silent -- agency-c)
export TOKEN_D=$(npm run token --silent -- agency-d)
export TOKEN_ADMIN=$(npm run token --silent -- platform admin)
```

Every call below is copy-pasteable against that local server.

---

## Scenario 1 — Tenants A and B share one IPSet

Both agencies are behind the shared CMS IPSet. Each manages only its own list; the worker
applies the union to the one IPSet.

**Point both at the same IPSet** (admin, once):

```bash
curl -sX PUT $API/v1/admin/tenants/agency-a/ip-set \
  -H "authorization: Bearer $TOKEN_ADMIN" -H 'content-type: application/json' \
  -d '{"ipSetId":"a1b2c3d4-1111-2222-3333-444455556666",
       "ipSetName":"websg-cms-allowlist-shared","description":"Agency A"}'

curl -sX PUT $API/v1/admin/tenants/agency-b/ip-set \
  -H "authorization: Bearer $TOKEN_ADMIN" -H 'content-type: application/json' \
  -d '{"ipSetId":"a1b2c3d4-1111-2222-3333-444455556666",
       "ipSetName":"websg-cms-allowlist-shared","description":"Agency B"}'
```

**Each tenant edits its own list:**

```bash
curl -sX PUT $API/v1/tenants/agency-a/ip-allowlist \
  -H "authorization: Bearer $TOKEN_A" -H 'content-type: application/json' \
  -H 'if-match: 0' -d '{"cidrs":["203.0.113.0/24"]}'

curl -sX PUT $API/v1/tenants/agency-b/ip-allowlist \
  -H "authorization: Bearer $TOKEN_B" -H 'content-type: application/json' \
  -H 'if-match: 0' -d '{"cidrs":["198.51.100.0/24"]}'
```

Each returns `202` with `syncStatus: "PENDING"`. The IPSet ends up holding **both** ranges
plus the break-glass ranges:

```
192.0.2.0/24        (break-glass)
198.51.100.0/24     (agency-b)
203.0.113.0/24      (agency-a)
```

Neither tenant can see or remove the other's ranges — `GET` returns only their own list.
When A edits, the worker still re-applies B's ranges, because it rebuilds the IPSet from
every tenant mapped to it rather than patching A's entries in.

---

## Scenario 2 — Tenants C and D each get their own IPSet

Full isolation: C's ranges never touch D's IPSet.

```bash
curl -sX PUT $API/v1/admin/tenants/agency-c/ip-set \
  -H "authorization: Bearer $TOKEN_ADMIN" -H 'content-type: application/json' \
  -d '{"ipSetId":"c1c1c1c1-1111-2222-3333-444455556666",
       "ipSetName":"websg-cms-allowlist-agency-c"}'

curl -sX PUT $API/v1/admin/tenants/agency-d/ip-set \
  -H "authorization: Bearer $TOKEN_ADMIN" -H 'content-type: application/json' \
  -d '{"ipSetId":"d1d1d1d1-1111-2222-3333-444455556666",
       "ipSetName":"websg-cms-allowlist-agency-d"}'

curl -sX PUT $API/v1/tenants/agency-c/ip-allowlist \
  -H "authorization: Bearer $TOKEN_C" -H 'content-type: application/json' \
  -H 'if-match: 0' -d '{"cidrs":["192.0.2.128/25"]}'

curl -sX PUT $API/v1/tenants/agency-d/ip-allowlist \
  -H "authorization: Bearer $TOKEN_D" -H 'content-type: application/json' \
  -H 'if-match: 0' -d '{"cidrs":["203.0.113.128/25"]}'
```

Result: IPSet C holds C's ranges, IPSet D holds D's. The same Lambda handled all four
tenants across three IPSets in this and the previous scenario, with no code change between
them.

Because the message group is the tenant id, C's edit and D's edit are **processed in
parallel** — and C's invocation does not even read D's IPSet.

---

## Scenario 3 — Admin assigns, moves and detaches an IPSet

The mapping is platform data: tenants cannot read or change it, only `platform:admin` can.

```bash
# See every assignment
curl -s $API/v1/admin/ip-set-assignments -H "authorization: Bearer $TOKEN_ADMIN"

# Read one
curl -s $API/v1/admin/tenants/agency-c/ip-set -H "authorization: Bearer $TOKEN_ADMIN"

# Move agency-c off the shared set onto its own (same call as assign)
curl -sX PUT $API/v1/admin/tenants/agency-c/ip-set \
  -H "authorization: Bearer $TOKEN_ADMIN" -H 'content-type: application/json' \
  -d '{"ipSetId":"c1c1c1c1-1111-2222-3333-444455556666",
       "ipSetName":"websg-cms-allowlist-agency-c"}'

# Detach - the list is kept but is no longer applied anywhere
curl -isX DELETE $API/v1/admin/tenants/agency-c/ip-set \
  -H "authorization: Bearer $TOKEN_ADMIN"     # 204
```

A reassignment clears the tenant's acknowledgement, so its status returns to `PENDING` and
that write is what triggers the re-sync. A tenant does the same call and gets `403`:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X PUT $API/v1/admin/tenants/agency-c/ip-set \
  -H "authorization: Bearer $TOKEN_C" -H 'content-type: application/json' \
  -d '{"ipSetId":"c1c1c1c1-1111-2222-3333-444455556666","ipSetName":"x"}'   # 403
```

---

## Scenario 4 — Waiting for a change to go live

`202` means stored, not enforced. Poll until `syncStatus` is `APPLIED`:

```bash
curl -sX PUT $API/v1/tenants/agency-c/ip-allowlist \
  -H "authorization: Bearer $TOKEN_C" -H 'content-type: application/json' \
  -H 'if-match: 1' -d '{"cidrs":["192.0.2.128/25","198.51.100.64/26"]}'
# → 202 {"version":2,"syncStatus":"PENDING", ...}

until curl -s $API/v1/tenants/agency-c/ip-allowlist \
        -H "authorization: Bearer $TOKEN_C" | grep -q '"syncStatus":"APPLIED"'; do
  sleep 2
done
echo "live in WAF"
```

`syncStatus` is derived from `syncedVersion == version`, never stored, so it cannot claim
APPLIED for a version WAF does not hold.

---

## Scenario 5 — Two tenants editing at the same time

```bash
curl -sX PUT $API/v1/tenants/agency-c/ip-allowlist \
  -H "authorization: Bearer $TOKEN_C" -H 'content-type: application/json' \
  -H 'if-match: 2' -d '{"cidrs":["192.0.2.128/25"]}' &

curl -sX PUT $API/v1/tenants/agency-d/ip-allowlist \
  -H "authorization: Bearer $TOKEN_D" -H 'content-type: application/json' \
  -H 'if-match: 1' -d '{"cidrs":["203.0.113.128/25"]}' &
wait
```

Both succeed. Different IPSets, different message groups, parallel invocations.

If they had *shared* an IPSet, both invocations would target it and one would lose the
`LockToken` race — that call fails, the message returns to the queue, and the retry
reconciles from a fresh read. Correct either way; the difference is one wasted attempt.

---

## Scenario 6 — Two admins editing the same tenant

`If-Match` is the version last read. A stale one is rejected rather than silently winning:

```bash
V=$(curl -s $API/v1/tenants/agency-c/ip-allowlist \
      -H "authorization: Bearer $TOKEN_C" | sed 's/.*"version":\([0-9]*\).*/\1/')

curl -s -o /dev/null -w 'first:  %{http_code}\n' -X PUT $API/v1/tenants/agency-c/ip-allowlist \
  -H "authorization: Bearer $TOKEN_C" -H 'content-type: application/json' \
  -H "if-match: $V" -d '{"cidrs":["192.0.2.128/25"]}'          # 202

curl -s -o /dev/null -w 'second: %{http_code}\n' -X PUT $API/v1/tenants/agency-c/ip-allowlist \
  -H "authorization: Bearer $TOKEN_C" -H 'content-type: application/json' \
  -H "if-match: $V" -d '{"cidrs":["203.0.113.0/24"]}'          # 409

# Omitting If-Match entirely
curl -s -o /dev/null -w 'no header: %{http_code}\n' -X PUT $API/v1/tenants/agency-c/ip-allowlist \
  -H "authorization: Bearer $TOKEN_C" -H 'content-type: application/json' \
  -d '{"cidrs":["203.0.113.0/24"]}'                            # 428
```

---

## Scenario 7 — Rejected input

```bash
curl -sX PUT $API/v1/tenants/agency-c/ip-allowlist \
  -H "authorization: Bearer $TOKEN_C" -H 'content-type: application/json' \
  -H 'if-match: 3' -d '{"cidrs":["10.0.0.1","203.0.113.9/24","not-an-ip","203.0.0.0/8"]}'
```

```json
{
  "error": "Invalid IP allowlist",
  "reasons": [
    "\"10.0.0.1\": private, loopback, link-local or reserved ranges are not allowed",
    "\"203.0.113.9/24\": host bits set, use the network address for /24",
    "\"not-an-ip\": not a valid IP address",
    "\"203.0.0.0/8\": range too broad, use /24 or narrower"
  ]
}
```

Every entry is reported at once, and **nothing is written** — a partial list is never
stored. Valid input is canonicalised: `203.0.113.9` becomes `203.0.113.9/32`, duplicates
collapse, IPv6 is compressed, and the list is sorted.

---

## Scenario 8 — Cross-tenant access

```bash
# agency-c's token against agency-d's allowlist
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/tenants/agency-d/ip-allowlist \
  -H "authorization: Bearer $TOKEN_C"                    # 403

# No token
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/tenants/agency-c/ip-allowlist    # 401

# Tampered token
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/tenants/agency-c/ip-allowlist \
  -H 'authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.nope'                        # 401

# Admin may read any tenant
curl -s -o /dev/null -w '%{http_code}\n' $API/v1/tenants/agency-d/ip-allowlist \
  -H "authorization: Bearer $TOKEN_ADMIN"                # 200
```

Isolation is enforced twice: the API refuses cross-tenant requests, and the worker only
puts a tenant's CIDRs into the IPSet its own mapping names.

---

## Scenario 9 — Someone edits WAF by hand

Say an operator adds `10.10.10.10/32` to tenant C's IPSet in the console.

1. **It should not be possible.** `iam/deny-manual-ipset-edits.json`, attached as an SCP,
   denies `wafv2:UpdateIPSet` to everyone except the worker role and a break-glass role. An
   explicit `Deny` beats any `Allow`, including an administrator's.
2. **If it happened anyway**, the scheduled drift check (every 15 minutes) reconciles from
   the table and the extra range disappears. No API call is involved.
3. **Terraform will not fight it either way** — `ignore_changes = [addresses]` means
   `terraform apply` never resets the IPSet to an empty list.

To force the sweep immediately instead of waiting:

```bash
aws lambda invoke --function-name websg-cms-ip-allowlist-waf-sync \
  --payload '{"Records":[]}' /dev/stdout
```

An unrecognised payload means "full sweep", so this reconciles every IPSet.

---

## Scenario 10 — A sync fails

WAF throttles, or an IPSet hits its address limit.

- The failing IPSet's message returns to the queue and is redelivered up to 5 times.
- **Other tenants are unaffected** — the worker reconciles every IPSet it can, then fails
  the batch. One tenant's WAF problem does not block the platform.
- After 5 attempts the message lands on the FIFO DLQ, the `dlq-not-empty` alarm fires to
  SNS, and the affected tenant's `syncStatus` stays `PENDING`.

Nothing on the API side fails while this is happening. That is exactly why the alarm
exists — tenants keep getting `202`s.

```bash
aws sqs receive-message --queue-url $(terraform -chdir=terraform output -raw dlq_url)
# fix the cause, then replay:
aws sqs start-message-move-task --source-arn <dlq-arn>
```

Often no replay is needed: a later run already rebuilt the IPSet from the table.

---

## Scenario 11 — Onboarding a new tenant

Two supported routes, same result.

**Terraform** (reviewable, the default for planned onboarding):

```hcl
tenants = {
  agency-e = { ip_set_name = "websg-cms-allowlist-agency-e" }
}
```

`make apply` creates the IPSet and writes the mapping.

**Admin API** (for an existing IPSet, no deploy):

```bash
curl -sX PUT $API/v1/admin/tenants/agency-e/ip-set \
  -H "authorization: Bearer $TOKEN_ADMIN" -H 'content-type: application/json' \
  -d '{"ipSetId":"e1e1e1e1-1111-2222-3333-444455556666",
       "ipSetName":"websg-cms-allowlist-agency-e"}'
```

A tenant that saves a list before being mapped gets `202`, stays `PENDING`, and the worker
logs `tenants have no IPSet mapping`. Their ranges are never applied to another tenant's
IPSet.

---

## What it does not do yet

Stated plainly, because these are the questions worth asking next:

- **No `FAILED` status.** A change that never applies stays `PENDING` while the DLQ alarm
  fires. Distinguishing "slow" from "stuck" in the portal means consuming the DLQ.
- **The WebACL rules are not in this repo.** `module.tenants.ip_sets` exports the ids;
  wiring `Host == <tenant>.cms.websg.gov.sg AND NOT ip in <IPSet>` lives with the CMS
  WebACL. Past ~100 tenants those per-tenant rules hit the 1,500 WCU cap and want a single
  rule backed by a CloudFront Function doing a host + IP lookup.
- **The mapping API does not verify the IPSet exists.** It validates the id's shape, not
  that WAF has it. A typo surfaces as a failed sync and a DLQ alarm rather than a `400`.
- **No per-tenant audit trail endpoint.** `updatedBy` and `updatedAt` are stored on each
  record, but history needs the DynamoDB stream archived somewhere.
