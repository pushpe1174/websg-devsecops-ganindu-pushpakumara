output "table_name" {
  description = "Table name, <prefix>-<tenant>. The worker gets it via TENANTS; the API derives it from TABLE_PREFIX."
  value       = aws_dynamodb_table.this.name
}

output "table_arn" {
  description = "Table ARN, for scoping IAM policies."
  value       = aws_dynamodb_table.this.arn
}

output "stream_arn" {
  description = "Stream ARN. The Lambda's event source."
  value       = aws_dynamodb_table.this.stream_arn
}
