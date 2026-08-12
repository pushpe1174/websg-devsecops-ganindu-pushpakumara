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
    Tenants to provision. Each key creates one WAF IPSet named
    "websg-cms-allowlist-<key>" and becomes a partition key in the shared
    allowlist table. Agencies that must share an IPSet share a tenant key and
    are separate items in that tenant's partition.
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

  // The IPSets are IPV4, matching the API which rejects IPv6. A v6 range here
  // would be accepted by Terraform and then fail every UpdateIPSet call.
  validation {
    condition     = alltrue([for cidr in var.break_glass_cidrs : can(regex("^([0-9]{1,3}\\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$", cidr))])
    error_message = "break_glass_cidrs must be IPv4 CIDRs; the IPSets are IPV4 only."
  }
}

variable "alert_emails" {
  description = "Addresses notified when an alarm fires. Each confirms the subscription by email once."
  type        = list(string)
  default     = []
}

variable "metric_namespace" {
  description = "CloudWatch namespace for the worker's embedded-format metrics."
  type        = string
  default     = "WebSG/Allowlist"
}

variable "stuck_threshold_seconds" {
  description = "Alarm when a tenant's oldest unacknowledged edit is older than this. Distinguishes slow from stuck."
  type        = number
  default     = 300
}
