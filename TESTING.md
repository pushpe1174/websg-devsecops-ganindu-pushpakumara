# Manual test guide

Walking the self-service portal by hand: a shared tenant edited by two users,
and the two layers that reject a bad address.

Two facts the steps depend on:

- Users are fixed in `backend/src/config/users.ts`. `user-c` and `user-d` both
map to `tenant-shared`, so they see and edit one list. `user-a` and `user-b`

## 1. One list, two users

Use two browsers (or one normal window and one private) so each holds its own
in-memory token.


| Step | Window A (`user-c`)        | Window B (`user-d`)                                 |
| ---- | -------------------------- | --------------------------------------------------- |
| 1    | Sign in as `user-c`        | Sign in as `user-d`                                 |
| 2    | Add `203.0.113.0/24`, Save | —                                                   |
| 3    | —                          | Reload, sign in again → list shows `203.0.113.0/24` |
| 4    | —                          | Add `198.51.100.0/24`, Save                         |
| 5    | Reload → both entries      | Both entries                                        |


Expected: a single union list for `tenant-shared`. Then sign in as `user-a` and
confirm its list is unrelated — tenancy comes from the server-side map, never
from the token.

### Conflict

In step 4, have B skip the reload:

1. B signs in and loads the list.
2. A adds `203.0.113.0/24` and saves.
3. B adds an entry and saves, still holding the older version in `If-Match`.

Expected: **409**. The page reloads the list and says someone else changed it,
rather than overwriting A's entry.

## 2. Two wrong inputs

Take one from each layer so both paths are exercised.

**a. Rejected in the browser** — the Network tab stays quiet, no request is made:

- `10.0.0`
- `2001:db8::1`
- `abc`

All give: *Enter an IPv4 address or CIDR, for example 203.0.113.0/24.*

**b. Rejected by the API** — passes the shape check, fails on Save with 400:


| Input             | Expected reason                                                  |
| ----------------- | ---------------------------------------------------------------- |
| `10.0.0.0/24`     | private, loopback, link-local or reserved ranges are not allowed |
| `203.0.113.5/24`  | host bits set, use the network address for /24                   |
| `198.51.100.0/16` | range too broad, use /24 or narrower                             |
| `999.1.1.1`       | not a valid IPv4 address                                         |


`999.1.1.1` is the interesting one: it satisfies the client regex (`\d{1,3}`)
and is caught only by the API, which is exactly the split the two layers are
meant to have.

## Also worth confirming

- Adding a duplicate gives *… is already on the list.*
- Save and Reset stay disabled until the draft differs from the saved list.
- Reloading the page signs you out — the token is a variable, not storage.
- A valid Save reports `APPLIED`, or `202 PENDING` when the worker does not
confirm within `SYNC_WAIT_MS`. Locally it will be `PENDING` unless
`SYNC_QUEUE_URL` is set; it is blank in `backend/.env.example`.

