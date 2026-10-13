'use strict';

// Gemini Nano Banana API connector. Secrets stay on the Mac, never in the UI
// or job metadata. Image generation is triggered only by explicit user action.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const {GoogleGenAI}=require('@google/genai');
const {getEditorialProfile}=require('./iagora-editorial');

const ROOT=path.resolve(__dirname,'..');
const KEY_FILE=path.join(ROOT,'config','gemini-image-auth.json');
const MODELS=Object.freeze({
  balanced:'gemini-nano-banana-2.1',
  economical:'gemini-3.1-flash-lite-image',
  premium:'gemini-3-pro-image'
});

function keyFormatLooksPlausible(key) {
  return typeof key==='string' && key.length>=25 && key.length<=180 &&
    /^[A-Za-z0-9_.-]+$/.test(key);
}
async function readKey() {
  if(process.env.NANOBANANA_API_KEY)return process.env.NANOBANANA_API_KEY.trim();
  try {
    const data=JSON.parse(await fs.readFile(KEY_FILE,'utf8'));
    return String(data.apiKey||'').trim();
  } catch(error) {
    if(error.code==='ENOENT')return '';
    throw new Error('Não foi possível ler a chave configurada.');
  }
}
async function verifyKey(apiKey) {
  if(!keyFormatLooksPlausible(apiKey))throw new Error('Formato de chave incompleto. Copie a chave de API do Google AI Studio.');
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),17000);
  try{
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1',{
      method:'GET',headers:{'x-goog-api-key':apiKey},signal:controller.signal
    });
    if(!response.ok) {
      if(response.status===401)throw new Error('Google recusou a autenticação da chave (401).');
      if(response.status===403)throw new Error('Google recusou o acesso (403). Confira as permissões e restrições da chave.');
      if(response.status===429)throw new Error('Limite de consultas ao Google atingido. Aguarde e tente novamente.');
      throw new Error('Não foi possível validar a chave no Google (HTTP '+response.status+').');
    }
    return true;
  } catch(error) {
    if(error.name==='AbortError')throw new Error('Tempo de validação esgotado. Verifique sua conexão.');
    // Never expose provider response containing URL/auth headers.
    if(/Google recusou|Não foi possível validar|Limite de consultas/.test(error.message))throw error;
    throw new Error('Falha de conexão ao validar a chave no Google AI Studio.');
  } finally {clearTimeout(timeout)}
}
async function saveKey(apiKey) {
  const key=String(apiKey||'').trim();
  await verifyKey(key);
  await fs.mkdir(path.dirname(KEY_FILE),{recursive:true});
  const tempfile=KEY_FILE+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  try{
    await fs.writeFile(tempfile,JSON.stringify({apiKey:key,savedAt:new Date().toISOString()})+'\n',{mode:0o600,flag:'wx'});
    await fs.chmod(tempfile,0o600);
    await fs.rename(tempfile,KEY_FILE);
    await fs.chmod(KEY_FILE,0o600);
  } finally {await fs.rm(tempfile,{force:true}).catch(()=>{})}
  return {configured:true,validated:true};
}
async function status(){
  return {configured:Boolean(await readKey()),models:MODELS,activeChannel:getEditorialProfile()?.brand||null,
    note:'A chave é armazenada no Mac. Gerar imagens via API pode ter cobrança por uso.'};
}
async function generateImage({prompt,quality='balanced'}={}) {
  if(!getEditorialProfile())throw new Error('A API de imagens está disponível somente para o canal IAgora.');
  if(!Object.hasOwn(MODELS,quality))throw new Error('Modelo Nano Banana não suportado.');
  const key=await readKey();
  if(!key)throw new Error('Configure e valide a chave Gemini antes de gerar imagens.');
  const instruction=String(prompt||'').trim();
  if(instruction.length<80||instruction.length>4000)throw new Error('Prompt inválido. Gere primeiro a direção de arte do GPT.');
  try{
    const ai=new GoogleGenAI({apiKey:key,httpOptions:{timeout:180000}});
    const response=await ai.models.generateContent({
      model:MODELS[quality],
      contents:instruction,
      config:{
        responseModalities:['TEXT','IMAGE'],
        imageConfig:{aspectRatio:'16:9',imageSize:'1K'}
      }
    });
    const parts=response?.candidates?.[0]?.content?.parts||[];
    const item=parts.find(part=>part.inlineData?.data);
    if(!item)throw new Error('Google não devolveu uma imagem. Confira a disponibilidade e os limites do modelo.');
    const mime=item.inlineData.mimeType||'image/png';
    if(!['image/png','image/jpeg','image/webp'].includes(mime))throw new Error('Google retornou um formato de imagem não suportado.');
    const buffer=Buffer.from(item.inlineData.data,'base64');
    if(buffer.length<1024||buffer.length>15*1024*1024)throw new Error('Imagem do Nano Banana está fora do limite de 15 MB.');
    return {buffer,contentType:mime,model:MODELS[quality]};
  } catch(error){
    if(/Google não devolveu|formato de imagem|fora do limite/.test(error.message))throw error;
    if(Number(error.status||error.code)===429) {
      const raw=String(error.message||'');
      const zeroLimit=/(?:quota_limit_value|quotaValue|limit)\s*[:=]\s*["']?0\b|limit:\s*0\b/i.test(raw);
      // Do not leak Google request details, API keys or prompt.
      throw new Error(zeroLimit
        ? 'Google retornou 429: a cota deste projeto/modelo parece estar em ZERO. Nano Banana 2.1 não tem nível gratuito na API. Confira se o projeto da chave está com faturamento ativo em AI Studio > Billing e se Rate limits mostra limite maior que zero. Sua assinatura Google AI Pro não ativa cobrança da API.'
        : 'Google retornou 429 (RESOURCE_EXHAUSTED). Nano Banana 2.1 exige acesso pago à API. Confira AI Studio > Billing (plano e créditos) e Rate limits (cota de imagens/solicitações do projeto). Se já estiver no nível pago, pode ser um limite temporário: aguarde e consulte Usage antes de repetir.');
    }
    if(error.status===401||error.status===403)throw new Error('O Google recusou a chave ou o acesso ao modelo escolhido.');
    if(error.status===402)throw new Error('É necessário habilitar faturamento para este modelo.');
    if(error.status===400)throw new Error('O Google recusou os parâmetros da imagem (400). Verifique modelo e prompt.');
    if(error.status===404)throw new Error('O modelo selecionado não está disponível no seu projeto (404).');
    if(Number(error.status)>=500)throw new Error('O serviço de imagens do Google está indisponível temporariamente.');
    if(error.name==='AbortError'||/timeout|deadline/i.test(String(error.message||''))) {
      throw new Error('O Google demorou muito para responder. Verifique o histórico de uso antes de repetir, para evitar cobranças duplicadas.');
    }
    // Provider errors may embed sensitive request metadata: do not log or echo raw errors.
    throw new Error('A geração falhou. Confirme faturamento, cota e acesso ao modelo no Google AI Studio.');
  }
}
module.exports={readKey,verifyKey,saveKey,status,generateImage,MODELS,KEY_FILE,keyFormatLooksPlausible};
