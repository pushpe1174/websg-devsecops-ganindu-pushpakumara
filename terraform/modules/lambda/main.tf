// WAF sync worker: FIFO queue -> Lambda -> each tenant's WAF IPSet.
// Retries and the DLQ belong to the queue module.

locals {
  ip_set_arns = distinct([for t in var.tenants : t.ipSetArn])

  // Runtime config: which IPSet belongs to which tenant.
  tenant_config = {
    for id, t in var.tenants : id => {
      ipSetId    = t.ipSetId
      ipSetName  = t.ipSetName
      ipSetScope = t.ipSetScope
    }
  }
}

terraform {
  required_providers {
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.6"
    }
  }
}

// Built by `make package`.
data "archive_file" "this" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.module}/.build/${var.function_name}.zip"
}

data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "${var.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
  tags               = var.tags
}

data "aws_iam_policy_document" "this" {
  // Query, not Scan: one partition per tenant.
  statement {
    sid       = "ReadTenantAllowlists"
    actions   = ["dynamodb:Query"]
    resources = [var.table_arn]
  }

  // Only to record which version reached WAF, so the API reports APPLIED
  // rather than guessing.
  statement {
    sid       = "AcknowledgeAppliedVersion"
    actions   = ["dynamodb:UpdateItem"]
    resources = [var.table_arn]
  }

  statement {
    sid = "ConsumeQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
    ]
    resources = [var.queue_arn]
  }

  // Scoped to this worker's IPSets - no wildcard WAF access.
  statement {
    sid       = "ReconcileIpSets"
    actions   = ["wafv2:GetIPSet", "wafv2:UpdateIPSet"]
    resources = local.ip_set_arns
  }

  // The stuck-sync metric is embedded format on stdout, so this covers it -
  // no cloudwatch:PutMetricData needed.
  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "${var.function_name}-policy"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.this.json
}

// ---------------------------------------------------------------- Function

// Declared explicitly so retention is enforced instead of "never expire".
resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = 30
  tags              = var.tags
}

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  role          = aws_iam_role.this.arn
  handler       = "index.handler"
  runtime       = "nodejs24.x"
  architectures = ["arm64"]

  filename         = data.archive_file.this.output_path
  source_code_hash = data.archive_file.this.output_base64sha256

  timeout     = var.timeout_seconds
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME        = var.table_name
      TENANTS           = jsonencode(local.tenant_config)
      BREAK_GLASS_CIDRS = join(",", var.break_glass_cidrs)
      METRIC_NAMESPACE  = var.metric_namespace
    }
  }

  depends_on = [aws_iam_role_policy.this, aws_cloudwatch_log_group.this]

  tags = var.tags
}

// ---------------------------------------------------------------- Trigger

resource "aws_lambda_event_source_mapping" "queue" {
  event_source_arn = var.queue_arn
  function_name    = aws_lambda_function.this.arn

  batch_size = 10

  // The handler returns the ids it could not process instead of throwing.
  // Without this, one tenant's failure returns all ten messages and ticks nine
  // healthy tenants toward the DLQ threshold.
  function_response_types = ["ReportBatchItemFailures"]
}
