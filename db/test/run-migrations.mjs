// CI check: applies every migration, in order, to an empty MySQL 8.4 (a service container), exactly as the migration
// function splits them, then makes a change to prove the history triggers work.
// RDS's IAM sign-in plugin doesn't exist outside RDS, so users are created with a password here instead.
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
// mysql2 is installed with the API (api/node_modules), so resolve it from there.
const mysql = createRequire(new URL('../../api/package.json', import.meta.url))('mysql2/promise');
import { splitSql } from '../../api/src/sqlsplit.mjs';

const c = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: 'root', charset: 'utf8mb4' });
const dir = new URL('../migrations/', import.meta.url);
for (const f of readdirSync(dir).filter(x => /^\d{3}_.*\.sql$/.test(x)).sort()) {
  const sql = readFileSync(new URL(f, dir), 'utf8').replace(/IDENTIFIED WITH AWSAuthenticationPlugin AS 'RDS'/g, "IDENTIFIED BY 'ci-only'");
  for (const s of splitSql(sql)) await c.query(s);
  console.log('applied', f);
}
await c.query('USE crm');
await c.query("SET @crm_user = 'ci@example.com'");
await c.query("INSERT INTO company (company_type, name, engagement_stage) VALUES ('Investor', 'CI Test Ltd', 'N/A - Other')");
await c.query("UPDATE company SET notes = 'changed' WHERE name = 'CI Test Ltd'");
const [[h]] = await c.query("SELECT COUNT(*) AS n FROM company_history WHERE name = 'CI Test Ltd'");
if (h.n !== 1) throw new Error(`expected 1 history row, found ${h.n}`);
console.log('history triggers ok');
await c.end();
