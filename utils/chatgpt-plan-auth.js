'use strict';
// OpenAI's published Sign in with ChatGPT flow for local open-source apps.
// https://developers.openai.com/siwc/token-sharing-open-source/sign-in
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFile } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'config', 'chatgpt-plan-auth.json');
const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const CALLBACK_PATH = '/auth/callback';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const MAX_LOGIN_MS = 5 * 60 * 1000;

function readSaved() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
async function writeSaved(data) {
  await fsp.mkdir(path.dirname(FILE), { recursive: true, mode: 0o700 });
  const temp = `${FILE}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  try { await fsp.chmod(temp, 0o600); await fsp.rename(temp, FILE); }
  catch (e) { await fsp.unlink(temp).catch(() => {}); throw e; }
}
function hasGrantedPlan(saved = readSaved()) {
  return Boolean(saved.client_id && saved.refresh_token && saved.scopes?.includes('chatgpt.tokens.use.direct'));
}
function status() {
  const s = readSaved();
  return { connected: hasGrantedPlan(s), email: s.email || null, clientRegistered: Boolean(s.client_id), planGranted: Boolean(s.scopes?.includes('chatgpt.tokens.use.direct')), expiresAt: s.expiresAt || null };
}
function base64url(bytes) { return Buffer.from(bytes).toString('base64url'); }
const random = () => base64url(crypto.randomBytes(32));
async function tokenRequest(params) {
  const response = await fetch(`${ISSUER}/api/accounts/oauth/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params), signal: AbortSignal.timeout(18000)
  });
  if (!response.ok) {
    // Never print raw responses or tokens.
    throw new Error(`Falha no OAuth da OpenAI (HTTP ${response.status}); conecte-se novamente se necessário.`);
  }
  return response.json();
}
async function verifyIdentity(idToken, clientId, nonce) {
  const { createRemoteJWKSet, jwtVerify } = await import('jose');
  const keys = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
  const { payload } = await jwtVerify(idToken, keys, {
    issuer: ISSUER, audience: clientId, requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5,
  });
  if (payload.nonce !== nonce || !payload.sub) throw new Error('Token de identidade inválido (nonce/sub).');
  return payload;
}
function chooseScopes(tokenResponse) {
  const scope = tokenResponse.scope;
  return typeof scope === 'string' ? scope.split(/\s+/).filter(Boolean) : [];
}
function tokenData(tokenResponse, prior = {}) {
  return {
    ...prior,
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token || prior.refresh_token,
    id_token: tokenResponse.id_token || prior.id_token,
    scopes: chooseScopes(tokenResponse).length ? chooseScopes(tokenResponse) : (prior.scopes || []),
    expiresAt: Date.now() + (Number(tokenResponse.expires_in) || 3600) * 1000,
    saved_at: new Date().toISOString()
  };
}
async function login() {
  const saved = readSaved();
  if (!saved.ext_agent_host_id) {
    saved.ext_agent_host_id = `urn:uuid:${crypto.randomUUID()}`;
    await writeSaved(saved);
  }
  const verifier = random() + random();
  const state = random();
  const nonce = random();
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirect_uri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
  const isReturning = Boolean(saved.client_id);
  const authorize = new URL(`${ISSUER}/api/accounts/authorize`);
  const params = {
    client_id: saved.client_id || 'dynamic_agent_client',
    ext_agent_host_id: saved.ext_agent_host_id,
    response_type: 'code', redirect_uri,
    scope: SCOPE, resource: RESOURCE, state, nonce,
    code_challenge_method: 'S256', code_challenge: challenge
  };
  if (!isReturning) params.agent_name_hint = 'AgentTube';
  else {
    if (saved.id_token) params.id_token_hint = saved.id_token;
    if (saved.email) params.login_hint = saved.email;
  }
  for (const [k, v] of Object.entries(params)) authorize.searchParams.set(k, v);
  console.log('Abrindo autenticação oficial da OpenAI no navegador. Autorize o uso do plano ChatGPT para AgentTube.');
  console.log(`Aguardando retorno em ${redirect_uri} (sem mostrar tokens ou códigos).`);
  const result = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Tempo de autenticação esgotado. Execute novamente o comando de login.')), MAX_LOGIN_MS);
    server.on('request', async (req, res) => {
      if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
      const url = new URL(req.url, redirect_uri);
      if (url.pathname !== CALLBACK_PATH) { res.writeHead(404); res.end(); return; }
      try {
        if (url.searchParams.get('state') !== state) throw new Error('OAuth state inválido.');
        if (url.searchParams.get('error')) throw new Error('Login recusado ou cancelado.');
        const code = url.searchParams.get('code');
        const issued = url.searchParams.get('client_id');
        const clientId = saved.client_id || issued;
        if (!code || !clientId || !clientId.startsWith('oaiapp_')) throw new Error('Registro incompleto: Client ID ou código ausente.');
        if (isReturning && issued && issued !== saved.client_id) throw new Error('Client ID incompatível com a sessão anterior.');
        const tokens = await tokenRequest({
          grant_type: 'authorization_code', client_id: clientId, code,
          code_verifier: verifier, redirect_uri, resource: RESOURCE
        });
        if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) throw new Error('Resposta OAuth sem tokens necessários.');
        const identity = await verifyIdentity(tokens.id_token, clientId, nonce);
        if (saved.subject && saved.subject !== identity.sub) throw new Error('A conta selecionada difere da conta já vinculada.');
        const record = tokenData(tokens, {
          client_id: clientId, ext_agent_host_id: saved.ext_agent_host_id,
          issuer: ISSUER, subject: identity.sub, email: identity.email || null,
        });
        if (!hasGrantedPlan(record)) throw new Error('Permissão de uso do plano ChatGPT não concedida.');
        await writeSaved(record);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><h2>AgentTube conectado ao ChatGPT!</h2><p>Autorização concluída. Você pode fechar esta aba.</p>');
        clearTimeout(timeout); resolve(record);
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Falha na autorização. Volte ao Terminal para conferir o motivo.');
        clearTimeout(timeout); reject(error);
      }
    });
  });
  execFile('open', [authorize.toString()], error => { if (error) console.warn('Abra o login pelo navegador manualmente; falha ao abrir automaticamente.'); });
  try { return await result; }
  finally { server.close(); }
}
let refreshing = null;
async function accessToken() {
  const saved = readSaved();
  if (!hasGrantedPlan(saved)) throw new Error('Conecte o ChatGPT Pro: npm run chatgpt:login');
  if (saved.access_token && saved.expiresAt > Date.now() + 90000) return saved.access_token;
  if (!refreshing) refreshing = (async () => {
    const current = readSaved();
    if (current.access_token && current.expiresAt > Date.now() + 90000) return current.access_token;
    const updated = await tokenRequest({
      grant_type: 'refresh_token', client_id: current.client_id,
      refresh_token: current.refresh_token, resource: RESOURCE
    });
    if (!updated.access_token) throw new Error('Refresh OAuth não retornou access_token.');
    const record = tokenData(updated, current);
    await writeSaved(record);
    return record.access_token;
  })().finally(() => { refreshing = null; });
  return refreshing;
}
module.exports = { login, status, hasGrantedPlan, accessToken, readSaved, FILE };
