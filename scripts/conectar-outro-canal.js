'use strict';
// Alterna o canal autorizado no AgentTube somente após confirmação humana.
// Evita substituir o token anterior antes de identificar o canal escolhido.
require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { google } = require('googleapis');

const ROOT = path.resolve(__dirname, '..');
const CONFIG = path.join(ROOT, 'config');
const TOKEN_PATH = path.join(CONFIG, 'tokens.json');
const CREDS_PATH = path.join(CONFIG, 'credentials.json');
const ARCHIVE = path.join(CONFIG, 'youtube-channel-backups');
const TIMEOUT = 12 * 60 * 1000;
const SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl'
];

const safe = value => String(value || '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
  .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function html(title, content) {
  return `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${safe(title)} · AgentTube</title><style>
  body{background:#0f1119;color:#f1f5ff;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif;line-height:1.5;margin:0;padding:8vh 20px}
  main{max-width:660px;margin:0 auto;background:#1a1e2d;border:1px solid #333c54;border-radius:18px;padding:35px}
  h1{font-size:27px}strong{color:#fff}p{color:#c4cede}small{color:#a5aec1}
  button{font-size:16px;font-weight:700;cursor:pointer;padding:14px 20px;margin:10px 8px 4px 0;border:0;border-radius:9px;background:#f04c65;color:white}
  button.secondary{background:#373e54}code{overflow-wrap:anywhere;color:#fff}
  </style><main><h1>${safe(title)}</h1>${content}</main></html>`;
}

async function atomicSave(destination, contents) {
  await fs.mkdir(path.dirname(destination), { recursive:true, mode:0o700 });
  const temporary = destination + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  try {
    await fs.writeFile(temporary, contents, {mode:0o600, flag:'wx'});
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600);
  } finally { await fs.rm(temporary, {force:true}).catch(()=>{}); }
}

