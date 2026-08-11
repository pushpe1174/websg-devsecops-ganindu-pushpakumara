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

variable "tenants" {
  description = "Tenant -> its table and IPSet. Passed to the function as TENANTS and used to scope IAM."

  type = map(object({
    tableName  = string
    tableArn   = string
    ipSetId    = string
    ipSetName  = string
    ipSetArn   = string
    ipSetScope = string
  }))
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
