'use strict';
// Safe, entirely offline deployment regression tests. No YouTube uploads.
const assert=require('node:assert/strict');
const express=require('express');
const {validateDeploymentEnv,serverFirewall}=require('../../utils/server-security');
const {DailyAutomation}=require('../../schedules/daily-automation');
const {PublishingSchedulingAgent}=require('../../agents/publishing-scheduling-agent');

async function testSecurity(){
 const env={
   DEPLOYMENT_MODE:'server',NODE_ENV:'production',HOST:'127.0.0.1',
   API_KEY:'S'.repeat(48),PUBLIC_ORIGIN:'https://iagora.example.org',
   DASHBOARD_BASIC_USER:'administrator',DASHBOARD_BASIC_PASSWORD:'VeryLongFakeUnitTestSecret'+String(123456789)
 };
 assert.equal(validateDeploymentEnv(env).mode,'server');
 for(const override of [
  {HOST:'0.0.0.0'},
  {API_KEY:''},
  {DASHBOARD_BASIC_PASSWORD:'short'},
  {PUBLIC_ORIGIN:'http://insecure.example.org'},
  {NODE_ENV:'development'}
 ]){
   assert.throws(()=>validateDeploymentEnv({...env,...override}));
 }
 const app=express();
 app.use(serverFirewall(env));
 app.get('/dashboard',(_req,res)=>res.json({ok:true}));
 app.post('/change',(_req,res)=>res.json({changed:true}));
 const server=await new Promise(ok=>{const s=app.listen(0,'127.0.0.1',()=>ok(s));});
 try{
  const base='http://127.0.0.1:'+server.address().port;
  const auth='Basic '+Buffer.from(env.DASHBOARD_BASIC_USER+':'+env.DASHBOARD_BASIC_PASSWORD).toString('base64');
  const noauth=await fetch(base+'/dashboard');
  assert.equal(noauth.status,401);
  const authorized=await fetch(base+'/dashboard',{headers:{Authorization:auth}});
  assert.equal(authorized.status,200);
  const other=await fetch(base+'/change',{method:'POST',headers:{Authorization:auth,Origin:'https://attacker.invalid'}});
  assert.equal(other.status,403);
  const valid=await fetch(base+'/change',{method:'POST',headers:{Authorization:auth,Origin:env.PUBLIC_ORIGIN}});
  assert.equal(valid.status,200);
  const raw=await fetch(base+'/change',{method:'POST',headers:{Authorization:auth,'x-api-key':env.API_KEY}});
  assert.equal(raw.status,200);
 }finally{await new Promise(ok=>server.close(ok))}
 console.log('SERVER_AUTH_SECURITY_PASS (credentials + CSRF + host validation)');
}
async function testAutomaticPublishing(){
 let settings={auto_publish_enabled:'false',automation_paused:'true',max_daily_posts:'2'};
 const reviewed={
   review_status:'approved',
   qualityChecks:[{id:'fact',passed:true,blocking:true}]
 };
 const db={
   getSetting:async key=>settings[key],
   getProductionBundle:async()=>reviewed,
   getRow:async()=>({count:0})
 };
 const agent=new PublishingSchedulingAgent(db,{});
 agent.publishQueue=[
   {productionId:'prod_test_1',status:'scheduled',title:'Approved video 1',publishTime:new Date(Date.now()-60000).toISOString()},
   {productionId:'prod_test_2',status:'scheduled',title:'Approved video 2',publishTime:new Date(Date.now()-60000).toISOString()},
   {productionId:'prod_test_3',status:'scheduled',title:'Approved video 3',publishTime:new Date(Date.now()-60000).toISOString()}
 ];
 let published=0;
 agent.publishContent=async()=>{published++;return {status:'published'}};
 assert.equal(await agent.processPublishQueue(),0);
 assert.equal(published,0);
 settings.auto_publish_enabled='true';
 assert.equal(await agent.processPublishQueue(),0);
 assert.equal(published,0);
 settings.automation_paused='false';
 reviewed.review_status='needs_attention';
 assert.equal(await agent.processPublishQueue(),0);
 assert.equal(published,0);
 reviewed.review_status='approved';
 reviewed.qualityChecks=[{id:'facts',blocking:true,passed:false}];
 assert.equal(await agent.processPublishQueue(),0);
 reviewed.qualityChecks=[{id:'facts',blocking:true,passed:true}];
 assert.equal(await agent.processPublishQueue(),2);
 assert.equal(published,2);
 console.log('PUBLISH_QUEUE_SAFETY_PASS (pause, autopublish switch, review, quality, 2/day cap)');
}
async function testAutonomousStorage(){
 const diskFs=require('node:fs/promises');
 const savedStat=diskFs.statfs;
 const testDir=await diskFs.mkdtemp(require('node:path').join(require('node:os').tmpdir(),'agenttube-fingerprints-'));
 const media={};
 for(const key of ['video','audio','thumbnail']){media[key]=require('node:path').join(testDir,key);await diskFs.writeFile(media[key],'Original approved test bytes');}
 const savedTarget=process.env.DAILY_GENERATION_TARGET;
 process.env.DAILY_GENERATION_TARGET='2';
 const bundle={review_status:'approved',provenance:{status:'verified',claims:[{status:'supported'}]},
  editorData:{autonomousApproval:{version:2},factChecked:true,rightsConfirmed:true},qualityChecks:[],
  assets:{finalVideo:{path:media.video},audio:{path:media.audio},thumbnail:{path:media.thumbnail}}};
 Object.assign(bundle.editorData.autonomousApproval,await require('../../utils/autonomous-editorial-audit').approvalFingerprints(bundle));
 let readiness = null;
 const agent=new PublishingSchedulingAgent({getProductionBundle:async()=>bundle,getLatestReadinessRun:async()=>readiness},{});
 let inserts=0;
 agent.uploadToYouTube=async()=>{inserts++;};
 try{
  diskFs.statfs=async()=>({bavail:10,bsize:1024**3});
  await assert.rejects(agent.publishContent('storage-test'),error=>error.status===409);
  assert.equal(inserts,0,'Missing readiness must prevent any YouTube insert');
  readiness={status:'passed',completed_at:new Date(Date.now()-25*60*60*1000).toISOString(),checks:['text_provider','video_provider','voice_narration','video_assembly','youtube_access','upload_metadata','disk_capacity'].map(id=>({id,status:'passed',blocking:true}))};
  await assert.rejects(agent.publishContent('storage-test'),error=>error.status===409);
  assert.equal(inserts,0,'Stale readiness must prevent any YouTube insert');
  readiness.completed_at=new Date().toISOString();
  await assert.rejects(agent.publishContent('storage-test'),error=>error.code==='AUTONOMOUS_STORAGE_BLOCKED');
  assert.equal(inserts,0,'Low storage must prevent any YouTube insert');
  bundle.seo={title:'Changed after approval'};
  await assert.rejects(agent.publishContent('storage-test'),error=>error.code==='AUTONOMOUS_AUDIT_BLOCKED');
  delete bundle.seo;await diskFs.writeFile(media.video,'Replaced video after approval');
  await assert.rejects(agent.publishContent('storage-test'),error=>error.code==='AUTONOMOUS_AUDIT_BLOCKED');
  assert.equal(inserts,0,'Changed text or media must prevent any YouTube insert');
  await diskFs.writeFile(media.video,'Original approved test bytes');
  diskFs.statfs=async()=>({bavail:30,bsize:1024**3});
  const Audit=require('../../utils/autonomous-editorial-audit').AutonomousEditorialAudit;
  const originalMediaAudit=Audit.prototype.verifyMediaRights;
  try {
    Audit.prototype.verifyMediaRights=async()=>({passed:true});
    const entry={status:'scheduled',publishTime:new Date(Date.now()-60000).toISOString(),metadata:{seo:{title:'Changed queued title'},video:bundle.assets.finalVideo,audio:bundle.assets.audio,thumbnail:bundle.assets.thumbnail,privacyStatus:'public'}};
    agent.db.getLatestScheduleEntry=async()=>entry;
    await assert.rejects(agent.publishContent('storage-test'),error=>error.code==='AUTONOMOUS_AUDIT_BLOCKED');
    assert.equal(inserts,0,'Tampered queued content must prevent any YouTube insert');
  } finally { Audit.prototype.verifyMediaRights=originalMediaAudit; }
 }finally{
  diskFs.statfs=savedStat;
  await diskFs.rm(testDir,{recursive:true,force:true});
  if(savedTarget===undefined)delete process.env.DAILY_GENERATION_TARGET;
  else process.env.DAILY_GENERATION_TARGET=savedTarget;
 }
 console.log('AUTONOMOUS_STORAGE_GATE_PASS (missing/stale readiness and 10 GiB block uploads for 2/day)');
}
async function testCaptionLocale(){
 const fs=require('node:fs/promises');
 const dir=await fs.mkdtemp(require('node:path').join(require('node:os').tmpdir(),'agenttube-caption-locale-'));
 const file=require('node:path').join(dir,'sample.srt');
 await fs.writeFile(file,'1\n00:00:00,000 --> 00:00:02,000\nNarração em português.\n');
 const agent=new PublishingSchedulingAgent({},{});
 let uploaded;
 agent.youtube={captions:{insert:async value=>{uploaded=value;}}};
 try{
  await agent.uploadCaptions('fake_test_video',file,'pt-BR');
  assert.equal(uploaded.requestBody.snippet.language,'pt-BR');
  assert.equal(uploaded.requestBody.snippet.name,'Legendas em português');
 }finally{await fs.rm(dir,{recursive:true,force:true});}
 console.log('PORTUGUESE_CAPTIONS_METADATA_PASS');
}
async function testScheduler(){
 const previous=process.env.DAILY_GENERATION_TARGET;
 process.env.DAILY_GENERATION_TARGET='2';
 let paused='true', probes=0;
 const db={getSetting:async k=>k==='channel_timezone'?'America/Sao_Paulo':paused,executeQuery:async()=>{}};
 const scheduler=new DailyAutomation({},db,{refreshReadiness:async()=>{probes++;return {status:'passed',summary:{failed:0}};}});
 try{
  await scheduler.setupScheduledTasks();
  assert(scheduler.scheduledTasks.has('second-daily-content-generation'));
  assert.equal(scheduler.isEnabled,false);
  assert.equal(scheduler.dailyGenerationTarget,2);
  assert.equal(scheduler.channelTimezone,'America/Sao_Paulo');
  const publishing=new PublishingSchedulingAgent({},{});
  publishing.getChannelAnalytics=async()=>{throw new Error('Fixed publication times must not be optimized');};
  await publishing.optimizePublishTimes();
  assert(scheduler.scheduledTasks.has('production-readiness-refresh'));
  await scheduler.refreshProductionReadiness();assert.equal(probes,0);
  scheduler.isEnabled=true;await scheduler.refreshProductionReadiness();assert.equal(probes,0);
  paused='false';await scheduler.refreshProductionReadiness();assert.equal(probes,1);
  paused='true';await scheduler.refreshProductionReadiness();assert.equal(probes,1);
 }finally{
  await scheduler.stopAutomation();
  if(previous===undefined)delete process.env.DAILY_GENERATION_TARGET;
  else process.env.DAILY_GENERATION_TARGET=previous;
 }
 console.log('TWICE_DAILY_SCHEDULER_PASS (two slots, timezone, starts paused)');
}
(async()=>{await testSecurity();await testAutomaticPublishing();await testAutonomousStorage();await testCaptionLocale();await testScheduler();})()
 .catch(e=>{console.error('DEPLOYMENT_TEST_FAILED',e.message);process.exitCode=2});
