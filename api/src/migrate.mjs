// Database set-up and migrations for the CRM, run as a separate Lambda function inside the database's network.
// Invoked only with AWS credentials (aws lambda invoke); it has no public address.
//   { "action": "status" }                         applied and pending migrations
//   { "action": "migrate" }                        applies pending files from db/migrations, in order, one at a time
//   { "action": "bootstrap", "baseline": [...] }   once per database, as the RDS master user: creates the IAM-only
//                                                  'crm_migrator' login and the crm_meta.schema_migrations table.
//                                                  "baseline" lists files already applied (a database copied from v1).
//   { "action": "bootstrap", "dropDatabases": ["intranet"], "confirm": "intranet" }
//                                                  also removes another app's database from a copied server.
// Bootstrap needs the master password from Secrets Manager, so the data stack's AdminEndpoint must be on.
import { readFileSync, readdirSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { Signer } from '@aws-sdk/rds-signer';
import { splitSql } from './sqlsplit.mjs';

const { DB_HOST, AWS_REGION, MASTER_SECRET_ARN } = process.env;
const MIGRATOR = 'crm_migrator';
const DIR = new URL('../migrations/', import.meta.url);
const ca = () => readFileSync(new URL('../rds-ca.pem', import.meta.url), 'utf8');
const files = () => readdirSync(DIR).filter(f => /^\d{3}_.*\.sql$/.test(f)).sort();

async function connect(user, password, extra = {}) {
  // Azure (DB_MIGRATOR_PASSWORD set): public CA certificates. AWS: the RDS certificate bundle.
  const ssl = process.env.DB_MIGRATOR_PASSWORD ? { rejectUnauthorized: true } : { ca: ca(), rejectUnauthorized: true };
  return mysql.createConnection({ host: DB_HOST, port: 3306, user, password, charset: 'utf8mb4', ssl,
    connectTimeout: 20000, ...extra });
}
async function asMigrator() {
  // Azure: password from Key Vault (set up by the Azure step 3 script, which also created this login).
  if (process.env.DB_MIGRATOR_PASSWORD) return connect(MIGRATOR, process.env.DB_MIGRATOR_PASSWORD);
  const token = await new Signer({ hostname: DB_HOST, port: 3306, username: MIGRATOR, region: AWS_REGION }).getAuthToken();
  return connect(MIGRATOR, token, { authPlugins: { mysql_clear_password: () => () => Buffer.from(token + '\0') } });
}
async function asMaster() {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const s = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: MASTER_SECRET_ARN }));
  const { username, password } = JSON.parse(s.SecretString);
  return connect(username, password);
}
const applied = async c => (await c.query('SELECT name FROM crm_meta.schema_migrations ORDER BY name'))[0].map(r => r.name);

async function bootstrap(ev) {
  const c = await asMaster();
  try {
    for (const db of ev.dropDatabases || []) {
      if (!/^\w+$/.test(db) || ['crm', 'crm_meta', 'mysql', 'sys', 'information_schema', 'performance_schema'].includes(db)) throw new Error(`Refusing to drop ${db}.`);
      if (ev.confirm !== db) throw new Error(`To drop ${db}, also pass "confirm": "${db}".`);
      await c.query(`DROP DATABASE IF EXISTS \`${db}\``);
      const [users] = await c.query('SELECT user, host FROM mysql.user WHERE user = ?', [db]);
      for (const u of users) await c.query('DROP USER ?@?', [u.user, u.host]);
    }
    await c.query(`CREATE USER IF NOT EXISTS '${MIGRATOR}'@'%' IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS' REQUIRE SSL`);
    await c.query(`GRANT CREATE, CREATE USER, RELOAD ON *.* TO '${MIGRATOR}'@'%'`);
    await c.query(`GRANT ALL PRIVILEGES ON \`crm\`.* TO '${MIGRATOR}'@'%' WITH GRANT OPTION`);
    await c.query(`GRANT ALL PRIVILEGES ON \`crm_meta\`.* TO '${MIGRATOR}'@'%'`);
    await c.query('CREATE DATABASE IF NOT EXISTS crm_meta CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci');
    await c.query('CREATE TABLE IF NOT EXISTS crm_meta.schema_migrations (name VARCHAR(200) PRIMARY KEY, applied_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)), baseline BOOLEAN NOT NULL DEFAULT FALSE)');
    const known = new Set(files());
    for (const f of ev.baseline || []) {
      if (!known.has(f)) throw new Error(`Baseline names ${f}, which is not in db/migrations.`);
      await c.query('INSERT IGNORE INTO crm_meta.schema_migrations (name, baseline) VALUES (?, TRUE)', [f]);
    }
    return { bootstrapped: true, baseline: ev.baseline || [], dropped: ev.dropDatabases || [] };
  } finally { await c.end().catch(() => {}); }
}

export async function migrate() {
  const c = await asMigrator();
  const done = [];
  try {
    const have = new Set(await applied(c));
    for (const f of files().filter(x => !have.has(x))) {
      for (const stmt of splitSql(readFileSync(new URL(f, DIR), 'utf8'))) await c.query(stmt);
      await c.query('INSERT INTO crm_meta.schema_migrations (name) VALUES (?)', [f]);
      done.push(f);
      console.log('migration applied', f);
    }
    return { applied: done, pending: [] };
  } catch (e) {
    console.error('migration failed', e.code, e.errno, e.sqlMessage);
    return { applied: done, failedAt: files().find(x => !done.includes(x) && true), error: `${e.code || ''} ${e.sqlMessage || e.message}` };
  } finally { await c.end().catch(() => {}); }
}

export async function status() {
  const c = await asMigrator();
  try { const a = await applied(c); return { applied: a, pending: files().filter(f => !a.includes(f)) }; }
  finally { await c.end().catch(() => {}); }
}

export const handler = async ev => {
  if (ev.action === 'bootstrap') return bootstrap(ev);
  if (ev.action === 'migrate') return migrate();
  if (ev.action === 'status') return status();
  throw new Error('Unknown action. Use status, migrate or bootstrap.');
};
