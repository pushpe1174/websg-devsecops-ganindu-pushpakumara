// One WAF IPSet per tenant. No DynamoDB here - tables are created in the root
// module so every table lives in one place.

resource "aws_wafv2_ip_set" "this" {
  for_each = var.ip_sets

  name               = each.key
  scope              = each.value
  ip_address_version = "IPV4"
  addresses          = []

  // Addresses belong to the sync worker. Without this, every apply would empty
  // the IPSet and lock the tenant out until the next sync.
  lifecycle {
    ignore_changes = [addresses]
  }

  tags = var.tags
}
