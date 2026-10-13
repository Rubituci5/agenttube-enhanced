'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { PublishingSchedulingAgent } = require('../../agents/publishing-scheduling-agent');
const { PublishedVideoCleanup } = require('../../utils/published-video-cleanup');
async function main() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-publication-safety-'));
  try {
    const id = 'prod_20261013_test123';
    const output = path.join(dir, id + '_final.mp4');
    const intermediate = path.join(dir, id + '_final_legendas.mp4');
    const another = path.join(dir, 'prod_other123_final.mp4');
    const thumb = path.join(dir, id + '_thumb.jpg');
    for (const file of [output, intermediate, another, thumb]) await fs.writeFile(file, Buffer.alloc(128));
    const cleanup = new PublishedVideoCleanup({videosDir:await fs.realpath(dir)});
    const entry = {
      id:'sch-public',
      productionId:id,
      status:'uploaded',
      youtubeId:'vidpublic123',
      publishTime:new Date().toISOString(),
      metadata:{privacyStatus:'public'}
    };
    await assert.rejects(cleanup.remove(entry), /not confirmed public/i);
    assert.equal((await fs.stat(output)).size,128);

    let status = {privacyStatus:'public',uploadStatus:'uploaded'};
    const writes = [];
    const db = {updateScheduleEntry:async x => writes.push({...x,metadata:{...x.metadata}})};
    const agent = new PublishingSchedulingAgent(db,{});
    agent.youtube = {videos:{list:async()=>({data:{items:[{
      id:'vidpublic123',status,processingDetails:{processingStatus:status.uploadStatus==='processed'?'succeeded':'processing'}
    }]}})}};
    agent.videoCleanup = cleanup;
    const awaiting = await agent.reconcileUploadedVideo(entry);
    assert.equal(awaiting.status,'uploaded');
    assert.equal((await fs.stat(output)).size,128,'never delete while processing');

    status={privacyStatus:'private',uploadStatus:'processed'};
    const privateOnly = await agent.reconcileUploadedVideo(entry);
    assert.equal(privateOnly.status,'uploaded');
    assert.equal((await fs.stat(output)).size,128,'never delete private upload');

    status={privacyStatus:'public',uploadStatus:'processed'};
    const published = await agent.reconcileUploadedVideo(entry);
    assert.equal(published.status,'published');
    assert.ok(published.metadata.publicVerifiedAt);
    assert.ok(published.metadata.processingVerifiedAt);
    assert.equal(published.metadata.localCleanupFiles.length,2);
    await assert.rejects(fs.stat(output),/ENOENT/);
    await assert.rejects(fs.stat(intermediate),/ENOENT/);
    assert.equal((await fs.stat(another)).size,128,'other production must survive');
    assert.equal((await fs.stat(thumb)).size,128,'thumbnail must survive');
    assert.equal(writes.at(-1).metadata.localCleanupBytes,256);
    const again = await agent.reconcileUploadedVideo(entry);
    assert.equal(again.metadata.localCleanupFiles.length,2,'must be idempotent');

    let uploads=0, body=null;
    const other=new PublishingSchedulingAgent({updateScheduleEntry:async()=>{}}, {});
    other.youtube={videos:{insert:async req=>{uploads++;body=req.requestBody;return {data:{id:'public123'}}}}};
    other.getVideoStream=async()=>({fake:true});
    const due={
      publishTime:new Date().toISOString(),
      metadata:{privacyStatus:'public',seo:{title:'Public test',description:'Desc',tags:[]},
        video:{path:'fixture.mp4'}}
    };
    await other.uploadToYouTube(due);
    assert.equal(body.status.privacyStatus,'public');
    assert.equal(body.status.publishAt,undefined);
    assert.equal(uploads,1);
    await assert.rejects(other.uploadToYouTube({...due,metadata:{...due.metadata,privacyStatus:'private'}}),/Only public/);
    await assert.rejects(other.uploadToYouTube({...due,publishTime:new Date(Date.now()+3600000).toISOString()}),/future slot/);
    assert.equal(uploads,1,'no private or premature insert');
    console.log('PUBLICATION_CLEANUP_TEST_PASS public-only, deferred slot, processing hold, private hold, scoped deletion, idempotence');
  } finally {
    await fs.rm(dir,{force:true,recursive:true});
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});
