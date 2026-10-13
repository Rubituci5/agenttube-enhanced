'use strict';

// Unattended publication is permitted only when the factual and media-rights
// checks both pass. A model's confidence alone is NEVER publication evidence.
// Any unavailable webpage, unverifiable quote, mismatch or missing stock
// license holds the draft for operator review rather than guessing.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const axios = require('axios');
const { AITextService } = require('./ai-text-service');
const { ProvenanceService } = require('./provenance-service');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const PIXABAY_LICENSE = 'https://pixabay.com/service/license-summary/';
const AUTHORIZED_EVIDENCE_HOSTS = new Set([
  'blog.google', 'huggingface.co', 'www.nature.com', 'www.nasa.gov',
  'science.nasa.gov', 'www.nist.gov',
  'deepmind.google', 'www.nih.gov', 'www.nasa.gov',
]);
function plain(html) {
  const s = String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[^]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
      const v = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : +n;
      return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : '';
    }).replace(/&(amp|lt|gt|quot|apos|nbsp|hellip|mdash|ndash);/gi, (_, e) => ({
      amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',hellip:'…',mdash:'-',ndash:'-'
    })[e.toLowerCase()]);
  return s.replace(/\s+/g,' ').trim();
}
function articleBody(html) {
  const raw = String(html || '');
  const main = raw.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const article = raw.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  return (main?.[1] || article?.[1] || raw)
    .replace(/<(nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
}
function normalized(s) {
  return String(s || '').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
}
function jsonFromText(raw) {
  const text = String(raw || '').replace(/^\s*```(?:json)?/i,'').replace(/```\s*$/,'').trim();
  try { return JSON.parse(text); } catch (_) {
    const open = text.indexOf('{'), close = text.lastIndexOf('}');
    if (open < 0 || close <= open) throw Error('Editorial auditor returned invalid JSON');
    return JSON.parse(text.slice(open, close + 1));
  }
}
function trustedUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password &&
      !u.port && AUTHORIZED_EVIDENCE_HOSTS.has(u.hostname) && !u.hash;
  } catch (_) { return false; }
}
async function fetchEvidence(source, http = axios) {
  if (!trustedUrl(source.url)) throw Error('Evidence is not hosted by an approved editorial publisher');
  const res = await http.get(source.url, {
    timeout: 13000, maxRedirects: 0, responseType: 'text',
    maxContentLength: 650000, maxBodyLength: 650000,
    headers: {'Accept': 'text/html,text/plain,application/xhtml+xml'},
    validateStatus: s => s === 200
  });
  if (!/html|text\/plain|xhtml/i.test(String(res.headers?.['content-type'] || ''))) {
    throw Error('Editorial source did not return an article page');
  }
  const articleText = plain(articleBody(res.data));
  if (articleText.length < 550) throw Error('Source article returned insufficient readable content');
  return { ...source, text: articleText.slice(0, 15000) };
}
function issuesReport(reason) {
  return { passed: false, reason, sourceCount: 0, claimCount: 0 };
}
class AutonomousEditorialAudit {
  constructor(db, credentials, options = {}) {
    this.db = db;
    this.credentials = credentials;
    this.fetchEvidence = options.fetchEvidence || fetchEvidence;
    this.aiText = options.aiText || new AITextService(credentials?.credentials || credentials || {});
    this.provenance = options.provenance || new ProvenanceService(db);
    this.mediaAudit = options.mediaAudit || this.verifyMediaRights.bind(this);
  }

