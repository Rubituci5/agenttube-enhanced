'use strict';
// Test/recovery entry point for the SAME automatic music engine used by the
// main AgentTube production and scene-rebuild pipelines.
// Usage: node scripts/auto-score-production.js <productionId>
const fs=require('node:fs/promises');
const {Database}=require('../database/db');
const {AutomaticMusicService}=require('../utils/automatic-music-service');
const {OperatorService}=require('../utils/operator-service');
const ID=process.argv[2];
if(!/^prod_[A-Za-z0-9_-]{8,90}$/.test(String(ID||''))){
  console.error('Usage: node scripts/auto-score-production.js prod_<id>');
  process.exit(2);
}
async function main(){
 const db=new Database();await db.initialize();
 try{
   if(await db.getSetting('automation_paused')!=='true'||
      await db.getSetting('auto_publish_enabled')!=='false'){
     throw new Error('Automação deve estar pausada e publicação automática desligada para reparo.');
   }
   const bundle=await db.getProductionBundle(ID);
   if(!bundle||bundle.schedule||bundle.review_status==='approved')
     throw new Error('Produção não está disponível para revisão.');
   const final=bundle.assets?.finalVideo;
   if(!final?.path||final.simulated)throw new Error('Vídeo real ainda não está disponível.');
   if(bundle.assets?.music?.status==='ready'&&
      await fs.stat(final.path).then(st=>st.size>20000).catch(()=>false)){
     console.log('AUTOMATIC_MUSIC_ALREADY_PRESENT',bundle.assets.music.title);
     return;
   }
   if(!AutomaticMusicService.enabled())throw new Error('Trilha automática não está habilitada para este canal.');
   const service=new AutomaticMusicService();
   const generated=await service.addToVideo(final.path,{
     script:bundle.script,strategy:bundle.strategy,allowDownload:false
   });
   const assets={...bundle.assets,
     music:{...generated.music,sourceVideoPath:final.path},
     finalVideo:{...final,path:generated.outputPath,
       previousPath:final.path,fileSize:(await fs.stat(generated.outputPath)).size,
       duration:generated.music.durationSeconds}
   };
   await db.updateProductionData({
     id:ID,status:bundle.status||'ready',
     assets,timeline:{...bundle.timeline,musicGenerated:new Date().toISOString()},
     scheduledPublishTime:bundle.scheduled_publish_time,priority:bundle.priority
   });
   const latest=await db.getProductionBundle(ID);
   const quality=await new OperatorService(db).runQualityChecks({
      ...latest,scheduledPublishTime:latest.scheduled_publish_time
   },await db.getChannelProfile()||{});
   await db.saveContentReview(ID,{
      status:'needs_attention',
      editorData:{...latest.editorData,rightsConfirmed:false},
      qualityChecks:quality.checks,
      reviewNotes:(String(bundle.review_notes||'').slice(0,700)+'\nTrilha automática CC0 adicionada por gênero, com redução de volume durante a voz. Revisão factual e editorial ainda obrigatória.').trim(),
      reviewedAt:null
   });
   console.log('AUTOMATIC_MUSIC_COMPLETE',JSON.stringify({
      output:generated.outputPath,selectedBySystem:generated.music.title,
      category:generated.music.genre,license:generated.music.license,
      voiceDucking:generated.music.voiceDucking,seconds:generated.music.durationSeconds,
      blockingFailures:quality.blockingFailures
   }));
 }finally{await db.close()}
}
main().catch(e=>{console.error('AUTOMATIC_MUSIC_FAILED:',String(e.message||e).slice(0,380));process.exitCode=1});
