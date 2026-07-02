#!/usr/bin/env bash
set -euo pipefail

# Applies pending D1 migrations, tracking applied state by FULL FILENAME in
# _schema_migrations. The numeric prefix only determines apply order, so two
# files sharing a prefix (e.g. an upstream sync colliding with a fork-local
# migration) both apply — nothing is silently skipped and nothing crashes.
#
# Fork convention: fork-local migrations use the 9000+ prefix band so they sort
# after upstream's sequential numbering and never collide with it.

DATABASE_NAME="${1:?Usage: d1-migrate.sh <database-name> [migrations-dir]}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="${2:-$SCRIPT_DIR/../terraform/d1/migrations}"

WRANGLER="npx wrangler"
D1_MAX_ATTEMPTS="${D1_MIGRATE_MAX_ATTEMPTS:-4}"
D1_RETRY_DELAY_SECONDS="${D1_MIGRATE_RETRY_DELAY_SECONDS:-3}"

case "$D1_MAX_ATTEMPTS" in
  "" | *[!0-9]*)
    echo "ERROR: D1_MIGRATE_MAX_ATTEMPTS must be a positive integer." >&2
    exit 1
    ;;
esac

case "$D1_RETRY_DELAY_SECONDS" in
  "" | *[!0-9]*)
    echo "ERROR: D1_MIGRATE_RETRY_DELAY_SECONDS must be a non-negative integer." >&2
    exit 1
    ;;
esac

if [ "$D1_MAX_ATTEMPTS" -lt 1 ]; then
  echo "ERROR: D1_MIGRATE_MAX_ATTEMPTS must be at least 1." >&2
  exit 1
fi

is_retryable_d1_error() {
  printf '%s\n' "$1" | grep -Eiq \
    "D1 DB storage operation exceeded timeout|object to be reset|code: 7429|timed? ?out|timeout|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|HTTP 429|HTTP 503|HTTP 504"
}

d1_execute_with_retry() {
  local description="$1"
  shift

  local attempt=1
  local delay="$D1_RETRY_DELAY_SECONDS"
  local output
  local stderr_file
  local stderr_output
  local status

  while true; do
    stderr_file=$(mktemp)
    if output=$($WRANGLER d1 execute "$DATABASE_NAME" --remote "$@" 2>"$stderr_file"); then
      cat "$stderr_file" >&2
      rm -f "$stderr_file"
      printf '%s\n' "$output"
      return 0
    else
      status=$?
    fi

    stderr_output=$(cat "$stderr_file")
    rm -f "$stderr_file"
    output="${output}"$'\n'"${stderr_output}"

    if [ "$attempt" -lt "$D1_MAX_ATTEMPTS" ] && is_retryable_d1_error "$output"; then
      printf 'D1 %s failed with a transient error (attempt %s/%s); retrying in %ss.\n' \
        "$description" "$attempt" "$D1_MAX_ATTEMPTS" "$delay" >&2
      printf '%s\n' "$output" >&2
      sleep "$delay"
      attempt=$((attempt + 1))
      delay=$((delay * 2))
      continue
    fi

    printf '%s\n' "$output"
    return "$status"
  done
}

d1_execute_once() {
  $WRANGLER d1 execute "$DATABASE_NAME" --remote "$@" 2>&1
}

# 0. Validate filenames. A numeric prefix is required for deterministic
# ordering. Duplicate prefixes are allowed (tracking is by filename), but
# usually signal fork/upstream numbering drift, so call them out.
INVALID_FILES=""
PREFIXES=""
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$file" ] || continue
  BASE=$(basename "$file")
  # `|| true` so a prefix-less filename doesn't trip the grep's non-zero exit
  # under `set -o pipefail` and abort before we can report it below.
  PREFIX=$(printf '%s' "$BASE" | grep -oE '^[0-9]+' || true)
  if [ -z "$PREFIX" ]; then
    INVALID_FILES+="  $BASE"$'\n'
  else
    PREFIXES+="$PREFIX"$'\n'
  fi
done

if [ -n "$INVALID_FILES" ]; then
  echo "ERROR: migration files without a leading numeric prefix:" >&2
  printf '%s' "$INVALID_FILES" >&2
  echo "Rename them as NNNN_description.sql so they order deterministically." >&2
  exit 1
fi

DUPES=$(printf '%s' "$PREFIXES" | sort | uniq -d)
if [ -n "$DUPES" ]; then
  echo "WARNING: duplicate migration version prefixes (safe — tracked by filename, applied in filename order):" >&2
  while IFS= read -r duplicate_prefix; do
    [ -n "$duplicate_prefix" ] || continue
    echo "  $duplicate_prefix" >&2
  done <<< "$DUPES"
fi

# 1. Ensure tracking table exists
d1_execute_with_retry "tracking table creation" \
  --command "CREATE TABLE IF NOT EXISTS _schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )"

# 2. Self-heal legacy rows: older versions of this script keyed rows on the
# numeric prefix. Rekey them to the full filename (stored in `name` all along)
# so filename-based tracking picks them up. Idempotent no-op once migrated.
d1_execute_with_retry "legacy migration key healing" \
  --command "UPDATE OR IGNORE _schema_migrations SET version = name WHERE version <> name"

# 3. Get applied filenames (parse JSON output)
APPLIED_JSON=$(d1_execute_with_retry "applied migration read" \
  --command "SELECT name FROM _schema_migrations ORDER BY name" \
  --json)
APPLIED=$(printf '%s\n' "$APPLIED_JSON" | jq -r '.[0].results[].name // empty')

# 4. Apply pending migrations in filename order (the glob sorts)
COUNT=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$file" ] || continue
  FILENAME=$(basename "$file")

  if echo "$APPLIED" | grep -qxF "$FILENAME"; then
    echo "Skip (already applied): $FILENAME"
    continue
  fi

  echo "Applying: $FILENAME"
  # Tolerate "duplicate column name": the migration was already applied under a
  # different filename (e.g. a file renamed after a collision) so the schema
  # is already in the target state. ADD COLUMN has no IF NOT EXISTS in SQLite,
  # so record it as applied and move on instead of aborting the whole deploy.
  # Every other error still aborts.
  #
  # Do not retry migration files automatically: several migrations are not
  # safely repeatable if D1 times out after partial execution. The idempotent
  # bookkeeping commands around them are retried above and below.
  if APPLY_OUTPUT=$(d1_execute_once --file "$file"); then
    echo "$APPLY_OUTPUT"
  elif echo "$APPLY_OUTPUT" | grep -qi "duplicate column name"; then
    echo "  Columns already present; recording as applied without re-running."
  else
    echo "$APPLY_OUTPUT" >&2
    exit 1
  fi

  SAFE_FILENAME=${FILENAME//\'/\'\'}
  d1_execute_with_retry "migration record insert" \
    --command "INSERT OR IGNORE INTO _schema_migrations (version, name) VALUES ('$SAFE_FILENAME', '$SAFE_FILENAME')"

  COUNT=$((COUNT + 1))
done

echo "Done. Applied $COUNT migration(s)."
