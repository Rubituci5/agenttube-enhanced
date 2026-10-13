'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SETTINGS_FILE = path.join(ROOT, 'config', 'perfil-editorial-iagora.json');
const CHANNEL_FILE = path.join(ROOT, 'config', 'canal-youtube-ativo.json');

function getEditorialProfile() {
  try {
    const selected = JSON.parse(fs.readFileSync(CHANNEL_FILE, 'utf8'));
    const profile = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    if (selected.channelId !== profile.channelId || selected.projectId !== profile.googleProject) {
      return null;
    }
    return profile;
  } catch (_error) {
    return null;
  }
}

function editorialBrief(stage = 'general') {
  const p = getEditorialProfile();
  if (!p) return '';
  const core = [
    `CANAL: ${p.brand} (@IAgoranews); LINGUA OBRIGATORIA: portugues brasileiro (pt-BR).`,
    `POSICIONAMENTO: ${p.positioning}`,
    `PUBLICO: ${p.audience}`,
    `PROMESSA: ${p.brandPromise}`,
    `PILARES E PESOS SUGERIDOS: ${p.contentPillars.map(x => `${x.name} (${x.weight}%)`).join('; ')}`,
    'NUNCA invente dados, noticias, estudos, fontes, imagens documentais ou resultados cientificos.',
    'Separe claramente fatos verificados, hipoteses, especulacoes e ficcao.',
    'Evite promessas de imortalidade, telepatia ou controle da materia como descobertas cientificas comprovadas.'
  ];
  if (stage === 'strategy') {
    return [...core,
      `APRENDIZADOS: ${p.lessons.join(' ')}`,
      'Prefira temas concretos com pesquisa verificavel, novidade intelectual, consequencia humana e possibilidade de imagens pertinentes.',
      'Quando nao houver fonte confiavel, nao invente a noticia e opte por um tema cientifico evergreen verificavel.',
      `TITULOS: ${p.narrative.titleRule}`
    ].join('\n');
  }
  if (stage === 'script') {
    return [...core,
      `FORMATO: ${p.narrative.style}`,
      `NARRACAO: ${p.narrative.voice}`,
      `ABERTURA: ${p.narrative.hookRule}`,
      `ATOS: ${p.narrative.sequence.join(' ')}`,
      `SHORTS: ${p.narrative.shortFormat}`,
      `LONGOS: ${p.narrative.longFormat}`,
      'Escreva TODO o conteudo narrado em portugues brasileiro fluente, mesmo quando os dados/fontes estiverem em ingles.',
      'Nao inclua frases vazias, pedidos de inscricao antes de contar a historia ou repeticao artificial.',
      'Marque afirmacoes importantes para verificacao humana e nao atribua URLs que nao estejam nas fontes fornecidas.'
    ].join('\n');
  }
  if (stage === 'seo') {
    return [...core,
      `TITULOS: ${p.narrative.titleRule}`,
      `DESCRICAO: ${p.seo.description}`,
      `TAGS: ${p.seo.tags}`,
      `EXEMPLOS DE ESTILO (NAO COPIAR): ${p.seo.titleExamples.join('; ')}`,
      'Retorne titulo, descricao, tags e capitulos somente em portugues brasileiro. Evite clickbait enganoso.'
    ].join('\n');
  }
  if (stage === 'visual') {
    return [...core,
      `VISUAL: ${p.visual.style}`,
      `CAPAS: ${p.visual.thumbnails}`,
      `IMAGENS: ${p.visual.stock}`,
      `EVITAR: ${p.visual.avoid.join('; ')}`,
      'Se imagens reais de um evento nao estiverem disponiveis, use ilustracoes pertinentes sem apresentá-las como imagens autênticas.'
    ].join('\n');
  }
  return core.join('\n');
}

function fallbackTopics() {
  if (!getEditorialProfile()) return null;
  return [
    'O que os computadores feitos com neuronios vivos realmente conseguem fazer?',
    'O que sabemos sobre cristais do tempo e suas aplicacoes reais?',
    'Inteligencias artificiais que tentam evitar o desligamento: o que os testes mostram?',
    'Implantes cerebrais e IA: quais avancos sao reais e quais riscos ainda existem?',
    'O que acontece quando uma IA inventa uma informacao e ninguem percebe?',
    'Cientistas ja conseguem fazer computadores lerem sinais do cerebro?',
    'Descobertas cientificas que pareciam impossiveis e foram comprovadas',
    'Maquinas e humanos: como a inteligencia artificial muda a medicina',
    'Misterios historicos que a ciencia conseguiu explicar recentemente',
    'Que tecnologias reais ja mudam o comportamento humano sem percebermos?'
  ];
}

module.exports = { getEditorialProfile, editorialBrief, fallbackTopics };
