# AgentTube IAgora: implantação segura em Ubuntu 24.04

Este roteiro **não foi executado em nenhum VPS**. Execute somente depois de escolher
o servidor e confirmar o procedimento de acesso. O painel local continua ativo
com automação pausada, autopublicação desligada e aprovação manual obrigatória.

## Servidor recomendado

- Ubuntu 24.04 LTS, Node.js 22 LTS, Python 3.12
- 8 vCPUs e 16 GB RAM para 2 vídeos longos/dia, SSD de 160 GB ou mais
- Criar usuário de serviço **agenttube** sem root/sudo para a aplicação
- Instalar com apt: nginx, ffmpeg, espeak-ng, libespeak1, libsndfile1,
  python3-venv, python3-dev, build-essential, curl, ca-certificates, certbot e
  python3-certbot-nginx
- Apenas portas 22/80/443 abertas. **Nunca abrir a porta 3456 publicamente**.
- Um único processo/instância do AgentTube por banco SQLite, sem balanceamento
  de carga em múltiplos contêineres enquanto a fila usar SQLite local.

## 1. Proteger e copiar os dados

No Mac, enquanto a aplicação estiver pausada:

```bash
npm test
npm run lint
node scripts/server/self-test.js
node scripts/server/preflight.js
node scripts/server/backup-db.js
```

Backup de banco SQLite é criado em `data/backups/`, modo 0600, validado com
`PRAGMA quick_check`. Antes da cópia definitiva, **parar o AgentTube no Mac**
para impedir novas gravações. Nunca copiar apenas `youtube_automation.db`
enquanto ele pode ter transações ou arquivos WAL ativos.

Transferir código, `data/`, `uploads/` e `config/` pelo SSH com criptografia,
preservando permissões. **Não copiar o `node_modules/` do Mac nem o
`data/models/kokoro/venv/`**, que são binários Apple Silicon incompatíveis
com Linux. Não publicar arquivos privados no GitHub. Copiar `.env` somente
por canal seguro e recriar suas entradas relevantes no
`/etc/agenttube/agenttube.env` com modo 0600. Não armazenar segredos no
diretório público do Nginx.

## 2. Instalar dependências no Linux

Como usuário `agenttube`, em `/opt/agenttube`:

```bash
bash scripts/server/install-ubuntu.sh
```

Esse instalador prepara módulos npm **nativos Linux**, Kokoro pt-BR,
espeak-ng e modelos locais. Não executa o YouTube nem ativa o agendador.
O próprio sistema usa `FFMPEG_PATH=/usr/bin/ffmpeg` para evitar reutilizar
o binário macOS.

## 3. Preservar projetos e reescrever os caminhos de mídia

**Só depois de restaurar a cópia e com o serviço Linux PARADO:**

```bash
node scripts/server/rebase-paths.js --old-root '/Users/rubituci/Documents/YOUTUBE AGENT'
```

O comando acima mostra uma prévia. No momento da auditoria há 96 referências
em 8 campos do SQLite. Para aplicar, é necessário entrar explicitamente no
modo servidor, confirmar que a aplicação está parada e usar:

```bash
DEPLOYMENT_MODE=server MIGRATION_OFFLINE_CONFIRMED=yes \
node scripts/server/rebase-paths.js --apply \
  --old-root '/Users/rubituci/Documents/YOUTUBE AGENT' \
  --new-root '/opt/agenttube'
```

O script cria um **backup adicional** do banco SQLite antes da conversão.
Se houver erro, faz `ROLLBACK`. Corrige campos textuais inclusive JSON de
produções, cenas, thumbnails, checkpoints e revisões.

## 4. Painel e credenciais

Instalar e adaptar os modelos:

- `deploy/server.env.example` -> `/etc/agenttube/agenttube.env`
- `deploy/agenttube.service` -> `/etc/systemd/system/agenttube.service`
- `deploy/nginx-agenttube.conf.example` -> site do Nginx com certificado TLS

Criar **segredos distintos** com `openssl rand -hex 32`. Nunca reutilizar
senha pessoal ou credencial do YouTube como senha administrativa.

Obrigatórios no modo servidor:

- `DEPLOYMENT_MODE=server`, `NODE_ENV=production`, `HOST=127.0.0.1`
- `PUBLIC_ORIGIN=https://SEU-DOMINIO`
- `API_KEY` (mín. 32 caracteres)
- `DASHBOARD_BASIC_USER`
- `DASHBOARD_BASIC_PASSWORD` (mín. 20 caracteres)
- `KOKORO_TTS_ENABLED=true`, `KOKORO_PYTHON=/opt/agenttube/data/models/kokoro/venv/bin/python`
- `BACKGROUND_MUSIC_ENABLED=true`
- `FFMPEG_PATH=/usr/bin/ffmpeg`

