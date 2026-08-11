// WAF sync worker: FIFO queue -> Lambda -> each tenant's WAF IPSet.
// Retries and the DLQ belong to the queue module.

locals {
  table_arns  = [for t in var.tenants : t.tableArn]
  ip_set_arns = distinct([for t in var.tenants : t.ipSetArn])

  // Runtime config: which table feeds which IPSet.
  tenant_config = {
    for id, t in var.tenants : id => {
      tableName  = t.tableName
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

// ---------------------------------------------------------------- IAM

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
  statement {
    sid       = "ReadAllTenantAllowlists"
    actions   = ["dynamodb:Scan"]
    resources = local.table_arns
  }

  // Records which version reached WAF, so the API can report APPLIED rather
  // than guessing. Write access is limited to that acknowledgement.
  statement {
    sid       = "AcknowledgeAppliedVersion"
    actions   = ["dynamodb:UpdateItem"]
    resources = local.table_arns
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
      TENANTS           = jsonencode(local.tenant_config)
      BREAK_GLASS_CIDRS = join(",", var.break_glass_cidrs)
    }
  }

  depends_on = [aws_iam_role_policy.this, aws_cloudwatch_log_group.this]

  tags = var.tags
}

// ---------------------------------------------------------------- Trigger

resource "aws_lambda_event_source_mapping" "queue" {
  event_source_arn = var.queue_arn
  function_name    = aws_lambda_function.this.arn

  // A batch is one reconciliation regardless of size: a failed run returns the
  // whole batch to the queue, and the DLQ catches it after max_receive_count.
  batch_size = 10
}
