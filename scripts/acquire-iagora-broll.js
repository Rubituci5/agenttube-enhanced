'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {PixabayVideoService}=require('../utils/pixabay-video-service');
const ID='prod_1791776974066_fxfxwh7olvf_f4cfkmbgwvp';
const ROOT=path.resolve(__dirname,'..');
const dest=path.join(ROOT,'data','stock','pixabay','manifests',ID+'_broll.json');
const queries=[
  ['nuclear power plant','nuclear power plant'],
  ['scientist laboratory','laboratory scientist'],
  ['dna molecule','dna animation'],
  ['atomic particles','radiation science'],
  ['medical laboratory','medical microscope'],
  ['hospital doctor','hospital research'],
  ['nuclear explosion','nuclear explosion'],
  ['space universe','science technology'],
  ['film camera','filmmaking camera']
];
async function main(){
  const pix=new PixabayVideoService();
  if(!await pix.configured())throw Error('Pixabay chave ausente');
  const result=await fs.readFile(dest,'utf8').then(JSON.parse).catch(()=>({clips:[]}));
  const used=new Set((result.clips||[]).map(v=>v.id));
  for(const [label,query] of queries){
    if(result.clips.some(x=>x.label===label)){console.log('REUSE',label);continue}
    try{
      const hits=pix.rank(await pix.search(query,{lang:'en'}),query,used);
      let selected;
      for(const candidate of hits.slice(0,4)){
        try{
          const clip=await pix.download(candidate);
          selected={...clip,label,query};
          used.add(clip.id);
          break;
        }catch(error){console.log('CANDIDATE_SKIPPED',label,String(error.message).slice(0,110))}
      }
      if(selected){
        result.clips.push(selected);
        console.log('CLIP_READY',label,selected.id,selected.duration,selected.path);
      }else console.log('CLIP_NOT_FOUND',label);
      await fs.mkdir(path.dirname(dest),{recursive:true});
      await fs.writeFile(dest,JSON.stringify({savedAt:new Date().toISOString(),provider:'Pixabay',
        license:'https://pixabay.com/service/license-summary/',clips:result.clips},null,2));
    }catch(error){console.log('SEARCH_FAILED',label,String(error.message).slice(0,160))}
  }
  console.log('BRoll_DOWNLOAD_DONE',result.clips.length,'real video clips');
}
main().catch(e=>{console.error('BROLL_FAILURE',e.message);process.exitCode=1});
