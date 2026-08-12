locals {
  name = "websg-cms-allowlist"

  tags = {
    Product     = "websg-custom"
    Component   = "ip-allowlist"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  // One tenant = one IPSet named "<name>-<tenant>". Adding a tenant is an entry
  // in var.tenants; no code change, no redeploy. All tenants share one table,
  // partitioned by tenant id.
  ip_set_names = { for id, t in var.tenants : id => "${local.name}-${id}" }
}

// One table for the whole platform, PK = tenantId / SK = ownerId.
module "allowlist" {
  source = "./modules/dynamodb"

  table_name = local.name
  tags       = local.tags
}

module "waf_ip_sets" {
  source = "./modules/waf_ip_sets"

  ip_sets = { for id, t in var.tenants : local.ip_set_names[id] => t.ip_set_scope }
  tags    = local.tags
}

module "queue" {
  source = "./modules/queue"

  name       = "${local.name}-waf-sync"
  tenant_ids = toset(keys(var.tenants))
  tags       = local.tags
}

module "lambda" {
  source = "./modules/lambda"

  function_name = "${local.name}-waf-sync"
  source_dir    = "${path.module}/../lambda/build"

  queue_arn  = module.queue.queue_arn
  table_name = module.allowlist.table_name
  table_arn  = module.allowlist.table_arn

  // The worker's whole config: which IPSet belongs to which tenant.
  tenants = {
    for id, t in var.tenants : id => {
      ipSetId    = module.waf_ip_sets.ip_sets[local.ip_set_names[id]].id
      ipSetName  = local.ip_set_names[id]
      ipSetArn   = module.waf_ip_sets.ip_sets[local.ip_set_names[id]].arn
      ipSetScope = t.ip_set_scope
    }
  }

  break_glass_cidrs = var.break_glass_cidrs
  metric_namespace  = var.metric_namespace
  tags              = local.tags
}

module "monitoring" {
  source = "./modules/monitoring"

  name_prefix   = local.name
  function_name = module.lambda.function_name
  dlq_name      = module.queue.dlq_name
  alert_emails  = var.alert_emails

  tenant_ids              = toset(keys(var.tenants))
  metric_namespace        = var.metric_namespace
  stuck_threshold_seconds = var.stuck_threshold_seconds

  tags = local.tags
}
