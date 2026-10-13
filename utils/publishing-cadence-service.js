'use strict';
// Select fixed publishing slots in the YouTube channel timezone. Uses native
// Intl only (no server/OS timezone assumption). No API or database writes.
const DEFAULT_ZONE='America/Sao_Paulo';
function parseSlots(raw='12:00,19:00'){
 const values=String(raw).split(',').map(x=>x.trim()).filter(Boolean);
 if(values.length!==2 || new Set(values).size!==2 ||
   values.some(x=>!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(x))) {
   throw Error('PUBLISH_SLOTS deve conter dois horários válidos: 12:00,19:00');
 }
 return values.sort();
}
function parts(date,zone){
 const f=new Intl.DateTimeFormat('en-US',{
   timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',
   hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
 });
 return Object.fromEntries(f.formatToParts(date).filter(p=>p.type!=='literal')
   .map(p=>[p.type,Number(p.value)]));
}
function inZone(day,hhmm,zone){
 const [hour,minute]=hhmm.split(':').map(Number);
 const candidate=Date.parse(day+'T'+hhmm+':00.000Z');
 const local=parts(new Date(candidate),zone);
 const actual=Date.UTC(local.year,local.month-1,local.day,local.hour,local.minute);
 const adjusted=new Date(candidate-(actual-candidate));
 const verifies=parts(adjusted,zone);
 if(verifies.year!==Number(day.slice(0,4)) ||
   verifies.month!==Number(day.slice(5,7)) ||
   verifies.day!==Number(day.slice(8,10)) ||
   verifies.hour!==hour || verifies.minute!==minute)throw Error('Esse horário não existe no fuso escolhido (mudança de horário de verão).');
 return adjusted;
}
function allocateSlot(occupied=[],opts={}){
 const zone=opts.timezone||DEFAULT_ZONE;
 const slots=parseSlots(opts.slots||'12:00,19:00');
 const now=opts.now instanceof Date?opts.now:new Date();
 const start=new Date(now.getTime()+Math.max(60,Number(opts.minLeadMinutes)||90)*60000);
 const local=parts(start,zone);
 const today=new Date(Date.UTC(local.year,local.month-1,local.day));
 const taken=(occupied||[]).map(x=>new Date(x)).filter(x=>Number.isFinite(x.getTime()));
 for(let d=0;d<20;d++){
   const day=new Date(today.getTime()+d*86400000).toISOString().slice(0,10);
   for(const slot of slots){
     let date;
     try{date=inZone(day,slot,zone)}catch(_){continue}
     if(date<=start)continue;
     if(taken.some(x=>Math.abs(x.getTime()-date.getTime())<40*60000))continue;
     return date.toISOString();
   }
 }
 throw Error('Sem horários disponíveis nos próximos 20 dias');
}
module.exports={parseSlots,parts,inZone,allocateSlot};
