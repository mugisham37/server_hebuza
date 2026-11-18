#!/bin/sh
# Restore drill / disaster recovery: restore.sh <r2-key> <target-database-url>
# Needs AGE_IDENTITY (the offline private key, supplied only for the restore) + the same R2 env as backup.sh.
set -eu
KEY=${1:?r2 key}; TARGET=${2:?target database url}
: "${AGE_IDENTITY:?private key required}"
export AWS_DEFAULT_REGION=auto
ID=$(mktemp); printf '%s\n' "$AGE_IDENTITY" > "$ID"
aws s3 cp "s3://$R2_BUCKET/$KEY" - --endpoint-url "$R2_ENDPOINT" | age -d -i "$ID" | pg_restore --no-owner --clean --if-exists -d "$TARGET"
rm -f "$ID"
echo "restored $KEY"
