'use strict';
/* IAgora cinematic draft: predownloaded licensed stock videos + local
 * neural pt-BR narration + burnt-in pt-BR captions.
 * No paid API requests and absolutely no YouTube publication.
 */
const fs=require('node:fs/promises');
const path=require('node:path');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const {Database}=require('../database/db');
const {SceneRepairService}=require('../utils/scene-repair-service');
const {AIVideoGenerator}=require('../utils/ai-video-generator');
const {getFFmpegPath,getMediaDuration}=require('../utils/ffmpeg');
const {OperatorService}=require('../utils/operator-service');

const exec=promisify(execFile);
const ROOT=path.resolve(__dirname,'..');
const ID='prod_1791776974066_fxfxwh7olvf_f4cfkmbgwvp';
const FFMPEG=getFFmpegPath();
const EDIT=path.join(ROOT,'data','videos','iagora-motion-draft',ID);
const manifest=path.join(ROOT,'data','stock','pixabay','manifests',ID+'_broll.json');
const NARRATION=path.join(ROOT,'data','audio','scenes',ID);
const WIDTH=1280, HEIGHT=720, FPS=15;
const TMP=path.join(EDIT,'playlist.ffconcat');
const VIDEO_TMP=path.join(EDIT,'visual.mp4');
const SRT=path.join(EDIT,'legendas-ptbr.srt');
const RESULT=path.join(ROOT,'data','videos',ID+'_motion_subtitles_ptbr.mp4');
const STAGING=RESULT.replace(/\.mp4$/,'.staging.mp4');

