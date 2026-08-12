output "table_name" {
  description = "Table name. The worker gets it as TABLE_NAME; so does the API."
  value       = aws_dynamodb_table.this.name
}

output "table_arn" {
  description = "Table ARN, for scoping IAM policies."
  value       = aws_dynamodb_table.this.arn
}
