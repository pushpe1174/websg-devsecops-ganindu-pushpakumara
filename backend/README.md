# backend

The API. Fastify on Node 24, TypeScript run directly — no compile step in
development. It is the only thing that writes to the allowlist table.

```sh
npm run dev      # http://localhost:3000, restarts on save
npm test         # unit + integration, no AWS involved
npm run token    # print a token for curl:  npm run token -- user-a
```

`npm run dev` reads `backend/.env` (copy `.env.example`). There is no local
DynamoDB, so `TABLE_NAME` and `SYNC_QUEUE_URL` must point at real resources from
`make apply`.

## Layout

```
src/
├── server.ts       starts the process: real DynamoDB, real SQS, listen, shut down cleanly
├── app.ts          the wiring — which plugins, in which order, on which routes
├── config/
│   ├── index.ts    every environment variable, read once, in one place
│   └── users.ts    the user → tenant directory
├── routes/
│   ├── health.ts   /healthz, /readyz — no token
│   └── auth.ts     password-less sign-in for the portal
├── plugins/        cross-cutting concerns, not one endpoint's business
│   ├── auth.ts             verifies the token, sets request.principal
│   └── error-handler.ts    the only place an error becomes a response
├── lib/            pure helpers — no HTTP, no AWS, trivially testable
│   ├── cidr.ts     what may go on a list at all
│   ├── jwt.ts      sign and verify
│   └── errors.ts   the error types the handler maps to status codes
└── modules/ip-allowlist/    the feature itself, in layers
    ├── routes.ts       HTTP: paths, status codes, If-Match
    ├── service.ts      the rules: validate, write, wait for the edge
    ├── repository.ts   DynamoDB, and nothing else
    └── notifier.ts     SQS, and nothing else
```

The layering in that last folder is the point: `routes` knows HTTP, `service`
knows the rules, `repository` and `notifier` know AWS. The service never
mentions DynamoDB, so the tests hand it an in-memory version and never touch a
cloud.

```
scripts/   one-off tools: token.ts
test/      unit/ = pure functions · integration/ = the real app with fake AWS · helpers/ = the fakes
Dockerfile how this becomes a container
```

## Endpoints

| Method | Path | |
|---|---|---|
| GET | `/healthz`, `/readyz` | probes, no token |
| GET | `/auth/users` | the directory, for the login dropdown |
| POST | `/auth/login` | sign in as a user, returns a token |
| GET | `/v1/allowlist` | your list and its sync status |
| PUT | `/v1/allowlist` | replace your list — `If-Match` required |

There is no id in any path. The token decides whose list you are touching, and
the tenant comes from `config/users.ts`, never from the token, so a forged claim
cannot reach another tenant's data.

## How a write works

1. `PUT` arrives with `If-Match: <version last read>`. Missing → 428, stale → 409.
2. Every entry is normalised and checked: IPv4 only, publicly routable, `/24` or
   narrower, network address not a host address.
3. Conditional write to DynamoDB — the version guard is what makes concurrent
   edits safe.
4. A message goes on the queue, and the request waits up to `SYNC_WAIT_MS` for
   the worker to confirm.
5. **200** if the edge confirmed, **202** if the wait ran out. 202 is not a
   failure: the change is stored and the worker will get there.

## Notes

- **Sign-in is a stand-in.** `POST /auth/login` hands a token to anyone who
  names a known user — no password. It replaces the real IdP for development,
  and must not be exposed anywhere untrusted.
- **Tokens are HS256** with a shared secret, issuer and audience checked and the
  algorithm pinned.
- **CORS.** An explicit origin list, no wildcard, no credentials. Registered
  before everything else so rejected requests still carry the headers — without
  that a browser cannot read a 401 and just reports "network error".
- **Errors.** One handler, one shape. Stack traces and AWS errors never reach a
  caller.
