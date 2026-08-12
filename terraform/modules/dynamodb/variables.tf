variable "table_name" {
  description = "Name of the IP allowlist table."
  type        = string
}

variable "tags" {
  description = "Tags applied to the table."
  type        = map(string)
  default     = {}
}
