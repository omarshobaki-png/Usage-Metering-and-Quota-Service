DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'plans'
      AND column_name = 'id'
      AND data_type = 'uuid'
  ) THEN
    ALTER TABLE accounts
      DROP CONSTRAINT IF EXISTS accounts_account_plan_fk;
    ALTER TABLE users
      DROP CONSTRAINT IF EXISTS users_user_plan_id_fkey;
    ALTER TABLE request_decisions
      DROP CONSTRAINT IF EXISTS request_decisions_account_plan_id_fkey,
      DROP CONSTRAINT IF EXISTS request_decisions_user_plan_id_fkey;

    ALTER TABLE plans ADD COLUMN new_id integer;

    UPDATE plans
    SET new_id = CASE id
      WHEN '10000000-0000-4000-8000-000000000001'::uuid THEN 1
      WHEN '10000000-0000-4000-8000-000000000002'::uuid THEN 2
      WHEN '20000000-0000-4000-8000-000000000001'::uuid THEN 3
      WHEN '20000000-0000-4000-8000-000000000002'::uuid THEN 4
      ELSE NULL
    END;

    WITH numbered_custom_plans AS (
      SELECT
        id,
        row_number() OVER (ORDER BY created_at, id)::integer + 4 AS new_id
      FROM plans
      WHERE new_id IS NULL
    )
    UPDATE plans
    SET new_id = numbered_custom_plans.new_id
    FROM numbered_custom_plans
    WHERE plans.id = numbered_custom_plans.id;

    ALTER TABLE plans ALTER COLUMN new_id SET NOT NULL;

    ALTER TABLE accounts ADD COLUMN account_plan_id_new integer;
    UPDATE accounts
    SET account_plan_id_new = plans.new_id
    FROM plans
    WHERE accounts.account_plan_id = plans.id;
    ALTER TABLE accounts ALTER COLUMN account_plan_id_new SET NOT NULL;

    ALTER TABLE users ADD COLUMN user_plan_id_new integer;
    UPDATE users
    SET user_plan_id_new = plans.new_id
    FROM plans
    WHERE users.user_plan_id = plans.id;
    ALTER TABLE users ALTER COLUMN user_plan_id_new SET NOT NULL;

    ALTER TABLE request_decisions
      ADD COLUMN account_plan_id_new integer,
      ADD COLUMN user_plan_id_new integer;
    UPDATE request_decisions
    SET
      account_plan_id_new = account_plans.new_id,
      user_plan_id_new = user_plans.new_id
    FROM plans AS account_plans, plans AS user_plans
    WHERE request_decisions.account_plan_id = account_plans.id
      AND request_decisions.user_plan_id = user_plans.id;
    ALTER TABLE request_decisions
      ALTER COLUMN account_plan_id_new SET NOT NULL,
      ALTER COLUMN user_plan_id_new SET NOT NULL;

    ALTER TABLE accounts DROP COLUMN account_plan_id;
    ALTER TABLE accounts RENAME COLUMN account_plan_id_new TO account_plan_id;

    ALTER TABLE users DROP COLUMN user_plan_id;
    ALTER TABLE users RENAME COLUMN user_plan_id_new TO user_plan_id;

    ALTER TABLE request_decisions
      DROP COLUMN account_plan_id,
      DROP COLUMN user_plan_id;
    ALTER TABLE request_decisions
      RENAME COLUMN account_plan_id_new TO account_plan_id;
    ALTER TABLE request_decisions
      RENAME COLUMN user_plan_id_new TO user_plan_id;

    ALTER TABLE plans DROP CONSTRAINT plans_pkey;
    ALTER TABLE plans DROP COLUMN id;
    ALTER TABLE plans RENAME COLUMN new_id TO id;
    ALTER TABLE plans ADD CONSTRAINT plans_pkey PRIMARY KEY (id);

    CREATE SEQUENCE plans_id_seq;
    ALTER SEQUENCE plans_id_seq OWNED BY plans.id;
    ALTER TABLE plans
      ALTER COLUMN id SET DEFAULT nextval('plans_id_seq');
    PERFORM setval(
      'plans_id_seq',
      COALESCE((SELECT max(id) FROM plans), 1),
      EXISTS (SELECT 1 FROM plans)
    );

    ALTER TABLE accounts
      ADD CONSTRAINT accounts_account_plan_fk
      FOREIGN KEY (account_plan_id) REFERENCES plans(id) ON DELETE RESTRICT;
    ALTER TABLE users
      ADD CONSTRAINT users_user_plan_id_fkey
      FOREIGN KEY (user_plan_id) REFERENCES plans(id) ON DELETE RESTRICT;
    ALTER TABLE request_decisions
      ADD CONSTRAINT request_decisions_account_plan_id_fkey
      FOREIGN KEY (account_plan_id) REFERENCES plans(id) ON DELETE RESTRICT,
      ADD CONSTRAINT request_decisions_user_plan_id_fkey
      FOREIGN KEY (user_plan_id) REFERENCES plans(id) ON DELETE RESTRICT;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'plans'::regclass
      AND conname = 'plans_owner_account_id_fkey'
  ) THEN
    ALTER TABLE plans
      RENAME CONSTRAINT plans_owner_account_id_fkey TO plans_owner_account_fk;
  END IF;
END
$$;
