'use strict';
/**
 * Read-only pre-migration and server diagnostic.
 * Does not send API requests, modify credentials, run generation or publish.
 * Usage: node scripts/server/preflight.js [--json]
 * For Linux launch, DEPLOYMENT_MODE=server with server secrets configured.
 */
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const sqlite3=require('sqlite3');
const {validateDeploymentEnv}=require('../../utils/server-security');
const {getFFmpegPath}=require('../../utils/ffmpeg');

const ROOT=path.resolve(__dirname,'../..');
// Read the local .env for an accurate audit; an existing systemd environment
// always has priority in server mode (dotenv does not overwrite by default).
require('dotenv').config({path:path.join(ROOT,'.env')});
const checks=[];
const add=(name,severity,message,details={})=>checks.push({name,severity,message,...details});
const exists=(name)=>{try{return fs.statSync(name).isFile()}catch(_){return false}};
const size=(name)=>{try{return fs.statSync(name).size}catch(_){return 0}};
const MODE=process.env.DEPLOYMENT_MODE||'local';

async function readDatabase(dbFile){
  if(!exists(dbFile)){add('sqlite','BLOCK','Banco SQLite não encontrado. Migre o backup antes de iniciar.');return}
  const db=await new Promise((resolve,reject)=>{
    const handle=new sqlite3.Database(dbFile,sqlite3.OPEN_READONLY,e=>e?reject(e):resolve(handle));
  });
  const row=sql=>new Promise((resolve,reject)=>db.get(sql,(e,r)=>e?reject(e):resolve(r)));
  try{
    const status=await row('PRAGMA quick_check');
    if(status?.quick_check!=='ok')add('sqlite','BLOCK','SQLite integrity check failed.');
    else add('sqlite','OK','SQLite integrity check: ok.');
    const legacyPath=await row("SELECT COUNT(*) AS total FROM productions WHERE instr(COALESCE(assets,''),'/Users/')>0");
    if(Number(legacyPath?.total)>0){
      add('database_absolute_paths','WARN',
        `${legacyPath.total} produção(ões) armazenam caminhos absolutos do Mac. Reescrever caminhos após restaurar a base no Linux.`);
    }else add('database_absolute_paths','OK','Sem referências diretas ao diretório /Users em productions.assets.');
    const previous=await row('SELECT COUNT(*) AS total FROM publish_schedule WHERE status IN (\'uploading\',\'reconciliation_required\')');
    if(Number(previous?.total)>0)add('upload_reconciliation','BLOCK',
      'Existem uploads com resultado desconhecido. Conciliar com YouTube ANTES da migração.');
  }catch(error){add('sqlite_schema','BLOCK','Falha na leitura do banco: '+String(error.message).slice(0,150))}
  finally{await new Promise(resolve=>db.close(()=>resolve()))}
}

