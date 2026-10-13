'use strict';
// IAgora's automatic thumbnail compositor. Pixabay images (free stock) + Sharp.
// No image-generation API calls, no local diffusion inference.
const fs=require('node:fs/promises');
const path=require('node:path');
const crypto=require('node:crypto');
const axios=require('axios');
const sharp=require('sharp');
const {ThumbnailStudio}=require('./nano-banana-thumbnail-studio');
const {getEditorialProfile}=require('./iagora-editorial');
const {PixabayVideoService,keywords}=require('./pixabay-video-service');

const ROOT=path.resolve(__dirname,'..');
const UPLOADS=path.join(ROOT,'uploads','thumbnails');
const STOCK=path.join(ROOT,'data','stock','pixabay','thumbnail-images');
const LICENSE='https://pixabay.com/service/license-summary/';
const CACHE_MS=24*60*60*1000;
const MAX_DOWNLOAD=12*1024*1024;
const COLORS={amarelo:'#FFF135',branco:'#FFFFFF',verde:'#A8FF37',vermelho:'#FF3A3A'};
const SEARCH_FALLBACKS=[
  [/godzilla|monstro|dinossauro|kaiju/,['dinosaur','monster movie']],
  [/radia[cç][aã]o|nuclear|ur[aâ]nio|reator/,['nuclear power plant','radiation scientist']],
  [/cristal|tempo|envelhec/,['crystal macro','science crystal']],
  [/intelig[eê]ncia artificial|\bia\b|robot|rob[oô]|algoritmo|chatgpt/,['robot artificial intelligence','human robot technology']],
  [/c[eé]rebro|neur[oô]nio|neuralink|implante cerebral/,['human brain science','brain technology']],
  [/espa[cç]o|universo|buraco negro|planeta|astronauta/,['space galaxy','astronaut technology']],
  [/celular|smartphone|telefone|cheiro digital/,['smartphone technology','human phone']],
  [/transplante|cirurgia|medicina/,['medical surgery','hospital science']],
  [/futebol|palmeiras|jogador/,['soccer football','soccer stadium']],
  [/mist[eé]rio|segredo|desaparec/,['mystery silhouette','dark forest']],
  [/cientista|ci[eê]ncia|pesquisa|laborat[oó]rio/,['scientist laboratory','science laboratory']]
];
function safePixabayUrl(raw){
  try{
    const u=new URL(raw);
    return u.protocol==='https:' &&
      ['cdn.pixabay.com','pixabay.com'].includes(u.hostname) &&
      !u.username && !u.password && !u.port;
  }catch(_){return false;}
}
function fallbackTerms(topic){
  const s=String(topic||'').toLowerCase();
  const match=SEARCH_FALLBACKS.find(([pattern])=>pattern.test(s));
  return match?.[1]||['future technology','science laboratory'];
}
function shortTerms(text){
  return String(text||'').toLowerCase().replace(/[^a-z\s-]/g,' ').replace(/\s+/g,' ').trim().slice(0,65);
}
function scoreHit(hit,query){
  const tags=keywords(hit.tags||'');
  const overlap=keywords(query).filter(t=>tags.includes(t)).length;
  const width=Number(hit.imageWidth||hit.webformatWidth||0);
  const height=Number(hit.imageHeight||hit.webformatHeight||1);
  const ratio=width/height;
  return overlap*20+(ratio>1.2?12:0)+(width>=1280?8:0)+
    Math.min(5,Math.log10(Number(hit.likes||0)+1)*2);
}
async function cachedJson(file){
  try{
    const data=JSON.parse(await fs.readFile(file,'utf8'));
    return Date.now()-data.savedAt<CACHE_MS ? data.hits : null;
  }catch(_){return null;}
}
class FreeThumbnailService {
  constructor(options={}){
    this.http=options.http||axios;
    this.stockService=options.stockService||new PixabayVideoService();
    this.now=options.now||(()=>Date.now());
    this.aiBrief=options.brief||null;
  }

  async chooseBrief(script, options={}){
    if(options.headline){
      const base=ThumbnailStudio.initialBrief(script);
      const headline=String(options.headline).replace(/\s+/g,' ').trim().slice(0,52);
      if(!headline)throw new Error('Informe uma manchete válida.');
      return {...base,headline,accent:COLORS[options.accent]?options.accent:base.accent};
    }
    if(this.aiBrief)return this.aiBrief(script);
    const studio=new ThumbnailStudio();
    return studio.createDirectorBrief(script);
  }

