output "ip_sets" {
  description = "IPSet name -> id, arn and scope."
  value = {
    for name, ip_set in aws_wafv2_ip_set.this :
    name => { id = ip_set.id, arn = ip_set.arn, scope = ip_set.scope }
  }
}
