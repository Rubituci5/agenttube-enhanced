'use strict';
// Assistente local de configuracao: a chave chega somente por stdin/ambiente
// no Mac do usuario. Nunca escreva a chave em logs nem argumentos de linha.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');
const key = process.env.ELEVENLABS_SETUP_KEY || '';
const redact = text => String(text ?? '').replace(/sk_[a-zA-Z0-9_-]{15,}/g, '[chave oculta]');

async function selectVoice(voices) {
  const rl = readline.createInterface({input:process.stdin,output:process.stdout});
  try {
    const answer = (await rl.question('\nDigite o numero da voz ou cole um Voice ID: ')).trim();
    const number = Number(answer);
    const chosen = Number.isInteger(number) && String(number) === answer
      ? voices[number - 1]
      : voices.find(voice => voice.voice_id === answer);
    if (!chosen) throw Error('Voz nao encontrada na lista retornada pelo ElevenLabs.');
    return chosen;
  } finally {
    rl.close();
  }
}
function setEnv(data) {
  let lines=[];
  try {lines=fs.readFileSync(envPath,'utf8').split(/\r?\n/);} catch(error) {
    if(error.code!=='ENOENT')throw error;
  }
  const updates = {
    ELEVENLABS_API_KEY:key,
    ELEVENLABS_VOICE_ID:data.voice_id,
    ELEVENLABS_TTS_MODEL:'eleven_multilingual_v2',
    ELEVENLABS_TTS_ENABLED:'true'
  };
  const remove = new Set(Object.keys(updates));
  lines = lines.filter(line => !Array.from(remove).some(name => line.startsWith(name+'=')));
  for(const [name,value] of Object.entries(updates)) {
    if(!/^[\w-]+$/.test(String(value)))throw Error('Formato de configuracao invalido para '+name);
    lines.push(name+'='+value);
  }
  const destination=envPath+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  fs.writeFileSync(destination,lines.filter(Boolean).join('\n')+'\n',{mode:0o600,flag:'wx'});
  fs.renameSync(destination,envPath);
  fs.chmodSync(envPath,0o600);
}
(async()=>{
  if(!/^sk_[a-zA-Z0-9_-]{20,}$/.test(key))throw Error('Chave de API ElevenLabs invalida. Verifique a chave fornecida.');
  console.log('Verificando acesso ElevenLabs (somente consulta de vozes, sem consumo de sintese)...');
  const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),18000);
  let response;
  try {
    response=await fetch('https://api.elevenlabs.io/v1/voices',
      {headers:{'xi-api-key':key},signal:controller.signal});
  } finally {clearTimeout(timeout)}
  if(!response.ok) {
    console.error('Nao foi possivel consultar ElevenLabs (HTTP '+response.status+').');
    console.error('Nenhuma chave foi gravada. Confira as permissoes da chave e tente novamente.');
    process.exitCode=1;
    return;
  }
  const data=await response.json();
  const voices=(data.voices||[]).filter(v=>v.voice_id&&v.name);
  if(!voices.length)throw Error('A conta nao retornou vozes disponiveis; selecione/crie uma voz no ElevenLabs primeiro.');
  console.log('\nVOZES DISPONIVEIS:');
  voices.slice(0,60).forEach((voice,i)=>{
    console.log(String(i+1).padStart(2,' ')+'  '+voice.name+' ('+(voice.labels?.language||voice.labels?.accent||voice.category||'sem rotulo')+')');
  });
  const selected=await selectVoice(voices.slice(0,60));
  setEnv(selected);
  console.log('\n✅ Voz selecionada: '+selected.name);
  console.log('✅ Credenciais guardadas em .env (modo 600; ignorado pelo Git).');
  console.log('✅ Modelo: eleven_multilingual_v2; narracao ElevenLabs habilitada.');
  console.log('ℹ️ Reinicie o AgentTube depois de configurar; a automacao continua pausada.');
  console.log('A configuracao NAO gerou audio nem consumiu creditos de sintese.');
})().catch(error=>{console.error('Nao foi possivel configurar:',redact(error.message));process.exitCode=1});
