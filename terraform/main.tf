data "aws_caller_identity" "current" {}

locals {
  account_id    = data.aws_caller_identity.current.account_id
  function_name = "mcp-bridge"
  lambda_src    = "${path.module}/../lambda"
}

# --- S3 bucket for Lambda deployment artifacts ---

resource "aws_s3_bucket" "artifacts" {
  bucket = "mcp-mux-artifacts-${local.account_id}"
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# --- IAM role for the bridge Lambda ---

resource "aws_iam_role" "lambda" {
  name = "mcp-bridge-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Allow the bridge Lambda to invoke other Lambdas (for future per-server Lambdas)
resource "aws_iam_role_policy" "lambda_invoke" {
  name = "mcp-bridge-invoke"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = "arn:aws:lambda:${var.aws_region}:${local.account_id}:function:mcp-*"
    }]
  })
}

# --- Package and deploy the bridge Lambda ---

resource "null_resource" "lambda_build" {
  triggers = {
    source_hash = filemd5("${local.lambda_src}/bridge.mjs")
  }

  provisioner "local-exec" {
    working_dir = local.lambda_src
    command     = <<-EOT
      rm -rf dist && mkdir dist
      cp bridge.mjs dist/
      cp ../package.json dist/
      cd dist && npm install --omit=dev --ignore-scripts 2>/dev/null
    EOT
  }
}

data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = "${local.lambda_src}/dist"
  output_path = "${path.module}/.build/mcp-bridge.zip"

  depends_on = [null_resource.lambda_build]
}

resource "aws_s3_object" "lambda_zip" {
  bucket = aws_s3_bucket.artifacts.id
  key    = "lambda/mcp-bridge-${data.archive_file.lambda.output_md5}.zip"
  source = data.archive_file.lambda.output_path
  etag   = data.archive_file.lambda.output_md5
}

resource "aws_lambda_function" "bridge" {
  function_name = local.function_name
  role          = aws_iam_role.lambda.arn
  handler       = "bridge.handler"
  runtime       = "nodejs22.x"
  timeout       = var.lambda_timeout
  memory_size   = var.lambda_memory

  s3_bucket = aws_s3_bucket.artifacts.id
  s3_key    = aws_s3_object.lambda_zip.key

  environment {
    variables = {
      NODE_OPTIONS = "--enable-source-maps"
    }
  }
}

# --- Lambda Function URL (for direct HTTPS invocation) ---

resource "aws_lambda_function_url" "bridge" {
  function_name      = aws_lambda_function.bridge.function_name
  authorization_type = "AWS_IAM"
}

# --- CloudWatch log group ---

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
}

# --- Provisioned concurrency (optional) ---

resource "aws_lambda_alias" "live" {
  count = var.provisioned_concurrency > 0 ? 1 : 0

  name             = "live"
  function_name    = aws_lambda_function.bridge.function_name
  function_version = aws_lambda_function.bridge.version
}

resource "aws_lambda_provisioned_concurrency_config" "bridge" {
  count = var.provisioned_concurrency > 0 ? 1 : 0

  function_name                     = aws_lambda_function.bridge.function_name
  qualifier                         = aws_lambda_alias.live[0].name
  provisioned_concurrent_executions = var.provisioned_concurrency
}
