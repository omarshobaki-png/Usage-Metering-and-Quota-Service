-- Preserve existing decisions and give tied legacy timestamps a stable order.
-- The migration transaction holds the table lock until the backfill is done.
ALTER TABLE request_decisions ADD COLUMN decision_sequence bigint;

WITH ordered AS (
  SELECT account_id, request_id,
    row_number() OVER (ORDER BY processed_at, account_id, request_id) AS sequence
  FROM request_decisions
)
UPDATE request_decisions d
SET decision_sequence = ordered.sequence
FROM ordered
WHERE d.account_id = ordered.account_id AND d.request_id = ordered.request_id;

ALTER TABLE request_decisions
  ALTER COLUMN decision_sequence SET NOT NULL,
  ALTER COLUMN decision_sequence ADD GENERATED ALWAYS AS IDENTITY,
  ADD CONSTRAINT request_decisions_sequence_positive CHECK (decision_sequence > 0);

SELECT setval(
  pg_get_serial_sequence('request_decisions', 'decision_sequence'),
  COALESCE(MAX(decision_sequence), 1),
  MAX(decision_sequence) IS NOT NULL
) FROM request_decisions;

-- New values are allocated by INSERT after consumption acquires its account
-- lock. Sequence gaps after rollbacks are valid; values are not usage quantities.
CREATE UNIQUE INDEX request_decisions_account_sequence_idx
  ON request_decisions (account_id, decision_sequence DESC);