  async getQueries(script,brief){
    const topic=String(script?.title||'').slice(0,140);
    const result=fallbackTerms(topic);
    // Keep searches about the real subject: never convert a generic AI-art prompt
    // into fabricated footage of a real scientific event.
    const combined=(topic+' '+String(script?.metadata?.strategy?.topic||'')).toLowerCase();
    const extra=SEARCH_FALLBACKS.filter(([rx])=>rx.test(combined)).flatMap(([,arr])=>arr).slice(0,2);
    const directed=Array.isArray(brief.stockQueries)
      ? brief.stockQueries.filter(term=>typeof term==='string'&&/^[a-zA-Z0-9 -]{3,70}$/.test(term)).slice(0,2)
      : [];
    return [...new Set([...directed,...extra,...result,'science technology'])].map(shortTerms).filter(Boolean).slice(0,3);
  }

  async search(query){
    const key=await this.stockService.key();
    if(!key)throw new Error('Conecte a chave do Pixabay para gerar thumbnails gratuitas.');
    const q=shortTerms(query);
    const cacheFile=path.join(STOCK,'queries',crypto.createHash('sha256').update(q).digest('hex')+'.json');
    const cached=await cachedJson(cacheFile);
    if(cached)return cached;
    const response=await this.http.get('https://pixabay.com/api/',{
      params:{key,q,lang:'en',image_type:'photo',orientation:'horizontal',
        safesearch:'true',per_page:15,order:'popular',min_width:900},
      timeout:16000,maxRedirects:0
    });
    const hits=Array.isArray(response.data?.hits)?response.data.hits:[];
    await fs.mkdir(path.dirname(cacheFile),{recursive:true});
    await fs.writeFile(cacheFile,JSON.stringify({savedAt:this.now(),hits}),'utf8');
    return hits;
  }

  async findAssets(script,brief){
    if(!(await this.stockService.configured()))return [];
    const selected=[],used=new Set();
    for(const query of await this.getQueries(script,brief)){
      let hits;
      try{hits=await this.search(query);}catch(_){continue;}
      const ranked=hits.filter(h=>Number.isSafeInteger(h.id)&&h.id>0&&
        safePixabayUrl(h.largeImageURL||h.webformatURL)&&
        Number(h.imageWidth||0)>=900)
        .sort((a,b)=>scoreHit(b,query)-scoreHit(a,query));
      for(const hit of ranked){
        if(used.has(hit.id))continue;
        try{
          const asset=await this.download(hit);
          if(asset){selected.push({...asset,query});used.add(hit.id);break;}
        }catch(_){/* try another image; never expose stock auth */}
      }
      if(selected.length>=3)break;
    }
    return selected;
  }

  async download(hit){
    const url=hit.largeImageURL||hit.webformatURL;
    if(!safePixabayUrl(url))throw new Error('Fonte da imagem não permitida.');
    await fs.mkdir(STOCK,{recursive:true});
    const file=path.join(STOCK,hit.id+'.jpg');
    try{
      const s=await fs.stat(file);
      if(s.size>1024&&s.size<=MAX_DOWNLOAD){
        const m=await sharp(file,{limitInputPixels:50e6}).metadata();
        if(m.width>=900)return this.source(hit,file,true);
      }
    }catch(_){/* fetch only missing/invalid assets */}
    const result=await this.http.get(url,{
      responseType:'arraybuffer',timeout:18000,maxRedirects:0,
      maxContentLength:MAX_DOWNLOAD,validateStatus:s=>s===200
    });
    const data=Buffer.from(result.data);
    if(data.length>MAX_DOWNLOAD||data.length<1024)throw new Error('Imagem fora do limite.');
    const mime=String(result.headers?.['content-type']||'');
    if(mime&&!mime.startsWith('image/'))throw new Error('Pixabay não retornou uma imagem.');
    const m=await sharp(data,{limitInputPixels:50e6}).metadata();
    if(!['jpeg','png','webp'].includes(m.format)||m.width<900||m.height<350)throw new Error('Resolução insuficiente.');
    const temp=file+'.'+crypto.randomBytes(5).toString('hex')+'.tmp';
    try{
      await sharp(data).rotate().resize(1920,1080,{fit:'inside',withoutEnlargement:true})
        .jpeg({quality:86}).toFile(temp);
      await fs.rename(temp,file);
    }finally{await fs.rm(temp,{force:true}).catch(()=>{});}
    return this.source(hit,file,false);
  }

  source(hit,file,cached){
    return {id:hit.id,path:file,url:hit.pageURL||'https://pixabay.com/',
      author:String(hit.user||'Colaborador Pixabay'),tags:String(hit.tags||''),
      license:LICENSE,cached,provider:'Pixabay'};
  }

