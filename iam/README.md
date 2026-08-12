# IAM policies

Three policies, all least-privilege and scoped to named resources rather than `*`. They are
written against account `273804046957` in `ap-southeast-1`; retarget them before attaching:

```bash
sed -i '' 's/273804046957/<account-id>/g;s/ap-southeast-1/<region>/g' iam/*.json
```

## `terraform-deploy-policy.json`

Attached to the role GitLab CI assumes to run `terraform apply`. It can manage exactly the
resources in [terraform/](../terraform), and nothing else.

Notable restrictions:

- **State access is prefix-scoped** to `websg-custom/*` in the state bucket, so this role
  cannot read or overwrite another product's state in the same bucket.
- **`iam:PassRole` is conditioned** on `iam:PassedToService` being Lambda. Without that
  condition, permission to create a role plus permission to pass it anywhere is a
  privilege-escalation path to any service.
- **Role management is name-scoped** to `websg-cms-allowlist-*`, so it cannot touch
  unrelated roles.
- **WAF access covers creating IPSets but not writing addresses to them.** The pipeline
  creates the per-tenant IPSets; only the sync Lambda writes their contents, at runtime.
- Event source mapping actions are not resource-scoped by AWS, so they are constrained with
  a `lambda:FunctionArn` condition instead.

Bootstrap note: creating the state bucket (`make state-bucket`) needs `s3:CreateBucket` and
`s3:Put*` on the bucket, which is deliberately **not** in this policy. Run it once as an
administrator; the pipeline should never be able to create or reconfigure its own state
bucket.

Trust policy for GitLab OIDC (replace `gitlab.com` and the project path):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::111122223333:oidc-provider/gitlab.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "gitlab.com:aud": "https://gitlab.com"
      },
      "StringLike": {
        "gitlab.com:sub": "project_path:your-group/websg-custom:ref_type:branch:ref:main"
      }
    }
  }]
}
```

The `sub` condition pins the role to one branch of one project. Without it, any project in
the GitLab instance could assume it.

## `deny-manual-ipset-edits.json`

Attach as an **SCP** on the account's OU, or as a permissions boundary. It denies
`wafv2:UpdateIPSet` on the CMS IPSets to every principal except the sync worker's role and
a named break-glass role.

This is the control that actually makes the application the only writer. An explicit `Deny`
beats any `Allow`, including an administrator's, so a console edit fails outright rather
than being silently reverted later.

It pairs with two other layers, which matter because a deny alone is not enough:

- **`ignore_changes = [addresses]`** on every `aws_wafv2_ip_set` — without it, `terraform
  apply` resets the addresses to the empty list in the resource and locks every tenant out
  until the next sync. Terraform owns the resource; the application owns its contents.
- **The scheduled drift check** (default every 15 minutes) — the reconciler rebuilds each
  IPSet from the table, so anything that did get changed outside the application is undone
  on the next run. Without the schedule, drift on a quiet tenant would survive until their
  next edit.

Keep the break-glass role in the exception list. If the sync path is broken *and* the
allowlist is wrong, someone needs a way to edit WAF directly.

## `backend-api-policy.json`

Everything the API can do:

- `dynamodb:GetItem` and `PutItem` on `websg-cms-allowlist` — the one allowlist table.
- `sqs:SendMessage` on the sync queue, so it can signal the worker after a write.

It never touches WAF. It records desired state and says "this tenant changed"; the worker is
the single writer to WAF.

There is deliberately **no `Query` and no `Scan`**. That matters more on a single table than
it did on per-tenant tables: without it, a leaked credential could enumerate not just one
tenant's allowlists but the whole platform's. The API only ever addresses one item by its
full `{tenantId, ownerId}` key, so it does not need either.

There is also no `UpdateItem`: a write replaces the whole item, which is what keeps the
worker's `syncedVersion` off tenant edits — a new version has not reached WAF, so it must
not inherit the previous one's acknowledgement.

If the API ever gets per-tenant credentials, this is where a `dynamodb:LeadingKeys`
condition on `${aws:PrincipalTag/tenantId}` would go. A single table makes that possible;
the previous per-table wildcard (`websg-cms-allowlist-*`) granted every tenant's table to
one role, so it was never enforcing the boundary it appeared to.

Use it in two places: attached to the pod's IRSA role, and attached to the credentials used
when running the backend locally (see [Running it](../README.md#running-it)).
