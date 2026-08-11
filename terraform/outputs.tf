output "table_name" {
  description = "Set as TABLE_NAME on the API deployment."
  value       = module.dynamodb.table_name
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
