'use strict';
/**
 * One-off, resumable local IAgora draft repair.
 * Does NOT call ElevenLabs, Gemini, OpenAI paid media, or publish to YouTube.
 * Uses existing authorized Pixabay stock API and macOS say (pt-BR).
 *
 * Run: node scripts/build-iagora-godzilla-local-draft.js
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const sharp = require('sharp');
const { Database } = require('../database/db');
const { FreeThumbnailService, scoreHit } = require('../utils/free-thumbnail-service');
const { SceneRepairService } = require('../utils/scene-repair-service');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { getFFmpegPath, getMediaDuration } = require('../utils/ffmpeg');
const { OperatorService } = require('../utils/operator-service');

const exec = promisify(execFile);
const ID = 'prod_1791776974066_fxfxwh7olvf_f4cfkmbgwvp';
const ROOT = path.resolve(__dirname, '..');
const SCENE_FOLDER = path.join(ROOT, 'data', 'scene-assets', ID);
const TTS_FOLDER = path.join(ROOT, 'data', 'audio', 'scenes', ID);
const VOICE = 'Luciana';
const SEARCHES = [
  ['dinosaur prehistoric', 'nuclear explosion'],
  ['nuclear power plant', 'laboratory research'],
  ['nuclear reactor', 'radiation danger'],
  ['dna double helix', 'human cells microscope'],
  ['dna genetics microscope', 'medical research lab'],
  ['radiation therapy hospital', 'medical laboratory'],
  ['doctor hospital science', 'laboratory scientist'],
  ['scientist research laboratory', 'science technology'],
  ['science space technology', 'science future']
];

async function exists(file) {
  try { const st = await fs.stat(file); return st.isFile() && st.size > 1024; }
  catch (_) { return false; }
}

async function pickPixabayImage(service, queries, used) {
  for (const q of queries) {
    let hits = [];
    try { hits = await service.search(q); }
    catch (_) { continue; }
    hits.sort((a,b) => scoreHit(b,q) - scoreHit(a,q));
    for (const hit of hits) {
      if (used.has(hit.id) || !hit.largeImageURL && !hit.webformatURL) continue;
      try {
        const asset = await service.download(hit);
        used.add(hit.id);
        return { ...asset, query: q };
      } catch (_) { /* try another Pixabay image */ }
    }
  }
  return null;
}

async function createSceneImage(service, scene, index, used, repair, db) {
  const current = (await db.getProductionScene(ID, scene.id));
  if (current.assetType === 'image' &&
      current.assetPath && !current.assetPath.endsWith('.info') &&
      await exists(current.assetPath)) {
    console.log('VISUAL_REUSE', index+1, current.label);
    return null;
  }
  const chosen = await pickPixabayImage(service, SEARCHES[index] || ['science laboratory'], used);
  if (!chosen) throw new Error('Pixabay não encontrou foto adequada para a cena '+(index+1));
  const jpeg = await sharp(chosen.path,{limitInputPixels:50e6})
    .rotate().resize(1280,720,{fit:'cover',position:'attention'})
    .modulate({brightness:0.98,saturation:1.08})
    .jpeg({quality:88}).toBuffer();
  // A locked Hook was a simulated .info placeholder. Temporarily unlock
  // only this unusable asset, then restore the exact previous locked state.
  if(current.locked)await db.updateProductionScene(ID,scene.id,{locked:false});
  let output;
  try{
    output=await repair.replaceAsset(ID,scene.id,{
      buffer:jpeg,contentType:'image/jpeg',
      filename:'pixabay_'+chosen.id+'.jpg',
      rightsConfirmed:true,containsSyntheticMedia:false
    });
  }finally{
    if(current.locked)await db.updateProductionScene(ID,scene.id,{locked:true});
  }
  await db.saveProductionSceneRevision({
    productionId:ID,sceneId:scene.id,action:'pixabay_stock_scene',
    before:{assetPath:scene.assetPath},
    after:{assetPath:output.assetPath,pixabayId:chosen.id,
      sourceUrl:chosen.url,author:chosen.author,license:chosen.license},
    costEvidence:{billed:false}
  });
  console.log('VISUAL_READY',index+1,scene.label,'Pixabay ID',chosen.id);
  return {
    sceneId:scene.id,
    pixabayId:chosen.id,
    url:chosen.url,
    author:chosen.author,
    license:chosen.license,
    search:chosen.query
  };
}