async function run() {
  const credentials = JSON.parse(await fs.readFile(CREDS_PATH, 'utf8'));
  const oauthCredentials = credentials.youtube;
  if (!oauthCredentials?.client_id || !oauthCredentials?.client_secret) throw Error('Client ID e segredo OAuth do Google não configurados.');
  let previous = {};
  try { previous = JSON.parse(await fs.readFile(TOKEN_PATH, 'utf8')); } catch (_) { /* No previous token is a valid first-time connection. */ }
  const previousTokens = previous.youtube || null;

  const server = http.createServer();
  await new Promise((resolve,reject)=>{
    server.once('error', reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  const callback = `http://127.0.0.1:${server.address().port}/auth/callback`;
  const client = new google.auth.OAuth2(oauthCredentials.client_id,oauthCredentials.client_secret,callback);
  const state = crypto.randomBytes(28).toString('hex');
  const confirmation = crypto.randomBytes(28).toString('hex');
  const authorizationUrl = client.generateAuthUrl({
    access_type:'offline', prompt:'select_account consent', scope:SCOPES, state
  });
  let pending = null;
  let oldChannel = null;
  let finishing = false;
  let finish;
  const done = new Promise(resolve=>{finish=resolve});
  const timeout = setTimeout(()=>{console.log('Prazo esgotado. A conexão original foi mantida.');finish(false);},TIMEOUT);
  const respond = (res,status,page) => {
    res.writeHead(status, {'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(page);
  };

  const lookupChannel = async auth => {
    const r = await google.youtube({version:'v3',auth}).channels.list({part:'snippet,statistics',mine:true});
    const channel = r.data.items?.[0];
    if (!channel) throw Error('Nenhum canal do YouTube encontrado para a conta escolhida.');
    return {id:channel.id,name:channel.snippet?.title||'Sem nome',subscriberCount:channel.statistics?.subscriberCount??null};
  };
  if (previousTokens) {
    try {
      const oldAuth = new google.auth.OAuth2(oauthCredentials.client_id,oauthCredentials.client_secret,callback);
      oldAuth.setCredentials(previousTokens);
      oldChannel = await lookupChannel(oldAuth);
    } catch (_) {
      console.log('Não foi possível identificar o canal anterior agora. O token atual será preservado.');
    }
  }

  server.on('request',async(req,res)=>{
    try {
      const url=new URL(req.url,callback);
      if (req.method==='GET' && url.pathname==='/auth/callback') {
        if (url.searchParams.get('state')!==state) return respond(res,403,html('Autorização inválida','<p>O código de segurança não confere. Nenhuma conta foi alterada.</p>'));
        const error=url.searchParams.get('error');
        if (error) {
          respond(res,400,html('Autorização cancelada','<p>O Google não concedeu autorização. A conta anterior foi mantida.</p>'));
          return finish(false);
        }
        const code=url.searchParams.get('code');
        if (!code) return respond(res,400,html('Código ausente','<p>Não recebemos o código de autorização.</p>'));
        const result=await client.getToken(code);
        const tokens=result.tokens;
        if (!tokens.access_token || !tokens.refresh_token) throw Error('O Google não forneceu os tokens necessários. Tente autorizar novamente.');
        client.setCredentials(tokens);
        const selected=await lookupChannel(client);
        if (oldChannel && selected.id===oldChannel.id) {
          respond(res,200,html('Este é o canal que já estava conectado',
            `<p><strong>${safe(selected.name)}</strong> já está conectado ao AgentTube.</p>
            <p>Volte ao YouTube e escolha outra conta ou canal de marca. Nenhum token foi substituído.</p>
            <p><small>ID: ${safe(selected.id)}</small></p>`));
          return finish(false);
        }
        pending={tokens,channel:selected};
        respond(res,200,html('Confirmar novo canal',
          `<p>O Google autorizou o canal:</p><h2>${safe(selected.name)}</h2>
          <p><small>ID do canal: <code>${safe(selected.id)}</code></small></p>
          <p><strong>Confirme somente se este for o canal de mistérios, curiosidades e histórias.</strong></p>
          <p>O canal anterior${oldChannel ? ` (${safe(oldChannel.name)})` : ''} terá a conexão guardada em backup protegido.
          O AgentTube continuará com aprovação manual, sem publicar vídeos automaticamente.</p>
          <form method="POST" action="/confirm">
            <input type="hidden" name="confirmation" value="${confirmation}">
            <button type="submit">Sim, conectar este canal</button>
          </form><form method="POST" action="/cancel">
            <input type="hidden" name="confirmation" value="${confirmation}">
            <button type="submit" class="secondary">Cancelar, manter canal anterior</button>
          </form>`));
        return;
      }
      if (req.method==='POST' && ['/confirm','/cancel'].includes(url.pathname)) {
        let body='';
        for await(const chunk of req) {
          body += chunk;
          if (body.length>10000) throw Error('Requisição muito grande.');
        }
        if (new URLSearchParams(body).get('confirmation')!==confirmation || !pending || finishing)
          return respond(res,403,html('Confirmação inválida','<p>Esta confirmação não está mais disponível.</p>'));
        finishing=true;
        if (url.pathname==='/cancel') {
          respond(res,200,html('Cancelado','<p>A conexão anterior foi preservada. Você pode fechar esta aba.</p>'));
          return finish(false);
        }
        // Save original first; only then write the new token atomically.
        const saveName=id=>id.replace(/[^A-Za-z0-9_-]/g,'');
        if(previousTokens) {
          const oldName = oldChannel?.id || 'canal-anterior-'+Date.now();
          await atomicSave(path.join(ARCHIVE,saveName(oldName)+'.json'),JSON.stringify({youtube:previousTokens},null,2));
        }
        await atomicSave(path.join(ARCHIVE,saveName(pending.channel.id)+'.json'),JSON.stringify({youtube:pending.tokens},null,2));
        await atomicSave(TOKEN_PATH,JSON.stringify({...previous,youtube:pending.tokens},null,2));
        await atomicSave(path.join(CONFIG,'canal-youtube-ativo.json'),
          JSON.stringify({channelId:pending.channel.id,name:pending.channel.name,connectedAt:new Date().toISOString()},null,2));
        respond(res,200,html('Novo canal conectado',
          `<p>✅ <strong>${safe(pending.channel.name)}</strong> está autorizado!</p>
          <p>A conexão foi salva com segurança. Você pode fechar esta aba. Para o AgentTube carregar o novo canal, reinicie o painel.</p>`));
        console.log('CANAL_NOVO_CONFIRMADO: '+pending.channel.name+' | '+pending.channel.id);
        return finish(true);
      }
      respond(res,404,html('Não encontrado','<p>Volte à página de autenticação do Google.</p>'));
    } catch(error) {
      console.error('Erro na conexão: '+error.message);
      respond(res,500,html('Não foi possível concluir',`<p>${safe(error.message)}</p><p>Não confirme nenhuma mudança. O token anterior será mantido salvo, quando possível.</p>`));
      finish(false);
    }
  });

  console.log('CONEXÃO ATUAL: '+(oldChannel ? oldChannel.name+' | '+oldChannel.id:'canal existente (não identificado)'));
  console.log('Abrindo Google para escolher outra conta/canal de marca.');
  console.log('Nenhuma credencial será trocada antes da confirmação no navegador.');
  execFile('open',[authorizationUrl],error=>{
    if(error)console.log('Não foi possível abrir o navegador automaticamente. Tente novamente pelo terminal.');
  });
  try {
    const result=await done;
    console.log(result?'RESULTADO: NOVO_CANAL_CONECTADO. Reinicie o YouTube Agent.':'RESULTADO: CONEXÃO_ORIGINAL_PRESERVADA.');
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}
run().catch(error=>{console.error('Não foi possível iniciar a conexão:',error.message);process.exitCode=1});
