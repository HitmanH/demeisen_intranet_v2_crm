// Demeisen CRM API and nightly backup. One Lambda function handles both:
// API Gateway requests, and the scheduled event { "backup": true }.
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { Signer } from '@aws-sdk/rds-signer';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { toCsv } from './csv.mjs';
import { buildWorkbook } from './workbook.mjs';
import { HttpError, cleanInt, cleanText, cleanDate, cleanUrl, oneOf, cleanIds } from './validate.mjs';

const { DB_HOST, DB_USER, BACKUP_BUCKET, AWS_REGION } = process.env;
const ca = () => readFileSync(new URL('../rds-ca.pem', import.meta.url), 'utf8');

// A new connection per request: two users, so no pool to leak @crm_user between people.
async function connect() {
  const token = await new Signer({ hostname: DB_HOST, port: 3306, username: DB_USER, region: AWS_REGION }).getAuthToken();
  return mysql.createConnection({
    host: DB_HOST, port: 3306, user: DB_USER, password: token, database: 'crm', charset: 'utf8mb4',
    ssl: { ca: ca(), rejectUnauthorized: true }, dateStrings: true, timezone: 'Z', connectTimeout: 20000, // the first request after idle can be slow
    authPlugins: { mysql_clear_password: () => () => Buffer.from(token + '\0') }
  });
}

const COMPANY_TYPES = ['Investor', 'Consultant', 'Prime CI', 'Third Party Marketer', 'Prior Colleague', 'Friendly LP', 'Other', 'Demeisen'];
const norm = v => (v === undefined || v === null || v === '' ? null : String(v));

/* Update one row inside a transaction. Rejects if someone else changed it since it was
   opened, and skips the write when nothing changed, so no empty history row is added. */
async function updateRow(c, table, idCol, id, fields, expected) {
  const [rows] = await c.query(`SELECT * FROM ${table} WHERE ${idCol} = ? FOR UPDATE`, [id]);
  if (!rows.length) throw new HttpError(404, 'That record no longer exists. Reload to see the latest data.');
  const row = rows[0];
  if (expected && row.valid_from !== expected) {
    throw new HttpError(409, `Changed by ${row.changed_by} at ${row.valid_from} UTC. Reload to see the latest version.`);
  }
  const cols = Object.keys(fields).filter(k => norm(fields[k]) !== norm(row[k]));
  if (!cols.length) return false;
  await c.query(`UPDATE ${table} SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE ${idCol} = ?`, [...cols.map(k => fields[k]), id]);
  return true;
}

function companyFields(b) {
  return { company_type: oneOf(b.type, COMPANY_TYPES, 'company type'), name: cleanText(b.name, 200, 'name', true),
    investor_type: cleanText(b.investorType, 50, 'investor type'), investment_type: cleanText(b.investmentType, 50, 'investment type'),
    engagement_stage: cleanText(b.stage, 50, 'engagement stage', true),
    notes: cleanText(b.notes, 60000, 'notes') };
}
function personFields(b) {
  return { name: cleanText(b.name, 200, 'name', true), email: cleanText(b.email, 254, 'email'), company_id: cleanInt(b.companyId, 'company', true),
    title: cleanText(b.title, 100, 'title'), phone: cleanText(b.phone, 50, 'phone'), personal_email: cleanText(b.personalEmail, 254, 'personal email'),
    linkedin_url: cleanUrl(b.linkedin, 300, 'LinkedIn profile'), notes: cleanText(b.notes, 60000, 'notes') };
}
function interactionFields(b) {
  const f = { entry_type: oneOf(b.type, ['Interaction', 'Intel'], 'entry type'), interaction_date: cleanDate(b.date, 'date', true),
    company_id: cleanInt(b.companyId, 'company'), via_company_id: cleanInt(b.viaId, 'via'), format: cleanText(b.format, 20, 'format'),
    description: cleanText(b.desc, 60000, 'description', true), next_steps: cleanText(b.next, 60000, 'next steps'),
    recorded_by_person_id: cleanInt(b.recordedBy, 'recorded by') };
  if (f.entry_type === 'Interaction' && !f.company_id) throw new HttpError(400, 'An interaction needs a company.');
  return f;
}
function actionFields(b) {
  return { description: cleanText(b.desc, 1000, 'action', true), due_date: cleanDate(b.due, 'due date'), owner_person_id: cleanInt(b.ownerId, 'owner') };
}
function pairingFields(b) {
  return { allocator_company_id: cleanInt(b.allocatorId, 'allocator', true), counterparty_company_id: cleanInt(b.counterpartyId, 'counterparty', true),
    connection_type: cleanText(b.connection, 50, 'connection', true), connection_detail: cleanText(b.detail, 200, 'detail'), connection_date: cleanDate(b.date, 'date') };
}
const pairingWrite = async fn => {
  try { return await fn(); }
  catch (e) { if (e.errno === 1062) throw new HttpError(409, 'That pairing already exists.'); throw e; }
};
const insert = async (c, table, f) => {
  const k = Object.keys(f);
  const [r] = await c.query(`INSERT INTO ${table} (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`, k.map(x => f[x]));
  return r.insertId;
};

