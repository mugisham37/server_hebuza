-- plpgsql resolves NEW.journal_id even in the untaken CASE branch, failing on ledger_journals; read via jsonb instead.
CREATE OR REPLACE FUNCTION ledger_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  jid varchar := CASE WHEN TG_TABLE_NAME = 'ledger_journals' THEN to_jsonb(NEW)->>'id' ELSE to_jsonb(NEW)->>'journal_id' END;
  n int; d bigint; c bigint;
BEGIN
  SELECT count(*), coalesce(sum(debit_rwf), 0), coalesce(sum(credit_rwf), 0) INTO n, d, c
    FROM ledger_entries WHERE journal_id = jid;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'ledger journal % unbalanced (% lines, debit %, credit %)', jid, n, d, c USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