  static atmosphere(index,accent){
    const glow=['#13d9ff','#ffb71c','#f92f64'][index%3];
    const intensity=index===2?.52:.36;
    const rule=index===2
      ? '<path d="M590 0 L715 0 L485 720 L360 720Z" fill="#0D1321" opacity=".34"/>'
      : index===1
      ? '<path d="M910 0 L965 0 L660 720 L605 720Z" fill="#fff" opacity=".12"/>'
      : '<path d="M880 0 L895 0 L730 720 L715 720Z" fill="#fff" opacity=".11"/>';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs>
    <radialGradient id="glow" cx="${index===1?'30%':'75%'}" cy="48%" r="60%"><stop offset="0" stop-color="${glow}" stop-opacity="${intensity}"/><stop offset="1" stop-color="${glow}" stop-opacity="0"/></radialGradient>
    <radialGradient id="vignette" cx="50%" cy="45%" r="65%"><stop offset="50%" stop-opacity="0"/><stop offset="100%" stop-color="#05060b" stop-opacity=".72"/></radialGradient>
    <linearGradient id="tone" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#020513" stop-opacity=".18"/><stop offset=".62" stop-opacity="0"/><stop offset="1" stop-color="${accent}" stop-opacity=".10"/></linearGradient></defs>
    <rect width="1280" height="720" fill="url(#glow)" style="mix-blend-mode:screen"/>
    <rect width="1280" height="720" fill="url(#tone)"/>
    ${rule}<rect width="1280" height="720" fill="url(#vignette)"/>
    <rect x="13" y="14" width="1254" height="692" rx="3" fill="none" stroke="${accent}" stroke-opacity=".25" stroke-width="2"/>
    </svg>`;
  }

  async compose({main,secondary,brief,index=0}){
    const placement=['left','right','bottom'][index];
    const accentName=[brief.accent||'amarelo','amarelo','verde'][index];
    const accent=COLORS[accentName]||COLORS.amarelo;
    const a=await sharp(main.path,{limitInputPixels:50e6}).rotate()
      .resize(1280,720,{fit:'cover',position:'attention'}).toBuffer();
    const layers=[];
    if(secondary&&secondary.id!==main.id){
      const left=index===1?0:index===2?460:615;
      const width=index===2?820:665;
      const overlay=await sharp(secondary.path,{limitInputPixels:50e6}).rotate()
        .resize(width,720,{fit:'cover',position:'attention'}).removeAlpha().toBuffer();
      const mask=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="720"><defs>
        <linearGradient id="fade" x1="0%" x2="100%">
        ${index===1?'<stop offset="0" stop-color="white"/><stop offset=".88" stop-color="white"/><stop offset="1" stop-color="black"/>'
        :'<stop offset="0" stop-color="black"/><stop offset=".18" stop-color="white"/><stop offset="1" stop-color="white"/>'}
        </linearGradient></defs><rect width="${width}" height="720" fill="url(#fade)"/></svg>`);
      const feather=await sharp(overlay).joinChannel(await sharp(mask).extractChannel('red').toBuffer())
        .png().toBuffer().catch(()=>null);
      if(feather)layers.push({input:feather,left,top:0});
    }
    layers.push({input:Buffer.from(FreeThumbnailService.atmosphere(index,accent)),left:0,top:0});
    layers.push({input:Buffer.from(ThumbnailStudio.headlineOverlay(brief.headline,placement,accent)),left:0,top:0});
    await fs.mkdir(UPLOADS,{recursive:true});
    const out=path.join(UPLOADS,'iagora_stock_'+crypto.randomBytes(10).toString('hex')+'.jpg');
    await sharp(a).composite(layers).jpeg({quality:86,mozjpeg:true}).toFile(out);
    const stat=await fs.stat(out);
    return {label:['Impacto','Contraste','Cinema'][index],path:out,
      source:'pixabay-free-composite',generatedWith:'Pixabay + Sharp',
      headline:brief.headline,accent:accentName,placement,width:1280,height:720,
      fileSize:stat.size,stockSources:[main,...(secondary&&secondary.id!==main.id?[secondary]:[])].map(s=>
        ({id:s.id,url:s.url,author:s.author,license:s.license,query:s.query})),
      requiresEditorialReview:true};
  }

  async generate(script,options={}){
    if(!getEditorialProfile())throw new Error('Modo gratuito configurado apenas para o canal IAgora.');
    const brief=await this.chooseBrief(script,options);
    const images=await this.findAssets(script,brief);
    if(!images.length)throw new Error('Nenhuma imagem pertinente encontrada no Pixabay. Use importação manual ou tente outro tema.');
    const variants=[];
    for(let i=0;i<3;i++){
      const main=images[i%images.length];
      const secondary=images.length>1 ? images[(i+1)%images.length] : null;
      variants.push(await this.compose({main,secondary,brief,index:i}));
    }
    return {source:'pixabay-free-composite',primary:variants[0],variants,brief,
      references:images.map(({id,url,author,license,query})=>({id,url,author,license,query})),
      generatedAt:new Date().toISOString()};
  }
}
module.exports={FreeThumbnailService,safePixabayUrl,scoreHit,SEARCH_FALLBACKS};
