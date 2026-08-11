region      = "ap-southeast-1"
environment = "prod"

# Onboarding a tenant = one entry here + terraform apply. No code change.
#
#   same ip_set_name        -> tenants share an IPSet (union of their lists)
#   different ip_set_name   -> separate IPSets, fully isolated
#   create_ip_set = false   -> adopt an IPSet that already exists
tenants = {
  agency-a = {
    ip_set_name = "websg-cms-allowlist-agency-a"
    description = "Agency A CMS"
  }

  agency-b = {
    ip_set_name = "websg-cms-allowlist-agency-b"
    description = "Agency B CMS"
  }

  # These two share one IPSet, the way the platform worked before per-tenant
  # sets existed. Migrating them later is a name change here, nothing more.
  agency-c = {
    ip_set_name = "websg-cms-allowlist-shared"
    description = "Agency C CMS (shared IPSet)"
  }

  agency-d = {
    ip_set_name = "websg-cms-allowlist-shared"
    description = "Agency D CMS (shared IPSet)"
  }
}

# Always kept in every IPSet so an empty table cannot lock the ops team out of
# the CMS. Replace with the real corporate egress ranges before the first apply.
break_glass_cidrs = ["112.134.158.144/32"] # company ip range

# Notified when a sync fails onto the DLQ. Each address confirms once by email.
alert_emails = ["ganindu.devops+alerts@gmail.com"]