async function readable(file){
  try{const st=await fs.stat(file);return st.size>1024&&st.isFile()}catch(_){return false}
}
async function ff(args,{silent=true}={}){
  const result=await exec(FFMPEG,args,{timeout:480000,maxBuffer:3*1024*1024});
  if(!silent&&result.stderr)console.log(result.stderr.slice(-300));
  return result;
}
async function normalize(asset,index,isImage=false){
  const dest=path.join(EDIT,(isImage?'still':'clip')+String(index).padStart(2,'0')+'.mp4');
  if(await readable(dest))return dest;
  const duration=isImage?5:8;
  const filters=`scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},setsar=1,fps=${FPS},format=yuv420p`;
  const args=['-hide_banner','-loglevel','error','-y'];
  if(isImage)args.push('-loop','1','-framerate',String(FPS),'-i',asset);
  else args.push('-stream_loop','-1','-i',asset);
  args.push('-t',String(duration),'-an','-vf',filters,
    '-c:v','libx264','-preset','veryfast','-crf','26','-r',String(FPS),
    '-pix_fmt','yuv420p','-video_track_timescale','15360',dest);
  await ff(args);
  console.log('BROLL_NORMALIZED',isImage?'still':'video',index);
  return dest;
}
async function trimClip(file,duration,index){
  const safe=Math.max(1/FPS,Math.round(duration*FPS)/FPS);
  if(safe>=7.99||safe>=4.99&&file.includes('still'))return file;
  const dest=path.join(EDIT,'tail_'+String(index).padStart(3,'0')+'_'+Math.round(safe*FPS)+'.mp4');
  if(await readable(dest))return dest;
  await ff(['-hide_banner','-loglevel','error','-y','-i',file,
    '-t',safe.toFixed(3),'-an','-c:v','libx264','-preset','veryfast',
    '-crf','26','-r',String(FPS),'-pix_fmt','yuv420p',dest]);
  return dest;
}
async function main(){
  const db=new Database();await db.initialize();
  try{
    const bundle=await db.getProductionBundle(ID);
    if(!bundle||bundle.schedule||bundle.review_status==='approved')
      throw Error('Rascunho indisponível ou bloqueado para alteração.');
    if(await db.getSetting('automation_paused')!=='true'||await db.getSetting('auto_publish_enabled')!=='false')
      throw Error('Automação deve estar pausada e publicação automática desligada.');
    const videos=JSON.parse(await fs.readFile(manifest,'utf8')).clips||[];
    if(videos.length<5)throw Error('Baixe os vídeos reais antes de reconstruir.');
    // Curate each chapter to relevant footage, never random adjacent clips.
    const sceneMatches = [
      ['nuclear explosion','nuclear power plant','film camera'],
      ['film camera','nuclear power plant','scientist laboratory'],
      ['nuclear explosion','nuclear power plant','scientist laboratory'],
      ['microscope cells','genetics research','medical laboratory'],
      ['genetics research','microscope cells','dna molecule'],
      ['hospital doctor','medical laboratory','microscope cells'],
      ['scientist laboratory','hospital doctor','atomic particles'],
      ['scientist laboratory','space universe','microscope cells'],
      ['film camera','space universe','scientist laboratory']
    ];
    const clipIndexByLabel=new Map(videos.map((v,index)=>[v.label,index]));
    const sceneClipChoices=sceneMatches.map(labels=>labels.map(label=>clipIndexByLabel.get(label))
      .filter(i=>Number.isInteger(i)));
    const sceneList=await db.listProductionScenes(ID);
    if(sceneList.length!==9)throw Error('Esperadas nove cenas.');
    const voiceManifest=JSON.parse(await fs.readFile(path.join(NARRATION,'kokoro_manifest.json'),'utf8'));
    if(voiceManifest.sources?.length!==9)throw Error('Narrador neural ainda não concluiu nove cenas.');
    await fs.mkdir(EDIT,{recursive:true});
    for(const v of videos){
      if(!await readable(v.path)||!v.license)throw Error('Clipe sem licença/arquivo válido: '+v.id);
    }
    let scenes=[];
    for(let i=0;i<sceneList.length;i++){
      const s=sceneList[i];
      const voice=voiceManifest.sources.find(x=>x.sceneId===s.id);
      if(!voice||!await readable(voice.path))throw Error('Sem narração para cena '+(i+1));
      const duration=await getMediaDuration(voice.path);
      const newDuration=Math.round((duration+.4)*100)/100;
      if(s.narrationProvider!=='kokoro-local'||s.audioPath!==voice.path||
         s.narrationStatus!=='current'||Math.abs(Number(s.duration||0)-newDuration)>.06){
        const next=await db.updateProductionScene(ID,s.id,{
          audioPath:voice.path,narrationStatus:'current',
          narrationProvider:'kokoro-local',narrationModel:voiceManifest.voice,
          narrationTaskId:null,narrationError:null,narrationGeneratedAt:new Date().toISOString(),
          narrationCost:{provider:'kokoro-local',billed:false,invoiceRequired:false},
          duration:newDuration,status:'needs_rebuild',revision:s.revision+1
        });
        await db.saveProductionSceneRevision({
          productionId:ID,sceneId:s.id,action:'local_neural_tts',
          before:{audioPath:s.audioPath,provider:s.narrationProvider},
          after:{audioPath:voice.path,provider:'kokoro-local',duration:newDuration},
          costEvidence:{billed:false}
        });
        scenes.push(next);
      }else scenes.push(s);
    }
    // A clip remains the primary scene asset; still images are secondary B-roll.
    for(let i=0;i<scenes.length;i++){
      const s=scenes[i],stock=videos[sceneClipChoices[i]?.[0] ?? (i%videos.length)];
      const next=await db.updateProductionScene(ID,s.id,{
        assetType:'video',assetOrigin:'pixabay-stock',
        assetPath:stock.path,provider:'Pixabay',model:null,
        externalTaskId:null,containsSyntheticMedia:false,
        rightsConfirmed:true,status:'needs_rebuild',
        revision:s.revision+1
      });
      scenes[i]=next;
    }
    const normalizedClips=[];
    for(let i=0;i<videos.length;i++) normalizedClips.push(await normalize(videos[i].path,i));
    const stills=[];
    for(let i=0;i<sceneList.length;i++){
      const fallback=path.join(ROOT,'data','scene-assets',ID);
      const all=await fs.readdir(fallback);
      const file=all.find(s=>s.startsWith(sceneList[i].id+'_')&&s.endsWith('.jpg'));
      const source=file?path.join(fallback,file):null;
      stills.push(source&&await readable(source)?await normalize(source,i,true):null);
    }
    console.log('ALL_NORMALIZED',normalizedClips.length,'stock videos',stills.filter(Boolean).length,'supporting stills');
    const playlist=['ffconcat version 1.0'];
    let itemCount=0,total=0;
    for(let i=0;i<scenes.length;i++){
      const scene=scenes[i];
      let remaining=Math.round(Number(scene.duration)*FPS)/FPS;
      let step=0;
      while(remaining>.025){
        const useStill=step%5===4&&!!stills[i];
        const choices=sceneClipChoices[i].length?sceneClipChoices[i]:[i%videos.length];
        const file=useStill?stills[i]:normalizedClips[choices[step%choices.length]];
        const max=useStill?5:8;
        const length=Math.min(max,remaining);
        const selected=length<max-.08?await trimClip(file,length,itemCount):file;
        playlist.push("file '"+selected.replaceAll("'","'\\''")+"'");
        itemCount++;
        total+=length;
        remaining-=length;
        step++;
        if(step>120)throw Error('Erro no cálculo da duração das cenas.');
      }
    }
    const currentPlaylist=playlist.join('\n')+'\n';
    const previousPlaylist=await fs.readFile(TMP,'utf8').catch(()=>null);
    await fs.writeFile(TMP,currentPlaylist,'utf8');
    console.log('BROLL_PLAYLIST',itemCount,'cuts',Math.round(total),'seconds');
    // Keep the existing preview intact. Rebuild cached visuals only if the edit list changed.
    if (previousPlaylist !== currentPlaylist) {
      await fs.rm(VIDEO_TMP,{force:true});
      console.log('VISUAL_TIMELINE_CHANGED_REBUILDING');
    }
    if(!await readable(VIDEO_TMP)){
      await ff(['-hide_banner','-loglevel','error','-y',
        '-safe','0','-f','concat','-i',TMP,
        '-c:v','copy','-t',total.toFixed(2),VIDEO_TMP],{silent:false});
    }
    const repair=new SceneRepairService(db,new AIVideoGenerator({}, {db}));
    const updated=await db.listProductionScenes(ID);
    const audioPath=await repair.rebuildNarration(ID,updated,null,Date.now());
    await fs.writeFile(SRT,repair.buildSRT(updated),'utf8');
    console.log('MONTAGE_AUDIO_SUBS_READY',Math.round(await getMediaDuration(audioPath)));
    const safePath=SRT.replaceAll('\\','/').replaceAll("'",'\\\'');
    // Burn captions into picture so captions work in the native HTML player,
    // mobile clients and exported MP4 without a sidecar file.
    const captionsFilter="subtitles='"+safePath+"':force_style='FontName=Arial,FontSize=17,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H99000000,BorderStyle=1,Outline=2,Shadow=1,MarginV=45,Alignment=2'";
    await ff(['-hide_banner','-loglevel','error','-y',
      '-i',VIDEO_TMP,'-i',audioPath,
      '-map','0:v:0','-map','1:a:0',
      '-vf',captionsFilter,
      '-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p',
      '-c:a','aac','-b:a','128k',
      '-shortest','-movflags','+faststart',STAGING]);
    if(!await readable(STAGING))throw Error('Arquivo MP4 novo não encontrado.');
    const videoLength=await getMediaDuration(STAGING);
    if(videoLength<180)throw Error('Vídeo final está curto demais.');
    // Atomic switch after FFmpeg completes, never expose an incomplete MP4 to the player.
    await fs.rename(STAGING, RESULT);
    const current=await db.getProductionBundle(ID);
    const previous=current.assets.finalVideo.path;
    const finalAssets={
      ...current.assets,
      audio:{...current.assets.audio,path:audioPath,
        status:'ready',simulated:false,provider:'kokoro-local',model:'pm_alex',
        sceneMixed:true,generatedAt:new Date().toISOString(),
        cost:{billed:false,provider:'kokoro-local'}},
      finalVideo:{...current.assets.finalVideo,path:RESULT,previousPath:previous,
        simulated:false,fileSize:(await fs.stat(RESULT)).size,
        duration:videoLength,provider:{actualProvider:'pixabay-motion-edit',model:'FFmpeg-burned-subtitles',scenes:scenes.length}},
      video:{...(current.assets.video||{}),stockVideoClips:videos.length,
        sourceVideos:videos.map(v=>({id:v.id,url:v.url,author:v.author,license:v.license})),
        motionComposition:'Pixabay B-roll + stills'},
      captions:{path:SRT,format:'srt',language:'pt-BR',burnedIn:true,sceneAware:true},
      previewVersion:'motion-kokoro-ptbr-v2'
    };
    await db.updateProductionData({
      id:ID,status:'ready',assets:finalAssets,timeline:{...current.timeline,
        captionBurnedAt:new Date().toISOString(),sceneRepairAt:new Date().toISOString()},
      scheduledPublishTime:current.scheduled_publish_time,priority:current.priority
    });
    for(const s of scenes)await db.updateProductionScene(ID,s.id,{status:'ready'});
    const final=await db.getProductionBundle(ID);
    const quality=await new OperatorService(db).runQualityChecks({
      ...final,scheduledPublishTime:final.scheduled_publish_time
    },await db.getChannelProfile()||{});
    await db.saveContentReview(ID,{
      status:'needs_attention',
      editorData:{...final.editorData,rightsConfirmed:false,factChecked:false},
      qualityChecks:quality.checks,
      reviewedAt:null,
      reviewNotes:'Nova montagem com clipes Pixabay reais, voz neural Kokoro local e legendas gravadas no MP4. REVISÃO HUMANA OBRIGATÓRIA: conteúdo científico, identidade visual e direitos.'
    });
    console.log('NEW_MOTION_VIDEO_READY',RESULT,
      Math.round(videoLength),'seconds',videos.length,'licensed clips',
      'remainingQualityAlerts',quality.blockingFailures.length);
  }finally{await db.close()}
}
main().catch(e=>{console.error('MOTION_RENDER_FAILED',String(e.message||e).slice(0,700));process.exitCode=1});
