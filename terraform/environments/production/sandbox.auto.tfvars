# Watchdog production cutover. This file takes precedence over legacy TF_VAR_*
# settings (including the existing SANDBOX_PROVIDER=modal Actions secret).
# Credentials remain in GitHub Actions secrets, never in this file.
sandbox_provider      = "daytona"
daytona_api_url       = "https://app.daytona.io/api"
daytona_base_snapshot = "watchdog-open-inspect"
