#!/usr/bin/env bash
set -euo pipefail
source /etc/os-release
case "$ID" in debian|ubuntu) ;; *) echo "Unsupported Debian target: $ID" >&2; exit 1 ;; esac
export DEBIAN_FRONTEND=noninteractive
audio_library=libasound2
if [[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]]; then audio_library=libasound2t64; fi
install -d -m 1777 /tmp
apt-get update
apt-get install -y --no-install-recommends git curl build-essential ca-certificates gnupg openssh-client jq unzip \
  passwd adduser sysvinit-utils procps util-linux xz-utils ffmpeg xvfb fluxbox x11vnc \
  websockify novnc libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 "$audio_library" \
  libpango-1.0-0 libcairo2
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg
printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y --no-install-recommends gh

# Daytona sessions cannot reach PGDG on restricted network tiers. Install the
# Watchdog database in the image, before the sandbox network policy applies.
if [[ "$OI_PROVIDER" == daytona ]]; then
  install -d /usr/share/postgresql-common/pgdg /etc/postgresql-common
  curl --fail --silent --show-error --retry 3 https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  printf 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' "$VERSION_CODENAME" \
    > /etc/apt/sources.list.d/pgdg.list
  # Each repository owns its data directory; do not bake a default cluster.
  printf 'create_main_cluster = false\n' > /etc/postgresql-common/createcluster.conf
  apt-get update --error-on=any
  apt-get install -y --no-install-recommends "postgresql-$POSTGRES_MAJOR" "postgresql-client-$POSTGRES_MAJOR"
fi
