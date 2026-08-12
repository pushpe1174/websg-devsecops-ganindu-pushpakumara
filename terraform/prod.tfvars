region      = "ap-southeast-1"
environment = "prod"

# One entry = one IPSet, "websg-cms-allowlist-<key>", and a partition key in the
# shared table. Agencies that must share an IPSet share a key (see tenant-shared).
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

# Merged into every IPSet, so an empty table cannot lock ops out of the CMS.
# Replace with the real corporate egress ranges before the first apply.
break_glass_cidrs = ["112.134.158.144/32"] # company ip range

# Notified when an alarm fires. Each address confirms once by email.
alert_emails = ["ganindu.devops+alerts@gmail.com"]