  async verifyFacts(productionId, production) {
    if (String(production.script?.fullScript || '').length > 24000) return issuesReport('Narrated script exceeds the complete audit budget');
    const old = await this.db.getContentProvenance(productionId);
    if (!old || !old.sources?.length || !old.claims?.length) {
      return issuesReport('Automatic approval requires explicitly listed factual claims AND first-party references');
    }
    if (old.claims.length > 24) return issuesReport('Too many claims to safely check automatically in a single audit');
    if (!this.aiText.isAvailable()) return issuesReport('Live independent textual review model unavailable');
    const evidence = [];
    for (const source of old.sources.slice(0, 4)) {
      try { evidence.push(await this.fetchEvidence(source)); }
      catch (_) { /* Unreachable/blocked sources are never marked verified. */ }
    }
    if (!evidence.length) return issuesReport('No cited primary source could be fetched and read');
    const catalog = evidence.map(s => ({id:s.id,url:s.url,publisher:s.publisher,sourceText:s.text.slice(0,12000)}));
    const claims = old.claims.map((c,i) => ({
      index:i,claim:c.text,risk:c.riskLevel,
      sourceIds:c.sourceIds
    }));
    const auditPrompt = `Independent conservative Brazilian science editorial fact checker.
Given the EXACT first-party article excerpts and a list of factual claims,
produce JSON and NOTHING ELSE:
{"checks":[{"index":0,"sourceId":"literal source id in list","quote":"an EXACT verbatim sentence or passage from sourceText proving the claim","supported":true}],"uncheckedStatements":["factual statement present in script or published copy but not covered by any supplied claim"]}
RULES: Match the actual meaning, time, uncertainty and quantities of the claim.
If unsupported or doubtful, supported=false with quote="". Never invent, paraphrase,
translate or alter the quote; it must appear verbatim in the provided sourceText.
A usable quote must contain at least 36 characters. For a short fact-table value such as a date, include contiguous surrounding text from the same source to provide that context; do not concatenate separate passages. If no such exact contextual passage exists, mark unsupported.
Audit the FULL narrated script AND the actual published title, description and thumbnail headline separately for additional externally verifiable assertions. A metadata statement must be covered by the same supplied claims; reject invented implications, quantities, dates or technical explanations.
Mark ALL uncovered factual statements in uncheckedStatements; do not omit them.
Do not treat the publisher's URL or the headline alone as evidence.
Return one check per claim index; reject anything without explicit support.
Source catalog:\n${JSON.stringify(catalog)}
Claims:\n${JSON.stringify(claims)}
Full narrated script:\n${String(production.script?.fullScript || '').slice(0,24000)}
Actual published copy:\n${JSON.stringify({...publishedCopy(production),script:undefined})}`;
    let result;
    try { result = jsonFromText(await this.aiText.generateText(auditPrompt, {maxTokens:2600,temperature:0})); }
    catch (error) { return issuesReport('Evidence verification unavailable: ' + String(error.message || error).slice(0,150)); }
    if (!Array.isArray(result.checks) || result.checks.length !== claims.length ||
        !Array.isArray(result.uncheckedStatements) || result.uncheckedStatements.length) {
      return { ...issuesReport('Script contains additional factual statements or the evidence audit is incomplete'), uncheckedStatements: Array.isArray(result.uncheckedStatements) ? result.uncheckedStatements.slice(0,16).map(value => String(value).slice(0,500)) : [] };
    }
    const checksByIndex = new Map();
    for (const c of result.checks) {
      if (!Number.isInteger(c.index) || checksByIndex.has(c.index)) {
        return issuesReport('Claim identifiers are inconsistent');
      }
      checksByIndex.set(c.index,c);
    }
    const verifiedSources = old.sources.map(s => ({
      ...s, status: evidence.some(e => e.id === s.id) ? 'verified' : 'pending',
      notes: evidence.some(e => e.id === s.id)
        ? 'Retrieved from original website for autonomous evidence audit'
        : 'Original document was not retrievable'
    }));
    const reviewed = [];
    for (let i=0; i<old.claims.length; i++) {
      const claim = old.claims[i], c = checksByIndex.get(i);
      const src = evidence.find(s => s.id === c?.sourceId);
      const quote = String(c?.quote || '').trim();
      const support = c?.supported === true && src && claim.sourceIds.includes(src.id) &&
        quote.length >= 36 && normalized(src.text).includes(normalized(quote));
      // Conservative: require two independent sources for high-risk assertions.
      // Until multi-source claim-level corroboration exists, hold them.
      if (!support || claim.riskLevel === 'high') {
        return issuesReport('Unverified or high-risk factual assertion: ' + claim.text.slice(0,130));
      }
      reviewed.push({
        ...claim,status:'supported',sourceIds:[src.id],
        notes:'Automatically checked against a verbatim excerpt from ' + src.publisher +
          ': "' + quote.slice(0,200) + '"'
      });
    }
    const verified = this.provenance.build({
      sources:verifiedSources,claims:reviewed,
      containsSyntheticMedia: production.containsSyntheticMedia === true
    });
    if (verified.status !== 'verified') return issuesReport('Evidence remained unverified');
    await this.db.saveContentProvenance(productionId,verified);
    return {passed:true,reason:'All enumerated claims supported by original-page excerpts; no extra assertions flagged',
      sourceCount:evidence.length,claimCount:reviewed.length,provenance:verified};
  }

