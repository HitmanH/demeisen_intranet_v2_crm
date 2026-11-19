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

let jwks;
/** Returns the token's claims if it is a valid, unexpired Cognito ID token for this app; otherwise null. */
export async function verifyIdToken(token) {
  const { COGNITO_ISSUER: issuer, COGNITO_CLIENT_ID: clientId } = process.env;
  if (!token || !issuer || !clientId) return null;
  jwks ||= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: clientId, algorithms: ['RS256'] });
    return payload.token_use === 'id' ? payload : null;
  } catch { return null; }
}
