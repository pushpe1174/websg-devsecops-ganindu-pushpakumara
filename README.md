# WebSG CMS IP allowlist

Document link -> 

A tenant edits their own list of allowed IP ranges; the ranges end up in an AWS
WAF IPSet in front of their CMS.

```
frontend/  ──▶  backend/  ──▶  DynamoDB + SQS
 the portal      the API            │
                                    ▼
                                lambda/  ──▶  WAF IPSet
                              the sync worker
```

The API never touches WAF. It stores the change and drops a message on a queue;
the worker rebuilds the IPSet from the table and marks the change applied. That
split is why a save can answer `202 PENDING` — durable, not yet live at the edge.

## Folders

| Folder | What lives there |
|---|---|
| [frontend/](frontend/) | The portal a user clicks. Plain HTML, CSS and JS, no build step. |
| [backend/](backend/) | The API. Fastify on Node, the only thing that writes to the table. |
| [lambda/](lambda/) | The sync worker. Runs in AWS, turns table rows into WAF IPSets. |
| [terraform/](terraform/) | The AWS resources everything above needs. |
| [iam/](iam/) | The permission policies, as JSON, for the humans and machines involved. |

Each folder has its own README with the detail.

## Running it locally

Two terminals:

```sh
cd backend && npm run dev     # API on http://localhost:3000
make frontend                 # portal on http://localhost:5173
```

The API talks to real DynamoDB and SQS — there is no local emulator — so
`backend/.env` needs `TABLE_NAME` and `SYNC_QUEUE_URL` from `make apply`. Sign-in
is password-less: pick a user from the dropdown.

## Commands

Run `make` on its own for the list. The ones you need day to day:

| Command | What it does |
|---|---|
| `make frontend` | Serves the portal |
| `make test` | Backend and lambda test suites |
| `make plan` / `make apply` | Packages the lambda, then Terraform |
| `make fmt` / `make validate` | Terraform formatting and validation |
