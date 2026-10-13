'use strict';
// Approximate captions aligned to the actual narration length.
// This avoids fixed section-length drift; it is not word-level forced alignment.
const punctuate=word=>/[.!?;:]$/.test(word);
function timeSrt(seconds){
  const ms=Math.max(0,Math.round(seconds*1000));
  const hours=Math.floor(ms/3600000);
  const minutes=Math.floor(ms%3600000/60000);
  const secs=Math.floor(ms%60000/1000);
  const remain=ms%1000;
  return [hours,minutes,secs].map(x=>String(x).padStart(2,'0')).join(':')+','+String(remain).padStart(3,'0');
}
function createSpeechTimedSrt(raw,duration,{wordsPerCaption=8}={}){
  if(!Number.isFinite(duration)||duration<2||duration>14400)throw Error('Duração de narração inválida.');
  const text=String(raw||'').replace(/\s+/g,' ').trim();
  const words=text.split(' ').filter(Boolean);
  if(!words.length)throw Error('Nenhum texto narrado.');
  const groups=[];
  for(let n=0;n<words.length;n+=wordsPerCaption){
    const part=words.slice(n,n+wordsPerCaption);
    groups.push({text:part.join(' '),
      weight:part.length+part.filter(punctuate).length*.55});
  }
  const total=groups.reduce((acc,g)=>acc+g.weight,0);
  let at=0;
  return groups.map((group,index)=>{
    const from=at;
    at=index===groups.length-1 ? duration : at+group.weight/total*duration;
    const start=Math.min(duration,from);
    const end=Math.min(duration,at);
    return `${index+1}\n${timeSrt(start)} --> ${timeSrt(end)}\n${group.text}\n`;
  }).join('\n')+'\n';
}
module.exports={createSpeechTimedSrt,timeSrt};
