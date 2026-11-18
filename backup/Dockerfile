# Nightly encrypted Postgres backup → Cloudflare R2 (docs/DEPLOYMENT-RAILWAY-CLOUDFLARE.md §7).
# Official Postgres image so pg_dump is never older than the server; age encrypts with a public key only.
FROM postgres:18-alpine
RUN apk add --no-cache age aws-cli ca-certificates
COPY backup.sh restore.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh
USER postgres
CMD ["backup.sh"]
