'use strict';
// Only uses the official Responses API endpoint with an OAuth access token.
// SIWC requires store:false, stream:true, and no temperature/max_output_tokens.
const OpenAI = require('openai');
const auth = require('./chatgpt-plan-auth');
const DEFAULT_MODEL = 'gpt-6.1-sol';
class ChatGPTPlanTextService {
  constructor(options = {}) {
    this.auth = options.auth || auth;
    this.OpenAI = options.OpenAI || OpenAI;
    this.model = process.env.CHATGPT_PLAN_MODEL || DEFAULT_MODEL;
    this.modelCache = null;
  }
  async models() {
    if (this.modelCache && Date.now() < this.modelCache.until) return this.modelCache.values;
    const token = await this.auth.accessToken();
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error(`Não foi possível carregar os modelos do ChatGPT (HTTP ${response.status}).`);
    const result = await response.json();
    const values = (result.models || []).filter(m => m.visibility === 'list').map(m => ({slug:m.slug, name:m.display_name}));
    if (!values.length) throw new Error('Nenhum modelo disponível na conta ChatGPT conectada.');
    this.modelCache = {values, until:Date.now()+60*60*1000};
    return values;
  }
  async generateText(prompt, options = {}) {
    if (!this.auth.hasGrantedPlan()) throw new Error('Autorize o uso do plano ChatGPT em npm run chatgpt:login.');
    const available = await this.models();
    const preferred = options.model || this.model;
    const model = available.find(m=>m.slug===preferred) ? preferred :
      (process.env.CHATGPT_PLAN_MODEL ? null : available[0].slug);
    if (!model) throw new Error(`Modelo ChatGPT não disponível: ${preferred}. Consulte npm run chatgpt:models.`);
    const token = await this.auth.accessToken();
    const client = new this.OpenAI({apiKey:token,maxRetries:0,timeout:90000});
    // Deliberately no automatic paid API fallback.
    const stream = await client.responses.create({
      model, input: [{role:'user',content:String(prompt)}],
      store:false,stream:true
    });
    let text = '';
    let completed = false;
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') text += event.delta || '';
      if (event.type === 'response.completed') completed = true;
      if (event.type === 'response.failed') {
        throw new Error(`Resposta do ChatGPT falhou: ${event.response?.error?.code || 'erro desconhecido'}`);
      }
      if (event.type === 'response.incomplete') throw new Error('Resposta do ChatGPT interrompida antes de concluir.');
      if (event.type === 'error') throw new Error(`Erro durante geração com plano ChatGPT: ${event.code || 'desconhecido'}`);
    }
    if (!completed || !text.trim()) throw new Error('A resposta do ChatGPT não foi concluída; nenhuma saída parcial será usada.');
    return text;
  }
}
module.exports = {ChatGPTPlanTextService};
