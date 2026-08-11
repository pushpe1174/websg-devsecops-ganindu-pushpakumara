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
    Tenant to IPSet mapping - the onboarding surface. Adding an entry and
    applying is all it takes to add a tenant; no code change, no redeploy.

    Same `ip_set_name` for two tenants means they share an IPSet and get the
    union of their lists. Different names give them separate IPSets.
    `create_ip_set = false` adopts an IPSet that already exists.
  EOT

  type = map(object({
    ip_set_name   = string
    ip_set_scope  = optional(string, "REGIONAL")
    create_ip_set = optional(bool, true)
    description   = optional(string, "")
  }))
}

variable "break_glass_cidrs" {
  description = "Ops ranges always kept in the IPSet, so an empty table cannot lock everyone out of the CMS."
  type        = list(string)
  default     = []
}

variable "alert_emails" {
  description = "Addresses notified when the DLQ alarm fires. Each confirms the subscription by email once."
  type        = list(string)
  default     = []
}
