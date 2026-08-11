variable "region" {
  description = "AWS region."
  type        = string
  default     = "ap-southeast-1"
}

variable "environment" {
  description = "Environment name, used in tags."
  type        = string
  default     = "prod"
}

variable "tenants" {
  description = <<-EOT
    Tenants to provision. Each key creates one DynamoDB table and one WAF IPSet,
    both named "websg-cms-allowlist-<key>". Agencies that must share an IPSet
    share a tenant key and are separate items in that tenant's table.
  EOT

  type = map(object({
    ip_set_scope = optional(string, "REGIONAL")
    description  = optional(string, "")
  }))
}

variable "break_glass_cidrs" {
  description = "Ops ranges always kept in every IPSet, so an empty table cannot lock everyone out of the CMS."
  type        = list(string)
  default     = []
}

variable "alert_emails" {
  description = "Addresses notified when the DLQ alarm fires. Each confirms the subscription by email once."
  type        = list(string)
  default     = []
}
