// The allowlist table, one for the whole platform. PK = tenantId / SK = ownerId,
// so the worker reads a tenant with a Query on one partition, bounded by that
// tenant's member count. Agencies sharing a tenant are separate items in it and
// their ranges are the union.
//
// No stream: the API is the only writer and signals the queue itself.

resource "aws_dynamodb_table" "this" {
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "tenantId"
  range_key    = "ownerId"

  attribute {
    name = "tenantId"
    type = "S"
  }

  attribute {
    name = "ownerId"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  deletion_protection_enabled = true

  tags = var.tags
}
