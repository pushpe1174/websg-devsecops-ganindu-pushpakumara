locals {
  name = "websg-cms-allowlist"

  tags = {
    Product     = "websg-custom"
    Component   = "ip-allowlist"
    Environment = var.environment
    ManagedBy   = "terraform"
  }

  // One tenant = one table + one IPSet, both named "<name>-<tenant>". Adding a
  // tenant is an entry in var.tenants; no code change, no redeploy.
  ip_set_names = { for id, t in var.tenants : id => "${local.name}-${id}" }
}

// One allowlist table per tenant. Same module every time.
module "allowlist" {
  source   = "./modules/dynamodb"
  for_each = var.tenants

  table_name = local.ip_set_names[each.key]
  tags       = local.tags
}

module "waf_ip_sets" {
  source = "./modules/waf_ip_sets"

  ip_sets = { for id, t in var.tenants : local.ip_set_names[id] => t.ip_set_scope }
  tags    = local.tags
}

module "queue" {
  source = "./modules/queue"

  name        = "${local.name}-waf-sync"
  stream_arns = { for id, table in module.allowlist : id => table.stream_arn }
  tags        = local.tags
}

module "lambda" {
  source = "./modules/lambda"

  function_name = "${local.name}-waf-sync"
  source_dir    = "${path.module}/../lambda/build"

  queue_arn = module.queue.queue_arn

  // The worker's whole config: which table feeds which IPSet.
  tenants = {
    for id, t in var.tenants : id => {
      tableName  = module.allowlist[id].table_name
      tableArn   = module.allowlist[id].table_arn
      ipSetId    = module.waf_ip_sets.ip_sets[local.ip_set_names[id]].id
      ipSetName  = local.ip_set_names[id]
      ipSetArn   = module.waf_ip_sets.ip_sets[local.ip_set_names[id]].arn
      ipSetScope = t.ip_set_scope
    }
  }

  break_glass_cidrs = var.break_glass_cidrs
  tags              = local.tags
}

module "monitoring" {
  source = "./modules/monitoring"

  name_prefix   = local.name
  function_name = module.lambda.function_name
  dlq_name      = module.queue.dlq_name
  alert_emails  = var.alert_emails

  tags = local.tags
}
