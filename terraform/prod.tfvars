region      = "ap-southeast-1"
environment = "prod"

# One entry = one table + one IPSet, both "websg-cms-allowlist-<key>".
# Agencies that must share an IPSet share a key (see tenant-shared).
tenants = {
  tenant-a = {
    description = "Agency A CMS"
  }

  tenant-b = {
    description = "Agency B CMS"
  }

  tenant-shared = {
    description = "Agencies C and D, one shared IPSet"
  }
}

# Always kept in every IPSet so an empty table cannot lock the ops team out of
# the CMS. Replace with the real corporate egress ranges before the first apply.
break_glass_cidrs = ["112.134.158.144/32"] # company ip range

# Notified when a sync fails onto the DLQ. Each address confirms once by email.
alert_emails = ["ganindu.devops+alerts@gmail.com"]