O aplicativo recusa iniciar em modo servidor sem essas proteções, e protege
também páginas e requisições de leitura. A autenticação do navegador usa
HTTP Basic sobre HTTPS; requisições de escrita exigem a origem pública
configurada. Não usar HTTP sem certificado.

## 5. Pré-check sem publicação

Com as credenciais privadas instaladas e domínio/HTTPS configurados:

```bash
node scripts/server/preflight.js
node scripts/server/self-test.js
npm test
```

Antes de liberar qualquer postagem, confirmar também:

1. **BLOQUEIO ATUAL DE TEXTO**: teste real em 13/10/2026 retornou
   `Subscription Sharing usage limit` para o ChatGPT Plan OAuth. O sistema
   não conseguirá criar dois roteiros por dia com essa sessão até a cota
   voltar ou ser provisionado outro motor de texto.
   Já existe fallback **opcional**, por `TEXT_FALLBACK_PROVIDER=gemini` e
   `GEMINI_API_KEY`; só habilitar com autorização explícita de cobrança e
   limites, depois de validar quotas. A mera existência de uma chave no
   Google AI Studio **não comprova** que há quota ou faturamento autorizado.
   Testar renovação do ChatGPT OAuth em Linux headless antes do uso.
2. Consulta **somente leitura** ao canal IAgora pelo YouTube:
   validada em 13/10/2026, com scope `youtube.upload`. Revalidar depois
   da migração. Verificar no Google Cloud cotas para duas inserções diárias.
3. Teste real de um roteiro sem conteúdo genérico em inglês, busca de fontes,
   vídeos Pixabay, Kokoro, legendas, thumbnail, música CC0, FFmpeg e revisão.
4. Nenhuma reivindicação factual pendente para conteúdos programados.
   Reclamações, erro de licença, narração ausente e falhas de sincronização
   devem **bloquear a publicação**, não ser ignoradas.
5. Backup/restore e disponibilidade do servidor por pelo menos 48 horas.
6. Checar se Shorts e experimentos não publicam inesperadamente sob o mesmo
   controle de segurança.

## 6. Ativar duas produções e, separadamente, publicar

O recurso foi preparado, mas não foi ativado. Requer decisão explícita:
`DAILY_GENERATION_TARGET=2`, janelas de geração **06h e 15h**, e
`PUBLISH_SLOTS=12:00,19:00` no fuso `America/Sao_Paulo`.

Também é necessário alterar as configurações no banco:
`max_daily_posts=2` e a estratégia autônoma conforme a cadência desejada
(14 por semana, se essa for a decisão). **Primeiro** ativar apenas geração
para teste sem postagem; **depois**, verificar qualidade, fatos, cotas e
aprovação. Só então considerar `auto_publish_enabled=true` separadamente.

O código agora impede a fila automática quando a autopublicação está
desligada ou o agendador está pausado, além de exigir revisão aprovada,
checks bloqueantes resolvidos e limite diário. Um clique para retomar
o agendador NÃO autoriza automaticamente a publicação.

O vídeo do Godzilla permanece em `needs_attention`, com 25 alegações
científicas em aberto. Não há autorização para publicação autônoma dele.

## Ajustes adicionais auditados em 13/10/2026

- `npm audit --omit=dev`: **0 alertas** após atualização segura de `sqlite3`, `sharp` e `node-cron`.
- `npm test`: **47 aprovados, 0 falhas**; `npm run lint`: sem erros.
- Testes de servidor `node scripts/server/self-test.js`: Basic Auth, CSRF, origem HTTPS, pausa, controle de autopublicação, limite diário e dois agendamentos.
- Legendas de novos vídeos IAgora agora partem do **mesmo texto enviado ao narrador** e duração medida do áudio, reduzindo descompasso de cronogramas fixos. Trata-se de alinhamento aproximado; ainda precisa ser ouvido/avaliado antes de liberar vídeos.
- Interfaces de imagens Pixabаy e Nano Banana permitem escrita através do proxy somente se autenticadas e com origem HTTPS validada, mantendo restrições de localhost no Mac. Login ChatGPT interativo permanece local.
- **Não foi realizada uma implantação em VPS nem uma publicação real durante esta auditoria.** Instalação Linux, autonomia de renovação OAuth e duas produções diárias reais ainda precisam ser comprovadas em ambiente de homologação.
