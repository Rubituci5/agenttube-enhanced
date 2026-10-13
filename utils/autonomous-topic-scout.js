'use strict';

// IAgora automatic editorial research. Sources are fixed, vetted RSS feeds;
// no arbitrary URL fetching, no paid research API, no generated "news" facts.
const { fetchEvidence } = require('./autonomous-editorial-audit');

const FEEDS = Object.freeze([
  { url: 'https://blog.google/technology/ai/rss/', host: 'blog.google', publisher: 'Google AI', weight: 9 },
  { url: 'https://huggingface.co/blog/feed.xml', host: 'huggingface.co', publisher: 'Hugging Face', weight: 7 },
  { url: 'https://www.nature.com/nature.rss', host: 'www.nature.com', publisher: 'Nature', weight: 10 },
  { url: 'https://www.nasa.gov/feed/', host: 'www.nasa.gov', publisher: 'NASA', weight: 9 }
]);

const EVERGREEN = Object.freeze([
  { topic: 'Como uma inteligência artificial reconhece padrões sem realmente compreender o mundo?',
    url: 'https://www.nist.gov/itl/ai-risk-management-framework' },
  { topic: 'O que o telescópio James Webb realmente pode revelar sobre o universo?',
    url: 'https://science.nasa.gov/mission/webb/' },
  { topic: 'O que é possível descobrir com as imagens do telescópio Hubble?',
    url: 'https://science.nasa.gov/mission/hubble/' },
  { topic: 'Quais são os limites reais da previsão de estruturas de proteínas por inteligência artificial?',
    url: 'https://deepmind.google/science/alphafold/' },
  { topic: 'Como são avaliados os riscos de sistemas de inteligência artificial?',
    url: 'https://www.nist.gov/itl/ai-risk-management-framework' },
  { topic: 'Por que a exploração robótica de Marte ainda é tão difícil?',
    url: 'https://science.nasa.gov/mars/' },
  { topic: 'O que distingue um modelo de inteligência artificial confiável de uma simples demonstração?',
    url: 'https://www.nist.gov/artificial-intelligence' },
  { topic: 'Como os robôs exploram Marte sem ajuda constante de humanos?', url: 'https://science.nasa.gov/mars/' },
  { topic: 'Como o telescópio Webb consegue observar galáxias antigas?', url: 'https://science.nasa.gov/mission/webb/' },
  { topic: 'O que observamos quando apontamos o Hubble para regiões distantes do espaço?', url: 'https://science.nasa.gov/mission/hubble/' },
  { topic: 'Por que o risco de uma inteligência artificial depende de como ela é utilizada?', url: 'https://www.nist.gov/itl/ai-risk-management-framework' },
  { topic: 'Como as sondas espaciais enviam informações de lugares tão distantes?', url: 'https://science.nasa.gov/' },
  { topic: 'Quais são os desafios de enviar pessoas novamente à Lua?', url: 'https://www.nasa.gov/' },
  { topic: 'Como cientistas identificam planetas fora do nosso sistema solar?', url: 'https://science.nasa.gov/exoplanets/' },
  { topic: 'O que é possível investigar sobre o Sol sem se aproximar demais?', url: 'https://science.nasa.gov/sun/' },
  { topic: 'Por que os cientistas estudam asteroides e cometas?', url: 'https://science.nasa.gov/solar-system/' },
  { topic: 'Como a tecnologia ajuda a observar o clima do planeta Terra?', url: 'https://science.nasa.gov/earth/' },
  { topic: 'O que realmente sabemos sobre buracos negros?', url: 'https://science.nasa.gov/universe/black-holes/' },
  { topic: 'Como pesquisadores verificam a confiabilidade de resultados produzidos por IA?', url: 'https://www.nist.gov/artificial-intelligence' },
  { topic: 'O que torna sistemas autônomos difíceis de testar com segurança?', url: 'https://www.nist.gov/itl/ai-risk-management-framework' }
]);
const KEYWORD = /(?:\bai\b|\bia\b|artificial intelligence|intelig[eê]ncia artificial|machine learning|deep learning|neural|neuron|neuro|brain|cerebr|quantum|qu[aâ]ntic|science|cient[ií]fic|research|pesquisa|discover|descobert|robot|rob[oô]|space|espac|mars|marte|telescope|telesc[oó]p|genom|protein|prote[ií]n|technology|tecnolog|black hole|buraco negro|astronom|comput)/i;
const PROMOTIONAL = /\b(sponsor(?:ed)?|deal|discount|sale|giveaway|buy now|webinar|advertisement)\b/i;
const STOP = new Set(('a o as os e em de da do das dos um uma no na nos nas ao aos para por com que como ' +
  'sobre mais esta este isso voce você sao são elas eles foi ser tem ter entre contra from with the and a of ' +
  'to in on for an is are how why what new study using could can has have into does says de novo um').split(/\s+/));

