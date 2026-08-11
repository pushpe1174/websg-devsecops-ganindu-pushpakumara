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

variable "tags" {
  description = "Tags applied to every resource in this module."
  type        = map(string)
  default     = {}
}
