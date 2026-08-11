output "ip_sets" {
  description = "IPSet name -> id, arn and scope."
  value = {
    for name, ip_set in aws_wafv2_ip_set.this :
    name => { id = ip_set.id, arn = ip_set.arn, scope = ip_set.scope }
  }
}

output "arns" {
  description = "Every IPSet ARN, for scoping the worker's wafv2 permissions."
  value       = [for ip_set in aws_wafv2_ip_set.this : ip_set.arn]
}
