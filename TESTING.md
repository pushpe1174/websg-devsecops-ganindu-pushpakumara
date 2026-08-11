# Testing

45 tests, split by the question they answer. The two that matter most for this design are:

- **Separate IPSets** — does a tenant's ranges stay out of every other tenant's IPSet?
- **Shared IPSet** — when agencies deliberately share one, does everybody's ranges survive
  each other's edits?

Both are the *same code path* in the worker, which is the point: sharing or isolating is a
`prod.tfvars` decision, not a mode the code branches on. The tests below are what hold that
claim up.

- [Running them](#running-them)
- [What the suites are](#what-the-suites-are)
- [Separate IPSets — what we test](#separate-ipsets--what-we-test)
- [Shared IPSet — what we test](#shared-ipset--what-we-test)
- [What sharing an IPSet actually costs you](#what-sharing-an-ipset-actually-costs-you)
- [Everything else the suites cover](#everything-else-the-suites-cover)
- [What the suites cannot prove](#what-the-suites-cannot-prove)

## Running them

```bash
make test                  # both suites

cd backend && npm test     # 33 tests
cd lambda   && npm test    # 12 tests
```

No AWS credentials, no running server, no Docker, no network. `node --test` with Node 24's
built-in type stripping — there is no test framework, no `ts-node` and no bundler in the
toolchain.

## What the suites are

| Suite | File | Substitutes |
| ----- | ---- | ----------- |
| CIDR validation | [test/unit/cidr.test.ts](backend/test/unit/cidr.test.ts) | nothing — `lib/` is framework-free and pure |
| Service rules | [test/unit/service.test.ts](backend/test/unit/service.test.ts) | an in-memory repository with DynamoDB's optimistic-locking contract |
| HTTP | [test/integration/ip-allowlist.test.ts](backend/test/integration/ip-allowlist.test.ts) | the same in-memory repository; the **real app** via `fastify.inject` |
| Worker | [lambda/test/handler.test.ts](lambda/test/handler.test.ts) | the AWS SDK *transport* only — the handler's real logic runs unchanged |

The worker suite stubs `DynamoDBDocumentClient.prototype.send` and
`WAFV2Client.prototype.send`, so `ScanCommand`, `GetIPSetCommand` and `UpdateIPSetCommand`
are asserted exactly as the SDK would have sent them — including the addresses, the scope
and the lock token.

Its fixtures are shaped the way Terraform renders `TENANTS`, so a test failing here means
the real deployment would misbehave the same way.

## Separate IPSets — what we test

**What we are solving:** agency A's ranges must never reach agency B's IPSet, and A's edit
must not cost B anything. Isolation here is *structural* — one table feeds exactly one
IPSet — so the tests assert that structure rather than a permission check.

| Test | What it proves |
| ---- | -------------- |
| `each tenant gets its own IPSet, built from its own table` | Two tenants, two tables, two `UpdateIPSet` calls. Asserts `ipset-a` holds **only** A's range + break-glass, and `ipset-b` only B's. This is the core isolation assertion. |
| `an edit touches only the IPSet of the table it came from` | An edit arriving from tenant A's stream reconciles `ipset-a` and **does not even read** `ipset-b`. Blast radius of one tenant's edit is one IPSet. |
| `uses the lock token belonging to each IPSet` | Each `UpdateIPSet` presents the token from *its own* `GetIPSet`, so a concurrent change to one IPSet cannot be clobbered using another's token. |
| `one tenant failing does not block the others` | WAF fails for `ipset-a`; `ipset-b` is still applied **and** acknowledged, and only then does the batch fail so SQS retries. One tenant's WAF problem is not a platform outage. |
| `a user only ever writes its own list` (HTTP) | `user-a`'s write lands in `tenant-a`'s table and nowhere else — `repository.get('tenant-b', 'user-a')` is `null`. |
| `resolves the tenant from the directory, not from the caller` (HTTP) | The tenant comes from the server-side directory keyed by the token's `sub`, never from a claim, so a forged `tenant_id` has nothing to attach to. |

There is no "cross-tenant request rejected with 403" test, because **there is no request to
reject**: no route carries a tenant or user id ([routes.ts](backend/src/modules/ip-allowlist/routes.ts)),
so a caller cannot express another tenant's list in the first place. The tests above assert
the property that replaces it.

## Shared IPSet — what we test

**What we are solving:** agencies C and D are behind one IPSet on purpose. Each manages only
its own list, neither can see the other's, and the IPSet must end up holding the **union** —
including after only one of them edits.

| Test | What it proves |
| ---- | -------------- |
| `agencies sharing a tenant table get the union in one IPSet` | Two items in one table → **one** `UpdateIPSet` (not one per agency) carrying both ranges plus break-glass. Asserted explicitly: *"a shared IPSet is reconciled once, not once per agency"*. |
| `an edit by one agency of a shared table still applies the union` | C edits; D did not. D's ranges **survive** — because the worker rebuilds from the whole table instead of patching C's entries in. This is the test that would catch a delta-based rewrite. |
| `users sharing a tenant keep separate lists in one table` (HTTP) | `user-c` and `user-d` write to the same table but remain separate items, each keyed by `ownerId`. Neither overwrites the other. |
| `reads each allowlist table with a strongly consistent scan` | `ConsistentRead: true`. A default eventually-consistent scan can miss the very write that triggered the run — on a shared table that means publishing an IPSet missing a range that was just saved. |

The union itself is one line in [index.ts](lambda/src/index.ts#L56-L58):

```ts
const desired = [
  ...new Set([...env.breakGlass, ...allowlists.flatMap((item) => item.cidrs)]),
].sort();
```

A `Set` of canonical strings. Read the next section before relying on that.

## What sharing an IPSet actually costs you

These are properties of sharing, not defects — but they are the things that surprise people,
so they belong in the decision.

**1. Dedup is exact-string, not overlap-aware.** If C has `1.1.1.1/32` and D has
`1.1.1.0/24`, the IPSet holds **both**. The `/24` already covers the `/32`, so it is
redundant rather than wrong — WAF matches if the client IP falls in *any* entry — but it
consumes two entries. Identical strings do collapse to one.

**2. A removal is only effective when the last holder drops it.** If C and D both list
`1.1.1.1/32` and C removes it, **the IP stays allowed**, because D still holds it. C cannot
see why: `GET` returns only their own list. On a shared IPSet, "I removed it" means "I
stopped vouching for it", not "it is now blocked". If an agency needs removal to mean
revocation, they need their own tenant key.

**3. Concurrent edits contend on one lock token.** Two users in the same tenant never get a
`409` — optimistic locking is per item (`ownerId` is the key), so both writes succeed. Both
then trigger a rebuild of the *same* IPSet, one may lose the WAF `LockToken` race, its
message returns to the queue, and the retry reconciles from a fresh read. Correct either
way; the cost is one wasted attempt and a slightly later `APPLIED`. On separate IPSets this
contention does not exist at all.

**4. The entry budget is shared.** `MAX_ENTRIES` (50) is enforced per *user*, but the WAF
IPSet limit (10,000) applies to the union. Fine at the documented scale; worth a thought if
one tenant key ever holds many agencies.

**5. Blast radius is shared.** A sync failure, a DLQ message or a bad break-glass range
affects every agency behind that IPSet at once. Test 6 (`one tenant failing does not block
the others`) bounds this to the IPSet — it does not divide it further.

Points 1 and 2 are the ones with no automated test today, because both are *emergent* from
the union rather than coded anywhere. If you want them pinned, the two tests to add are a
worker test asserting an overlapping `/32` + `/24` produces two entries, and one asserting
that removing a range still held by a co-tenant leaves it in the IPSet.

## Everything else the suites cover

**Input validation** ([cidr.test.ts](backend/test/unit/cidr.test.ts), 9 tests) — bare IPs
widened to `/32`, IPv6 canonicalised and compressed, duplicates collapsed, output sorted;
malformed input, private/loopback/link-local/CGNAT ranges, ranges broader than policy, CIDRs
with host bits set and over-long lists all rejected; **every** bad entry reported at once and
nothing written on failure.

**Sync status** ([service.test.ts](backend/test/unit/service.test.ts)) — a fresh write is
`PENDING`; it becomes `APPLIED` when the worker acknowledges within the wait; it answers
`PENDING` rather than hanging when the wait elapses. `returns 200 APPLIED …` and
`reports PENDING when …` assert the same thing over HTTP.

**Lost-update protection** — `requires If-Match to prevent lost updates` (428),
`returns 409 when If-Match is stale`, and `rejects a write against a stale version` at the
service layer.

**The invariant that keeps the pipeline from looping** —
`a write never carries the previous acknowledgement`. The EventBridge Pipe filter treats
"no `syncedVersion`" as a tenant edit ([queue/main.tf](terraform/modules/queue/main.tf)). If
the repository ever merged instead of replacing, the worker would stop seeing tenant changes
entirely. That coupling is deliberate, commented at both ends, and pinned by this test.

**Auth** — no token, wrong signing key, and a user absent from the directory are all 401.

**Worker housekeeping** — `reverts a manual edit made outside the application`,
`skips the update when an IPSet already matches` (no pointless WAF writes),
`the drift check sweeps every IPSet`, and the two acknowledgement tests.

## What the suites cannot prove

These need real AWS. Each has a runnable walkthrough in
[ARCHITECTURE.md](ARCHITECTURE.md#setup-for-the-walkthroughs):

| Not covered by tests | Verify with |
| -------------------- | ----------- |
| The Pipe filter really excludes the worker's own writes | Scenario 3 — a write settles to `APPLIED` and stays there, no sync loop |
| A real `WAFOptimisticLockException` and its redelivery | Scenario 4, run as `user-c` + `user-d` |
| The SCP denying manual `wafv2:UpdateIPSet` | Scenario 8 — try a console edit |
| The 15-minute drift schedule firing | Scenario 8 — edit in the console, wait |
| DLQ parking, the alarm and redrive | Scenario 9 and the [runbook](terraform/README.md#runbook-the-dlq-alarm-fired) |
| `ignore_changes = [addresses]` surviving an apply | write a list, `make apply`, re-read the IPSet |

The split is deliberate: everything that is *logic* is tested offline in under a second;
everything that is *AWS behaviour* is verified by exercising the deployed system, because a
mock of it would only prove the mock.
