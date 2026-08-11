output "config_table_name" {
  description = "Mapping table name, read by the sync worker."
  value       = aws_dynamodb_table.config.name
}

output "config_table_arn" {
  description = "Mapping table ARN, for scoping the worker's Scan permission."
  value       = aws_dynamodb_table.config.arn
}

output "ip_set_arns" {
  description = "Every IPSet the worker may write to. Scopes its wafv2 permissions."
  value       = distinct([for id, ip_set in local.ip_sets : ip_set.arn])
}

output "ip_sets" {
  description = "Tenant to IPSet mapping, for reference in WebACL rules."
  value       = { for id, ip_set in local.ip_sets : id => { id = ip_set.id, arn = ip_set.arn } }
}
