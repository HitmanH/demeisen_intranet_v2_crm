// Demeisen CRM web server for Azure Container Apps: the page, its settings and the API, on one address.
// On AWS the same API code runs as a Lambda function behind API Gateway (see index.mjs); this file is not used there.
//   GET  /healthz                 health check
//   GET  <BASE_PATH>              the CRM page (web/index.html)
//   GET  <BASE_PATH>config.js     sign-in settings for the page
//   *    <BASE_PATH>api/...       the API: needs a valid Cognito ID token (Authorization: Bearer ...)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { handleApi } from './index.mjs';
import { verifyIdToken } from './azure.mjs';

const PORT = Number(process.env.PORT || 8080);
const BASE = (process.env.BASE_PATH || '/crm/').replace(/\/?$/, '/');
const VERIFY = process.env.ORIGIN_VERIFY;          // set: only requests through the Demeisen front door
const MAX_BODY = 5 * 1024 * 1024;
const page = readFileSync(new URL('../web/index.html', import.meta.url));
const config = Buffer.from(`window.CRM_CONFIG = ${JSON.stringify({
  authDomain: process.env.AUTH_DOMAIN, clientId: process.env.COGNITO_CLIENT_ID, basePath: BASE,
  apps: [{ title: 'Intranet', url: '/' }, { title: 'Investor CRM', url: BASE, current: true }] })};\n`);

const send = (res, status, headers, body) => { res.writeHead(status, { 'x-content-type-options': 'nosniff', ...headers }); res.end(body); };
const json = (res, status, obj) => send(res, status, { 'content-type': 'application/json', 'cache-control': 'no-store' }, JSON.stringify(obj));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = []; let n = 0;
    req.on('data', d => { n += d.length; if (n > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); } else parts.push(d); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    if (path === '/healthz') return send(res, 200, { 'content-type': 'text/plain' }, 'ok');
    if (VERIFY && req.headers['x-origin-verify'] !== VERIFY) return send(res, 403, { 'content-type': 'text/plain' }, 'Forbidden');
    if (path === BASE.slice(0, -1)) return send(res, 301, { location: BASE }, '');
    if (req.method === 'GET' && (path === BASE || path === `${BASE}index.html`))
      return send(res, 200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, page);
    if (req.method === 'GET' && path === `${BASE}config.js`)
      return send(res, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' }, config);
    if (!path.startsWith(`${BASE}api/`)) return json(res, 404, { error: 'Not found.' });

    const auth = req.headers.authorization || '';
    const claims = await verifyIdToken(auth.startsWith('Bearer ') ? auth.slice(7) : null);
    if (!claims) return json(res, 401, { error: 'Please sign in.' });
    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : '';
    const out = await handleApi({ rawPath: path, body, isBase64Encoded: false,
      requestContext: { http: { method: req.method }, authorizer: { jwt: { claims } } } });
    send(res, out.statusCode, out.headers || {}, out.isBase64Encoded ? Buffer.from(out.body, 'base64') : out.body);
  } catch (e) {
    if (e.status === 413) return json(res, 413, { error: 'That request is too large.' });
    console.error('request failed', e);
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Please try again.' });
  }
});

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  server.listen(PORT, () => console.log(`CRM listening on ${PORT}, page at ${BASE}`));
}
