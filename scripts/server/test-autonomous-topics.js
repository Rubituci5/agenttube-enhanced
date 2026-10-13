'use strict';
const assert = require('node:assert/strict');
const { AutonomousTopicScout, parseFeed, duplicate } = require('../../utils/autonomous-topic-scout');
const { YouTubeAutomationAgent } = require('../../index');

const now = Date.parse('2026-10-13T12:00:00Z');
const published = new Date(now - 86400000).toUTCString();
const feed = {
  host: 'blog.google', publisher: 'Google AI', weight: 9,
  url: 'https://blog.google/technology/ai/rss/'
};
const sample = `<rss><channel>
<item><title>Artificial intelligence improves scientific research on proteins</title><link>https://blog.google/technology/ai/new-research/</link><pubDate>${published}</pubDate><description>Official research publication.</description></item>
<item><title>Artificial intelligence improves scientific research on proteins</title><link>http://127.0.0.1/admin</link><pubDate>${published}</pubDate></item>
<item><title>AI product discount sale today for everyone</title><link>https://blog.google/technology/ai/sale/</link><pubDate>${published}</pubDate></item>
<item><title>AI research from four months ago</title><link>https://blog.google/technology/ai/old/</link><pubDate>Mon, 01 Jun 2026 12:00:00 GMT</pubDate></item>
</channel></rss>`;

async function run() {
  const candidates = parseFeed(sample, feed, now);
  assert.equal(candidates.length, 1, 'Only fresh, allowed, relevant URLs should pass');
  assert.equal(candidates[0].sourceUrl, 'https://blog.google/technology/ai/new-research/');
  assert.equal(duplicate('AI helps study protein research', 'Research on AI helps study proteins'), true);
  assert.equal(duplicate('Mars robots', 'Quantum computers'), false);
  const db = { getAllRows: async () => [] };
  const scout = new AutonomousTopicScout(db, { now: () => now, sources: [feed], fetchFeed: async () => sample, validateArticle: async () => true });
  const selected = await scout.selectTopic();
  assert.equal(selected.topic, candidates[0].topic);
  assert.equal(selected.researchSources.length, 1);
  assert.equal(selected.researchSources[0].status, 'pending', 'Research headline cannot become automatically verified evidence');
  let called = null;
  const app = Object.create(YouTubeAutomationAgent.prototype);
  app.db = {
    getChannelStrategy: async () => null,
    createContentIdea: async ({ topic }) => ({ id: 'idea-1', topic }),
    updateContentIdea: async () => null,
    getGenerationJob: async () => ({ status: 'completed' })
  };
  app.activeJobs = new Map([['job-auto-1', Promise.resolve()]]);
  app.logger = { info() {}, warn() {} };
  app.topicScout = scout;
  app.startGenerationJob = async job => { called = job; return { id: 'job-auto-1' }; };
  await app.queueScheduledContent({ source: 'scheduler' });
  assert.equal(called.source, 'scheduler');
  assert.equal(called.topic, selected.topic);
  assert.equal(called.strategyContext.researchSources[0].sourceType, 'official');
  // A repeat must never be selected as news; use distinct curated fallback.
  scout.db.getAllRows = async () => [{ topic: selected.topic }];
  // The scheduler's research provenance must reach the script intact.
  const input = {
    topic:selected.topic,source:'scheduler',
    strategyContext:{researchSources:[{url:'https://www.nist.gov/itl/ai-risk-management-framework',
      title:'NIST AI Framework',sourceType:'official',excerpt:'Source text evidence',status:'verified'}]}
  };
  const allowed = app.validateGenerateRequestBody(input);
  assert.equal(allowed.valid,true);
  assert.equal(allowed.value.strategyContext.researchSources.length,1);
  assert.equal(allowed.value.strategyContext.researchSources[0].status,'pending',
    'Caller must not smuggle automatic verification status');
  assert.equal(allowed.value.strategyContext.researchSources[0].excerpt,'Source text evidence');
  const manual = app.validateGenerateRequestBody({...input,source:'manual'});
  assert.equal(manual.value.strategyContext.researchSources,undefined,
    'Manual callers must not invent pre-approved sources');

  const fallback = await scout.selectTopic();
  assert.equal(fallback.selection, 'evergreen-fallback');
  assert.notEqual(fallback.topic, selected.topic);
  const brokenFeeds = new AutonomousTopicScout({ getAllRows: async () => [] }, {
    now: () => now, sources: [feed], fetchFeed: async () => { throw Error('source offline'); }, validateArticle: async () => true
  });
  const offline = await brokenFeeds.selectTopic();
  assert.equal(offline.selection, 'evergreen-fallback');
  console.log('AUTONOMOUS_TOPICS_TEST_PASS news relevance, safe source URL, date, dedup, provenance, scheduler, offline fallback');
}
run().catch(e => { console.error(e); process.exitCode = 1; });
