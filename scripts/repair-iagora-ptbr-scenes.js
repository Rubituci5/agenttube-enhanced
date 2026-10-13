'use strict';
/* Repair the three template-English narration scenes without rewriting the
 * science chapters. Leaves the project unapproved and automation paused. */
const fs=require('fs/promises');
const path=require('path');
const {Database}=require('../database/db');
const ID='prod_1791776974066_fxfxwh7olvf_f4cfkmbgwvp';
const ROOT=path.resolve(__dirname,'..');
const scenesPath=path.join(ROOT,'temp','processing','godzilla-kokoro-scenes.json');
const backups=path.join(ROOT,'data','scene-assets',ID,'ptbr-revision-backup');
const audioFolder=path.join(ROOT,'data','audio','scenes',ID);
const newText={
  1: 'O filme Godzilla Minus One mostra um monstro gigantesco e um país marcado pela guerra. Mas o perigo invisível que inspira nossa investigação é real: como a radiação pode danificar o DNA? Hoje vamos separar os efeitos comprovados pela ciência das transformações impossíveis que só acontecem na ficção.',
  7: 'No cinema, a radiação pode criar monstros. Na realidade, ela pode alterar moléculas, prejudicar células e aumentar determinados riscos à saúde, dependendo da exposição. Vimos por que o DNA pode ser danificado e reparado, por que uma mutação não cria superpoderes e o que aprendemos com estudos em seres humanos. A pergunta importante não é se uma história parece assustadora, mas quais evidências sustentam suas afirmações.',
  8: 'Se esta investigação ajudou você a entender melhor os efeitos da radiação, deixe seu gostei e compartilhe o vídeo. Inscreva-se no IAgora para descobrir outras histórias em que ciência e cinema se encontram. E me conte nos comentários: qual dúvida você ainda tem sobre radiação e DNA?'
};
async function main(){
  const db=new Database();await db.initialize();
  try{
    if(await db.getSetting('automation_paused')!=='true' ||
       await db.getSetting('auto_publish_enabled')!=='false')throw Error('Requer automação pausada e autopublicação desligada');
    const bundle=await db.getProductionBundle(ID);
    if(!bundle || bundle.review_status==='approved'||bundle.schedule)throw Error('Produção indisponível para ajustes');
    const scenes=await db.listProductionScenes(ID);
    if(scenes.length!==9)throw Error('Esperadas nove cenas');
    await fs.mkdir(backups,{recursive:true});
    const backupPath=path.join(backups,'scene-text-before-ptbr.json');
    const already=await fs.stat(backupPath).then(()=>true).catch(()=>false);
    if(!already)await fs.writeFile(backupPath,JSON.stringify({
      capturedAt:new Date().toISOString(),
      scenes:scenes.map(s=>({id:s.id,label:s.label,scriptText:s.scriptText,audioPath:s.audioPath}))
    },null,2));
    const input={scenes:scenes.map((s,i)=>({...s,scriptText:newText[i]||s.scriptText}))};
    for(const [idx,original] of scenes.entries()){
      if(!newText[idx])continue;
      const updated=await db.getProductionScene(ID,original.id);
      if(updated.scriptText===newText[idx]){console.log('PTBR_SCENE_ALREADY_UPDATED',idx+1);continue;}
      const oldAudio=path.join(audioFolder,String(idx).padStart(3,'0')+'_kokoro_pm_alex.mp3');
      const backupAudio=path.join(backups,String(idx).padStart(3,'0')+'_kokoro_original.mp3');
      if(await fs.stat(oldAudio).then(()=>true).catch(()=>false)&&
         !await fs.stat(backupAudio).then(()=>true).catch(()=>false)){
        await fs.copyFile(oldAudio,backupAudio);
      }
      // Delete only the Kokoro cache of scenes whose narration text changed.
      await fs.rm(oldAudio,{force:true});
      await db.updateProductionScene(ID,original.id,{
        scriptText:newText[idx],narrationStatus:'stale',status:'needs_rebuild',
        revision:updated.revision+1
      });
      await db.saveProductionSceneRevision({
        productionId:ID,sceneId:original.id,action:'ptbr_narration_correction',
        before:{scriptText:updated.scriptText,language:'mixed-pt-en'},
        after:{scriptText:newText[idx],language:'pt-BR'},
        costEvidence:{billed:false}
      });
      console.log('PTBR_SCENE_CORRECTED',idx+1,original.label);
    }
    await fs.writeFile(scenesPath,JSON.stringify(input,null,2),'utf8');
    const edited=await db.getProductionBundle(ID);
    await db.saveContentReview(ID,{
      status:'needs_attention',
      editorData:{...edited.editorData,rightsConfirmed:false,factChecked:false},
      qualityChecks:edited.qualityChecks,
      reviewNotes:'Introdução, conclusão e chamada final corrigidas para português brasileiro; regenerando narração neural e legendas. Revisão factual continua obrigatória.',
      reviewedAt:null
    });
    console.log('PTBR_SCENE_TEXT_UPDATED_WITH_BACKUP',scenesPath);
  }finally{await db.close();}
}
main().catch(e=>{console.error('PTBR_REPAIR_FAILED',String(e.message||e).slice(0,400));process.exitCode=1});
