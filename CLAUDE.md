# demeisen_intranet_v2_crm: notes for Claude sessions

Investor CRM for Demeisen LLP. Read README.md first. Shareable on its own with `_ui` and `_auth`.

## Rules
- Data lives in `data/data.yaml` (stack `demeisen-v2-crm-data`). Never remove `DeletionPolicy`, `DeletionProtection`,
  encryption, backups or the stack policy; `python3 tools/check-guardrails.py data/data.yaml` must pass.
- Never change `SourceSnapshot` once Phase is `live` (it would replace the database). The Deploy data workflow refuses it.
- Data changes only through the **Deploy data** workflow (GitHub environment `data`, needs Russell's approval).
  App changes deploy on merge to main. Nothing is deployed from a laptop; no AWS keys in the repo or in CI secrets.
- Schema changes: add a new `db/migrations/NNN_*.sql`; never edit an applied one. CI applies all of them to MySQL 8.4.
- Never commit investor data. Workbooks and CSVs are ignored by `.gitignore`; page example data is fictional.
- `web/index.html` must keep working both at `/` and under `/crm/` (use `BASE` for every URL).
- AWS: account 642552605309, eu-west-2. App role `demeisen-v2-github-crm-app`, data role `demeisen-v2-github-crm-data`.
