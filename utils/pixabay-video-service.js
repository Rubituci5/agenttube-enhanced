'use strict';
// Pixabay official videos API. Only a few purposeful searches/downloads per production.
// API cache: >=24 hours; no mass acquisition. No Pixabay keys are logged.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const axios = require('axios');

const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_CLIP_BYTES = 35 * 1024 * 1024;
const LICENSE_URL = 'https://pixabay.com/service/license-summary/';
const ROOT = path.join(__dirname, '..');
const STOPWORDS = new Set('de da do dos das um uma o a os as e em no na com para por que como sobre mais seu sua seus suas the of and for with from into this that video scene guia dicas explicação introdução parte capitulo capítulo'.split(' '));

function keywords(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(word => word.length > 2 && !STOPWORDS.has(word));
}
function searchTerm(title) {
  return String(title || '').trim().replace(/\s+/g, ' ').slice(0, 100);
}
function safeHost(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.protocol === 'https:' && (u.hostname === 'cdn.pixabay.com' || u.hostname === 'pixabay.com') &&
      u.username === '' && u.password === '';
  } catch (_) { return false; }
}

class PixabayVideoService {
  constructor(options = {}) {
    this.http = options.http || axios;
    this.root = options.root || ROOT;
    this.now = options.now || (() => Date.now());
    this.keyPath = options.keyPath || path.join(this.root, 'config', 'pixabay.json');
    this.cachePath = path.join(this.root, 'data', 'stock', 'pixabay');
  }

  async key() {
    if (process.env.PIXABAY_API_KEY) return process.env.PIXABAY_API_KEY.trim();
    try {
      const config = JSON.parse(await fs.readFile(this.keyPath, 'utf8'));
      return String(config.key || '').trim();
    } catch (_) { return ''; }
  }
  async configured() { return Boolean(await this.key()); }

  async saveKey(input) {
    const key = String(input || '').trim();
    if (!/^[a-zA-Z0-9_-]{15,128}$/.test(key)) throw new Error('Chave Pixabay inválida. Copie a chave de sua conta no Pixabay.');
    // Verify once against the official videos endpoint before claiming connection.
    try {
      const check = await this.http.get('https://pixabay.com/api/videos/', {
        params: { key, q: 'nature', per_page: 3, safesearch: 'true' },
        timeout: 15000, maxRedirects: 0
      });
      if (!Array.isArray(check.data?.hits)) throw new Error('invalid response');
    } catch (error) {
      const status = error.response?.status;
      throw new Error(status === 401 || status === 403
        ? 'Pixabay rejeitou a chave. Confira a API key da sua conta.'
        : 'Não foi possível validar a chave no Pixabay. Tente novamente.');
    }
    await fs.mkdir(path.dirname(this.keyPath), { recursive: true });
    const temp = this.keyPath + '.' + process.pid + '.tmp';
    try {
      await fs.writeFile(temp, JSON.stringify({ key }), { mode: 0o600 });
      await fs.chmod(temp, 0o600);
      await fs.rename(temp, this.keyPath);
      await fs.chmod(this.keyPath, 0o600);
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    return true;
  }

  async search(query, options = {}) {
    const q = searchTerm(query);
    if (!q || q.length > 100) return [];
    const key = await this.key();
    if (!key) return [];
    const lang = options.lang || 'pt';
    const fingerprint = crypto.createHash('sha256').update([q.toLowerCase(), lang, 'film'].join('|')).digest('hex');
    const cacheFile = path.join(this.cachePath, 'search', fingerprint + '.json');
    try {
      const data = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (this.now() - data.savedAt < CACHE_MS && Array.isArray(data.hits)) return data.hits;
    } catch (_) { /* cache miss */ }

    const url = 'https://pixabay.com/api/videos/';
    let response;
    try {
      response = await this.http.get(url, {
        params: { key, q, lang, video_type: 'film', safesearch: 'true', per_page: 10, order: 'popular' },
        timeout: 15000, maxRedirects: 0
      });
    } catch (error) {
      const status = error.response?.status;
      throw new Error(status === 429 ? 'Pixabay: limite de solicitações atingido.' :
        status === 401 || status === 403 ? 'Pixabay: chave rejeitada pela API.' : 'Pixabay: busca indisponível.');
    }
    const hits = Array.isArray(response.data?.hits) ? response.data.hits : [];
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, JSON.stringify({ savedAt: this.now(), hits }), 'utf8');
    return hits;
  }

  rank(hits, query, excludedIds = new Set()) {
    const terms = new Set(keywords(query));
    return hits.filter(hit => !excludedIds.has(hit.id) &&
      Boolean(hit.videos?.medium?.url || hit.videos?.small?.url))
      .map(hit => {
        const tags = new Set(keywords(hit.tags));
        const overlap = [...terms].filter(term => tags.has(term)).length;
        const ratio = Number(hit.videos?.medium?.width || hit.videos?.small?.width || 0) /
          Math.max(1, Number(hit.videos?.medium?.height || hit.videos?.small?.height || 1));
        const score = overlap * 15 + (ratio >= 1.3 ? 3 : -3) +
          (hit.duration >= 5 && hit.duration <= 45 ? 3 : 0) + Math.min(3, Math.log10(1 + (hit.downloads || 0)));
        return { hit, score };
      }).sort((a, b) => b.score - a.score).map(item => item.hit);
  }