/* ---------- Reads ---------- */
async function getData(c) {
  const [[companies], [people], [interactions], [links], [actions], [edited], [pairings], [stages], [materials], [materialTypes]] = await Promise.all([
    c.query('SELECT * FROM company'), c.query('SELECT * FROM person'), c.query('SELECT * FROM interaction'),
    c.query('SELECT interaction_id, person_id FROM interaction_person'), c.query('SELECT * FROM action'),
    c.query("SELECT DISTINCT interaction_id FROM interaction_history WHERE operation = 'UPDATE'"),
    c.query('SELECT * FROM counterparty_pairing'), c.query('SELECT stage_name FROM engagement_stage ORDER BY sort_order'),
    c.query('SELECT interaction_id, material_name, shared_date, version FROM interaction_material'), c.query('SELECT material_name FROM material_type ORDER BY sort_order')
  ]);
  const matByIx = new Map();
  materials.forEach(m => { if (!matByIx.has(m.interaction_id)) matByIx.set(m.interaction_id, []); matByIx.get(m.interaction_id).push({ name: m.material_name, date: m.shared_date, version: m.version || '' }); });
  const byIx = new Map();
  links.forEach(l => { if (!byIx.has(l.interaction_id)) byIx.set(l.interaction_id, []); byIx.get(l.interaction_id).push(l.person_id); });
  const wasEdited = new Set(edited.map(e => e.interaction_id));
  return {
    stages: stages.map(x => x.stage_name),
    materialTypes: materialTypes.map(x => x.material_name),
    companies: companies.map(x => ({ id: x.company_id, type: x.company_type, name: x.name, investorType: x.investor_type || '', investmentType: x.investment_type || '', stage: x.engagement_stage, notes: x.notes || '', validFrom: x.valid_from })),
    people: people.map(x => ({ id: x.person_id, name: x.name, email: x.email || '', companyId: x.company_id, title: x.title || '', phone: x.phone || '',
      personalEmail: x.personal_email || '', linkedin: x.linkedin_url || '', notes: x.notes || '', validFrom: x.valid_from })),
    interactions: interactions.map(x => ({ id: x.interaction_id, type: x.entry_type, date: x.interaction_date, companyId: x.company_id, viaId: x.via_company_id, format: x.format || '',
      people: byIx.get(x.interaction_id) || [], materials: matByIx.get(x.interaction_id) || [], recordedBy: x.recorded_by_person_id, desc: x.description, next: x.next_steps || '', review: x.review || '', validFrom: x.valid_from,
      ...(wasEdited.has(x.interaction_id) ? { updated: x.valid_from.replace(' ', 'T') + 'Z' } : {}) })),
    actions: actions.map(x => ({ id: x.action_id, desc: x.description, due: x.due_date || '', ownerId: x.owner_person_id, interactionId: x.interaction_id, status: x.status, review: x.review || '', validFrom: x.valid_from })),
    pairings: pairings.map(x => ({ id: x.pairing_id, allocatorId: x.allocator_company_id, counterpartyId: x.counterparty_company_id, connection: x.connection_type, detail: x.connection_detail || '', date: x.connection_date || '', validFrom: x.valid_from }))
  };
}
async function getHistory(c, id) {
  const [rows] = await c.query(
    `SELECT v.entry_type, v.interaction_date, co.name AS company, via.name AS via, v.format, v.description, v.next_steps, p.name AS recorded_by, v.changed_by, v.valid_from, v.valid_to
     FROM interaction_versions v LEFT JOIN company co ON co.company_id = v.company_id LEFT JOIN company via ON via.company_id = v.via_company_id
     LEFT JOIN person p ON p.person_id = v.recorded_by_person_id WHERE v.interaction_id = ? ORDER BY v.valid_from DESC`, [id]);
  return { versions: rows };
}

