resource "aws_sqs_queue" "dlq" {
  name       = "${var.name}-dlq.fifo"
  fifo_queue = true

  message_retention_seconds = 1209600 # 14 days, the SQS maximum
  sqs_managed_sse_enabled   = true

  tags = var.tags
}

resource "aws_sqs_queue" "main" {
  name       = "${var.name}.fifo"
  fifo_queue = true
  content_based_deduplication = true
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = 345600 # 4 days
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = var.tags
}

resource "aws_cloudwatch_event_rule" "drift_check" {
  name                = "${var.name}-drift-check"
  description         = "Periodic reconciliation, reverts IPSet edits made outside the application"
  schedule_expression = var.drift_check_schedule

  tags = var.tags
}

resource "aws_cloudwatch_event_target" "drift_check" {
  for_each = var.tenant_ids

  rule      = aws_cloudwatch_event_rule.drift_check.name
  target_id = "sweep-${each.key}"
  arn       = aws_sqs_queue.main.arn

  sqs_target {
    message_group_id = each.key
  }

  input_transformer {
    input_paths    = { time = "$.time" }
    input_template = "{\"source\":\"drift-check\",\"tenantId\":\"${each.key}\",\"time\":<time>}"
  }
}

data "aws_iam_policy_document" "queue" {
  statement {
    sid       = "AllowScheduledDriftCheck"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.main.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.drift_check.arn]
    }
  }
}

resource "aws_sqs_queue_policy" "main" {
  queue_url = aws_sqs_queue.main.id
  policy    = data.aws_iam_policy_document.queue.json
}
