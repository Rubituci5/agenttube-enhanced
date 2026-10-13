'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { PixabayVideoService, safeHost, MAX_CLIP_BYTES, CACHE_MS } = require('../utils/pixabay-video-service');
const { AIVideoGenerator } = require('../utils/ai-video-generator');

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttube-pixabay-test-'));
  const requests = [];
  const fakeHit = { id: 125, pageURL: 'https://pixabay.com/videos/id-125/',
    type: 'film', tags: 'nature, forest, trees', duration: 9, user: 'TestArtist',
    downloads: 50, videos: { medium: { url: 'https://cdn.pixabay.com/video/clip.mp4', width: 1280,
      height: 720, size: 2048 } } };
  const fakeHTTP = {
    async get(url, opts) {
      requests.push({ url, opts });
      if (url === 'https://pixabay.com/api/videos/') {
        assert.equal(opts.params.safesearch, 'true');
        assert.equal(opts.params.per_page, opts.params.q === 'nature' ? 3 : 10);
        return { data: { hits: [fakeHit] } };
      }
      assert.equal(url, fakeHit.videos.medium.url);
      return { data: Readable.from([Buffer.alloc(2048, 0x53)]),
        headers: { 'content-type': 'video/mp4', 'content-length': '2048' } };
    }
  };
  const service = new PixabayVideoService({ root, http: fakeHTTP });
  try {
    assert.equal(await service.configured(), false);
    assert.deepEqual(await service.acquire({ title: 'Forest' }, 'prod_test'), []);
    await assert.rejects(() => service.saveKey('bad'), /inválida/);
    await service.saveKey('12345678-AbcdEFGHijk');
    assert.equal(await service.configured(), true);
    assert.equal((await fs.stat(path.join(root, 'config', 'pixabay.json'))).mode & 0o777, 0o600);
    const hits = await service.search('forest');
    assert.equal(hits.length, 1);
    const again = await service.search('forest');
    assert.deepEqual(again, hits);
    assert.equal(requests.filter(r => r.url.includes('/api/videos/')).length, 2, '1 verification + 1 cached search');
    assert(CACHE_MS >= 86400000);
    assert.equal(safeHost('https://evil.com/bad.mp4'), false);
    assert.equal(safeHost('https://cdn.pixabay.com.evil.com/bad.mp4'), false);
    assert.equal(safeHost(fakeHit.videos.medium.url), true);
    const clip = await service.download(fakeHit);
    assert.equal(clip.author, 'TestArtist');
    assert.equal((await fs.stat(clip.path)).size, 2048);
    const againClip = await service.download(fakeHit);
    assert.equal(againClip.cached, true);
    assert.equal(requests.filter(r => r.url === fakeHit.videos.medium.url).length, 1, 'download cache');
    assert.equal(service.rendition({ id: 42, videos: { medium: {
      url: 'https://evil.com/no.mp4', width: 640, height: 360, size: 1234 } } }), null);
    assert.equal(service.rendition({ id: 42, videos: { medium: {
      url: fakeHit.videos.medium.url, width: 640, height: 360, size: MAX_CLIP_BYTES + 1 } } }), null);
    const manifest = await service.acquire({ title: 'forest', mainContent: { sections: [{ title: 'forest' }] } }, 'prod_test');
    assert.equal(manifest.length, 1);
    assert.equal(manifest[0].id, 125);
    assert.equal((await fs.readFile(path.join(root,'data','stock','pixabay','manifests','prod_test.json'),'utf8')).includes('pixabay.com/videos/id-125'), true);

    const fakeGenerator = new AIVideoGenerator({}, { db: { getSetting: async () => 'pixabay' }, pixabay: {
      acquire: async () => manifest
    } });
    let rendered = 0, muxed = 0;
    fakeGenerator.resolveSlideshowDuration = async () => 26;
    fakeGenerator.renderMediaTimeline = async (segments) => {
      assert(segments.length <= 12);
      assert(Math.abs(segments.reduce((n,s)=>n+s.duration,0)-26)<0.1);
      assert(segments.every(s => s.type === 'video' && s.path === clip.path));
      rendered++;
    };
    fakeGenerator.addAudioToVideo = async () => { muxed++; };
    const out = await fakeGenerator.generateVideo({ title: 'Forest' }, [], 'narration.mp3', path.join(root,'output.mp4'), { productionId: 'prod_test' });
    assert(out.endsWith('output.mp4'));
    assert.equal(rendered,1);
    assert.equal(muxed,1);
    assert.equal(fakeGenerator.lastVideoResult.actualProvider,'pixabay-stock');
    assert.equal(fakeGenerator.lastVideoResult.scenes[0].author,'TestArtist');
    assert.equal(fakeGenerator.lastVideoResult.generatedSeconds,0);
    console.log('Pixabay: 17 validations passed (search/cache, download, security, manifest, FFmpeg timeline, provenance).');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
