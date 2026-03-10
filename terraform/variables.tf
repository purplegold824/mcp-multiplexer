variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "lambda_memory" {
  description = "Memory allocation for the bridge Lambda (MB)"
  type        = number
  default     = 512
}

variable "lambda_timeout" {
  description = "Timeout for the bridge Lambda (seconds)"
  type        = number
  default     = 120
}

variable "provisioned_concurrency" {
  description = "Provisioned concurrency for the bridge Lambda (0 = disabled)"
  type        = number
  default     = 0
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 14
}
