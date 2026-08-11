// Per-tenant DynamoDB stream -> EventBridge Pipe -> one shared SQS FIFO queue.
//
// Streams cannot target SQS directly, so a Pipe does the hop - a managed
// integration, no forwarder function to run. The queue is FIFO and grouped by
// tenant: edits from one tenant stay ordered, different tenants reconcile in
// parallel, and a failed message is parked on the DLQ for redrive.

locals {
  // The drift check owns no list, so it gets a group of its own. Edits use the
  // list owner id (see the pipe's target parameters).
  drift_check_group_id = "drift-check"
}

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

  // Stream records are unique, so this only collapses genuine duplicates.
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
// Edits alone would leave a manual console change to an IPSet in place until the
// next edit. This schedule re-runs the worker, which rebuilds from the tables.

resource "aws_cloudwatch_event_rule" "drift_check" {
  name                = "${var.name}-drift-check"
  description         = "Periodic reconciliation, reverts IPSet edits made outside the application"
  schedule_expression = var.drift_check_schedule

  tags = var.tags
}

resource "aws_cloudwatch_event_target" "drift_check" {
  rule = aws_cloudwatch_event_rule.drift_check.name
  arn  = aws_sqs_queue.main.arn

  // Own group, so a sweep runs alongside tenant edits instead of behind them.
  sqs_target {
    message_group_id = local.drift_check_group_id
  }

  // Content dedup would swallow a fixed body within its 5-minute window, so
  // stamp the event time to keep each check distinct.
  input_transformer {
    input_paths    = { time = "$.time" }
    input_template = "{\"source\":\"drift-check\",\"time\":<time>}"
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

// ---------------------------------------------------------------- Pipe role

data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["pipes.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "pipe" {
  name               = "${var.name}-pipe-role"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
  tags               = var.tags
}

data "aws_iam_policy_document" "pipe" {
  statement {
    sid = "ReadStream"
    actions = [
      "dynamodb:DescribeStream",
      "dynamodb:GetRecords",
      "dynamodb:GetShardIterator",
      "dynamodb:ListStreams",
    ]
    resources = values(var.stream_arns)
  }

  statement {
    sid       = "SendToQueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.main.arn]
  }
}

resource "aws_iam_role_policy" "pipe" {
  name   = "${var.name}-pipe-policy"
  role   = aws_iam_role.pipe.id
  policy = data.aws_iam_policy_document.pipe.json
}

// ---------------------------------------------------------------- Pipe

resource "aws_pipes_pipe" "stream_to_queue" {
  for_each = var.stream_arns

  name     = "${var.name}-${each.key}"
  role_arn = aws_iam_role.pipe.arn
  source   = each.value
  target   = aws_sqs_queue.main.arn

  source_parameters {
    // Forwards tenant edits only, so the sync loop cannot feed itself: the API
    // replaces the whole item (never carries `syncedVersion`), the worker's
    // acknowledgement is the only write that sets it. `exists` needs a leaf
    // node, hence `syncedVersion.N`. See backend ip-allowlist/repository.ts.
    filter_criteria {
      filter {
        pattern = jsonencode({
          dynamodb = {
            NewImage = {
              syncedVersion = {
                N = [{ exists = false }]
              }
            }
          }
        })
      }
    }

    dynamodb_stream_parameters {
      starting_position = "LATEST"

      // One stream record becomes one SQS message, so each message carries a
      // single tenant and the dynamic group id below resolves cleanly. 10 is
      // the SendMessageBatch maximum.
      batch_size                         = 10
      maximum_batching_window_in_seconds = 5

      // The Pipe only forwards; retries beyond this are the queue's job.
      maximum_retry_attempts = 3
    }
  }

  target_parameters {
    sqs_queue_parameters {
      // Group = the item key, resolved from the record at runtime (Pipes
      // substitutes a value that is entirely a JSON path). Keeps one tenant's
      // edits ordered while other tenants run in parallel; concurrent writers
      // on a shared IPSet collide on the WAF lock token and retry.
      message_group_id = "$.dynamodb.Keys.ownerId.S"
    }
  }

  tags = var.tags

  depends_on = [aws_iam_role_policy.pipe]
}
