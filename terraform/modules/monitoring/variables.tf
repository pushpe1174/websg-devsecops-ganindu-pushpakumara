variable "name_prefix" {
  description = "Prefix for the topic and alarm names."
  type        = string
}

variable "function_name" {
  description = "Sync function to alarm on."
  type        = string
}

variable "dlq_name" {
  description = "DLQ to alarm on."
  type        = string
}

variable "alert_emails" {
  description = "Addresses subscribed to the alert topic."
  type        = list(string)
  default     = []
}

variable "tenant_ids" {
  description = "Tenant ids. One stuck-sync alarm each, since the metric is dimensioned by tenant."
  type        = set(string)
  default     = []
}

variable "metric_namespace" {
  description = "CloudWatch namespace the worker emits its embedded-format metrics to."
  type        = string
  default     = "WebSG/Allowlist"
}

variable "stuck_threshold_seconds" {
  description = "Alarm when a tenant's oldest unacknowledged edit is older than this."
  type        = number
  default     = 300
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
