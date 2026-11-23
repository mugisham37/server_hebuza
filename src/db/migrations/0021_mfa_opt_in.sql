-- 2FA becomes opt-in for every role: switch off the 2FA that was forced or seeded so nobody is asked for a code
-- until they turn it on themselves from the dashboard suggestion or Settings.
UPDATE "staff_profiles" SET "twofa_enabled" = false, "totp_secret_encrypted" = NULL, "totp_last_step" = NULL WHERE "twofa_enabled" = true;--> statement-breakpoint
DELETE FROM "backup_codes";--> statement-breakpoint
DELETE FROM "auth_trusted_devices";
