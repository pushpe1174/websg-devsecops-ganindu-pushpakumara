output "queue_arn" {
  description = "FIFO queue ARN. The Lambda's event source."
  value       = aws_sqs_queue.main.arn
}

output "queue_url" {
  description = "FIFO queue URL, for checking backlog depth."
  value       = aws_sqs_queue.main.url
}

output "dlq_name" {
  description = "DLQ name. The monitoring module alarms on it."
  value       = aws_sqs_queue.dlq.name
}

output "dlq_url" {
  description = "DLQ URL. Inspect or redrive from here when the alarm fires."
  value       = aws_sqs_queue.dlq.url
}
