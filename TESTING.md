# Testing

58 tests. The two questions that matter most for this design:

- **Separate IPSets** — do a tenant's ranges stay out of every other tenant's IPSet?
- **Shared IPSet** — when agencies deliberately share one, does everybody's ranges survive
  each other's edits?

Both are the *same code path* in the worker. Sharing or isolating is a `prod.tfvars`
decision, not a mode the code branches on.

[Running](#running-them) · [Suites](#what-the-suites-are) ·
[Validation](#validation-what-goes-in-what-comes-out) ·
[Add / remove](#adding-and-removing-one-ip) ·
[Separate IPSets](#separate-ipsets) · [Shared IPSet](#shared-ipset) ·
[Cost of sharing](#what-sharing-an-ipset-costs-you) ·
[Everything else](#everything-else-the-suites-cover) ·
[Not covered](#what-the-suites-cannot-prove)

## Running them

```bash
make test                  # both suites

cd backend && npm test     # 39 tests
cd lambda   && npm test    # 19 tests
```

No AWS credentials, no running server, no Docker, no network. `node --test` with Node 24's
type stripping — no test framework, no `ts-node`, no bundler.

## What the suites are

| Suite | File | Substitutes |
| ----- | ---- | ----------- |
| CIDR validation | [test/unit/cidr.test.ts](backend/test/unit/cidr.test.ts) | nothing — `lib/` is pure |
| Service rules | [test/unit/service.test.ts](backend/test/unit/service.test.ts) | in-memory repository with DynamoDB's optimistic-locking contract; a notifier that records what would have been queued |
| HTTP | [test/integration/ip-allowlist.test.ts](backend/test/integration/ip-allowlist.test.ts) | the same two fakes; the **real app** via `fastify.inject` |
| Worker | [lambda/test/handler.test.ts](lambda/test/handler.test.ts) | the AWS SDK *transport* only — the handler's real logic runs unchanged |

The worker suite stubs `DynamoDBDocumentClient.prototype.send` and
`WAFV2Client.prototype.send`, so `QueryCommand`, `GetIPSetCommand` and `UpdateIPSetCommand`
are asserted exactly as the SDK would have sent them — addresses, scope and lock token. It
also captures `console.log` to assert the embedded metric, the same channel CloudWatch reads.
Its fixtures are shaped the way Terraform renders `TENANTS`, so a failure here means the real
deployment would misbehave the same way.

## Validation: what goes in, what comes out

`normalizeAllowlist` ([cidr.ts](backend/src/lib/cidr.ts)), 10 tests. Accepted:

| Sent | Stored | Rule |
| ---- | ------ | ---- |
| `203.0.113.9` | `203.0.113.9/32` | bare address widened |
| `198.51.100.0/24` | `198.51.100.0/24` | explicit CIDR kept verbatim |
| `203.0.113.9`, `203.0.113.9/32` | `203.0.113.9/32` | duplicates collapse after widening |
| `["203.0.113.0/24","198.51.100.0/24"]` | `["198.51.100.0/24","203.0.113.0/24"]` | always sorted |

Rejected — `400`, one reason per entry, **nothing written**:

| Sent | Reason |
| ---- | ------ |
| `10.0.0.1`, `127.0.0.1`, `192.168.1.1`, `172.16.0.1`, `100.64.0.1`, `169.254.1.1` | `private, loopback, link-local or reserved ranges are not allowed` |
| `203.0.113.9/24` | `host bits set, use the network address for /24` |
| `203.0.0.0/8` | `range too broad, use /24 or narrower` |
| `not-an-ip`, `203.0.113.9/24/8`, `203.0.113.9/33` | `not a valid IPv4 address` / `malformed CIDR` / `prefix length out of range` |
| `2001:db8::/48` | `IPv6 is not supported, use an IPv4 address or CIDR` |
| 51 entries | `At most 50 entries are allowed` |

Two tests cover IPv6 separately: `rejects IPv6, which the IPV4 WAF IPSets cannot hold` pins
the decision, `says IPv6 is unsupported rather than that it is malformed` pins the *reason
string* — collapsing it into "not a valid IP" would send someone hunting a typo that is not
there.

`reports every invalid entry at once` and `rejects an invalid list without writing anything`
pin that a five-bad-entry body returns five reasons and leaves the item untouched.

## Adding and removing one IP

There is no `POST`/`DELETE` — every change is a full `PUT`. What that means concretely,
starting from `["198.51.100.0/24"]` at `version: 1`:

| Action | Body sent | If-Match | Result | Version |
| ------ | --------- | -------- | ------ | ------- |
| Add `203.0.113.9` | `["198.51.100.0/24","203.0.113.9"]` | `1` | `["198.51.100.0/24","203.0.113.9/32"]` | `2` |
| Remove it, bare form | subtracting `203.0.113.9` matches nothing, so the body is still `["198.51.100.0/24","203.0.113.9/32"]` | `2` | **unchanged — still holds `203.0.113.9/32`** | `3` |
| Remove it, stored form | `["198.51.100.0/24"]` | `3` | `["198.51.100.0/24"]` | `4` |
| Clear the list | `[]` | `4` | `[]` → IPSet holds break-glass only | `5` |

Row 2 is the trap: **removal is by exact string, and the stored form is normalised.**
Subtracting `203.0.113.9` from a list holding `203.0.113.9/32` matches nothing, and the `PUT`
succeeds having changed nothing while still bumping the version. Subtracting both forms is
what makes it work either way:

```bash
# Add one IP, keeping the rest
CUR=$(curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN")
curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "if-match: $(jq -r .version <<<"$CUR")" \
  -d "$(jq -c '{cidrs: (.cidrs + ["203.0.113.9"] | unique)}' <<<"$CUR")"

# Remove one IP - subtract the bare address AND its /32
IP=203.0.113.9
CUR=$(curl -s $API/v1/allowlist -H "authorization: Bearer $TOKEN")
curl -sX PUT $API/v1/allowlist \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "if-match: $(jq -r .version <<<"$CUR")" \
  -d "$(jq -c --arg ip "$IP" '{cidrs: (.cidrs - [$ip, "\($ip)/32"])}' <<<"$CUR")"
```

Read and write are two requests, so a concurrent edit between them makes the `PUT` fail
`409` — the optimistic lock working. Re-read and re-apply; do not retry with a bumped version.

An explicit range is stored exactly as sent, so subtract the same string you added —
`198.51.100.0/24` comes back as `198.51.100.0/24`, never rounded or re-prefixed, because a
CIDR with host bits set is rejected outright rather than corrected.

Pinned by `normalises entries before storing them`, `widens a bare IPv4 address to /32 and
sorts the result`, `deduplicates equivalent entries`, and
`stores a normalised allowlist against the caller` (HTTP).

## Separate IPSets

**What we are solving:** agency A's ranges must never reach agency B's IPSet, and A's edit
must not cost B anything. Isolation is *structural* — one partition feeds exactly one IPSet —
so the tests assert that structure, not a permission check.

| Test | What it proves |
| ---- | -------------- |
| `each tenant gets its own IPSet, built from its own partition` | Two tenants → two `UpdateIPSet` calls; `ipset-a` holds only A's range + break-glass, `ipset-b` only B's. The core isolation assertion. |
| `an edit touches only the IPSet of the tenant it came from` | An edit carrying `tenantId: tenant-a` reconciles `ipset-a` and does not even *read* `ipset-b`. |
| `queries one partition per tenant, strongly consistent, instead of scanning` | A `Query` keyed on `tenantId`, not a `Scan`. The worker cannot read across tenants even by accident. |
| `uses the lock token belonging to each IPSet` | Each `UpdateIPSet` presents the token from *its own* `GetIPSet`. |
| `one tenant failing does not block the others` | WAF fails for `ipset-a`; `ipset-b` is still applied **and** acknowledged. |
| `returns only the failed tenant's messages, not the whole batch` | `batchItemFailures` holds A's message id and not B's. Without this the previous test is hollow — B would be redelivered anyway and tick toward the DLQ on A's behalf. |
| `a sweep message is retried when any tenant in the sweep fails` | A sweep is acknowledged only if every tenant succeeded. |
| `an unknown tenant id falls back to a full sweep rather than skipping` | A mistyped or decommissioned id sweeps everything. Being slow beats skipping an IPSet. |
| `a user only ever writes its own list` (HTTP) | `user-a`'s write lands in `tenant-a` and nowhere else — `repository.get('tenant-b','user-a')` is `null`. |
| `a write signals the sync worker with the tenant resolved from the token` (HTTP) | The message group is the tenant from the server-side directory — the mutex keys off something the caller cannot influence. |
| `resolves the tenant from the directory, not from the caller` (HTTP) | A forged `tenant_id` claim has nothing to attach to. |

There is no "cross-tenant request rejected with 403" test, because **there is no request to
reject**: no route carries a tenant or user id, so a caller cannot express another tenant's
list. The tests above assert the property that replaces it.

## Shared IPSet

**What we are solving:** agencies C and D sit behind one IPSet on purpose. Each manages only
its own list, neither can see the other's, and the IPSet must hold the **union** — including
when only one of them edits.

Concretely, `tenant-shared` with break-glass `112.134.158.144/32`:

| C's list | D's list | IPSet after either edit |
| -------- | -------- | ----------------------- |
| `203.0.113.0/24` | `198.51.100.0/24` | `112.134.158.144/32`, `198.51.100.0/24`, `203.0.113.0/24` |
| `203.0.113.0/24` → `192.0.2.0/24` | `198.51.100.0/24` (untouched) | `112.134.158.144/32`, `192.0.2.0/24`, `198.51.100.0/24` |

| Test | What it proves |
| ---- | -------------- |
| `agencies sharing a tenant get the union in one IPSet` | Two items in one partition → **one** `UpdateIPSet`, not one per agency, carrying both ranges + break-glass. |
| `an edit by one agency of a shared tenant still applies the union` | C edits, D did not, D's ranges survive — row 2 above. The test that would catch a delta-based rewrite. |
| `users sharing a tenant keep separate lists in one table` (HTTP) | Same partition, separate items keyed by `ownerId`. Neither overwrites the other. |
| `queries one partition per tenant, strongly consistent, instead of scanning` | `ConsistentRead: true` — an eventually consistent read can miss the very write that triggered the run, publishing an IPSet missing a range just saved. |

The union is one line in [index.ts](lambda/src/index.ts):

```ts
const desired = [
  ...new Set([...env.breakGlass, ...allowlists.flatMap((item) => item.cidrs)]),
].sort();
```

A `Set` of canonical strings. Read the next section before relying on that.

## What sharing an IPSet costs you

Properties of sharing, not defects — but they surprise people, so they belong in the decision.

**1. Dedup is exact-string, not overlap-aware.**

| C has | D has | IPSet holds |
| ----- | ----- | ----------- |
| `203.0.113.9/32` | `203.0.113.0/24` | **both** — the `/24` covers the `/32`, so it is redundant, not wrong, but costs two entries |
| `203.0.113.0/24` | `203.0.113.0/24` | one — identical strings collapse |

**2. A removal is only effective when the last holder drops it.** If C and D both list
`203.0.113.9/32` and C removes it, **the IP stays allowed**, because D still holds it. C
cannot see why — `GET` returns only their own list. On a shared IPSet, "I removed it" means
"I stopped vouching for it", not "it is now blocked". An agency needing removal to mean
revocation needs its own tenant key.

**3. Concurrent edits serialise.** Two users in one tenant never get a `409` — the lock is
per item (`{tenantId, ownerId}`), so both writes succeed. Both then rebuild the *same* IPSet,
but the FIFO group is the tenant, so SQS holds the second until the first is done. The cost
is latency, not correctness: the second edit's `APPLIED` waits behind the first. On separate
IPSets this queuing does not exist. (Grouping by `ownerId` would let the two run concurrently
and collide — exactly the failure mode tenant grouping removes.)

**4. The entry budget is shared.** `MAX_ENTRIES` (50) is per *user*; WAF's 10,000 applies to
the union. Fine at the documented scale, worth a thought if one key ever holds many agencies.

**5. Blast radius is shared.** A sync failure or a bad break-glass range affects every agency
behind that IPSet at once. The per-tenant failure tests bound this to the one IPSet — they do
not divide it further.

Points 1 and 2 have no automated test today, because both are *emergent* from the union
rather than coded anywhere. To pin them: a worker test asserting an overlapping `/32` + `/24`
produces two entries, and one asserting a range still held by a co-tenant survives removal.

## Everything else the suites cover

| Area | Tests |
| ---- | ----- |
| **Sync status** | fresh write is `PENDING`; `APPLIED` once acknowledged within the wait; `PENDING` rather than hanging when the wait elapses. Same three asserted over HTTP. |
| **Lost updates** | `requires If-Match to prevent lost updates` (428), `returns 409 when If-Match is stale`, `rejects a write against a stale version` at the service layer. |
| **The signal path** | `signals the sync worker once per write, grouped by tenant` asserts the version is in the signal — what makes the `tenant:owner:version` dedup id tell a real second edit from a retry. `does not signal when validation rejects the write` keeps rejected input off the queue. |
| **Auth** | no token, wrong signing key, and a user absent from the directory are all 401. |
| **Worker housekeeping** | `reverts a manual edit made outside the application`, `skips the update when an IPSet already matches` (no pointless WAF writes), `the drift check sweeps every IPSet it is told about`, plus the two acknowledgement tests. |
| **The stuck signal** | zero when everything is acknowledged (recovery visible, not inferred from missing data), the age of the *oldest* unacknowledged edit rather than the newest, and `still reports sync lag for a tenant whose reconcile fails`. |

Two worth reading in full:

**`a failed signal still stores the write and answers PENDING`** — the DynamoDB write and the
`SendMessage` are not atomic, and this pins which one may fail: the edit stays durable, the
response is honestly `PENDING`, the loss is logged, and the 15-minute sweep picks it up. A
500 here would tell the caller their saved edit was lost.

**`a write never carries the previous acknowledgement`** — a new version has not reached WAF,
so it must not inherit the previous `syncedVersion`, or an unapplied edit reports as already
live.

## What the suites cannot prove

These need real AWS. Each has a walkthrough in
[ARCHITECTURE.md](ARCHITECTURE.md#setup-for-the-walkthroughs):

| Not covered by tests | Verify with |
| -------------------- | ----------- |
| FIFO really serialising two edits in one tenant's group | Scenario 4 as `user-c` + `user-d` — both settle to `APPLIED`, no lock exception in the logs |
| `MessageDeduplicationId` collapsing a retry but not a real edit | Scenario 3 — save twice quickly, confirm both versions reach WAF |
| The sweep queuing behind edits rather than beside them | Scenario 8 — edit while a sweep is due |
| The SCP denying manual `wafv2:UpdateIPSet` | Scenario 8 — try a console edit |
| The 15-minute drift schedule firing | Scenario 8 — edit in the console, wait |
| DLQ parking, the alarm and redrive | Scenario 9 and the [runbook](terraform/README.md#runbook-the-dlq-alarm-fired) |
| The `sync-stuck-<tenant>` alarm on a real stall | Scenario 9 — break the worker's WAF permission, wait two sweeps |
| `ignore_changes = [addresses]` surviving an apply | write a list, `make apply`, re-read the IPSet |

The split is deliberate: everything that is *logic* is tested offline in under a second;
everything that is *AWS behaviour* is verified against the deployed system, because a mock of
it would only prove the mock.
