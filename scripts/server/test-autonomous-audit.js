'use strict';
const assert=require('node:assert/strict');
const { AutonomousEditorialAudit, trustedUrl, plain, articleBody }=require('../../utils/autonomous-editorial-audit');
const quote='The laboratory confirmed that the model measures proteins more accurately under the controlled experiment conditions.';
const reference='This is an actual complete reference article '.repeat(20)+quote+' More actual context about the study.';
const source={id:'src_1',url:'https://science.nasa.gov/mars/',title:'Laboratory research notes',
  publisher:'NASA',sourceType:'official',status:'pending'};
const claim={id:'cl_1',text:'O modelo foi confirmado em testes controlados.',riskLevel:'standard',
  sourceIds:['src_1'],status:'pending'};
function mock(overrides={}){
  const old={sources:[source],claims:[{...claim}],status:'blocked',summary:{unresolvedClaims:1}};
  let saved=null;
  const db={
    getContentProvenance:async()=>old,
    saveContentProvenance:async(id,value)=>{saved=value;},
  };
  const aiText={
    isAvailable:()=>true,
    generateText:async()=>JSON.stringify({
      checks:[{index:0,sourceId:'src_1',quote,supported:true}],uncheckedStatements:[]
    })
  };
  const audit=new AutonomousEditorialAudit(db,{},{
    aiText:overrides.aiText||aiText,
    fetchEvidence:overrides.fetchEvidence||(async s=>({...s,text:reference})),
    mediaAudit:async()=>({passed:true,videoClips:2,thumbnailImages:2})
  });
  if(overrides.override)overrides.override(old,db);
  return {audit,db,getSaved:()=>saved};
}
async function run(){
 assert.equal(trustedUrl('https://science.nasa.gov/mars/'),true);
 assert.equal(trustedUrl('https://www.sciencedaily.com/releases/example.htm'),false,'Secondary news cannot approve autonomous facts');
 assert.equal(plain(articleBody('<header>Top menu</header><main><nav>Mission menu</nav><p>Real source evidence</p><footer>Footer</footer></main>')),'Real source evidence');
 for(const bad of ['http://science.nasa.gov/mars/','https://127.0.0.1/','https://science.nasa.gov.evil.com/',
  'https://bob:pwd@science.nasa.gov/mars/']) assert.equal(trustedUrl(bad),false);
 assert.equal(plain('<style>bad</style><p>This &amp; that</p>'),'This & that');
 const production={script:{fullScript:'O modelo foi confirmado em testes controlados.'},containsSyntheticMedia:false};
 let t=mock();
 const okay=await t.audit.audit('prod_test_a',production);
 assert.equal(okay.passed,true);
 assert.equal(t.getSaved().claims[0].status,'supported');
 assert.equal(t.getSaved().sources[0].status,'verified');
 t=mock({aiText:{isAvailable:()=>true,generateText:async()=>JSON.stringify({
   checks:[{index:0,sourceId:'src_1',quote:'Fabricated support invented by model',supported:true}],
   uncheckedStatements:[]})}});
 assert.equal((await t.audit.verifyFacts('prod_test_b',production)).passed,false,'Invented quote blocked');
 t=mock({aiText:{isAvailable:()=>true,generateText:async()=>JSON.stringify({
  checks:[{index:0,sourceId:'src_1',quote,supported:true}],
  uncheckedStatements:['additional unsourced scientific claim']})}});
 assert.equal((await t.audit.verifyFacts('prod_test_c',production)).passed,false,'Uncovered script claim blocked');
 t=mock({fetchEvidence:async()=>{throw Error('blocked by publisher');}});
 assert.equal((await t.audit.verifyFacts('prod_test_d',production)).passed,false,'Unreachable reference blocked');
 t=mock({override:old=>{old.claims[0].riskLevel='high';}});
 assert.equal((await t.audit.verifyFacts('prod_test_e',production)).passed,false,'High-risk claim without corroboration blocked');
 t=mock({override:old=>{old.claims=[];}});
 assert.equal((await t.audit.verifyFacts('prod_test_f',production)).passed,false,'No explicit factual claims blocks auto approval');

 let receivedPrompt='';
 t=mock({aiText:{isAvailable:()=>true,generateText:async prompt=>{receivedPrompt=prompt;return JSON.stringify({checks:[{index:0,sourceId:'src_1',quote,supported:true}],uncheckedStatements:prompt.includes('METADATA_UNSUPPORTED_SENTINEL')?['metadata extra assertion']:[]});}}});
 const metadataProduction={...production,seo:{title:'Published title',description:'METADATA_UNSUPPORTED_SENTINEL'},thumbnail:{concept:{primaryText:'Published thumbnail headline'}}};
 assert.equal((await t.audit.verifyFacts('prod_metadata',metadataProduction)).passed,false,'Unsupported published metadata must prevent approval');
 assert(receivedPrompt.includes('Published title') && receivedPrompt.includes('Published thumbnail headline'),'Audit must inspect actual published title and thumbnail');
 console.log('AUTONOMOUS_AUDIT_TEST_PASS source trust, quotes, unsupported facts, source outage, high risk, missing claims');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