/* ---------- Writes ---------- */
async function saveInteraction(c, id, b) {
  const f = interactionFields(b);
  if (id) await updateRow(c, 'interaction', 'interaction_id', id, f, b.expectedValidFrom);
  else id = await insert(c, 'interaction', f);

  const want = new Set(cleanIds(b.people));
  const [cur] = await c.query('SELECT person_id FROM interaction_person WHERE interaction_id = ? FOR UPDATE', [id]);
  const have = new Set(cur.map(r => r.person_id));
  for (const p of want) if (!have.has(p)) await c.query('INSERT INTO interaction_person (interaction_id, person_id) VALUES (?, ?)', [id, p]);
  for (const p of have) if (!want.has(p)) await c.query('DELETE FROM interaction_person WHERE interaction_id = ? AND person_id = ?', [id, p]);

  // Material shared: one row per item, kept in step with the list sent. Older pages send no list and leave it alone.
  if (Array.isArray(b.materials)) {
    const wantM = new Map();
    for (const m of b.materials) {
      const name = cleanText(m?.name, 50, 'material', true);
      wantM.set(name, { shared_date: cleanDate(m.date, `date ${name} was shared`) || f.interaction_date, version: cleanText(m.version, 100, `${name} version`) });
    }
    const [curM] = await c.query('SELECT material_name, shared_date, version FROM interaction_material WHERE interaction_id = ? FOR UPDATE', [id]);
    const haveM = new Map(curM.map(r => [r.material_name, r]));
    for (const [name, v] of wantM) {
      const old = haveM.get(name);
      if (!old) await c.query('INSERT INTO interaction_material (interaction_id, material_name, shared_date, version) VALUES (?, ?, ?, ?)', [id, name, v.shared_date, v.version]);
      else if (old.shared_date !== v.shared_date || norm(old.version) !== norm(v.version)) {
        await c.query('UPDATE interaction_material SET shared_date = ?, version = ? WHERE interaction_id = ? AND material_name = ?', [v.shared_date, v.version, id, name]);
      }
    }
    for (const name of haveM.keys()) if (!wantM.has(name)) await c.query('DELETE FROM interaction_material WHERE interaction_id = ? AND material_name = ?', [id, name]);
  }

  const rows = Array.isArray(b.actions) ? b.actions : [];
  const [existing] = await c.query('SELECT action_id FROM action WHERE interaction_id = ? FOR UPDATE', [id]);
  const known = new Set(existing.map(r => r.action_id));
  const kept = new Set();
  for (const a of rows) {
    const aid = cleanInt(a.id, 'action id');
    if (aid) {
      if (!known.has(aid)) throw new HttpError(400, 'That action does not belong to this entry.');
      await updateRow(c, 'action', 'action_id', aid, actionFields(a));
      kept.add(aid);
    } else await insert(c, 'action', { ...actionFields(a), interaction_id: id, status: 'Open' });
  }
  for (const aid of known) if (!kept.has(aid)) await c.query('DELETE FROM action WHERE action_id = ?', [aid]);
  return { id };
}

const routes = [
  ['GET', /^\/api\/data$/, (c) => getData(c)],
  ['GET', /^\/api\/interactions\/(\d+)\/history$/, (c, m) => getHistory(c, +m[1])],
  ['POST', /^\/api\/interactions$/, (c, m, b) => saveInteraction(c, null, b), true],
  ['PUT', /^\/api\/interactions\/(\d+)$/, (c, m, b) => saveInteraction(c, +m[1], b), true],
  ['POST', /^\/api\/actions$/, async (c, m, b) => ({ id: await insert(c, 'action', { ...actionFields(b), interaction_id: null, status: 'Open' }) }), true],
  ['PATCH', /^\/api\/actions\/(\d+)$/, async (c, m, b) => {
    await updateRow(c, 'action', 'action_id', +m[1], { status: oneOf(b.status, ['Open', 'Done', 'Cancelled'], 'status') }, b.expectedValidFrom);
    return { id: +m[1] };
  }, true],
  ['POST', /^\/api\/companies$/, async (c, m, b) => ({ id: await insert(c, 'company', companyFields(b)) }), true],
  ['PUT', /^\/api\/companies\/(\d+)$/, async (c, m, b) => { await updateRow(c, 'company', 'company_id', +m[1], companyFields(b), b.expectedValidFrom); return { id: +m[1] }; }, true],
  ['POST', /^\/api\/people$/, async (c, m, b) => ({ id: await insert(c, 'person', personFields(b)) }), true],
  ['PUT', /^\/api\/people\/(\d+)$/, async (c, m, b) => { await updateRow(c, 'person', 'person_id', +m[1], personFields(b), b.expectedValidFrom); return { id: +m[1] }; }, true],
  ['POST', /^\/api\/pairings$/, (c, m, b) => pairingWrite(async () => ({ id: await insert(c, 'counterparty_pairing', pairingFields(b)) })), true],
  ['PUT', /^\/api\/pairings\/(\d+)$/, (c, m, b) => pairingWrite(async () => { await updateRow(c, 'counterparty_pairing', 'pairing_id', +m[1], pairingFields(b), b.expectedValidFrom); return { id: +m[1] }; }), true],
  ['DELETE', /^\/api\/pairings\/(\d+)$/, async (c, m) => {
    const [r] = await c.query('DELETE FROM counterparty_pairing WHERE pairing_id = ?', [+m[1]]);
    if (!r.affectedRows) throw new HttpError(404, 'That record no longer exists. Reload to see the latest data.');
    return { id: +m[1] };
  }, true]
];

