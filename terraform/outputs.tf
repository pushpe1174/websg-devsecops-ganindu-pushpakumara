// The three values the API needs in its .env; everything else it derives.
output "table_name" {
  description = "Set as TABLE_NAME on the API. One table for every tenant, partitioned by tenantId."
  value       = module.allowlist.table_name
}

output "sync_queue_url" {
  description = "Set as SYNC_QUEUE_URL on the API. It posts one message per write, grouped by tenant."
  value       = module.queue.queue_url
}

output "region" {
  description = "Set as AWS_REGION on the API."
  value       = var.region
}

output "ip_sets" {
  description = "IPSet name -> id and arn, for reference in WebACL rules."
  value       = module.waf_ip_sets.ip_sets
}

output "function_name" {
  description = "Sync function name, for logs and manual invokes."
  value       = module.lambda.function_name
}

output "dlq_url" {
  description = "Inspect or redrive from here when the DLQ alarm fires."
  value       = module.queue.dlq_url
}

output "alert_topic_arn" {
  description = "SNS topic the alarms publish to."
  value       = module.monitoring.alert_topic_arn
}
