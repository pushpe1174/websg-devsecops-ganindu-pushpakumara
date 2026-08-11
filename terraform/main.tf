locals {
  name = "websg-cms-ip-allowlist"

  tags = {
    Product     = "websg-custom"
    Component   = "ip-allowlist"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

/**
 * Tenant onboarding. One entry per tenant in prod.tfvars creates its IPSet and
 * maps the tenant to it; the worker reads that mapping at runtime, so adding a
 * tenant needs no code change and no redeploy.
 *
 * Tenants sharing an ip_set_name share an IPSet and get the union of their
 * lists. Separate names give separate IPSets.
 */
module "tenants" {
  source = "./modules/tenants"

  tenants           = var.tenants
  config_table_name = "${local.name}-tenants"
  tags              = local.tags
}

module "dynamodb" {
  source = "./modules/dynamodb"

  table_name = local.name
  tags       = local.tags
}

module "queue" {
  source = "./modules/queue"

  name       = "${local.name}-waf-sync"
  stream_arn = module.dynamodb.stream_arn
  tags       = local.tags
}

module "lambda" {
  source = "./modules/lambda"

  function_name = "${local.name}-waf-sync"
  source_dir    = "${path.module}/../lambda/build"

  queue_arn  = module.queue.queue_arn
  table_name = module.dynamodb.table_name
  table_arn  = module.dynamodb.table_arn

  config_table_name = module.tenants.config_table_name
  config_table_arn  = module.tenants.config_table_arn
  ip_set_arns       = module.tenants.ip_set_arns

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