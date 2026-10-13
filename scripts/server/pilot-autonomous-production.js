'use strict';
// One real, shorter unattended production. Never uploads to YouTube;
// requires persisted pause + disabled uploads before starting.
const { YouTubeAutomationAgent } = require('../../index');
const { setTimeout: delay } = require('node:timers/promises');
async function main() {
  const app = new YouTubeAutomationAgent();
  if (process.env.AUTONOMOUS_APPROVAL_ENABLED !== 'true') throw Error('Auto evidence gate not enabled');
  const okay = await app.initialize();
  if (!okay || app.setupRequired) throw Error('AgentTube not initialized');
  if ((await app.db.getSetting('automation_paused')) !== 'true' ||
      (await app.db.getSetting('auto_publish_enabled')) !== 'false')
    throw Error('REFUSING PILOT: automation or publishing is not safely paused');
  const concurrent = Number((await app.db.getRow("SELECT COUNT(*) as count FROM generation_jobs WHERE status IN ('running','queued')")).count||0);
  if (concurrent) throw Error('REFUSING PILOT: existing active generation jobs');
  const pick = await app.topicScout.selectTopic();
  console.log('PILOT_TOPIC',pick.topic);
  console.log('PILOT_RESEARCH_SOURCE',pick.researchSources.map(x=>x.url).join(' | ')||'NONE');
  const job = await app.startGenerationJob({
    source:'scheduler',topic:pick.topic,
    style:pick.style,length:'short',
    strategyContext:{
      angle:pick.topic,
      rationale:pick.rationale,
      researchSources:pick.researchSources
    }
  });
  console.log('PILOT_JOB_ID',job.id);
  const result = await app.waitForGenerationJob(job.id);
  console.log('PILOT_JOB_STATUS',result.status);
  console.log('PILOT_JOB_STAGE',result.stage);
  console.log('PILOT_JOB_ERROR',String(result.error||'').slice(0,280));
  const productionId = result.production_id;
  if (productionId) {
    const bundle = await app.db.getProductionBundle(productionId);
    console.log('PILOT_PRODUCTION_ID',productionId);
    console.log('PILOT_REVIEW_STATUS',bundle.review_status);
    console.log('PILOT_PROVENANCE_STATUS',bundle.provenance?.status);
    console.log('PILOT_MEDIA_PROVIDER',bundle.assets?.finalVideo?.provider?.actualProvider);
    console.log('PILOT_QUALITY_BLOCKS',(bundle.qualityChecks||[]).filter(x=>x.blocking&&!x.passed).map(x=>x.id).join(','));
    console.log('PILOT_FACT_CHECK_SOURCES',bundle.provenance?.summary?.verifiedSources || 0);
    console.log('PILOT_SCRIPT_CLAIMS',bundle.provenance?.summary?.claimCount || 0);
    console.log('PILOT_FILE_SIZE',bundle.assets?.finalVideo?.fileSize||0);
  }
  await app.scheduler.stopAutomation();
  await delay(500);
  return result.status === 'completed' ? 0 : 2;
}
const hardStop=setTimeout(()=>{console.error('PILOT_TIMEOUT_14_MINUTES');process.exit(124)},14*60*1000);
hardStop.unref();
main().then(code=>process.exit(code)).catch(error=>{
  console.error('PILOT_FAILED',String(error.message||error).slice(0,350));
  process.exit(2);
});
