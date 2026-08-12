# terraform

Everything AWS: the table, the queue, the worker, the IPSets, the alarms.

```
main.tf           calls the modules and connects them to each other
variables.tf      what can be configured
prod.tfvars       the values for prod
outputs.tf        the values you paste into backend/.env
providers.tf      the AWS provider, and the S3 bucket holding state
.terraform.lock.hcl   provider checksums — committed on purpose
modules/
├── dynamodb/      the one table
├── queue/         the FIFO queue and its dead-letter queue
├── lambda/        the worker, its role, its queue trigger
├── waf_ip_sets/   one IPSet per tenant
└── monitoring/    alarms, the sync-lag metric, the alert topic
```

Every module is the same three files: `main.tf` (the resources), `variables.tf`
(its inputs), `outputs.tf` (what it hands back to `main.tf`).

## Commands

Run these from the repo root — the Makefile packages the lambda first, which
`plan` and `apply` both need.

```sh
make state-bucket   # once per account, before anything else
make init
make plan
make apply
make fmt validate
```

## Wiring

`main.tf` is the whole picture in one screen:

```
var.tenants ──┬──▶ waf_ip_sets   one IPSet per tenant
              ├──▶ queue         one message group per tenant
              ├──▶ lambda        told which IPSet belongs to which tenant
              └──▶ monitoring    one lag alarm per tenant
dynamodb ─────────▶ lambda       the table it reads and acknowledges into
```

## Adding a tenant

One entry in `tenants` in `prod.tfvars`, then `make apply`. That creates the
IPSet, the message group, and the alarms; the partition in the table appears on
first write. No code change, no redeploy.

Agencies that must share one IPSet share one key — `tenant-shared` is that case,
and their lists become the union.

## Worth knowing

- **State lives in S3**, versioned and encrypted, created by `make state-bucket`.
  It lists every resource in the account and must never be public.
- **`prod.tfvars` is committed.** It holds no secrets, and CI needs it.
- **`.terraform.lock.hcl` is committed too**, so every apply resolves identical
  provider versions.
- **`break_glass_cidrs` goes into every IPSet.** Set it to the real corporate
  egress ranges before the first apply, or a bad list can lock everyone out.
- **`alert_emails` need confirming once** by email before alarms reach anyone.
- **Outputs are the handover to the API:** `table_name`, `sync_queue_url` and
  `region` are what `backend/.env` wants.

```sh
terraform -chdir=terraform output -raw table_name
terraform -chdir=terraform output -raw sync_queue_url
```
