import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { toCsv } from '../src/csv.mjs';
import { buildWorkbook, WORKBOOK_COLUMNS } from '../src/workbook.mjs';
import { cleanText, cleanInt, cleanDate, cleanUrl, oneOf, cleanIds, HttpError } from '../src/validate.mjs';

test('csv quotes commas, quotes and line breaks and keeps blanks', () => {
  const out = toCsv(['a', 'b'], [{ a: 'x,y', b: 'say "hi"' }, { a: 'line\nbreak', b: null }]);
  assert.equal(out, '﻿a,b\r\n"x,y","say ""hi"""\r\n"line\nbreak",\r\n');
});
const SAMPLE = {
  companies: [{ id: 2, type: 'Investor', name: 'Northgate Capital', investorType: 'Hedge Fund', stage: 'Target Investor' }, { id: 1, type: 'Demeisen', name: 'Example Fund', stage: 'N/A - Other' }],
  people: [{ id: 1, name: 'Sam Rivers', companyId: 2 }, { id: 2, name: 'Sam Rivers', companyId: 1 }],
  interactions: [{ id: 5, type: 'Interaction', date: '2026-03-01', companyId: 2, viaId: null, people: [2, 1], recordedBy: 2, desc: 'Intro',
    materials: [{ name: 'Sample portfolio', date: '2026-03-02', version: 'Q1 2026' }] }],
  actions: [{ id: 3, desc: 'Follow up', due: '2026-03-08', status: 'Open', ownerId: 2, interactionId: 5 }],
  pairings: [{ id: 4, allocatorId: 2, counterpartyId: 1, connection: 'Relationship Lead', detail: 'Email', date: '2026-05-01' }]
};
const readBack = data => XLSX.read(buildWorkbook(data), { type: 'buffer' });
test('workbook has the export tabs and columns, including when a tab is empty', () => {
  for (const data of [SAMPLE, { companies: [], people: [], interactions: [], actions: [], pairings: [] }]) {
    const wb = readBack(data);
    assert.deepEqual(wb.SheetNames, Object.keys(WORKBOOK_COLUMNS));
    for (const tab of wb.SheetNames) assert.deepEqual(XLSX.utils.sheet_to_json(wb.Sheets[tab], { header: 1 })[0], WORKBOOK_COLUMNS[tab]);
  }
});
test('workbook keeps person IDs, so people with the same name stay distinct', () => {
  const wb = readBack(SAMPLE);
  const [ix] = XLSX.utils.sheet_to_json(wb.Sheets.Interaction), [ac] = XLSX.utils.sheet_to_json(wb.Sheets.Action);
  assert.equal(ix['People Involved IDs'], '2; 1');
  assert.equal(ix['Recorded By ID'], 2);
  assert.equal(ix['Interaction Date'], 46082); // 1 March 2026 as an Excel date
  assert.equal(ac['Owner ID'], 2);
  assert.equal(ac['Company'], 'Northgate Capital');
});
test('workbook includes each company engagement stage', () => {
  const rows = XLSX.utils.sheet_to_json(readBack(SAMPLE).Sheets.Company);
  assert.deepEqual(rows.map(r => r['Engagement Stage']), ['N/A - Other', 'Target Investor']);
});
test('workbook lists material shared with its date and version', () => {
  const [m] = XLSX.utils.sheet_to_json(readBack(SAMPLE).Sheets['Material Shared']);
  assert.deepEqual(m, { 'Interaction ID': 5, 'Company': 'Northgate Capital', 'Material': 'Sample portfolio', 'Date Shared': 46083, 'Version': 'Q1 2026' });
});
test('workbook names both companies in a pairing', () => {
  const [p] = XLSX.utils.sheet_to_json(readBack(SAMPLE).Sheets['Counterparty Pairing']);
  assert.deepEqual(p, { 'Pairing ID': 4, 'Allocator': 'Northgate Capital', 'Prime CI': 'Example Fund', 'Connection': 'Relationship Lead', 'Detail': 'Email', 'Date': 46143 });
});
test('workbook refuses text too long for an Excel cell', () => {
  const companies = [{ ...SAMPLE.companies[0], notes: 'x'.repeat(32768) }];
  assert.throws(() => buildWorkbook({ ...SAMPLE, companies }), /too long/);
});
test('the page exports every workbook column', () => {
  const page = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
  for (const h of Object.values(WORKBOOK_COLUMNS).flat()) assert.ok(page.includes(`'${h}'`), h);
});
test('text is trimmed, blank becomes null, required and length enforced', () => {
  assert.equal(cleanText('  hi ', 5, 'x'), 'hi');
  assert.equal(cleanText('  ', 5, 'x'), null);
  assert.throws(() => cleanText('', 5, 'x', true), HttpError);
  assert.throws(() => cleanText('abcdef', 5, 'x'), HttpError);
});
test('ids must be positive whole numbers', () => {
  assert.equal(cleanInt('7', 'x'), 7);
  assert.equal(cleanInt(null, 'x'), null);
  assert.throws(() => cleanInt('1 OR 1=1', 'x'), HttpError);
  assert.throws(() => cleanInt(-1, 'x'), HttpError);
  assert.throws(() => cleanInt(null, 'x', true), HttpError);
});
test('dates must be real calendar dates', () => {
  assert.equal(cleanDate('2026-02-28', 'x'), '2026-02-28');
  assert.equal(cleanDate('', 'x'), null);
  assert.throws(() => cleanDate('2026-02-30', 'x'), HttpError);
  assert.throws(() => cleanDate('28/02/2026', 'x'), HttpError);
});
test('web links get https:// and must be plain web addresses', () => {
  assert.equal(cleanUrl('linkedin.com/in/example', 300, 'x'), 'https://linkedin.com/in/example');
  assert.equal(cleanUrl('https://www.linkedin.com/in/example/', 300, 'x'), 'https://www.linkedin.com/in/example/');
  assert.equal(cleanUrl('  ', 300, 'x'), null);
  assert.throws(() => cleanUrl('javascript:alert(1)', 300, 'x'), HttpError);
  assert.throws(() => cleanUrl('not a link', 300, 'x'), HttpError);
  assert.throws(() => cleanUrl('https://example.com/' + 'a'.repeat(300), 300, 'x'), HttpError);
});
test('allowed values and id lists', () => {
  assert.equal(oneOf('Open', ['Open'], 'x'), 'Open');
  assert.throws(() => oneOf('DROP', ['Open'], 'x'), HttpError);
  assert.deepEqual(cleanIds([1, '1', 2]), [1, 2]);
  assert.deepEqual(cleanIds(undefined), []);
  assert.throws(() => cleanIds('1'), HttpError);
});

