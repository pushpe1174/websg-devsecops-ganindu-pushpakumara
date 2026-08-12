# IAM policies

Three least-privilege policies, all scoped to named resources rather than `*`. They are
written against account `273804046957` in `ap-southeast-1`; retarget before attaching:

```bash
sed -i '' 's/273804046957/<account-id>/g;s/ap-southeast-1/<region>/g' iam/*.json
```

## `terraform-deploy-policy.json`

The role GitLab CI assumes to run `terraform apply`. It can manage exactly the resources in
[terraform/](../terraform), and nothing else.

| Restriction | Why |
| ----------- | --- |
| State access prefix-scoped to `websg-custom/*` | cannot read or overwrite another product's state in the same bucket |
| `iam:PassRole` conditioned on `iam:PassedToService` = Lambda | create-a-role plus pass-it-anywhere is a privilege-escalation path to any service |
| Role management name-scoped to `websg-cms-allowlist-*` | cannot touch unrelated roles |
| WAF: create IPSets, **not** write their addresses | the pipeline creates them; only the sync Lambda writes contents, at runtime |
| Event source mapping constrained by a `lambda:FunctionArn` condition | those actions are not resource-scoped by AWS |

Creating the state bucket (`make state-bucket`) needs `s3:CreateBucket` and `s3:Put*`, which
is deliberately **not** here. Run it once as an administrator; the pipeline should never be
able to create or reconfigure its own state bucket.

Trust policy for GitLab OIDC (replace `gitlab.com` and the project path):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::111122223333:oidc-provider/gitlab.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "gitlab.com:aud": "https://gitlab.com" },
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
`wafv2:UpdateIPSet` on the CMS IPSets to every principal except the sync worker's role and a
named break-glass role.

This is the control that actually makes the application the only writer: an explicit `Deny`
beats any `Allow`, including an administrator's, so a console edit fails outright rather than
being silently reverted later. It pairs with `ignore_changes = [addresses]` (which stops
`terraform apply` emptying the IPSets) and the 15-minute drift check (which undoes anything
that did get through). See [terraform/README.md](../terraform/README.md#keeping-waf-in-the-applications-hands).

Keep the break-glass role in the exception list. If the sync path is broken *and* the
allowlist is wrong, someone needs a way to edit WAF directly.

## `backend-api-policy.json`

Everything the API can do:

- `dynamodb:GetItem` and `PutItem` on `websg-cms-allowlist`.
- `sqs:SendMessage` on the sync queue, to signal the worker after a write.

It never touches WAF — it records desired state and says "this tenant changed".

**No `Query` and no `Scan`.** That matters more on a single table than it did on per-tenant
tables: without it a leaked credential could enumerate not one tenant's allowlists but the
whole platform's. The API only ever addresses one item by its full `{tenantId, ownerId}` key.

**No `UpdateItem`** either: a write replaces the whole item, which is what keeps the worker's
`syncedVersion` off tenant edits — a new version has not reached WAF, so it must not inherit
the previous one's acknowledgement.

If the API ever gets per-tenant credentials, this is where a `dynamodb:LeadingKeys` condition
on `${aws:PrincipalTag/tenantId}` would go. A single table makes that possible; the previous
per-table wildcard granted every tenant's table to one role, so it never enforced the boundary
it appeared to.

Use it in two places: on the pod's IRSA role, and on the credentials used to run the backend
locally (see [Running it](../README.md#running-it)).
