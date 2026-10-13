// Textos da interface e mensagens dinâmicas. Não traduz identificadores de API,
// estados persistidos, URLs, valores de formulários ou conteúdo do usuário.
(() => {
  'use strict';
  const words = {
    'OPERATOR OVERVIEW':'VISÃO GERAL DO OPERADOR',
    'AUTONOMOUS OPERATOR':'OPERADOR AUTÔNOMO',
    'CONTENT OPERATIONS':'OPERAÇÃO DE CONTEÚDO',
    'EDITORIAL PLANNING':'PLANEJAMENTO EDITORIAL',
    'PERFORMANCE':'DESEMPENHO',
    'AUDIENCE ENGAGEMENT':'ENGAJAMENTO DA AUDIÊNCIA',
    'PRODUCTION READINESS':'PRONTIDÃO DE PRODUÇÃO',
    'CHANNEL GUARDRAILS':'DIRETRIZES DO CANAL',
    'Know what happens next.':'Saiba o que vem a seguir.',
    'Give Lumen the strategy.':'Defina a estratégia do Lumen.',
    'From idea to published.':'Da ideia à publicação.',
    'Plan before you generate.':'Planeje antes de produzir.',
    'Turn results into the next move.':'Transforme dados em decisões.',
    'Talk with the people watching.':'Converse com a sua audiência.',
    'Verify before autonomy runs.':'Verifique antes de automatizar.',
    'Make every agent sound like you.':'Faça os agentes refletirem sua voz.',
    'Overview':'Visão geral','Operator':'Operador','Pipeline':'Produção',
    'Calendar':'Calendário','Analytics':'Análises','Readiness':'Prontidão',
    'Setup':'Configurações','Home':'Início','Stats':'Estatísticas','Checks':'Verificações',
    'Automation paused':'Automação pausada','Resume automation':'Retomar automação',
    'Pause automation':'Pausar automação','Setup required':'Configuração necessária',
    'Dashboard unavailable':'Painel indisponível',
    'Quality':'Qualidade','Review':'Revisar','View':'Ver','Generate':'Gerar',
    'Cancel':'Cancelar','Resume':'Retomar','Inspect':'Inspecionar',
    'Fix issues':'Corrigir problemas','Scheduled':'Agendado',
    'State':'Estado','Title':'Título','Description':'Descrição','Tags':'Palavras-chave',
    'No topic recorded':'Nenhum tema registrado',
    'Agent-selected topic':'Tema escolhido pelo agente',
    'No angle added':'Nenhuma abordagem informada',
    'No generation runs yet.':'Nenhuma geração iniciada ainda.',
    'No approved videos are scheduled.':'Não há vídeos aprovados e agendados.',
    'No activity has been recorded yet.':'Nenhuma atividade registrada ainda.',
    'No content matches this view.':'Nenhum conteúdo corresponde a este filtro.',
    'Add promising topics here before spending generation credits.':'Adicione temas promissores antes de gastar créditos de geração.',
    'Nothing is waiting. New content will appear here after quality review.':'Nenhum conteúdo aguardando. Novos vídeos aparecerão após a revisão.',
    'Run the verified check to inspect every production dependency.':'Execute a verificação para testar todos os requisitos da produção.',
    'The production path is verified.':'O fluxo de produção foi validado.',
    'Core checks passed with warnings.':'Os testes principais passaram com alertas.',
    'Automation is blocked until this is fixed.':'A automação está bloqueada até corrigir o problema.',
    'Prove the pipeline, without uploading.':'Verifique a produção sem enviar vídeos.',
    'No readiness run recorded.':'Nenhuma verificação registrada.',
    'No analyzed videos yet.':'Ainda não há vídeos analisados.',
    'Keep collecting results; recommendations get stronger with more published videos.':'Continue coletando resultados: as recomendações melhoram com mais vídeos publicados.',
    'Publish and analyze the first video to unlock performance recommendations.':'Publique e analise o primeiro vídeo para receber recomendações.',
    'Untitled video':'Vídeo sem título','Untitled content':'Conteúdo sem título',
    'Not configured':'Não configurado','Measuring':'Medindo',
    'Unavailable':'Indisponível','No numeric target':'Sem meta numérica',
    'Net subscribers':'Inscritos líquidos','Watch hours':'Horas assistidas',
    'Estimated revenue':'Receita estimada','Known production cost':'Custo de produção conhecido',
    'Estimated ROI':'ROI estimado','Budget used':'Orçamento utilizado',
    'Content pillars':'Pilares de conteúdo','Formats':'Formatos','Production providers':'Provedores de produção',
    'CTR':'Taxa de cliques (CTR)','Retention':'Retenção','Engagement':'Engajamento','Performance':'Desempenho',
    'Approve':'Aprovar','Reject':'Rejeitar',
    'Approve plan':'Aprovar plano','Start live test':'Iniciar teste real',
    'Refresh evidence':'Atualizar resultados','Cancel & restore control':'Cancelar e restaurar padrão',
    'Retry control restore':'Tentar restaurar padrão novamente','winner':'vencedor',
    'Control':'Controle','Result:':'Resultado:',
    'No eligible published variants':'Nenhuma variação publicada elegível',
    'Only real YouTube evidence advances controlled tests.':'Somente dados reais do YouTube permitem avançar nos testes controlados.',
    'No measured curves yet':'Nenhuma curva de retenção medida',
    'Retention curves appear after a published video reaches a real analytics measurement window.':'As curvas de retenção aparecem quando um vídeo publicado alcança o período de medição.',
    'The saved curve could not be mapped to a scene timeline.':'Não foi possível associar a curva salva às cenas da linha do tempo.',
    'Average watching':'Retenção média','Scene change':'Variação por cena',
    'Relative retention':'Retenção relativa','Sharpest drop':'Maior queda',
    'posting enabled':'publicação permitida','posting locked':'publicação bloqueada',
    'No synced videos yet':'Nenhum vídeo sincronizado',
    'Comments appear after a published video is synced.':'Os comentários aparecem após sincronizar um vídeo publicado.',
    'Draft replies from a synced video to review them here.':'Prepare respostas para um vídeo sincronizado e revise-as aqui.',
    'Nothing flagged as spam, scam, or toxic.':'Nenhum comentário sinalizado como spam, golpe ou ofensivo.',
    'AI analysis unavailable — mechanical facts only':'Análise de IA indisponível: apenas dados básicos',
    'never synced':'nunca sincronizado','No recurring themes yet.':'Ainda não há temas recorrentes.',
    'Themes need a working AI text provider.':'A análise de temas exige um provedor de IA de texto funcionando.',
    'Viewer':'Espectador','Reply':'Resposta','Save edit':'Salvar edição',
    'Discard':'Descartar','Approve & post':'Aprovar e publicar',
    'Open on YouTube':'Abrir no YouTube',
    'No reply drafts for this video yet.':'Nenhuma resposta em rascunho para este vídeo.',
    'Mined audience requests appear here once comment analysis finds repeated asks.':'Os pedidos recorrentes do público aparecerão após a análise dos comentários.',
    'Waiting for a strategy':'Aguardando estratégia',
    'Save a channel mandate, then activate it to research and produce the first plan.':'Salve as diretrizes do canal e ative o operador para pesquisar e criar o primeiro plano.',
    'No editorial plan yet.':'Ainda não há plano editorial.',
    'Research and planning will appear here when the run begins.':'A pesquisa e o planejamento aparecerão quando a execução começar.',
    'Run strategy now':'Executar estratégia agora','Activate & run now':'Ativar e executar agora',
    'Local FFmpeg slideshow is selected; no external video credentials are required.':'Slides locais com FFmpeg selecionados; não é necessário configurar outro provedor.',
    'Unverified':'Não verificado','passed':'aprovado','warning':'alerta','failed':'falhou',
    'blocking':'bloqueante','optional':'opcional','Next:':'Próximo passo:',
    'connected':'conectado','ready':'pronto','pending':'pendente','running':'em execução',
    'approved':'aprovado','rejected':'rejeitado','scheduled':'agendado','published':'publicado',
    'queued':'na fila','completed':'concluído','interrupted':'interrompido',
    'needs review':'precisa de revisão','needs attention':'precisa de atenção',
    'needs_review':'precisa de revisão','needs_attention':'precisa de atenção',
    'quality_review':'revisão de qualidade','thumbnail':'miniatura','strategy':'estratégia',
    'script':'roteiro','production':'produção','seo':'SEO',
    'engagement_sync':'sincronização de engajamento','analytics_collection':'coleta de métricas',
    'active':'ativo','inactive':'inativo','draft':'rascunho',
    'strong_hold':'boa retenção','drop_off':'queda de retenção','rewatch':'revisualização',
    'Awaiting evidence':'Aguardando dados','No recommendation yet. Lumen needs at least two real, sufficiently exposed measurements.':'Ainda não há recomendações. O Lumen precisa de pelo menos duas medições reais com dados suficientes.',
    'Two real measurements unlock evidence-backed recommendations.':'Duas medições reais liberam recomendações baseadas em dados.',
    'Choose a measurable primary outcome in the Autonomous Operator strategy.':'Escolha uma meta principal mensurável na estratégia do Operador Autônomo.',
    'Configure a primary outcome to activate goal-aligned learning.':'Configure uma meta principal para ativar o aprendizado orientado a resultados.',
    'Breakdowns appear once measured videos carry comparable pillar, format, or provider evidence.':'Os comparativos aparecem quando vídeos medidos têm dados equivalentes de pilares, formatos ou provedores.',
    'Only real YouTube analytics are eligible; simulated fallbacks are excluded.':'Somente métricas reais do YouTube são consideradas; dados simulados são excluídos.',
    'Re-authorize YouTube (npm run walkthrough) to grant the comment permission.':'Autorize novamente o YouTube (npm run walkthrough) para conceder permissão de comentários.',
    'Re-authorize YouTube to enable posting':'Autorize novamente o YouTube para publicar respostas',
    'Generate a fresh version using the same topic?':'Gerar uma nova versão usando o mesmo tema?',
    'Publish this video to YouTube now using the selected privacy setting?':'Publicar este vídeo no YouTube agora com a privacidade selecionada?',
    'Delete this schedule entry? The generated content and assets will be kept.':'Excluir este agendamento? Os vídeos e arquivos gerados serão mantidos.',
    'Why are you rejecting this content?':'Por que você está rejeitando este conteúdo?',
    'Needs a different angle':'Precisa de outra abordagem',
    'Enter the API_KEY value from your .env. It stays in this browser only.':'Informe a API_KEY do arquivo .env. Ela ficará somente neste navegador.',
    'Dashboard API key saved in this browser.':'Chave de API do painel salva neste navegador.',
    'No Short drafts yet. Create three candidates from the current scene timeline without calling a paid provider.':'Não há rascunhos de Shorts. Crie três opções a partir das cenas atuais, sem usar um provedor pago.',
    'CONTENT REVIEW':'REVISÃO DE CONTEÚDO','No playable preview was produced.':'Nenhuma prévia reproduzível foi gerada.',
    'No quality results recorded.':'Nenhum resultado de qualidade registrado.',
    'APPROVED LEARNING EXPERIMENT':'EXPERIMENTO DE APRENDIZADO APROVADO',
    'Choose the packaging to ship. Nothing changes on YouTube until this content is approved and published.':'Escolha a apresentação do vídeo. Nada muda no YouTube antes da aprovação e publicação.',
    'Title variant':'Variação de título','Publish time':'Data de publicação','Privacy':'Privacidade',
    'Private':'Privado','Unlisted':'Não listado','Public':'Público',
    'Facts and claims reviewed':'Fatos e afirmações revisados',
    'Media rights confirmed':'Direitos de uso de mídia confirmados',
    'Reschedule':'Reagendar','Publish now':'Publicar agora','Delete schedule':'Excluir agendamento',
    'Approve & schedule':'Aprovar e agendar','Save draft':'Salvar rascunho',
    'Regenerate':'Gerar novamente','No matching commands.':'Nenhum comando encontrado.',
    'Create video':'Criar vídeo','Add backlog idea':'Adicionar ideia',
    'Run verified readiness check':'Executar teste de prontidão',
    'Refresh dashboard data':'Atualizar dados do painel',
    'Set dashboard API key':'Configurar chave da API do painel',
    'Queue a new generation job':'Adicionar uma nova geração à fila',
    'Save a topic for later':'Salvar tema para depois','Prove the production path':'Validar o fluxo de produção',
    'Unpause the scheduler':'Retomar o agendador',
    'Halt scheduled generation':'Pausar geração agendada',
    'Pull latest state now':'Buscar informações atualizadas',
    'Store access key in this browser':'Armazenar chave neste navegador',
    'Navigate':'Navegar','Actions':'Ações','Search':'Pesquisar',
    'Command palette':'Paleta de comandos','Command input':'Campo de comando',
    'Commands':'Comandos','Jump to a view, run a command…':'Ir para uma tela ou executar um comando…',
    'Open command palette':'Abrir paleta de comandos',
    'navigate':'navegar','run':'executar','Lumen console':'Painel Lumen',
    'status':'estado','high':'alto','medium':'médio','low':'baixo',
    'positive':'positivo','neutral':'neutro','negative':'negativo',
    'question':'pergunta','request':'pedido','praise':'elogio',
    'correction':'correção','spam':'spam','scam':'golpe','toxic':'ofensivo'
  };

  const dynamic = [
    [/^(\d+) snapshots$/i, '$1 medições'],
    [/^(\d+) approved$/i, '$1 aprovadas'],
    [/^(\d+) drafts$/i, '$1 rascunhos'],
    [/^(\d+) flagged$/i, '$1 sinalizados'],
    [/^(\d+) pending$/i, '$1 pendentes'],
    [/^(\d+) running$/i, '$1 em andamento'],
    [/^(\d+) real points$/i, '$1 pontos reais'],
    [/^(\d+) scenes$/i, '$1 cenas'],
    [/^(\d+) drop-offs$/i, '$1 quedas'],
    [/^(\d+) rewatch signals$/i, '$1 sinais de revisão'],
    [/^(\d+) comments$/i, '$1 comentários'],
    [/^(\d+) analyzed$/i, '$1 analisados'],
    [/^(\d+) measured videos$/i, '$1 vídeos medidos'],
    [/^(\d+) stages saved$/i, '$1 etapas salvas'],
    [/^(\d+) reused$/i, '$1 reutilizadas'],
    [/^Scene (\d+)$/i, 'Cena $1'],
    [/^Performance (\d+) \/ 100$/i, 'Desempenho $1 / 100'],
    [/^(\d+)m ago$/i, 'há $1 min'],
    [/^(\d+)h ago$/i, 'há $1 h'],
    [/^(\d+)d ago$/i, 'há $1 dias'],
    [/^just now$/i, 'agora mesmo'],
    [/^Video: (\d+)\/(\d+) clips ready/i, 'Vídeo: $1/$2 clipes prontos'],
    [/^([\d.]+)% of target from stored measurement windows$/i, '$1% da meta nos períodos medidos'],
    [/^No numeric target · (\d+)-day evidence window$/i, 'Sem meta numérica · janela de $1 dias'],
    [/^(.+) credentials are not configured\.$/i, 'Credenciais de $1 não configuradas.'],
    [/^(.+) is configured \((.+)\)\.$/i, '$1 configurado ($2).']
  ];

  function translate(input) {
    if (typeof input !== 'string') return input;
    const trimmed = input.trim();
    if (!trimmed) return input;
    const translated = Object.prototype.hasOwnProperty.call(words, trimmed) ? words[trimmed] :
      dynamic.reduce((current, [pattern, replacement]) => current === trimmed && pattern.test(current)
        ? current.replace(pattern, replacement) : current, trimmed);
    if (translated === trimmed) return input;
    return input.replace(trimmed, translated);
  }

  window.agentTubePtBR = translate;
  // Traduções para mensagens de confirmação e entrada do próprio dashboard.
  const originalConfirm = window.confirm.bind(window);
  const originalPrompt = window.prompt.bind(window);
  window.confirm = message => originalConfirm(translate(message));
  window.prompt = (message, value) => originalPrompt(translate(message), value);

  function translateNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const current = node.nodeValue;
      const updated = translate(current);
      if (updated !== current) node.nodeValue = updated;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.matches('script,style,textarea,[contenteditable],code,pre')) return;
      for (const name of ['title', 'placeholder', 'aria-label']) {
        const before = node.getAttribute(name);
        if (before) {
          const after = translate(before);
          if (after !== before) node.setAttribute(name, after);
        }
      }
      for (const child of Array.from(node.childNodes)) translateNode(child);
    }
  }

  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') translateNode(record.target);
      for (const node of record.addedNodes) translateNode(node);
    }
  });
  function start() {
    translateNode(document.body);
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
