variable "ip_sets" {
  description = "IPSet name -> scope (REGIONAL or CLOUDFRONT)."
  type        = map(string)

  validation {
    condition     = alltrue([for scope in var.ip_sets : contains(["REGIONAL", "CLOUDFRONT"], scope)])
    error_message = "ip_sets values must be REGIONAL or CLOUDFRONT."
  }
}

variable "tags" {
  description = "Tags applied to every IPSet."
  type        = map(string)
  default     = {}
}
