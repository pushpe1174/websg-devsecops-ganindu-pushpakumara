output "table_name" {
  description = "Table name. Set as TABLE_NAME on the API and the Lambda."
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
