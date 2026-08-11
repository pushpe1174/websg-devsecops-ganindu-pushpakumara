// DynamoDB stream -> EventBridge Pipe -> SQS FIFO queue.
//
// Streams cannot target SQS directly, so a Pipe does the hop. It is a managed
// integration: no forwarder function to write, deploy or monitor.
//
// The queue is FIFO, keyed by tenant, which gives three things:
//   - ordering per tenant: two edits from one tenant are never reordered
//   - parallelism across tenants: Lambda scales FIFO by message group, so
//     tenant C and tenant D reconcile at the same time
//   - a real DLQ: the failed message itself is parked, and SQS can redrive it
//     back to the source queue with one API call.

locals {
  // The drift check has no tenant of its own, so it gets a group of its own.
  // Tenant edits use the tenant id (see the pipe's target parameters).
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
// Reconciliation only runs when a tenant edits their list, so a manual console
// edit to an IPSet would survive until the next edit - potentially forever on a
// quiet tenant. This schedule puts a message on the same queue, and because the
// worker rebuilds from the tables, that reverts any change made outside the
// application.

resource "aws_cloudwatch_event_rule" "drift_check" {
  name                = "${var.name}-drift-check"
  description         = "Periodic reconciliation, reverts IPSet edits made outside the application"
  schedule_expression = var.drift_check_schedule

  tags = var.tags
}

resource "aws_cloudwatch_event_target" "drift_check" {
  rule = aws_cloudwatch_event_rule.drift_check.name
  arn  = aws_sqs_queue.main.arn

  // Its own group, so a full sweep runs alongside tenant edits rather than
  // queueing behind them.
  sqs_target {
    message_group_id = local.drift_check_group_id
  }

  // The queue deduplicates on content within a 5-minute window, so a fixed body
  // would be swallowed on tighter schedules. Stamping the event time keeps each
  // check distinct whatever the schedule is set to.
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
    resources = [var.stream_arn]
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
  name     = var.name
  role_arn = aws_iam_role.pipe.arn
  source   = var.stream_arn
  target   = aws_sqs_queue.main.arn

  source_parameters {
    /**
     * Suppresses the worker's own acknowledgement writes.
     *
     * The API replaces the whole item on every write, so a tenant edit never
     * carries `syncedVersion`. The worker's UpdateItem is the only thing that
     * sets it. Forwarding only records without that attribute therefore means
     * "tenant edits only", and the sync loop cannot feed itself.
     *
     * `exists` works on leaf nodes only, hence matching `syncedVersion.N`
     * rather than `syncedVersion`.
     *
     * This depends on the API replacing rather than merging the item - see the
     * note in backend/src/modules/ip-allowlist/repository.ts.
     */
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
      /**
       * The group is the tenant, taken from the stream record at runtime -
       * Pipes replaces a target parameter whose entire value is a JSON path.
       *
       * FIFO scales Lambda by message group, so edits from different tenants
       * are processed in parallel while edits from one tenant stay ordered.
       * Two tenants sharing an IPSet can therefore collide; the WAF lock token
       * turns that into a retry rather than a lost update.
       */
      message_group_id = "$.dynamodb.Keys.tenantId.S"
    }
  }

  tags = var.tags

  depends_on = [aws_iam_role_policy.pipe]
}
