// One WAF IPSet per tenant. The table lives in the root module, not here.

resource "aws_wafv2_ip_set" "this" {
  for_each = var.ip_sets

  name  = each.key
  scope = each.value

  // IPSets are single-family, and the API rejects IPv6 to match - so there is no
  // family the API accepts that this cannot hold. Supporting v6 means a second
  // set per tenant, family routing in the worker, and both in the WebACL.
  ip_address_version = "IPV4"
  addresses          = []

  // Addresses belong to the worker. Without this, every apply empties the IPSet
  // and locks the tenant out until the next sync.
  lifecycle {
    ignore_changes = [addresses]
  }

  tags = var.tags
}
