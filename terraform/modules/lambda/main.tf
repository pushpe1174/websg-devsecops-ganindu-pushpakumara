// WAF sync worker: FIFO queue -> Lambda -> the existing WAF IPSet.
//
// Retries and the DLQ belong to the queue, so this module only owns the
// function, its permissions and the event source mapping.

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
    resources = [var.table_arn, var.config_table_arn]
  }

  // Records which version reached WAF, so the API can report APPLIED rather
  // than guessing. Write access is limited to that acknowledgement.
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

  // Scoped to exactly the tenant IPSets this worker owns - no wildcard WAF
  // access, so it cannot touch any other WebACL's IPSets.
  statement {
    sid       = "ReconcileIpSets"
    actions   = ["wafv2:GetIPSet", "wafv2:UpdateIPSet"]
    resources = var.ip_set_arns
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
      TABLE_NAME        = var.table_name
      CONFIG_TABLE_NAME = var.config_table_name
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

  // The queue has a single message group, so Lambda runs one invocation at a
  // time. No reserved concurrency needed - FIFO ordering does that for us.
  // A batch is one reconciliation regardless of size, so partial-failure
  // reporting would be meaningless here: if the run fails, the whole batch
  // returns to the queue and is redelivered, and after max_receive_count
  // attempts SQS moves it to the DLQ.
  batch_size = 10
}
