// One shared SQS FIFO queue between the API and the reconciler.
//
// The queue earns its keep as a mutex, not as transport. MessageGroupId is the
// tenant id on every producer - the API and the scheduled sweep alike - and FIFO
// allows one in-flight batch per group, so there is never a second concurrent
// writer to a tenant's IPSet and WAFOptimisticLockException cannot occur.
//
// The message carries no data. The worker rebuilds a tenant's IPSet from the
// table, so duplication, reordering and redelivery are all harmless.

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

  // For the sweep only. EventBridge has no dedup-id field on an SQS target, so
  // FIFO delivery needs this; the input transformer stamps the event time to
  // keep each check distinct within the 5-minute window.
  //
  // The API does not rely on it: it sends an explicit MessageDeduplicationId of
  // tenant:owner:version, which takes precedence. That id is per logical edit,
  // so an API retry collapses while a genuine second edit is never swallowed.
  content_based_deduplication = true

  // Must exceed the function timeout, or a slow run is redelivered while the
  // first invocation is still working.
  visibility_timeout_seconds = var.visibility_timeout_seconds
  message_retention_seconds  = 345600 # 4 days
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = var.max_receive_count
  })

  tags = var.tags
}

// ------------------------------------------------------------ Drift check
//
// Two jobs. It reverts a manual console edit to an IPSet, which edits alone
// would leave in place until the next tenant write. And it bounds the cost of a
// lost signal: the DynamoDB write and the SQS send are not atomic, so a write
// that never produced a message is picked up here instead of hanging PENDING.

resource "aws_cloudwatch_event_rule" "drift_check" {
  name                = "${var.name}-drift-check"
  description         = "Periodic reconciliation, reverts IPSet edits made outside the application"
  schedule_expression = var.drift_check_schedule

  tags = var.tags
}

// One target per tenant, each in that tenant's message group. A sweep therefore
// queues behind that tenant's edits instead of running alongside them - without
// this, the sweep would be the one producer able to collide on the lock token
// that every other producer is arranged to protect.
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
