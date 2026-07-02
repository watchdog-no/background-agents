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
  echo "$DUPES" | sed 's/^/  /' >&2
fi

# 1. Ensure tracking table exists
$WRANGLER d1 execute "$DATABASE_NAME" --remote \
  --command "CREATE TABLE IF NOT EXISTS _schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )"

# 2. Self-heal legacy rows: older versions of this script keyed rows on the
# numeric prefix. Rekey them to the full filename (stored in `name` all along)
# so filename-based tracking picks them up. Idempotent no-op once migrated.
$WRANGLER d1 execute "$DATABASE_NAME" --remote \
  --command "UPDATE _schema_migrations SET version = name WHERE version <> name"

# 3. Get applied filenames (parse JSON output)
APPLIED=$($WRANGLER d1 execute "$DATABASE_NAME" --remote \
  --command "SELECT name FROM _schema_migrations ORDER BY name" \
  --json | jq -r '.[0].results[].name // empty' 2>/dev/null || echo "")

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
  if APPLY_OUTPUT=$($WRANGLER d1 execute "$DATABASE_NAME" --remote --file "$file" 2>&1); then
    echo "$APPLY_OUTPUT"
  elif echo "$APPLY_OUTPUT" | grep -qi "duplicate column name"; then
    echo "  Columns already present; recording as applied without re-running."
  else
    echo "$APPLY_OUTPUT" >&2
    exit 1
  fi

  SAFE_FILENAME=$(echo "$FILENAME" | sed "s/'/''/g")
  $WRANGLER d1 execute "$DATABASE_NAME" --remote \
    --command "INSERT INTO _schema_migrations (version, name) VALUES ('$SAFE_FILENAME', '$SAFE_FILENAME')"

  COUNT=$((COUNT + 1))
done

echo "Done. Applied $COUNT migration(s)."