function decodeXml(value) {
  return String(value || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => {
      const v = n.toLowerCase().startsWith('x') ? parseInt(n.slice(1), 16) : parseInt(n, 10);
      return v > 0 && v <= 0x10ffff ? String.fromCodePoint(v) : '';
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) =>
      ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity.toLowerCase()])
    .replace(/\s+/g, ' ').trim();
}

function tag(xml, label) {
  const match = String(xml).match(new RegExp('<(?:[\\w.-]+:)?' + label + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?' + label + '\\s*>', 'i'));
  return decodeXml(match ? match[1] : '');
}

function parseFeed(xml, source, now = Date.now()) {
  const entries = [...String(xml).matchAll(/<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi)];
  const recent = [];
  for (const [, raw] of entries.slice(0, 65)) {
    const title = tag(raw, 'title').slice(0, 190);
    let link = tag(raw, 'link');
    if (!link) link = (raw.match(/<link\s+[^>]*href=["']([^"']+)["'][^>]*\/?\s*>/i) || [])[1] || '';
    const timestamp = Date.parse(tag(raw, 'pubDate') || tag(raw, 'published') || tag(raw, 'updated') || tag(raw, 'date'));
    if (!title || title.length < 23 || !Number.isFinite(timestamp) ||
        timestamp > now + 3600000 || now - timestamp > 21 * 86400000 ||
        !KEYWORD.test(title) || PROMOTIONAL.test(title)) continue;
    let url;
    try {
      url = new URL(link);
      if (url.protocol !== 'https:' || url.hostname !== source.host || url.username || url.password) continue;
      url.hash = '';
    } catch (_) { continue; }
    recent.push({
      topic: title, sourceUrl: url.toString(), publisher: source.publisher,
      publishedAt: new Date(timestamp).toISOString(), sourceWeight: source.weight,
      sourceType: source.weight >= 9 ? 'official' : 'article',
      excerpt: tag(raw, 'description').slice(0, 450)
    });
  }
  return recent;
}

function tokens(value) {
  return [...new Set(String(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(word => (word.length > 2 || word === 'ai' || word === 'ia') && !STOP.has(word))
    .map(word => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word))];
}

function duplicate(a, b) {
  const left = new Set(tokens(a)); const right = new Set(tokens(b));
  if (!left.size || !right.size) return false;
  const common = [...left].filter(x => right.has(x)).length;
  const union = left.size + right.size - common;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase() ||
    (common >= 3 && (common / union >= .52 || common / Math.min(left.size, right.size) >= .75));
}

class AutonomousTopicScout {
  constructor(db, options = {}) {
    this.db = db;
    this.fetchFeed = options.fetchFeed || this.fetchFeedFromWeb.bind(this);
    this.validateArticle = options.validateArticle || (async candidate => {
      const result = await fetchEvidence({url:candidate.sourceUrl});
      return result.text;
    });
    this.sources = options.sources || FEEDS;
    this.now = options.now || (() => Date.now());
  }

  async fetchFeedFromWeb(url) {
    // Fixed URLs only, no redirects to arbitrary hosts or private networks.
    const response = await fetch(url, {
      redirect: 'error', signal: AbortSignal.timeout(9500),
      headers: { accept: 'application/rss+xml,application/atom+xml,application/xml,text/xml' }
    });
    if (!response.ok) throw new Error('Feed HTTP ' + response.status);
    const bytes = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1_000_000) throw new Error('Feed too large');
      bytes.push(chunk);
    }
    return Buffer.concat(bytes).toString('utf8');
  }

  async recentTopics() {
    const [jobs, strategies, ideas] = await Promise.all([
      this.db.getAllRows("SELECT topic FROM generation_jobs WHERE topic IS NOT NULL AND created_at >= datetime('now','-120 days') ORDER BY created_at DESC LIMIT 160"),
      this.db.getAllRows("SELECT topic FROM content_strategies WHERE created_at >= datetime('now','-120 days') ORDER BY created_at DESC LIMIT 160"),
      this.db.getAllRows("SELECT topic FROM content_ideas WHERE status != 'archived' ORDER BY created_at DESC LIMIT 160")
    ]);
    return [...new Set([...jobs, ...strategies, ...ideas].map(row => row.topic).filter(Boolean))];
  }

  async selectTopic() {
    const historical = await this.recentTopics();
    const checkedAt = this.now();
    const responses = await Promise.allSettled(this.sources.map(async feed => {
      const xml = await this.fetchFeed(feed.url);
      return parseFeed(xml, feed, checkedAt);
    }));
    const candidates = responses.flatMap(response =>
      response.status === 'fulfilled' ? response.value : []);
    candidates.sort((a, b) => {
      const score = item => item.sourceWeight * 10 +
        12 * Math.max(0, 1 - ((checkedAt - Date.parse(item.publishedAt)) / 86400000) / 21) +
        (/(?:artificial intelligence|ai\b|inteligencia artificial|\bia\b|brain|space|quantum)/i.test(item.topic) ? 10 : 0);
      return score(b) - score(a);
    });
    // RSS alone is not evidence. Skip articles whose original webpage cannot
    // be read, because they would fail the stricter factual audit anyway.
    const available = candidates
      .filter(item => !historical.some(old => duplicate(item.topic, old)))
      .slice(0, 8);
    const reachable = await Promise.all(available.map(async item => {
      try {
        const text = await this.validateArticle(item);
        return text ? {...item, evidenceExcerpt: typeof text === 'string' ? text.slice(0,5600) : ''} : null;
      } catch (_) { return null; }
    }));
    const selected = reachable.find(Boolean);
    if (selected) return {
      topic: selected.topic, style: 'story', length: 'medium',
      selection: 'verified-feed-headline',
      researchSources: [{
        url: selected.sourceUrl, title: selected.topic,
        publisher: selected.publisher, publishedAt: selected.publishedAt,
        sourceType: selected.sourceType, status: 'pending',
        notes: 'Automatically discovered RSS headline; factual claims still require independent verification.',
        excerpt: selected.evidenceExcerpt || ''
      }],
      rationale: 'Recent article from ' + selected.publisher + '. Editorial facts and media rights must be verified before publication.'
    };

    const alternatives = EVERGREEN.filter(item =>
      !historical.some(old => duplicate(item.topic, old)));
    const checked = await Promise.all(alternatives.slice(0, 5).map(async choice => {
      try {
        const text = await this.validateArticle({sourceUrl:choice.url,topic:choice.topic});
        return text ? {...choice,evidenceExcerpt:typeof text === 'string' ? text.slice(0,5600) : ''} : null;
      } catch (_) { return null; }
    }));
    const choice = checked.find(Boolean);
    if (!choice) throw new Error('No accessible, non-duplicated editorial sources; retry later.');
    return {
      topic: choice.topic, style: 'story', length: 'medium',
      selection: 'evergreen-fallback',
      researchSources: choice.url ? [{
        url: choice.url, title: choice.topic, publisher: new URL(choice.url).hostname,
        sourceType: 'official', status: 'pending',
        notes: 'Curated reference page; still requires actual claim-by-claim checks.',
        excerpt: choice.evidenceExcerpt || ''
      }] : [],
      rationale: 'Editorial evergreen fallback because fresh feed signals were unavailable or repeated.'
    };
  }
}

module.exports = { AutonomousTopicScout, FEEDS, EVERGREEN, parseFeed, duplicate };
