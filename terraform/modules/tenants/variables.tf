variable "tenants" {
  description = <<-EOT
    Tenant to IPSet mapping. Adding an entry onboards a tenant.

    Give two tenants the same `ip_set_name` to have them share one IPSet (the
    worker applies the union of their lists); give them different names for full
    isolation. Set `create_ip_set = false` to point at an IPSet that already
    exists, which this stack then only reads.
  EOT

  type = map(object({
    ip_set_name   = string
    ip_set_scope  = optional(string, "REGIONAL")
    create_ip_set = optional(bool, true)
    description   = optional(string, "")
  }))

  validation {
    condition = alltrue([
      for t in var.tenants : contains(["REGIONAL", "CLOUDFRONT"], t.ip_set_scope)
    ])
    error_message = "ip_set_scope must be REGIONAL or CLOUDFRONT."
  }
}

variable "config_table_name" {
  description = "Name of the tenant to IPSet mapping table."
  type        = string
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
