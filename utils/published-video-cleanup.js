'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');

// Only production-specific MP4s, never shared stock footage, audio,
// subtitles, thumbnails, database, scripts or channel credentials.
class PublishedVideoCleanup {
  constructor({ videosDir, filesystem } = {}) {
    this.videosDir = path.resolve(videosDir || path.join(__dirname, '..', 'data', 'videos'));
    this.fs = filesystem || fs;
  }
  async remove(entry) {
    const id = String(entry?.productionId || '');
    if (!/^prod_[a-zA-Z0-9_-]{3,100}$/.test(id)) throw Error('Unsafe production ID for cleanup');
    if (entry?.status !== 'published' ||
      !/^[\w-]{8,35}$/.test(String(entry.youtubeId || '')) ||
      !entry.metadata?.publicVerifiedAt || !entry.metadata?.processingVerifiedAt) {
      throw Error('Video not confirmed public and processed by YouTube');
    }
    if (await this.fs.realpath(this.videosDir) !== this.videosDir) {
      throw Error('Unsafe video directory symlink');
    }
    const files = await this.fs.readdir(this.videosDir, { withFileTypes: true });
    const removed = [];
    let bytes = 0;
    for (const file of files) {
      if (!file.name.startsWith(id + '_') || !file.name.endsWith('.mp4')) continue;
      if (!file.isFile() || file.isSymbolicLink()) throw Error('Unsafe video file type');
      const full = path.join(this.videosDir, file.name);
      const stat = await this.fs.lstat(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw Error('Video file is linked or not regular');
      }
      await this.fs.unlink(full);
      removed.push(file.name);
      bytes += stat.size;
    }
    return { removed, bytes };
  }
}
module.exports = { PublishedVideoCleanup };