const reply = (statusCode, body) => ({ statusCode, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify(body) });

async function handleApi(event) {
  const user = event.requestContext?.authorizer?.jwt?.claims?.email;
  if (!user) return reply(401, { error: 'Please sign in.' });
  const method = event.requestContext.http.method;
  // Served at /api/... on its own address, or /crm/api/... behind the Demeisen front door: route on the /api/... part.
  const raw = event.rawPath || '', at = raw.indexOf('/api/'), path = at > 0 ? raw.slice(at) : raw;
  const route = routes.map(r => ({ r, m: r[0] === method && path.match(r[1]) })).find(x => x.m);
  if (!route) return reply(404, { error: 'Not found.' });
  let body = {};
  try { body = event.body ? JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : {}; }
  catch { return reply(400, { error: 'The request could not be read.' }); }

  let c;
  try {
    c = await connect();
    const writes = route.r[3];
    if (writes) { await c.query('SET @crm_user = ?', [user]); await c.beginTransaction(); }
    const result = await route.r[2](c, route.m, body);
    if (writes) await c.commit();
    return reply(200, result);
  } catch (e) {
    if (c) await c.rollback().catch(() => {});
    if (e instanceof HttpError) return reply(e.status, { error: e.message });
    if (e.errno === 1062) return reply(409, { error: 'That name already exists.' });
    if (e.errno === 1452 && /material_type/.test(e.message)) return reply(400, { error: 'That material is not in the list. Reload to see the latest list.' });
    if (e.errno === 1452 && /engagement_stage/.test(e.message)) return reply(400, { error: 'That engagement stage is not in the list. Reload to see the latest stages.' });
    if ([1451, 1452, 3819].includes(e.errno)) return reply(400, { error: 'That change breaks a data rule, such as a missing or invalid link.' });
    console.error('request failed', method, path, e.code, e.errno); // no request content in logs
    return reply(500, { error: 'Something went wrong. Nothing was saved.' });
  } finally {
    if (c) await c.end().catch(() => {});
  }
}

/* ---------- Nightly backup: every table as CSV, a workbook that can seed an empty database, and a manifest with counts ---------- */
export const BACKUP_TABLES = ['engagement_stage', 'material_type', 'company', 'person', 'interaction', 'interaction_person', 'action', 'counterparty_pairing', 'interaction_material',
  'company_history', 'person_history', 'interaction_history', 'interaction_person_history', 'action_history', 'counterparty_pairing_history', 'interaction_material_history'];

async function runBackup() {
  const stamp = new Date().toISOString();
  const prefix = `${stamp.slice(0, 4)}/${stamp.slice(5, 7)}/${stamp.slice(8, 10)}/`;
  const s3 = new S3Client({});
  const put = (Key, Body, ContentType) => s3.send(new PutObjectCommand({ Bucket: BACKUP_BUCKET, Key, Body, ContentType, ChecksumAlgorithm: 'CRC32' }));
  const c = await connect();
  const manifest = { exportedAt: stamp, files: {} };
  let data;
  try {
    await c.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    for (const t of BACKUP_TABLES) {
      const [rows, fields] = await c.query(`SELECT * FROM ${t}`);
      await put(`${prefix}${t}.csv`, toCsv(fields.map(f => f.name), rows), 'text/csv; charset=utf-8');
      manifest.files[t] = rows.length;
    }
    data = await getData(c);
    await c.commit();
  } finally { await c.end().catch(() => {}); }
  // The CSVs and manifest are still saved if the workbook fails; the error then triggers the alarm.
  let workbookError;
  try {
    manifest.workbook = `Demeisen CRM ${stamp.slice(0, 10)}.xlsx`;
    await put(prefix + manifest.workbook, buildWorkbook(data), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  } catch (e) { workbookError = e; delete manifest.workbook; }
  await put(`${prefix}manifest.json`, JSON.stringify(manifest, null, 2), 'application/json');
  console.log('backup complete', prefix, JSON.stringify(manifest.files));
  if (workbookError) throw workbookError;
  return manifest;
}

export const handler = event => (event.backup ? runBackup() : handleApi(event));
