// The allowlist table. One table for the whole platform.
//
// PK = tenantId, SK = ownerId. The sync worker reads a tenant with a Query on a
// single partition, so its cost is bounded by that tenant's member count rather
// than by the size of the platform. Agencies sharing a tenant are separate items
// in the same partition, and their ranges are the union of that partition.
//
// No stream. The API is the only writer and posts its own signal to the queue,
// so there is no change-capture hop to configure.

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
