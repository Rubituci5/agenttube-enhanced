'use strict';
/**
 * Deployment firewall for the AgentTube dashboard.
 *
 * Server deployment MUST run behind a HTTPS reverse proxy, binding the Node
 * listener to loopback. Basic auth is enforced for static pages AND APIs,
 * including reads, to prevent accidental exposure of YouTube account data.
 *
 * Legacy localhost development behavior is unchanged.
 */
const crypto = require('node:crypto');

function isLoopback(host) {
  const h = String(host || '').trim().toLowerCase();
  return ['localhost','127.0.0.1','::1','[::1]'].includes(h);
}
function validateDeploymentEnv(env = process.env) {
  const mode = String(env.DEPLOYMENT_MODE || 'local').toLowerCase();
  if (!['local','server'].includes(mode)) throw Error('DEPLOYMENT_MODE deve ser local ou server.');
  if (mode === 'server') {
    if (!isLoopback(env.HOST || '127.0.0.1')) {
      throw Error('Segurança: em modo server, HOST deve ser 127.0.0.1. Coloque HTTPS/reverse proxy na frente.');
    }
    if (!env.API_KEY || env.API_KEY.length < 32) throw Error('Segurança: API_KEY deve ter ao menos 32 caracteres no servidor.');
    if (!/^https:\/\/[^/]+$/.test(String(env.PUBLIC_ORIGIN||''))) throw Error('Segurança: PUBLIC_ORIGIN deve ser a URL HTTPS completa do painel.');
    if (!env.DASHBOARD_BASIC_USER || env.DASHBOARD_BASIC_USER.length < 3 ||
        !env.DASHBOARD_BASIC_PASSWORD || env.DASHBOARD_BASIC_PASSWORD.length < 20) {
      throw Error('Segurança: DASHBOARD_BASIC_USER e DASHBOARD_BASIC_PASSWORD (20+ caracteres) são obrigatórios no servidor.');
    }
    if (env.NODE_ENV !== 'production') throw Error('Segurança: NODE_ENV=production é obrigatório no servidor.');
    if (env.TRUST_PROXY === 'true' && !isLoopback(env.REVERSE_PROXY_IP || '127.0.0.1')) {
      throw Error('O proxy de confiança precisa ser local.');
    }
  } else if (env.HOST && !isLoopback(env.HOST)) {
    throw Error('Segurança: não exponha o AgentTube diretamente na rede. Use DEPLOYMENT_MODE=server e HTTPS.');
  }
  return {mode,listenHost:env.HOST || '127.0.0.1'};
}
function matchSecret(provided,expected) {
  const a=crypto.createHash('sha256').update(String(provided||'')).digest();
  const b=crypto.createHash('sha256').update(String(expected||'')).digest();
  return crypto.timingSafeEqual(a,b);
}
function basicCredentials(req) {
  const auth=String(req.get('authorization') || '');
  if (!auth.startsWith('Basic ') || auth.length>2000) return null;
  try {
    const decoded=Buffer.from(auth.slice(6),'base64').toString('utf8');
    const i=decoded.indexOf(':');
    return i<0 ? null : {username:decoded.slice(0,i),password:decoded.slice(i+1)};
  }catch(_){return null}
}
function serverFirewall(env=process.env) {
  return (req,res,next) => {
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('X-Frame-Options','DENY');
    if (String(env.DEPLOYMENT_MODE || 'local').toLowerCase()!=='server') return next();

    res.setHeader('Cache-Control','no-store');
    if (req.path === '/health') {
      return res.json({status:'up'});
    }
    const creds=basicCredentials(req);
    const authorized=creds &&
      matchSecret(creds.username,env.DASHBOARD_BASIC_USER) &&
      matchSecret(creds.password,env.DASHBOARD_BASIC_PASSWORD);
    if(!authorized){
      res.setHeader('WWW-Authenticate','Basic realm="AgentTube", charset="UTF-8"');
      return res.status(401).type('text/plain').send('Authentication required');
    }
    req.basicAuthenticated = true;
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const origin=String(req.get('origin')||'');
      const allowedOrigin=String(env.PUBLIC_ORIGIN||'').replace(/\/$/,'');
      // Browser writes require the exact configured public HTTPS origin.
      // API clients may instead authenticate with an explicit x-api-key.
      const machineKey=req.get('x-api-key');
      const nonBrowserClient=machineKey && matchSecret(machineKey,env.API_KEY);
      if (!nonBrowserClient && (
        !allowedOrigin.startsWith('https://') ||
        !origin || origin!==allowedOrigin
      )){
        return res.status(403).json({error:'Origem inválida. Configure PUBLIC_ORIGIN com o endereço HTTPS do painel.'});
      }
    }
    next();
  };
}
module.exports={validateDeploymentEnv,serverFirewall,isLoopback,matchSecret};