  rendition(hit) {
    const options = [hit.videos?.medium, hit.videos?.small, hit.videos?.tiny];
    return options.find(video => video && safeHost(video.url) && video.size > 0 && video.size <= MAX_CLIP_BYTES) || null;
  }

  async download(hit) {
    if (!Number.isSafeInteger(hit?.id) || hit.id < 1) throw new Error('ID de vídeo Pixabay inválido.');
    const video = this.rendition(hit);
    if (!video) throw new Error('Vídeo sem arquivo permitido na resolução ou tamanho configurado.');
    const clipDir = path.join(this.cachePath, 'clips');
    const target = path.join(clipDir, hit.id + '-' + video.width + 'x' + video.height + '.mp4');
    const metaFile = target + '.source.json';
    await fs.mkdir(clipDir, { recursive: true });
    try {
      const stat = await fs.stat(target);
      if (stat.size > 1024 && stat.size <= MAX_CLIP_BYTES) return this.metadata(hit, target, true);
    } catch (_) { /* need download */ }

    let response;
    try {
      response = await this.http.get(video.url, { responseType: 'stream', timeout: 30000,
        maxRedirects: 0, maxContentLength: MAX_CLIP_BYTES, validateStatus: n => n === 200 });
    } catch (_) { throw new Error('Pixabay: download do clipe falhou.'); }
    const length = Number(response.headers?.['content-length'] || 0);
    const mime = String(response.headers?.['content-type'] || '').toLowerCase();
    if (length > MAX_CLIP_BYTES || (mime && !/^(video\/|application\/octet-stream)/.test(mime))) {
      response.data.destroy?.();
      throw new Error('Resposta de download não é um MP4 permitido.');
    }
    const temp = target + '.' + process.pid + '.part';
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, cb) {
        bytes += chunk.length;
        cb(bytes > MAX_CLIP_BYTES ? new Error('Vídeo excedeu o limite de 35 MB.') : null, chunk);
      }
    });
    try {
      const { createWriteStream } = require('node:fs');
      await pipeline(response.data, limiter, createWriteStream(temp, { flags: 'wx' }));
      if (bytes < 1024) throw new Error('O clipe recebido está vazio.');
      await fs.rename(temp, target);
      const source = this.metadata(hit, target, false);
      await fs.writeFile(metaFile, JSON.stringify(source, null, 2), 'utf8');
      return source;
    } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
  }

  metadata(hit, target, cached) {
    return { source: 'Pixabay', id: hit.id, path: target, url: hit.pageURL || 'https://pixabay.com/videos/id-' + hit.id + '/',
      author: hit.user || 'Pixabay contributor', tags: hit.tags || '',
      duration: Number(hit.duration || 0), license: LICENSE_URL, cached };
  }

  async acquire(script, productionId, logger = console) {
    if (!(await this.configured())) return [];
    const sections = Array.isArray(script?.mainContent?.sections) ? script.mainContent.sections : [];
    const regularTerms = [...new Set([...(sections.map(s => searchTerm(s.title)).filter(Boolean)), searchTerm(script?.title)].filter(Boolean))].slice(0, 3);
    const iagora = Boolean(require('./iagora-editorial').getEditorialProfile());
    // IAgora editorial headlines are Portuguese. Search Pixabay stock video
    // in English with subject-specific terms; the API's stock tags are often English.
    const terms = iagora
      ? await new (require('./free-thumbnail-service').FreeThumbnailService)().getQueries(script,{})
      : regularTerms;
    const found = [];
    const used = new Set();
    // Three targeted queries, at most six downloaded clips for IAgora.
    for (const query of terms) {
      try {
        const hits = this.rank(await this.search(query, { lang: iagora ? 'en' : 'pt' }), query, used);
        let picked = 0;
        for (const hit of hits.slice(0, 4)) {
          const candidate = this.rendition(hit);
          if (!candidate) continue;
          const clip = await this.download(hit);
          found.push({ ...clip, query });
          used.add(hit.id);
          picked++;
          if (!iagora || picked >= 2) break;
        }
      } catch (error) {
        logger.warn?.('Pixabay: cena não encontrada: ' + error.message);
      }
    }
    if (found.length && productionId && /^prod_[a-zA-Z0-9_-]+$/.test(productionId)) {
      const dest = path.join(this.cachePath, 'manifests');
      await fs.mkdir(dest, { recursive: true });
      await fs.writeFile(path.join(dest, productionId + '.json'), JSON.stringify({
        provider: 'Pixabay', license: LICENSE_URL, savedAt: new Date(this.now()).toISOString(),
        clips: found
      }, null, 2));
    }
    return found;
  }
}

module.exports = { PixabayVideoService, safeHost, keywords, MAX_CLIP_BYTES, CACHE_MS };
