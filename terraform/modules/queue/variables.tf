variable "name" {
  description = "Base name for the pipe, the queue and its DLQ."
  type        = string
}

variable "stream_arn" {
  description = "DynamoDB stream ARN. The pipe's source."
  type        = string
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
