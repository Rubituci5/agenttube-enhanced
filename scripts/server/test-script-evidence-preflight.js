'use strict';
const assert=require('node:assert/strict');
const {YouTubeAutomationAgent}=require('../../index');
const {AutonomousEditorialAudit}=require('../../utils/autonomous-editorial-audit');
(async()=>{
 const original=AutonomousEditorialAudit.prototype.verifyFacts;
 const prior=process.env.AUTONOMOUS_APPROVAL_ENABLED;
 process.env.AUTONOMOUS_APPROVAL_ENABLED='true';
 const app=new YouTubeAutomationAgent();
 app.db={getGenerationJob:async()=>({source:'scheduler'})};
 app.credentials={};
 let written=0,checked=0,received=[];
 app.agents={scriptWriter:{generateScript:async strategy=>{written++;received.push(strategy);return {title:'Primary facts',fullScript:'Primary facts only.',claims:[{text:'A primary fact',riskLevel:'standard',sourceUrls:['https://science.nasa.gov/mission/webb/']}],metadata:{strategy}};}}};
 const strategy={researchSources:[{url:'https://science.nasa.gov/mission/webb/',publisher:'NASA',sourceType:'official'}]};
 try{
  AutonomousEditorialAudit.prototype.verifyFacts=async()=>{checked++;return checked===1?{passed:false,reason:'Unsupported analogy',uncheckedStatements:['Unsupported premise']}:{passed:true,claimCount:1,sourceCount:1};};
  const result=await app.generateEvidenceCheckedScript(strategy,'preflight');
  assert.equal(written,2);assert.equal(checked,2);
  assert.deepEqual(received[1].editorialCorrection.uncheckedStatements,['Unsupported premise']);
  assert.equal(result.metadata.editorialPreflight.attempts,2);
  written=0;checked=0;
  AutonomousEditorialAudit.prototype.verifyFacts=async()=>{checked++;return {passed:false,reason:'Still unsupported'};};
  await assert.rejects(app.generateEvidenceCheckedScript(strategy,'preflight'),e=>e.code==='EDITORIAL_PREFLIGHT');
  assert.equal(written,3);assert.equal(checked,3,'Only three audited drafts; media must not start');
  app.db.getGenerationJob=async()=>({source:'manual'});written=0;checked=0;
  await app.generateEvidenceCheckedScript(strategy,'manual');assert.equal(written,1);assert.equal(checked,0);
  app.db.getGenerationJob=async()=>({source:'scheduler'});
  let packaged=0, inspected=0, correction;
  app.agents.thumbnailDesigner={generateThumbnail:async draft=>{packaged++;correction=draft.metadata.packagingCorrection;return {concept:{primaryText:'DOCUMENTED DESTINATION'}};}};
  app.agents.seoOptimizer={optimize:async()=>({title:'Documented destination',description:'Literal source facts'})};
  AutonomousEditorialAudit.prototype.verifyFacts=async(_id,bundle)=>{inspected++;return bundle.seo.title==='Unsafe current location'?{passed:false,reason:'Destination is not current location',uncheckedStatements:['Unsafe current location']}:{passed:true};};
  const packaging=await app.ensureEvidenceCheckedPackaging(result,strategy,{concept:{primaryText:'Unsafe current location'}},{title:'Unsafe current location'},'preflight');
  assert.equal(packaged,1);assert.equal(inspected,2);
  assert.equal(packaging.seo.title,'Documented destination');
  assert.deepEqual(correction.uncheckedStatements,['Unsafe current location']);
  inspected=0;
  AutonomousEditorialAudit.prototype.verifyFacts=async()=>{inspected++;return {passed:false,reason:'Unverified metadata'};};
  await assert.rejects(app.ensureEvidenceCheckedPackaging(result,strategy,{}, {},'preflight'),e=>e.code==='EDITORIAL_PACKAGING_PREFLIGHT');
  assert.equal(inspected,3,'Metadata that cannot pass must block before rendering');
  console.log('PUBLISHED_COPY_PREFLIGHT_PASS (audits actual cover and SEO, correction feedback, bounded retry)');
  console.log('SCRIPT_EVIDENCE_PREFLIGHT_PASS (rewrite feedback, three-attempt cap, manual flow preserved)');
 }finally{
  AutonomousEditorialAudit.prototype.verifyFacts=original;
  if(prior===undefined)delete process.env.AUTONOMOUS_APPROVAL_ENABLED;else process.env.AUTONOMOUS_APPROVAL_ENABLED=prior;
 }
})().catch(e=>{console.error('PREFLIGHT_TEST_FAILED',e.message);process.exitCode=2});
