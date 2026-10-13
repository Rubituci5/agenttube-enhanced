'use strict';
// AgentTube IAgora: automatic CC0 soundtrack selection and non-destructive mix.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const axios=require('axios');
const {getMediaDuration,runFFmpeg}=require('./ffmpeg');
const {getEditorialProfile}=require('./iagora-editorial');
const ROOT=path.resolve(__dirname,'..');
const MUSIC_DIR=path.join(ROOT,'data','music','cc0');
const LICENSE='https://creativecommons.org/publicdomain/zero/1.0/';
const SOURCE='https://github.com/0lhi/FreePD';
const ENVATO_TRACK=Object.freeze({
  key:'envato_default',title:'Cinematic Trailer',genre:'Cinematic Trailer',
  path:path.join(ROOT,'data','music','envato','cinematic-trailer-full.mp3'),
  sourceUrl:'https://elements.envato.com/cinematic-trailer-ABL93GX',
  sourceRepository:'Envato Elements',license:'Envato Elements Project License',
  licenseUrl:'https://elements.envato.com/license-terms',
  licenseCertificate:path.join(ROOT,'data','music','envato','licenses','license_certificate_DX9RCL6N7H.pdf'),
  licenseCode:'DX9RCL6N7H',licensedProject:'Agape',licensee:'Alex Rubituci',
  attributionRequired:false,requiresPerEndProductLicense:true
});
const TRACKS=Object.freeze({
  mystery:{title:'Hidden Truth',genre:'Suspense e mistério',category:'Horror',filename:'Hidden Truth.mp3',localFile:'misterio.mp3',
    keywords:['godzilla','mistério','radiação','perigo','monstro','terror','segredo','assustador','sobrenatural','sombra','sombrio','ameaça']},
  science:{title:'Space Ambience',genre:'Ciência e tecnologia',category:'Electronic',filename:'Space Ambience.mp3',localFile:'tecnologia.mp3',
    keywords:['tecnologia','ciência','inteligência artificial','robô','robótica','futuro','artificial','espacial','espaço','universo','laboratório','cientista','inovação','quântica']},
  dramatic:{title:'Beginning of Conflict',genre:'Tensão e drama',category:'Scoring',filename:'Beginning of Conflict.mp3',localFile:'tensao.mp3',
    keywords:['guerra','batalha','conflito','explosão','desastre','tragédia','militar','catástrofe','sobrevivência','combate']},
  documentary:{title:'After the End',genre:'Documentário investigativo',category:'Scoring',filename:'After the End.mp3',localFile:'documentario.mp3',
    keywords:['história','documentário','investigação','pesquisa','memória','descoberta','natureza','medicina','realidade','mundo']}
});
function sourceUrl(t){return 'https://raw.githubusercontent.com/0lhi/FreePD/master/'+encodeURIComponent(t.category)+'/'+encodeURIComponent(t.filename);}
function info(key){
  const t=TRACKS[key];if(!t)throw Error('Faixa não autorizada: '+key);
  return {...t,key,path:path.join(MUSIC_DIR,t.localFile),sourceUrl:sourceUrl(t),
    sourceRepository:SOURCE,license:'CC0-1.0',licenseUrl:LICENSE,attributionRequired:false};
}
function selectMood(script={},strategy={}){
  const text=[strategy?.topic,strategy?.angle,script?.title,script?.metadata?.strategy?.topic,
    (script?.mainContent?.sections||[]).map(s=>s.title).join(' ')]
    .filter(Boolean).join(' ').toLocaleLowerCase('pt-BR');
  const priority=['mystery','science','dramatic','documentary'];
  if (/\bia\b/.test(text)&&!/sombrio|ameaça|perigo/.test(text))return 'science';
  const ranked=priority.map((key,index)=>({
    key,position:index,
    points:TRACKS[key].keywords.reduce((total,word)=>
      total+(text.includes(word)?((key==='mystery'&&['godzilla','mistério','radiação'].includes(word))?4:1):0),0)
  })).sort((a,b)=>b.points-a.points||a.position-b.position);
  return ranked[0].points?ranked[0].key:'documentary';
}
async function validAudio(file){
  try{const stat=await fs.stat(file);return stat.isFile()&&stat.size>60*1024&&stat.size<18*1024*1024
    &&(await getMediaDuration(file))>25;}catch(_){return false}
}
async function ensureTrack(track,allowDownload){
  if(await validAudio(track.path))return track;
  if(!allowDownload)throw Error('Trilha local não encontrada: '+track.title);
  await fs.mkdir(MUSIC_DIR,{recursive:true});
  const part=track.path+'.'+crypto.randomBytes(6).toString('hex')+'.tmp';
  try{
    const res=await axios.get(track.sourceUrl,{responseType:'arraybuffer',
      timeout:45000,maxContentLength:18*1024*1024,maxRedirects:3});
    const body=Buffer.from(res.data);
    if(body.length<60*1024||body.length>=18*1024*1024)throw Error('Faixa fora do limite de 18 MB');
    await fs.writeFile(part,body);
    if(!(await validAudio(part)))throw Error('Arquivo de música inválido');
    await fs.rename(part,track.path);
    return track;
  }finally{await fs.rm(part,{force:true}).catch(()=>{})}
}
function enabled(){return process.env.BACKGROUND_MUSIC_ENABLED!=='false'&&Boolean(getEditorialProfile())}
class AutomaticMusicService{
  static enabled=enabled;
  static selectMood=selectMood;
  static catalogue=TRACKS;
  async choose(script,strategy,options={}){
    // Default Envato. Select CC0 explicitly with BACKGROUND_MUSIC_SOURCE=cc0.
    if(process.env.BACKGROUND_MUSIC_SOURCE!=='cc0'){
      if(!(await validAudio(ENVATO_TRACK.path)))
        throw new Error('Trilha Envato padrão ausente ou inválida: '+ENVATO_TRACK.path);
      return ENVATO_TRACK;
    }
    const preferred=options.mood&&TRACKS[options.mood]?options.mood:selectMood(script,strategy);
    const choices=[preferred,...Object.keys(TRACKS).filter(x=>x!==preferred)];
    let error;
    for(const k of choices){
      try{return await ensureTrack(info(k),options.allowDownload!==false)}
      catch(e){error=e}
    }
    throw new Error('Sem trilhas CC0 disponíveis: '+(error?.message||'erro desconhecido'));
  }
  async addToVideo(sourceVideo,{script={},strategy={},outputPath,
    allowDownload=true,musicLevel=0.15,fadeInSeconds=3,fadeOutSeconds=7}={}){
    if(!Number.isFinite(musicLevel)||musicLevel<0.07||musicLevel>0.25)
      throw Error('Volume da trilha fora da faixa segura');
    const music=await this.choose(script,strategy,{allowDownload});
    const duration=await getMediaDuration(sourceVideo);
    if(duration<5||duration>10800)throw Error('Duração do vídeo incompatível com a trilha');
    const parsed=path.parse(sourceVideo);
    const finalPath=outputPath||path.join(parsed.dir,parsed.name+'_com_trilha.mp4');
    if(path.resolve(finalPath)===path.resolve(sourceVideo))
      throw Error('É proibido sobrescrever o vídeo original durante a mixagem');
    const temp=finalPath.replace(/\.mp4$/i,'.'+crypto.randomBytes(4).toString('hex')+'.part.mp4');
    const fadeOutAt=Math.max(0,duration-fadeOutSeconds);
    const filter=[
      '[0:a]aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[voice][control]',
      '[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,'+
       'highpass=f=90,lowpass=f=5500,volume='+musicLevel+
       ',afade=t=in:st=0:d='+fadeInSeconds+
       ',afade=t=out:st='+fadeOutAt.toFixed(2)+':d='+fadeOutSeconds+'[bed]',
      '[bed][control]sidechaincompress=threshold=0.024:ratio=8:attack=35:release=650[duck]',
      '[voice][duck]amix=inputs=2:duration=first:normalize=0:dropout_transition=0[mixed]'
    ].join(';');
    try{
      await runFFmpeg(['-hide_banner','-loglevel','error','-y',
        '-i',sourceVideo,'-stream_loop','-1','-i',music.path,
        '-filter_complex',filter,
        '-map','0:v:0','-map','[mixed]','-c:v','copy',
        '-c:a','aac','-b:a','160k','-ar','48000',
        '-t',duration.toFixed(3),'-movflags','+faststart',temp]);
      const mixedDuration=await getMediaDuration(temp);
      if(Math.abs(duration-mixedDuration)>1.2)throw Error('Trilha comprometeu a sincronização do vídeo');
      if((await fs.stat(temp)).size<40000)throw Error('MP4 com trilha incompleto');
      await fs.rename(temp,finalPath);
      return {outputPath:finalPath,
        music:{status:'ready',provider:music.key==='envato_default'?'Envato Elements':'FreePD CC0',
          mood:music.key,title:music.title,
          genre:music.genre,path:music.path,sourceUrl:music.sourceUrl,
          sourceRepository:music.sourceRepository,license:music.license,licenseUrl:music.licenseUrl,
          attributionRequired:music.attributionRequired,voiceDucking:true,volumeRatio:musicLevel,
          licenseCertificate:music.licenseCertificate||null,
          licenseCode:music.licenseCode||null,licensedProject:music.licensedProject||null,
          requiresPerEndProductLicense:Boolean(music.requiresPerEndProductLicense),
          fadeInSeconds,fadeOutSeconds,durationSeconds:duration,
          mixedAt:new Date().toISOString()}};
    }finally{await fs.rm(temp,{force:true}).catch(()=>{})}
  }
}
module.exports={AutomaticMusicService,TRACKS,ENVATO_TRACK,info,selectMood,enabled,validAudio};
