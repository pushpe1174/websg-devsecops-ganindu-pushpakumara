output "function_name" {
  description = "Name of the sync function."
  value       = aws_lambda_function.this.function_name
}

output "function_arn" {
  description = "ARN of the sync function."
  value       = aws_lambda_function.this.arn
}
