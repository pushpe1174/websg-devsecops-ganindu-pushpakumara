variable "name" {
  description = "Base name for the queue and its DLQ."
  type        = string
}

variable "tenant_ids" {
  description = "Tenant ids. The sweep emits one message per tenant, each in that tenant's message group."
  type        = set(string)
}

variable "visibility_timeout_seconds" {
  description = "Must exceed the consuming function's timeout."
  type        = number
  default     = 120
}

variable "max_receive_count" {
  description = "Deliveries before a message is moved to the DLQ."
  type        = number
  default     = 5
}

variable "drift_check_schedule" {
  description = "How often to re-reconcile, reverting IPSet edits made outside the application."
  type        = string
  default     = "rate(15 minutes)"
}

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
