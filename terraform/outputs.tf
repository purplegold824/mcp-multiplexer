output "lambda_function_name" {
  description = "Name of the MCP bridge Lambda"
  value       = aws_lambda_function.bridge.function_name
}

output "lambda_function_arn" {
  description = "ARN of the MCP bridge Lambda"
  value       = aws_lambda_function.bridge.arn
}

output "lambda_function_url" {
  description = "HTTPS URL for the bridge Lambda"
  value       = aws_lambda_function_url.bridge.function_url
}

output "artifacts_bucket" {
  description = "S3 bucket for Lambda artifacts"
  value       = aws_s3_bucket.artifacts.id
}