/* ---------- v2: migrations and paths ---------- */
import { splitSql } from '../src/sqlsplit.mjs';
import { readdirSync } from 'node:fs';

test('splitSql honours DELIMITER and drops comments', () => {
  const s = splitSql("/* header; with a semicolon; */\nUSE crm;\n-- note;\nDELIMITER $$\nCREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW\nBEGIN\n  SET NEW.a = 1;\n  SET NEW.b = 2;\nEND$$\nDELIMITER ;\nSELECT 1;");
  assert.deepEqual(s, ['USE crm', 'CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW\nBEGIN\n  SET NEW.a = 1;\n  SET NEW.b = 2;\nEND', 'SELECT 1']);
});

test('every migration splits into statements with no DELIMITER left in them', () => {
  const dir = new URL('../../db/migrations/', import.meta.url);
  const names = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  assert.ok(names.length >= 9);
  for (const f of names) {
    const stmts = splitSql(readFileSync(new URL(f, dir), 'utf8'));
    assert.ok(stmts.length > 0, f);
    for (const s of stmts) assert.ok(!/^\s*DELIMITER/im.test(s) && !s.trimEnd().endsWith('$$'), `${f}: ${s.slice(0, 60)}`);
  }
});

test('the API routes the same with or without the /crm prefix', async () => {
  const { handler } = await import('../src/index.mjs');
  const ev = p => ({ rawPath: p, requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { email: 'a@b.c' } } } } });
  // No route exists for /api/nope with either prefix: both reach the router (404), not a sign-in or parse error.
  assert.equal((await handler(ev('/api/nope'))).statusCode, 404);
  assert.equal((await handler(ev('/crm/api/nope'))).statusCode, 404);
});
