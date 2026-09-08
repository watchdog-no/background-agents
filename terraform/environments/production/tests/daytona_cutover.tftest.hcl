mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = {
        hash = "test-source-hash"
      }
    }
  }
}
mock_provider "local" {}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}

variables {
  daytona_api_key                  = "test-daytona-key"
  cloudflare_api_token             = "test-cloudflare-token"
  cloudflare_account_id            = "test-account"
  cloudflare_worker_subdomain      = "test-account"
  github_app_id                    = "1"
  github_app_private_key           = "test-private-key"
  github_app_installation_id       = "1"
  anthropic_api_key                = "test-anthropic-key"
  token_encryption_key             = "test-token-key"
  repo_secrets_encryption_key      = "test-repo-key"
  provider_accounts_encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
  nextauth_secret                  = "test-browser-auth-secret-with-32-characters"
  deployment_name                  = "auth-provider-test"

  modal_token_id     = ""
  modal_token_secret = ""
  modal_workspace    = ""
  modal_api_secret   = ""

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id       = "github-id"
  github_client_secret   = "github-secret"
  allowed_users          = "octocat"
  allowed_email_domains  = ""
  allowed_emails         = ""
  allowed_github_orgs    = ""
  unsafe_allow_all_users = false
}

run "watchdog_daytona_cutover" {
  command = plan

  assert {
    condition = (
      var.sandbox_provider == "daytona" &&
      length(module.daytona_infra) == 1 &&
      length(module.modal_app) == 0
    )
    error_message = "Watchdog production must build Daytona, with no Modal deployment."
  }

  assert {
    condition = (
      contains(module.control_plane_worker.secret_binding_names, "DAYTONA_API_KEY") &&
      !contains(module.control_plane_worker.secret_binding_names, "MODAL_API_SECRET") &&
      contains(module.control_plane_worker.plain_text_binding_names, "DAYTONA_BASE_SNAPSHOT") &&
      module.daytona_infra[0].snapshot_name == "watchdog-open-inspect-test-source-hash"
    )
    error_message = "Daytona must receive its secret and immutable runtime snapshot."
  }
}

run "missing_daytona_key_blocks_cutover" {
  command = plan
  variables {
    daytona_api_key = ""
  }
  expect_failures = [var.daytona_api_key]
}