async function main(){
  try{validateDeploymentEnv(process.env);add('deployment_security','OK',
    MODE==='server'?'Servidor configurado com host local e segredos administrativos.':'Mac permanece vinculado a loopback.');}
  catch(error){add('deployment_security','BLOCK',error.message)}
  if(MODE==='local'&&!process.env.API_KEY)add('local_api_key','WARN',
    'API_KEY ausente no Mac. É tolerado apenas no loopback; obrigatório no servidor.');
  if(!/^https:\/\//.test(process.env.PUBLIC_ORIGIN||'')&&MODE==='server')
    add('https_domain','BLOCK','Configure PUBLIC_ORIGIN com domínio HTTPS atrás de nginx.');
  const major=Number(process.versions.node.split('.')[0]);
  add('node',major>=20?'OK':'BLOCK',`Node.js ${process.version}; recomendado v22 LTS (mínimo v20).`);
  add('platform',MODE==='server'&&process.platform!=='linux'?'BLOCK':'OK',
    `Host atual: ${process.platform}/${process.arch}. A migração exige nova instalação Linux de módulos nativos.`);
  for(const [title,filename] of [
    ['youtube_credentials','config/credentials.json'],
    ['youtube_tokens','config/tokens.json'],
    ['chatgpt_plan_auth','config/chatgpt-plan-auth.json'],
    ['pixabay_stock','config/pixabay.json'],
    ['iagora_editorial_profile','config/perfil-editorial-iagora.json']
  ]){
    const f=path.join(ROOT,filename);
    add(title,exists(f)?'OK':(title.includes('youtube')?'BLOCK':'WARN'),
      exists(f)?'Arquivo presente. Nunca publicar esse arquivo nem incluí-lo no Git.':'Arquivo não encontrado. Pode exigir migração/conexão.');
    if(exists(f) && process.platform!=='win32'){
      const permissions=fs.statSync(f).mode&0o077;
      if(permissions!==0)add(title+'_permissions','BLOCK','Arquivo privado acessível por outros usuários do sistema.');
    }
  }
  const ffmpeg=getFFmpegPath();
  try{
    const version=execFileSync(ffmpeg,['-version'],{timeout:5000,encoding:'utf8'});
    const filters=execFileSync(ffmpeg,['-hide_banner','-filters'],{timeout:5000,encoding:'utf8'});
    const missing=['subtitles','amix','sidechaincompress','afade','drawtext'].filter(x=>!new RegExp('\\b'+x+'\\b').test(filters));
    add('ffmpeg',missing.length?'BLOCK':'OK',`FFmpeg disponível (${version.split('\\n')[0].slice(0,75)}). ${missing.length?'Filtros ausentes: '+missing.join(', '):'Filtros de legenda e mixagem disponíveis.'}`);
  }catch(error){add('ffmpeg','BLOCK','FFmpeg indisponível ou sem filtros: '+String(error.message).slice(0,120))}
  const models=path.join(ROOT,'data/models/kokoro');
  const python=process.env.KOKORO_PYTHON||path.join(models,'venv','bin','python');
  for(const [title,filename,min] of [
    ['kokoro_model',path.join(models,'kokoro-v1.0.fp16.onnx'),100000000],
    ['kokoro_voices',path.join(models,'voices-v1.0.bin'),10000000],
    ['kokoro_python',python,1000]
  ]){
    const ok=exists(filename)&&size(filename)>min;
    add(title,ok?'OK':process.env.KOKORO_TTS_ENABLED==='true'?'BLOCK':'WARN',
      ok?'Arquivo nativo presente.':'Instale dependências nativas Kokoro para a arquitetura do servidor.');
  }
  if(process.env.KOKORO_TTS_ENABLED==='true'&&exists(python)){
    try{
      execFileSync(python,['-c',
        'from kokoro_onnx import Kokoro; from misaki.espeak import EspeakG2P; EspeakG2P(language="pt-br")'],
        {timeout:14000,stdio:'ignore'});
      add('kokoro_runtime','OK','Ambiente Kokoro pt-BR carregado.');
    }catch(error){add('kokoro_runtime','BLOCK','O Python Kokoro não iniciou com fonetização pt-BR.');}
  }
  if(process.env.CHATGPT_PLAN_ENABLED==='true')add('chatgpt_server_auth','WARN',
    'OAuth ChatGPT possui limites de uso compartilhado. O teste real em 13/10/2026 atingiu a cota; servidor headless e capacidade diária exigem validação.');
  if(process.env.TEXT_FALLBACK_PROVIDER==='gemini'&&!process.env.GEMINI_API_KEY){
    add('metered_fallback','BLOCK','Fallback Gemini foi ativado, mas GEMINI_API_KEY não foi fornecida.');
  } else if(process.env.TEXT_FALLBACK_PROVIDER!=='gemini'){
    add('metered_fallback','WARN','Fallback pago de texto permanece desligado (correto até autorização de custos).');
  }
  await readDatabase(path.join(ROOT,'data/youtube_automation.db'));
  if(process.platform==='linux'){
    try{
      const disk=fs.statfsSync(path.join(ROOT,'data'));
      const freeGb=disk.bavail*disk.bsize/1024**3;
      add('disk_free',freeGb<20?'BLOCK':'OK',
        `Espaço livre: ${freeGb.toFixed(1)} GB; recomendado 20+ GB livres para 2 vídeos longos/dia.`);
    }catch(_){add('disk_free','WARN','Sem estatísticas de espaço livre.');}
  }
  // The preflight never changes the production DB. The operator should still
  // confirm persistent switches using the dashboard before scheduling.
  add('publishing_activation','WARN',
    'Antes de ir ao ar: validar pesquisa factual, capacidade/quotas do YouTube e duas publicações numa simulação sem upload.');
  const block=checks.filter(x=>x.severity==='BLOCK'),warn=checks.filter(x=>x.severity==='WARN');
  const report={mode:MODE,root:ROOT,at:new Date().toISOString(),
    safeToStartServer:block.length===0,productionAutopublishApproved:false,
    summary:{checks:checks.length,blocked:block.length,warnings:warn.length},
    checks};
  if(process.argv.includes('--json'))console.log(JSON.stringify(report,null,2));
  else {
    console.log(`AgentTube preflight: ${checks.length} verificações; bloqueios=${block.length}; avisos=${warn.length}`);
    checks.forEach(x=>console.log(`[${x.severity}] ${x.name}: ${x.message}`));
  }
  if(block.length)process.exitCode=2;
}
main().catch(error=>{console.error('PREFLIGHT_FAILED',String(error.message).slice(0,300));process.exitCode=2});
