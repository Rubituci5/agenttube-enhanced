'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {promisify}=require('node:util');
const {execFile}=require('node:child_process');
const {getFFmpegPath}=require('../utils/ffmpeg');
const exec=promisify(execFile),ROOT=path.resolve(__dirname,'..');
const ID='prod_1791776974066_fxfxwh7olvf_f4cfkmbgwvp';
async function valid(p){try{return (await fs.stat(p)).size>1024}catch(_){return false}}
(async()=>{
 const meta=JSON.parse(await fs.readFile(path.join(ROOT,'data','stock','pixabay','manifests',ID+'_broll.json')));
 const output=path.join(ROOT,'data','videos','iagora-motion-draft',ID);
 await fs.mkdir(output,{recursive:true});
 for(let i=0;i<meta.clips.length;i++){
   const item=meta.clips[i],file=path.join(output,'clip'+String(i).padStart(2,'0')+'.mp4');
   if(await valid(file)){console.log('NORMALIZED_CACHED',i,item.id);continue}
   await exec(getFFmpegPath(),[
     '-hide_banner','-loglevel','error','-y','-stream_loop','-1','-i',item.path,
     '-t','8','-an','-vf','scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1,fps=15,format=yuv420p',
     '-c:v','libx264','-preset','veryfast','-crf','26','-r','15','-pix_fmt','yuv420p','-video_track_timescale','15360',file
   ],{timeout:150000,maxBuffer:2048*1024});
   console.log('NORMALIZED_READY',i+1,meta.clips.length,item.id);
 }
 console.log('BROLL_VIDEO_PARTS_READY',meta.clips.length);
})().catch(e=>{console.error('BROLL_PREP_FAILED',String(e.message).slice(0,300));process.exitCode=1});
