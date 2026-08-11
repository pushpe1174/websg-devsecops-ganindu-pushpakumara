// The two values the API needs in its .env; everything else it derives.
output "table_prefix" {
  description = "Set as TABLE_PREFIX on the API. It resolves a tenant's table as <prefix>-<tenantId>."
  value       = local.name
}

output "region" {
  description = "Set as AWS_REGION on the API."
  value       = var.region
}

output "table_names" {
  description = "Tenant -> allowlist table, for confirming what was created."
  value       = { for id, table in module.allowlist : id => table.table_name }
}

output "ip_sets" {
  description = "IPSet name -> id and arn, for reference in WebACL rules."
  value       = module.waf_ip_sets.ip_sets
}

output "function_name" {
  description = "Sync function name, for logs and manual invokes."
  value       = module.lambda.function_name
}

output "queue_url" {
  description = "FIFO queue feeding the sync function."
  value       = module.queue.queue_url
}

output "dlq_url" {
  description = "Inspect or redrive from here when the DLQ alarm fires."
  value       = module.queue.dlq_url
}

output "alert_topic_arn" {
  description = "SNS topic the alarms publish to."
  value       = module.monitoring.alert_topic_arn
}
