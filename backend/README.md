# IP allowlist API

Self-service API for a tenant's WAF IP allowlist. A user reads and replaces its own list;
the write is stored, signalled to the sync worker, and answered once WAF confirms it.

## Layout

```
src/
  server.ts        process: config check, wiring, listen, graceful shutdown
  app.ts           HTTP: routes, schemas, status codes, error mapping
  config.ts        environment + the user -> tenant directory
  core/            what the service does - no AWS, no Fastify
    allowlist.ts     the service: validate -> store -> signal -> await sync
    cidr.ts          normalises and enforces policy on CIDR entries
    errors.ts        the errors the API answers with deliberately
  infra/           what it talks to
    aws.ts           DynamoDB repository, SQS notifier
    auth.ts          HS256 token verification, the auth hook
test/
  unit/            core in isolation, against in-memory fakes
  integration/     the app through `inject` - real routing, auth and status codes
  helpers/         fakes with the same contract as the real adapters
```

Two rules keep this honest, and are worth preserving:

- **Dependencies point inward.** `core/` imports nothing from `infra/` or Fastify, so the
  rules can be tested without AWS. `app.ts` and `server.ts` are the only files that know
  both sides, and they only wire them together.
- **`core/` takes its adapters as arguments.** `createAllowlistService` receives a
  repository and a notifier rather than constructing them, which is why the tests swap in
  in-memory versions with no mocking library.

`core/errors.ts` carries an HTTP status on purpose. Status is the contract this service
exposes, and one `HttpError` avoids a translation layer that would only ever map three
cases.

## Running

```sh
npm install
npm run dev                  # watch mode, reads .env
npm test                     # node:test, no runner
npm run typecheck            # src, test and scripts
npm run build                # tsc -> dist/
npm run token -- user-a      # prints a bearer token for calling the API by hand
```

`JWT_SECRET` and `SYNC_QUEUE_URL` are required; everything else in `config.ts` has a
default. See `.env.example`.

## API

Both routes act on the caller's own list — the token decides whose, there is no id in the
path.

| | |
|---|---|
| `GET /v1/allowlist` | Returns the list, its `version`, and `syncStatus`. |
| `PUT /v1/allowlist` | Full replacement. `If-Match: <version>` is required: **428** without it, **409** if stale. **200** once the worker confirms the version live in WAF, **202** if the wait elapsed first — the write is durable either way, so poll `GET` for `APPLIED`. |
| `GET /healthz`, `/readyz` | Unauthenticated probes. |
