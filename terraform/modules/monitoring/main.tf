resource "aws_sns_topic" "alerts" {
  name              = "${var.name_prefix}-alerts"
  kms_master_key_id = "alias/aws/sns"

  tags = var.tags
}

resource "aws_sns_topic_subscription" "email" {
  for_each = toset(var.alert_emails)

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value // each address must confirm by email once
}

resource "aws_cloudwatch_metric_alarm" "dlq_not_empty" {
  alarm_name        = "${var.name_prefix}-dlq-not-empty"
  alarm_description = "A sync message failed permanently and was parked on the DLQ. Tenant IP allowlist changes are NOT reaching AWS WAF."

  namespace   = "AWS/SQS"
  metric_name = "ApproximateNumberOfMessagesVisible"
  dimensions  = { QueueName = var.dlq_name }

  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn] // notify on recovery too

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "sync_stuck" {
  for_each = var.tenant_ids

  alarm_name        = "${var.name_prefix}-sync-stuck-${each.key}"
  alarm_description = "Tenant ${each.key} has an allowlist edit that has not reached AWS WAF. Nothing has failed onto the DLQ, so check the function logs for repeated retries."

  namespace   = var.metric_namespace
  metric_name = "OldestUnacknowledgedAgeSeconds"
  dimensions  = { Tenant = each.key }

  statistic           = "Maximum"
  period              = 900
  evaluation_periods  = 1
  threshold           = var.stuck_threshold_seconds
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name        = "${var.name_prefix}-errors"
  alarm_description = "The WAF sync function is erroring. Retries may still succeed; investigate before batches reach the DLQ."

  namespace   = "AWS/Lambda"
  metric_name = "Errors"
  dimensions  = { FunctionName = var.function_name }

  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = var.tags
}
