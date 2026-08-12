// One WAF IPSet per tenant. No DynamoDB here - the table is created in the root
// module so storage lives in one place.

resource "aws_wafv2_ip_set" "this" {
  for_each = var.ip_sets

  name  = each.key
  scope = each.value

  // WAF IPSets are single-family. IPV4 only is a deliberate pair with the API,
  // which rejects IPv6 outright - so there is no address family the API accepts
  // that this cannot hold. Supporting IPv6 means a second set per tenant here,
  // family routing in the worker, and both sets referenced from the WebACL.
  ip_address_version = "IPV4"
  addresses          = []

  // Addresses belong to the sync worker. Without this, every apply would empty
  // the IPSet and lock the tenant out until the next sync.
  lifecycle {
    ignore_changes = [addresses]
  }

  tags = var.tags
}
