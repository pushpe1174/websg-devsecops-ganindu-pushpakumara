output "alert_topic_arn" {
  description = "SNS topic the alarms publish to."
  value       = aws_sns_topic.alerts.arn
}

output "alarm_names" {
  description = "Alarms created by this module."
  value = [
    aws_cloudwatch_metric_alarm.dlq_not_empty.alarm_name,
    aws_cloudwatch_metric_alarm.lambda_errors.alarm_name,
  ]
}
