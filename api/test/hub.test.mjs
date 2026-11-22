// Own sign-in through the intranet hub: crm.demeisen.io gets the hub settings at /, and the API accepts the hub's tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const { publicKey, privateKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
const hub = createServer((q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ keys: [jwk] })); });
await new Promise(ok => hub.listen(0, ok));
const HUB = `http://127.0.0.1:${hub.address().port}`;
Object.assign(process.env, { HUB_ISSUER: HUB, HUB_HOSTS: 'crm.demeisen.io', BASE_PATH: '/crm/', COGNITO_ISSUER: 'https://cognito.example', COGNITO_CLIENT_ID: 'c' });
const { server } = await import('../src/server.mjs');
const { verifyIdToken } = await import('../src/azure.mjs');
await new Promise(ok => server.listen(0, ok));
const CRM = `http://127.0.0.1:${server.address().port}`;
const sign = (claims, iss = HUB) => new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(iss)
  .setAudience('demeisen-crm').setIssuedAt().setExpirationTime('1h').sign(privateKey);

test('crm.demeisen.io: hub sign-in settings; other addresses keep Cognito', async () => {
  const h = { 'x-forwarded-host': 'crm.demeisen.io' };
  assert.equal((await fetch(`${CRM}/crm/`, { headers: h })).status, 200);
  const cfg = await (await fetch(`${CRM}/crm/config.js`, { headers: h })).text();
  assert.match(cfg, new RegExp(`"authorizeUrl":"${HUB}/oauth2/authorize"`));
  assert.match(cfg, /"basePath":"\/crm\/"/);
  const old = await (await fetch(`${CRM}/crm/config.js`, { headers: { 'x-forwarded-host': 'mycroft.demeisen.io' } })).text();
  assert.doesNotMatch(old, /authorizeUrl/);
  assert.equal((await fetch(`${CRM}/crm/api/people`, { headers: h })).status, 401);
});

test('hub tokens are accepted only if signed by the hub, for the CRM, as ID tokens', async () => {
  assert.equal((await verifyIdToken(await sign({ email: 'a@b.c', token_use: 'id' }))).email, 'a@b.c');
  assert.equal(await verifyIdToken(await sign({ email: 'a@b.c' })), null);
  const other = await generateKeyPair('RS256');
  const forged = await new SignJWT({ email: 'a@b.c', token_use: 'id' }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(HUB).setAudience('demeisen-crm').setExpirationTime('1h').sign(other.privateKey);
  assert.equal(await verifyIdToken(forged), null);
  server.close(); hub.close();
});
