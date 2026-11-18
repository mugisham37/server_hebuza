-- Ledger safeguards: posted lines are immutable (corrections are reversal journals) and every journal balances.
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- the only allowed change: fk_ledger_journals_created_by ON DELETE SET NULL (user erasure)
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'ledger_journals' AND NEW.created_by IS NULL
     AND (to_jsonb(NEW) - 'created_by') = (to_jsonb(OLD) - 'created_by') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only: post a reversal instead', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
--> statement-breakpoint
CREATE TRIGGER trg_ledger_journals_append_only BEFORE UPDATE OR DELETE ON ledger_journals
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER trg_ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER trg_ledger_journals_no_truncate BEFORE TRUNCATE ON ledger_journals
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
CREATE TRIGGER trg_ledger_entries_no_truncate BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
--> statement-breakpoint
-- Checked at commit so a journal and its lines can be inserted in any order inside one tx.
CREATE OR REPLACE FUNCTION ledger_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  jid varchar := CASE WHEN TG_TABLE_NAME = 'ledger_journals' THEN NEW.id ELSE NEW.journal_id END;
  n int; d bigint; c bigint;
BEGIN
  SELECT count(*), coalesce(sum(debit_rwf), 0), coalesce(sum(credit_rwf), 0) INTO n, d, c
    FROM ledger_entries WHERE journal_id = jid;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'ledger journal % unbalanced (% lines, debit %, credit %)', jid, n, d, c USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_ledger_journals_balanced AFTER INSERT ON ledger_journals
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_journal_balanced();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER trg_ledger_entries_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_journal_balanced();
