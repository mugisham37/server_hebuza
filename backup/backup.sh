#!/bin/sh
# Railway cron (daily 01:00 UTC). Tier: monthly on the 1st, weekly on Sundays, else daily — R2 lifecycle rules expire each tier.
# status/LATEST-<env>.json sits outside postgres/ because that prefix is under the 14-day deletion lock (not overwritable).
# Env: DIRECT_DATABASE_URL, BACKUP_AGE_RECIPIENT (age public key), R2_ENDPOINT, R2_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY.
set -eu
: "${DIRECT_DATABASE_URL:?}" "${BACKUP_AGE_RECIPIENT:?}" "${R2_ENDPOINT:?}" "${R2_BUCKET:?}"
export AWS_DEFAULT_REGION=auto
TS=$(date -u +%Y-%m-%dT%H%M%SZ)
TIER=daily; [ "$(date -u +%u)" = 7 ] && TIER=weekly; [ "$(date -u +%d)" = 01 ] && TIER=monthly
KEY="postgres/$TIER/hebuza-${RAILWAY_ENVIRONMENT_NAME:-env}-$TS.dump.age"
TMP=$(mktemp)
pg_dump "$DIRECT_DATABASE_URL" --format=custom --no-owner --compress=9 | age -r "$BACKUP_AGE_RECIPIENT" > "$TMP"
SIZE=$(wc -c < "$TMP")
[ "$SIZE" -gt 1024 ] || { echo "backup too small ($SIZE bytes)"; exit 1; }
aws s3 cp "$TMP" "s3://$R2_BUCKET/$KEY" --endpoint-url "$R2_ENDPOINT" --only-show-errors
printf '{"at":"%s","tier":"%s","key":"%s","bytes":%s}' "$TS" "$TIER" "$KEY" "$SIZE" \
  | aws s3 cp - "s3://$R2_BUCKET/status/LATEST-${RAILWAY_ENVIRONMENT_NAME:-env}.json" --endpoint-url "$R2_ENDPOINT" --only-show-errors
rm -f "$TMP"
echo "backup ok: $KEY ($SIZE bytes)"
