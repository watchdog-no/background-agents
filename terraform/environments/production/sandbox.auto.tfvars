# Watchdog production uses Modal. This file takes precedence over TF_VAR_*
# settings so stale provider configuration cannot switch production back.
# Credentials remain in GitHub Actions secrets, never in this file.
sandbox_provider = "modal"
