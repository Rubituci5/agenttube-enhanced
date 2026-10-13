'use strict';
const assert = require('node:assert/strict');
const {ChatGPTPlanTextService} = require('../utils/chatgpt-plan-text-service');
const {AITextService} = require('../utils/ai-text-service');
(async () => {
  let sent = null;
  const fakeAuth = {hasGrantedPlan: () => true,accessToken: async () => 'fake-oauth-access-token'};
  class FakeOpenAI {
    constructor({apiKey}) { assert.equal(apiKey,'fake-oauth-access-token'); }
    responses = {create: async args => {
      sent = args;
      return (async function* () {
        yield {type:'response.output_text.delta',delta:'Olá '};
        yield {type:'response.output_text.delta',delta:'mundo'};
        yield {type:'response.completed'};
      })();
    }};
  }
  const service = new ChatGPTPlanTextService({auth:fakeAuth,OpenAI:FakeOpenAI});
  service.models = async () => [{slug:'gpt-6.1-sol',name:'Test model'}];
  assert.equal(await service.generateText('Teste do AgentTube.'),'Olá mundo');
  assert.equal(sent.store,false);
  assert.equal(sent.stream,true);
  assert.equal(sent.input[0].role,'user');
  assert(!('temperature' in sent));
  assert(!('max_output_tokens' in sent));
  assert(!('previous_response_id' in sent));
  const oldFlag = process.env.CHATGPT_PLAN_ENABLED;
  process.env.CHATGPT_PLAN_ENABLED = 'true';
  const a = new AITextService({});
  assert.equal(a.providerName,'ChatGPT Plan (OAuth)');
  assert.equal(a.client,null,'Must not fall back to API key with OAuth mode enabled');
  if (oldFlag === undefined) delete process.env.CHATGPT_PLAN_ENABLED;
  else process.env.CHATGPT_PLAN_ENABLED = oldFlag;
  class IncompleteOpenAI {
    responses = {create: async () => (async function*(){yield {type:'response.output_text.delta',delta:'incomplete'};})()};
  }
  const failService = new ChatGPTPlanTextService({auth:fakeAuth,OpenAI:IncompleteOpenAI});
  failService.models = service.models;
  await assert.rejects(() => failService.generateText('test'),/não foi concluída/);
  console.log('ChatGPT Pro OAuth adapter: 8 checks passed (mocked Responses API; no paid request).');
})().catch(e => { console.error('OAuth adapter test failed:',e.message);process.exitCode=1; });