  async verifyMediaRights(production) {
    try {
      const videoPath = production.assets?.finalVideo?.path;
      const audioPath = production.assets?.audio?.path;
      if (!videoPath || !audioPath) throw Error('Missing video or narration');
      if (production.assets?.finalVideo?.provider?.actualProvider !== 'pixabay-stock')
        throw Error('Final video was not assembled from verified Pixabay stock footage');
      const [video,audio] = await Promise.all([fs.stat(videoPath),fs.stat(audioPath)]);
      if (!video.isFile() || video.size < 40000 || !audio.isFile() || audio.size < 1024) throw Error('Media missing or empty');
      const probe = JSON.parse((await execFileAsync(process.env.FFPROBE_PATH || 'ffprobe',[
        '-v','error','-show_entries','stream=codec_type','-of','json',videoPath
      ],{timeout:25000})).stdout);
      if (!probe.streams?.some(s => s.codec_type === 'audio') ||
          !probe.streams?.some(s => s.codec_type === 'video')) throw Error('MP4 missing audio or video track');
      const thumbnail = production.thumbnail || {};
      if (thumbnail.source !== 'pixabay-free-composite' ||
          !Array.isArray(thumbnail.references) || !thumbnail.references.length ||
          thumbnail.references.some(s => s.license !== PIXABAY_LICENSE ||
            !Number.isInteger(s.id) || !/^https:\/\/pixabay\.com\//.test(s.url || ''))) {
        throw Error('Thumbnail stock license or provenance missing');
      }
      if (!production.assets?.thumbnail?.path) throw Error('Thumbnail file unavailable');
      if (path.resolve(production.assets.thumbnail.path) !== path.resolve(thumbnail.path))
        throw Error('Reviewed and uploaded thumbnail paths do not match');
      await fs.stat(production.assets.thumbnail.path);
      const music = production.assets?.music;
      if (process.env.BACKGROUND_MUSIC_ENABLED !== 'false' &&
          (!music || music.status !== 'ready' || music.license !== 'CC0-1.0' ||
            music.voiceDucking !== true || !music.sourceUrl ||
            music.licenseUrl !== 'https://creativecommons.org/publicdomain/zero/1.0/' ||
            !music.sourceUrl.startsWith('https://raw.githubusercontent.com/0lhi/FreePD/')))
        throw Error('Music license and ducking not confirmed');
      if (music?.path) {
        const st = await fs.stat(music.path);
        if (!st.isFile() || st.size < 2048) throw Error('Background music file unavailable');
      }
      const id = production.id;
      if (!/^prod_[a-zA-Z0-9_-]+$/.test(id)) throw Error('Invalid production ID for stock manifest');
      const manifestFile = path.join(ROOT,'data','stock','pixabay','manifests',id+'.json');
      const manifest = JSON.parse(await fs.readFile(manifestFile,'utf8'));
      if (manifest.provider !== 'Pixabay' || manifest.license !== PIXABAY_LICENSE ||
          !Array.isArray(manifest.clips) || manifest.clips.length===0 ||
          manifest.clips.some(c => c.license !== PIXABAY_LICENSE ||
            !Number.isInteger(c.id) || !/^https:\/\/pixabay\.com\//.test(c.url || '') ||
            !c.author || !c.path)) throw Error('Pixabay video stock license incomplete');
      for (const c of manifest.clips) {
        const stat = await fs.stat(c.path);
        if (!stat.isFile() || stat.size < 1024 ||
            !path.resolve(c.path).startsWith(path.join(ROOT,'data','stock','pixabay','clips') + path.sep)) {
          throw Error('Unrecognized or missing stock video clip');
        }
      }
      if (production.scenes?.some(scene => scene.assetOrigin === 'uploaded' ||
        scene.rightsConfirmed === false || scene.containsSyntheticMedia === true)) {
        throw Error('Unlicensed, unknown or synthetic scene in final content');
      }
      return {passed:true,reason:'All media sourced to Pixabay and FreePD with recorded licenses',
        videoClips:manifest.clips.length,thumbnailImages:thumbnail.references.length};
    } catch (error) {
      return issuesReport('Rights or media-integrity gate: ' + String(error.message || error).slice(0,160));
    }
  }

  async audit(productionId, production) {
    const factual = await this.verifyFacts(productionId, production);
    if (!factual.passed) return {passed:false,factual,media:null};
    const media = await this.mediaAudit(production);
    return {passed:media.passed,factual,media};
  }
}

function publishedCopy(production) {
  return {
    title: production.seo?.title || production.script?.title || '',
    description: production.seo?.description || '',
    thumbnailHeadline: production.thumbnail?.concept?.primaryText || production.thumbnail?.headline || production.assets?.thumbnail?.headline || '',
    thumbnailSecondary: production.thumbnail?.concept?.secondaryText || '',
    script: production.script?.fullScript || ''
  };
}
async function approvalFingerprints(production) {
  const crypto = require('node:crypto');
  const copyHash = crypto.createHash('sha256').update(JSON.stringify(publishedCopy(production))).digest('hex');
  const mediaHashes = {};
  for (const [kind, filename] of Object.entries({video:production.assets?.finalVideo?.path, audio:production.assets?.audio?.path, thumbnail:production.assets?.thumbnail?.path})) {
    if (!filename) throw Error('Approved media path missing');
    const digest = crypto.createHash('sha256');
    for await (const bytes of require('node:fs').createReadStream(filename)) digest.update(bytes);
    mediaHashes[kind] = digest.digest('hex');
  }
  return {copyHash, mediaHashes};
}
async function matchesApproval(production, stamp) {
  if (!stamp?.copyHash || !stamp?.mediaHashes) return false;
  try {
    const actual = await approvalFingerprints(production);
    return actual.copyHash === stamp.copyHash && ['video','audio','thumbnail'].every(key => actual.mediaHashes[key] === stamp.mediaHashes[key]);
  } catch (_) { return false; }
}
module.exports = { AutonomousEditorialAudit, fetchEvidence, plain, articleBody, normalized, trustedUrl, jsonFromText, publishedCopy, approvalFingerprints, matchesApproval };
