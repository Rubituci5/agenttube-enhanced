'use strict';
/**
 * Alterna o projeto OAuth do AgentTube somente após consentimento do Google
 * e confirmação explícita do canal no navegador.
 *
 * Uso: npm run youtube:novo-projeto [caminho-do-json-baixado]
 * Não imprime client_secret, tokens nem URLs OAuth com códigos.
 */
require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { google } = require('googleapis');

const ROOT = path.resolve(__dirname,'..');
const CONFIG = path.join(ROOT,'config');
const TOKEN_PATH = path.join(CONFIG,'tokens.json');
const CREDS_PATH = path.join(CONFIG,'credentials.json');
const BACKUP_DIR = path.join(CONFIG,'youtube-project-backups');
const PROJECT = '259108835778';
const SCOPE = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.force-ssl'
];
const validClientId = clientId => new RegExp('^'+PROJECT+'-[a-zA-Z0-9_-]+\\.apps\\.googleusercontent\\.com$').test(String(clientId||''));
const escape = value => String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
const safeLabel = value => String(value||'').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,90);
const html = (title,body) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escape(title)} · AgentTube</title>
  <style>body{font:17px/1.5 -apple-system,BlinkMacSystemFont,Arial,sans-serif;background:#10121a;color:#f3f5fe;margin:0;padding:7vh 20px}
  main{max-width:640px;margin:0 auto;border-radius:18px;padding:28px 36px;background:#1b2030;border:1px solid #3b4254}
  small,p{color:#c9d0df}button{font-size:16px;font-weight:600;border:0;border-radius:9px;padding:13px 18px;margin:8px 10px 0 0;background:#416be6;color:white;cursor:pointer}
  .cancel{background:#414a60}code{overflow-wrap:anywhere}</style>
  <main><h1>${escape(title)}</h1>${body}</main></html>`;

async function atomicWrite(file, content) {
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+crypto.randomBytes(7).toString('hex')+'.tmp';
  try {
    await fs.writeFile(temporary,content,{mode:0o600,flag:'wx'});
    await fs.chmod(temporary,0o600);
    await fs.rename(temporary,file);
    await fs.chmod(file,0o600);
  } finally { await fs.rm(temporary,{force:true}).catch(()=>{}); }
}

async function readJSON(file) { return JSON.parse(await fs.readFile(file,'utf8')); }

function candidateClient(record) {
  const installed=record?.installed;
  if (!installed || !validClientId(installed.client_id) || typeof installed.client_secret!=='string' || !installed.client_secret.trim()) return null;
  return installed;
}

async function locateDownload() {
  const explicit=process.argv[2];
  if (explicit) {
    const file=path.resolve(explicit);
    const oauth=candidateClient(await readJSON(file));
    if (!oauth) throw Error('O arquivo informado não é uma credencial OAuth Desktop do projeto '+PROJECT+'.');
    return {file,oauth};
  }
  const directories=[path.join(process.env.HOME||'/Users/rubituci','Downloads'),CONFIG];
  const candidates=[];
  for (const dir of directories) {
    let files=[];
    try { files=await fs.readdir(dir); } catch(_error) { continue; }
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      if (!/client_secret|oauth|credenciais-google-novo-projeto|259108835778/i.test(name)) continue;
      const file=path.join(dir,name);
      try {
        const oauth=candidateClient(await readJSON(file));
        if(oauth) candidates.push({file,oauth,stat:await fs.stat(file)});
      } catch (_error) { /* Candidate or prior channel may be unavailable. */ }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
  return candidates[0];
}

async function getChannel(oauth,authTokens,callback) {
  const client=new google.auth.OAuth2(oauth.client_id,oauth.client_secret,callback);
  client.setCredentials(authTokens);
  const reply=await google.youtube({version:'v3',auth:client}).channels.list({part:'snippet,statistics',mine:true});
  const channel=reply.data.items?.[0];
  if (!channel) throw Error('Esta conta não tem um canal YouTube disponível para autorização.');
  return {id:channel.id,name:channel.snippet?.title||'Canal sem nome',videos:Number(channel.statistics?.videoCount||0)};
}

async function backupOriginal(originalCredentials,originalTokens,oldChannel) {
  const oldProject=String(originalCredentials.youtube?.client_id||'').split('-')[0];
  const oldId=safeLabel(oldChannel?.id||'canal-original');
  const location=path.join(BACKUP_DIR,safeLabel(oldProject)+'_'+oldId);
  // Explicitly keep a restorable backup of both halves of the OAuth pairing.
  await atomicWrite(path.join(location,'credentials.json'),JSON.stringify(originalCredentials,null,2));
  await atomicWrite(path.join(location,'tokens.json'),JSON.stringify(originalTokens,null,2));
  return location;
}

async function run() {
  const target=await locateDownload();
  if (!target) {
    console.log('\nARQUIVO_OAUTH_AUSENTE');
    console.log('Projeto esperado: '+PROJECT);
    console.log('No Google Cloud > Google Auth Platform > Clientes, crie ou abra um cliente OAuth do tipo App para computador.');
    console.log('Por segurança, primeiro redefina o Client Secret que foi compartilhado na conversa.');
    console.log('Baixe o JSON atualizado, salve na pasta Downloads e execute este comando novamente.');
    console.log('https://console.cloud.google.com/auth/clients?project='+PROJECT);
    return;
  }

  const originalCredentials=await readJSON(CREDS_PATH);
  const originalTokens=await readJSON(TOKEN_PATH);
  const previous=originalTokens.youtube;
  if (!previous) throw Error('O token da conexão anterior não foi encontrado. Nenhuma alteração realizada.');
  let oldChannel=null;
  try {oldChannel=await getChannel(originalCredentials.youtube,previous);} catch (_error) { /* Candidate or prior channel may be unavailable. */ }
  console.log('PROJETO_ANTERIOR: '+String(originalCredentials.youtube?.client_id||'').split('-')[0]);
  console.log('CANAL_ANTERIOR: '+(oldChannel?.name||'não identificado'));
  console.log('PROJETO_NOVO: '+PROJECT);
  console.log('Arquivo OAuth Desktop encontrado. Nenhum segredo será exibido.');

  const server=http.createServer();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const callback='http://127.0.0.1:'+server.address().port+'/auth/callback';
  const oauth=new google.auth.OAuth2(target.oauth.client_id,target.oauth.client_secret,callback);
  const state=crypto.randomBytes(32).toString('hex');
  const confirmation=crypto.randomBytes(32).toString('hex');
  const url=oauth.generateAuthUrl({scope:SCOPE,access_type:'offline',prompt:'select_account consent',state});
  let pending=null,finished=false;
  let complete;
  const done=new Promise(resolve=>{complete=resolve;});
  const timeout=setTimeout(()=>{console.log('Autorização expirada; projeto antigo mantido.');complete(false);},11*60*1000);
  const reply=(res,status,title,body)=>{
    res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
    res.end(html(title,body));
  };

  server.on('request',async(req,res)=>{
    try {
      const reqUrl=new URL(req.url,callback);
      if(req.method==='GET' && reqUrl.pathname==='/auth/callback') {
        if(finished || reqUrl.searchParams.get('state')!==state)
          return reply(res,403,'Sessão inválida','<p>A tentativa de autenticação não corresponde à solicitação original.</p>');
        if(reqUrl.searchParams.has('error')) {
          reply(res,400,'Autorização cancelada','<p>O Google recusou ou cancelou o acesso. O canal anterior foi mantido.</p>');
          return complete(false);
        }
        const code=reqUrl.searchParams.get('code');
        if(!code) return reply(res,400,'Código ausente','<p>Não recebemos o código de autorização.</p>');
        const result=await oauth.getToken(code);
        const tokens=result.tokens;
        if(!tokens.access_token || !tokens.refresh_token)
          throw Error('O Google não retornou os tokens necessários.');
        const granted=String(tokens.scope||'').split(/\s+/).filter(Boolean);
        const needed=['https://www.googleapis.com/auth/youtube.readonly','https://www.googleapis.com/auth/yt-analytics.readonly'];
        if(granted.length && needed.some(scope=>!granted.includes(scope)))
          throw Error('Permissões incompletas. Autorize leitura do YouTube e YouTube Analytics.');
        const selected=await getChannel(target.oauth,tokens,callback);
        if(oldChannel && oldChannel.id===selected.id) {
          reply(res,400,'Canal anterior selecionado',
            '<p>Você selecionou o canal <strong>'+escape(selected.name)+'</strong>, que já está conectado. A troca foi cancelada.</p>');
          return complete(false);
        }
        pending={tokens,selected};
        reply(res,200,'Confirme o canal de mistérios',
          '<p>Projeto OAuth: <strong>'+PROJECT+'</strong></p>'+
          '<p>O Google autorizou o canal:</p><h2>'+escape(selected.name)+'</h2>'+
          '<p>ID: <code>'+escape(selected.id)+'</code></p>'+
          '<p><strong>Confirme somente se este for seu canal de mistérios, curiosidades e histórias.</strong></p>'+
          '<p>A configuração atual será salva em backup privado. Nenhum vídeo será enviado por este procedimento.</p>'+
          '<form method="post" action="/confirmar"><input type="hidden" name="csrf" value="'+confirmation+'"><button>Sim, conectar este canal</button></form>'+
          '<form method="post" action="/cancelar"><input type="hidden" name="csrf" value="'+confirmation+'"><button class="cancel">Cancelar e manter o atual</button></form>');
        return;
      }

      if(req.method==='POST' && ['/confirmar','/cancelar'].includes(reqUrl.pathname)) {
        let body='';
        for await(const chunk of req) {body+=chunk;if(body.length>4096)throw Error('Solicitação muito grande.');}
        if(finished || !pending || new URLSearchParams(body).get('csrf')!==confirmation)
          return reply(res,403,'Confirmação inválida','<p>A sessão foi encerrada.</p>');
        finished=true;
        if(reqUrl.pathname==='/cancelar') {
          reply(res,200,'Troca cancelada','<p>Nenhuma configuração foi alterada.</p>');
          return complete(false);
        }
        const newCredentials={...originalCredentials,youtube:{
          client_id:target.oauth.client_id,client_secret:target.oauth.client_secret,
          redirect_uris:['http://127.0.0.1']
        }};
        const newTokens={...originalTokens,youtube:pending.tokens};
        const archive=await backupOriginal(originalCredentials,originalTokens,oldChannel);
        // Keep an additional restorable copy of the newly authorized pairing.
        const destination=path.join(BACKUP_DIR,PROJECT+'_'+safeLabel(pending.selected.id));
        await atomicWrite(path.join(destination,'credentials.json'),JSON.stringify(newCredentials,null,2));
        await atomicWrite(path.join(destination,'tokens.json'),JSON.stringify(newTokens,null,2));
        await atomicWrite(CREDS_PATH,JSON.stringify(newCredentials,null,2));
        await atomicWrite(TOKEN_PATH,JSON.stringify(newTokens,null,2));
        await atomicWrite(path.join(CONFIG,'canal-youtube-ativo.json'),JSON.stringify({
          name:pending.selected.name,channelId:pending.selected.id,
          projectId:PROJECT,connectedAt:new Date().toISOString()
        },null,2));
        reply(res,200,'Canal conectado!',
          '<p>✅ Canal <strong>'+escape(pending.selected.name)+'</strong> autorizado pelo projeto '+PROJECT+'.</p>'+
          '<p>As credenciais anteriores foram preservadas em backup privado. Agora é necessário reiniciar o AgentTube para carregar o novo canal.</p>');
        console.log('NOVO_CANAL_CONFIRMADO: '+pending.selected.name+' | '+pending.selected.id);
        console.log('PROJETO_ATIVO: '+PROJECT);
        console.log('BACKUP_PROTEGIDO: '+archive);
        return complete(true);
      }
      reply(res,404,'Não encontrado','<p>Esta página não existe.</p>');
    } catch(error) {
      console.error('FALHA_DE_AUTORIZAÇÃO: '+error.message);
      reply(res,500,'Não foi possível conectar','<p>'+escape(error.message)+'</p><p>Se ocorrer erro durante a gravação, as credenciais anteriores estarão em backup privado.</p>');
      complete(false);
    }
  });

  console.log('Abrindo autorização no Google. Escolha a conta do seu canal de mistérios.');
  console.log('A troca só será aplicada após confirmação do nome do canal em uma página local.');
  execFile('open',[url],error=>{if(error)console.log('Não foi possível abrir automaticamente o navegador.');});
  try {
    const succeeded=await done;
    console.log(succeeded?'RESULTADO: PROJETO_NOVO_CONECTADO':'RESULTADO: CONEXÃO_ANTERIOR_MANTIDA');
  } finally {clearTimeout(timeout);server.close();}
}

if(require.main===module)run().catch(error=>{console.error('ERRO:',error.message);process.exitCode=1});
module.exports={candidateClient,validClientId,locateDownload};
