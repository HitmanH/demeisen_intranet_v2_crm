// Azure-only helpers, loaded only when running on Azure (AZURE_STORAGE_ACCOUNT / COGNITO_ISSUER set).
// Storage: signs in with the app's managed identity (AZURE_CLIENT_ID), so no storage key exists anywhere.
// Sign-in check: verifies the Cognito ID token itself, as API Gateway's JWT authorizer does on AWS.
import { ManagedIdentityCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export function blobWriter(container) {
  const svc = new BlobServiceClient(`https://${process.env.AZURE_STORAGE_ACCOUNT}.blob.core.windows.net`,
    new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID }));
  const c = svc.getContainerClient(container);
  return (key, body, contentType) => {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return c.getBlockBlobClient(key).uploadData(buf, { blobHTTPHeaders: { blobContentType: contentType } });
  };
}

let jwks, hubJwks;
/** Returns the token's claims if it is a valid, unexpired ID token for the CRM, from either sign-in:
 *  - Cognito (COGNITO_ISSUER / COGNITO_CLIENT_ID), the previous shared sign-in;
 *  - Demeisen's own sign-in at the intranet (HUB_ISSUER, client `demeisen-crm`), keys from HUB_ISSUER/oauth2/jwks. */
export async function verifyIdToken(token) {
  if (!token) return null;
  const { COGNITO_ISSUER: issuer, COGNITO_CLIENT_ID: clientId, HUB_ISSUER: hub } = process.env;
  const hubClient = process.env.HUB_CLIENT_ID || 'demeisen-crm';
  let iss;
  try { iss = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).iss; } catch { return null; }
  try {
    if (hub && iss === hub) {
      hubJwks ||= createRemoteJWKSet(new URL(`${hub}/oauth2/jwks`));
      const { payload } = await jwtVerify(token, hubJwks, { issuer: hub, audience: hubClient, algorithms: ['RS256'] });
      return payload.token_use === 'id' && payload.email ? payload : null;
    }
    if (!issuer || !clientId || iss !== issuer) return null;
    jwks ||= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: clientId, algorithms: ['RS256'] });
    return payload.token_use === 'id' ? payload : null;
  } catch { return null; }
}
