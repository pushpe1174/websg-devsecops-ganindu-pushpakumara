# iam

The permission policies that are attached by hand, not by Terraform — the ones
that decide what the API and the deploy credentials are allowed to do. The
worker's own role is created in [`../terraform/modules/lambda`](../terraform/modules/lambda),
because Terraform owns the worker.

```
backend-api-policy.json        for the credentials the API runs with
terraform-deploy-policy.json   for the credentials that run make apply
```

## backend-api-policy.json

Four actions, two resources:

| Allowed | Why |
|---|---|
| `dynamodb:GetItem`, `PutItem` | read and replace an allowlist |
| `sqs:SendMessage`, `GetQueueUrl` | signal the sync worker after a write |

What is deliberately absent matters as much: no `DeleteItem`, no WAF
permissions at all. The API cannot reach the edge even if something goes wrong —
only the worker can.

## terraform-deploy-policy.json

What `make apply` needs, and no more.

## Applying one

These are plain policy documents; attach them to the role or user that needs
them.

```sh
aws iam create-policy --policy-name websg-backend-api \
  --policy-document file://iam/backend-api-policy.json
```

Account id and region are baked into the resource ARNs — update them if this
ever moves account.
