# Demeisen CRM

Internal CRM for Demeisen LLP: investor and cap intro contacts, interactions and intel, actions, allocator one-pagers and search.

## Layout (v2)

The CRM is self-contained: with this repo, `demeisen_intranet_v2_ui` and `demeisen_intranet_v2_auth` anyone can
stand up the whole CRM, database included, without the rest of the Demeisen platform.

- `web/index.html`: the website, a single page with no build step. It works at the site root or under a path
  (`basePath` in `config.js`; `/crm/` behind the Demeisen front door). Shared parts are inlined between marker comments:
  - `demeisen-ui`: `python3 ../demeisen_intranet_v2_ui/inline.py <ref> web/index.html`
  - `demeisen-auth`: `python3 ../demeisen_intranet_v2_auth/inline.py <ref> web/index.html`

  Don't edit inside the markers; change the shared repo and re-run the script.
- `api/`: one Lambda package with two functions: the API and nightly export (`src/index.mjs`), and database
  set-up and migrations (`src/migrate.mjs`).
- `db/migrations/`: MySQL 8.4 schema, applied in order by the migration function and recorded in
  `crm_meta.schema_migrations`. Add a new numbered file for every change; never edit one that has been applied.
- `data/data.yaml`: **the data stack** (`demeisen-v2-crm-data`): private network, the RDS instance, the backup bucket
  and an AWS Backup plan. Deletion protection, final snapshots, a stack policy and `tools/check-guardrails.py` keep it
  safe. Changed only by the **Deploy data** workflow, after approval in the GitHub `data` environment.
- `infra/app.yaml`: **the app stack** (`demeisen-v2-crm-app`): functions, API, page bucket, sign-in client, alarms. No data.
  Set `Standalone=true` and `BasePath=/` for a copy with its own CloudFront address.
- `.github/workflows/`: `ci.yml` (tests, templates, migrations on MySQL 8.4), `deploy.yml` (app, on merge to main),
  `deploy-data.yml` (data, by hand, approved).

Apps find data resources through SSM parameters under `/demeisen/v2/crm/`, never CloudFormation exports, so the data
stack is never locked to an app and an app can be deleted without touching data.

## Backups

Three layers, all in the data stack:

1. RDS point-in-time recovery, 35 days.
2. AWS Backup daily snapshots (vault `demeisen-v2-crm`), kept for a year.
3. Each night at 02:00 UK time, an export to the private S3 bucket `demeisen-v2-crm-backups-<account id>` under `YYYY/MM/DD/`, write-protected and kept for 90 days:

- `Demeisen CRM YYYY-MM-DD.xlsx`: the current data, in the same format as **Export to Excel**.
- One CSV per table, including the history tables, which the workbook does not hold.
- `manifest.json`: row counts.

## Recovery

The database has no public address, so recovery runs inside AWS, never from a laptop:

- **Whole database** (most cases): restore an RDS point-in-time copy or an AWS Backup snapshot to a new snapshot, then
  run **Deploy data** with `source_snapshot` set to it (test phase), or follow "Restore live data" in the platform
  repo's `ops/RUNBOOK.md` (live phase). Then run **Deploy** so the app picks up the new database address.
- **From an export**: `scripts/import_workbook.py` loads a workbook into an empty database. Run it from AWS CloudShell
  in the CRM's network (CloudShell → Actions → Create VPC environment, VPC `demeisen-v2-crm`, security group from SSM
  `/demeisen/v2/crm/net/client-sg`). Record IDs are kept; history restarts from the load, earlier versions stay in the CSVs.

## Running it

The MySQL database is the source of truth. Staff sign in to the hosted site, and every change is saved straight to the database, with earlier versions kept in the history tables.

**Export to Excel** on the Settings tab downloads the current data, without history, as a copy. Changes made to that file do not flow back.

Workbooks are only for seeding an empty database or for recovery (see above). `scripts/import_workbook.py` refuses to run if the database holds any data, and the site itself has no import in live mode.

For local testing without a database, open `web/index.html` in Chrome or Edge. Data then stays in that browser, using fictional example data or **Import workbook (.xlsx)**. Internet access is needed for the spreadsheet library and fonts.

## Data

**Never commit investor data.** Workbooks and CSV files are excluded by `.gitignore`, and the example data in the page is fictional.
