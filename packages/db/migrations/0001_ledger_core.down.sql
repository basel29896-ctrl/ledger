DROP VIEW IF EXISTS trial_balance_view;

DROP FUNCTION IF EXISTS ledger_verify(UUID);
DROP FUNCTION IF EXISTS ledger_rebuild_balances(UUID);
DROP FUNCTION IF EXISTS allocate_document_number(UUID, TEXT, TEXT);

DROP TABLE IF EXISTS account_balances;
DROP TABLE IF EXISTS journal_lines;
DROP TABLE IF EXISTS journal_entries;
DROP TABLE IF EXISTS number_sequences;
DROP TABLE IF EXISTS accounts;
DROP TABLE IF EXISTS fiscal_periods;
DROP TABLE IF EXISTS fiscal_years;
DROP TABLE IF EXISTS exchange_rates;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;
DROP TABLE IF EXISTS currencies;

DROP FUNCTION IF EXISTS assert_period_closable();
DROP FUNCTION IF EXISTS assert_postable_period();
DROP FUNCTION IF EXISTS assert_line_integrity();
DROP FUNCTION IF EXISTS assert_posted_line_immutable();
DROP FUNCTION IF EXISTS assert_posted_entry_immutable();
DROP FUNCTION IF EXISTS assert_entry_has_balanced_lines();
DROP FUNCTION IF EXISTS assert_entry_balanced();
DROP FUNCTION IF EXISTS assert_parent_not_postable();
DROP FUNCTION IF EXISTS assert_account_normal_balance();
DROP FUNCTION IF EXISTS set_updated_at();
DROP FUNCTION IF EXISTS uuid_generate_v7();

DROP TYPE IF EXISTS source_module;
DROP TYPE IF EXISTS entry_side;
DROP TYPE IF EXISTS entry_status;
DROP TYPE IF EXISTS normal_balance;
DROP TYPE IF EXISTS account_type;
DROP TYPE IF EXISTS fiscal_status;
