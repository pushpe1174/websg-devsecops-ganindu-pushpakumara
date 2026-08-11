/**
 * Tenant onboarding: one entry in var.tenants creates (or adopts) an IPSet and
 * maps the tenant to it. The sync worker reads that mapping at runtime, so
 * adding a tenant is a Terraform change and never a code change or a redeploy.
 *
 * Two tenants pointing at the same ip_set_name share one IPSet and get the
 * union of their lists; separate names give them separate IPSets. The worker
 * derives both from the same mapping.
 */

locals {
  // Filter tenants managed by this stack vs. adopted from existing stacks
  managed_tenants = { for id, t in var.tenants : id => t if t.create_ip_set }
  adopted_tenants = { for id, t in var.tenants : id => t if !t.create_ip_set }

  // Group managed tenants by ip_set_name to avoid duplicate WAF IPSet resources
  unique_managed_ip_sets = {
    for id, t in local.managed_tenants : t.ip_set_name => t...
  }

  // Pick the first tenant definition for each unique IPSet name to drive resource creation
  managed_ip_sets = {
    for name, tenants in local.unique_managed_ip_sets : name => tenants[0]
  }

  // Map each tenant back to its corresponding created or adopted WAF IPSet resource
  ip_sets = merge(
    { for id, t in local.managed_tenants : id => aws_wafv2_ip_set.tenant[t.ip_set_name] },
    { for id, t in local.adopted_tenants : id => data.aws_wafv2_ip_set.tenant[id] }
  )
}

// --------------------------------------------------------------- IPSets

resource "aws_wafv2_ip_set" "tenant" {
  for_each = local.managed_ip_sets

  name               = each.value.ip_set_name
  scope              = each.value.ip_set_scope
  ip_address_version = "IPV4"
  addresses          = []

  /**
   * The addresses belong to the application, not to Terraform.
   *
   * Without this, every `terraform apply` would reset the IPSet to the empty
   * list above and lock every tenant out until the next sync. With it, drift in
   * `addresses` is invisible to Terraform - and the sync worker corrects any
   * manual console edit on its next run, including the scheduled drift check.
   */
  lifecycle {
    ignore_changes = [addresses]
  }

  tags = var.tags
}

data "aws_wafv2_ip_set" "tenant" {
  for_each = local.adopted_tenants

  name  = each.value.ip_set_name
  scope = each.value.ip_set_scope
}

// --------------------------------------------------------------- Mapping

resource "aws_dynamodb_table" "config" {
  name         = var.config_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenantId"

  attribute {
    name = "tenantId"
    type = "S"
  }

  // No stream: this table is configuration, and a change to it should not
  // trigger a sync on its own. The next tenant edit or drift check picks it up.
  server_side_encryption {
    enabled = true
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = var.tags
}

resource "aws_dynamodb_table_item" "tenant" {
  for_each = var.tenants

  table_name = aws_dynamodb_table.config.name
  hash_key   = aws_dynamodb_table.config.hash_key

  item = jsonencode({
    tenantId    = { S = each.key }
    ipSetId     = { S = local.ip_sets[each.key].id }
    ipSetName   = { S = each.value.ip_set_name }
    ipSetScope  = { S = each.value.ip_set_scope }
    description = { S = each.value.description }
  })
}