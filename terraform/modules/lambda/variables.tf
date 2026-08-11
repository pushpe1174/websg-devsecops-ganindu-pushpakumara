variable "function_name" {
  description = "Name of the sync function. Also prefixes its role."
  type        = string
}

variable "source_dir" {
  description = "Directory zipped into the deployment package (built by `make package`)."
  type        = string
}

variable "queue_arn" {
  description = "FIFO queue ARN. The event source."
  type        = string
}

variable "table_name" {
  description = "Allowlist table name, passed to the function as TABLE_NAME."
  type        = string
}

variable "table_arn" {
  description = "Allowlist table ARN, for the Scan permission."
  type        = string
}

variable "config_table_name" {
  description = "Tenant to IPSet mapping table. Read at runtime, so onboarding needs no redeploy."
  type        = string
}

variable "config_table_arn" {
  description = "Mapping table ARN, for the Scan permission."
  type        = string
}

variable "ip_set_arns" {
  description = "Every IPSet the worker may write to. Scopes the wafv2 permissions."
  type        = list(string)
}

variable "break_glass_cidrs" {
  description = "Ops ranges merged into every sync so an empty table cannot lock everyone out."
  type        = list(string)
  default     = []
}

variable "timeout_seconds" {
  description = "Function timeout. Must be under the queue's visibility timeout."
  type        = number
  default     = 60
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
