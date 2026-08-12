# lambda

The sync worker. It is the only thing that writes to WAF.

```
src/index.ts         the handler
scripts/package.sh   builds build/ for Terraform to upload
test/handler.test.ts the suite
```

```sh
npm test        # no AWS involved
npm run package # or `make package` from the root, which plan/apply do for you
```

There is no local run: it is driven by an SQS trigger. Test it, package it,
deploy it, read its logs.

## What it does

For each tenant in the batch:

1. Query that tenant's partition in DynamoDB.
2. Union every owner's ranges, plus the break-glass ranges, into one sorted list.
3. Compare with the live IPSet and update it only if it differs.
4. Write back which version is now live, so the API can report `APPLIED`.

## Why it is built this way

- **The message is a signal, not data.** It says which tenant to look at;
  the answer always comes from the table. So a duplicate, a retry and the
  periodic sweep all converge on the same result.
- **One tenant cannot block another.** A failing tenant is caught, logged, and
  only its messages are returned for retry. The rest still sync.
- **Break-glass ranges are merged into every IPSet**, so an empty table can
  never lock ops out of the CMS.
- **An unreadable message triggers a full sweep.** Slow beats silently skipping
  an IPSet.
- **Acknowledgement is conditional.** If the row changed after the read, the
  write is rejected and the item stays `PENDING` — the status can never claim
  more than what is actually live.
- **Lag is a metric, not a guess.** Each run logs the age of the oldest
  unacknowledged change, which is what tells slow apart from stuck.