async function generateLocalSpeech(scene,index,db) {
  const current=await db.getProductionScene(ID,scene.id);
  if(current.narrationStatus==='current' &&
     current.audioPath && await exists(current.audioPath)) {
    console.log('VOICE_REUSE',index+1,current.label);
    return;
  }
  if(!current.scriptText?.trim())throw new Error('Cena '+(index+1)+' sem texto narrado.');
  const output=path.join(TTS_FOLDER,String(index).padStart(3,'0')+'_mac_preview.mp3');
  const textPath=path.join(TTS_FOLDER,String(index).padStart(3,'0')+'.txt');
  const aiff=path.join(TTS_FOLDER,String(index).padStart(3,'0')+'.aiff');
  await fs.mkdir(TTS_FOLDER,{recursive:true});
  if(!await exists(output)){
    await fs.writeFile(textPath,current.scriptText,'utf8');
    try{
      await exec('say',['-v',VOICE,'-f',textPath,'-o',aiff],{timeout:180000});
      await exec(getFFmpegPath(),['-hide_banner','-loglevel','error','-y',
        '-i',aiff,'-ac','1','-ar','24000','-b:a','80k',output],
        {timeout:120000,maxBuffer:4*1024*1024});
    }finally{
      await fs.rm(textPath,{force:true}).catch(()=>{});
      await fs.rm(aiff,{force:true}).catch(()=>{});
    }
  }
  const length=await getMediaDuration(output);
  if(length<1)throw new Error('Áudio gerado incorretamente para cena '+(index+1));
  await db.updateProductionScene(ID,scene.id,{
    audioPath:output,
    duration:Number((length+0.6).toFixed(2)),
    narrationStatus:'current',
    narrationProvider:'macos-say',
    narrationModel:VOICE,
    narrationTaskId:null,
    narrationError:null,
    narrationGeneratedAt:new Date().toISOString(),
    narrationCost:{provider:'macos-say',billed:false,invoiceRequired:false},
    status:'needs_rebuild',
    revision:current.revision+1
  });
  await db.saveProductionSceneRevision({
    productionId:ID,sceneId:scene.id,action:'local_preview_narration',
    before:{narrationStatus:current.narrationStatus,duration:current.duration},
    after:{audioPath:output,duration:Number((length+0.6).toFixed(2)),
      narrationProvider:'macos-say'},
    costEvidence:{billed:false}
  });
  console.log('VOICE_READY',index+1,scene.label,'seconds',length.toFixed(1));
}

async function run(){
  // Fail closed on accidental paid TTS if implementation changes.
  process.env.ELEVENLABS_TTS_ENABLED='false';
  process.env.LOCAL_MAC_TTS='true';
  const db=new Database();
  await db.initialize();
  try{
    if(await db.getSetting('automation_paused')!=='true')
      throw new Error('Automação precisa estar pausada antes do reparo manual.');
    if(await db.getSetting('auto_publish_enabled')!=='false')
      throw new Error('Publicação automática precisa permanecer desligada.');
    const bundle=await db.getProductionBundle(ID);
    if(!bundle)throw new Error('Produção não encontrada.');
    if(bundle.review_status==='approved'||bundle.schedule)
      throw new Error('Produção já aprovada ou agendada; não alterar.');
    const scenes=await db.listProductionScenes(ID);
    if(scenes.length!==9)throw new Error('Esperadas 9 cenas, encontradas '+scenes.length);
    await fs.mkdir(SCENE_FOLDER,{recursive:true});
    const stock=new FreeThumbnailService();
    const repair=new SceneRepairService(db,new AIVideoGenerator({}, {db}),{logger:console});
    const manifestFile=path.join(SCENE_FOLDER,'pixabay-sources.json');
    const previous=await fs.readFile(manifestFile,'utf8').then(JSON.parse).catch(()=>({sources:[]}));
    const sources=new Map((previous.sources||[]).map(s=>[s.sceneId,s]));
    const used=new Set([...sources.values()].map(s=>s.pixabayId));
    for(let i=0;i<scenes.length;i++){
      const src=await createSceneImage(stock,scenes[i],i,used,repair,db);
      if(src)sources.set(src.sceneId,src);
      await fs.writeFile(manifestFile,JSON.stringify({
        productionId:ID,savedAt:new Date().toISOString(),
        sources:[...sources.values()]},null,2),'utf8');
    }
    console.log('ALL_REAL_VISUALS_READY');
    for(let i=0;i<scenes.length;i++){
      await generateLocalSpeech(scenes[i],i,db);
    }
    console.log('ALL_LOCAL_NARRATION_READY');
    const updated=await db.getProductionBundle(ID);
    await db.updateProductionData({
      id:ID,status:updated.status,
      assets:{...updated.assets,audio:{
        ...updated.assets.audio,
        path:null,status:'partial',simulated:false,
        provider:'macos-say',model:VOICE,
        error:'Aguardando reconstrução da faixa de áudio do vídeo',
        cost:{provider:'macos-say',billed:false,invoiceRequired:false}},
        stockSceneSources:[...sources.values()]},
      timeline:updated.timeline,
      scheduledPublishTime:updated.scheduled_publish_time,priority:updated.priority
    });
    console.log('REBUILDING_720P_DRAFT');
    const rebuilt=await repair.rebuild(ID,{preview:true});
    console.log('REBUILD_DONE',JSON.stringify(rebuilt));
    const final=await db.getProductionBundle(ID);
    const quality=await new OperatorService(db).runQualityChecks({
      ...final,scheduledPublishTime:final.scheduled_publish_time
    },await db.getChannelProfile()||{});
    await db.saveContentReview(ID,{
      status:'needs_attention',
      editorData:{...final.editorData,rightsConfirmed:false,factChecked:false},
      qualityChecks:quality.checks,
      reviewNotes:'Rascunho local de áudio e vídeo (Mac TTS + Pixabay) concluído. Exige revisão de fatos, mídia, cenas e narração antes de aprovar.',
      reviewedAt:null
    });
    console.log('QUALITY_REMAINING',quality.blockingFailures.length);
    console.log('LOCAL_DRAFT_READY_NOT_APPROVED');
  }finally{
    await db.close();
  }
}
run().catch(err=>{
  console.error('LOCAL_DRAFT_FAILED:',String(err.message||err).slice(0,850));
  process.exitCode=1;
});
