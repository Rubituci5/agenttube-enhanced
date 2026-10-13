require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const { OperatorService } = require('./utils/operator-service');
const { AutonomousChannelOperator } = require('./utils/autonomous-channel-operator');
const { ActivationMetrics } = require('./utils/activation-metrics');
const { AnonymousTelemetry } = require('./utils/anonymous-telemetry');
const { ProductionReadinessService } = require('./utils/production-readiness-service');
const { GenerationRecoveryService, GENERATION_STAGES } = require('./utils/generation-recovery-service');
const { ProvenanceService } = require('./utils/provenance-service');
const { SceneRepairService } = require('./utils/scene-repair-service');
const { ShortsRepurposingService } = require('./utils/shorts-repurposing-service');
const { AudienceEngagementService } = require('./utils/audience-engagement-service');
const { GrowthExperimentService } = require('./utils/growth-experiment-service');
const { AITextService } = require('./utils/ai-text-service');
const { ChannelMetricsService } = require('./utils/channel-metrics-service');
const { PixabayVideoService } = require('./utils/pixabay-video-service');
const { AutonomousTopicScout } = require('./utils/autonomous-topic-scout');
const { AutonomousEditorialAudit, trustedUrl, approvalFingerprints } = require('./utils/autonomous-editorial-audit');
const { ThumbnailStudio, MAX_IMAGE_BYTES } = require('./utils/nano-banana-thumbnail-studio');
const { getEditorialProfile } = require('./utils/iagora-editorial');
const NanoBananaAPI = require('./utils/nanobanana-api-service');
const { FreeThumbnailService } = require('./utils/free-thumbnail-service');
const { DiscoverabilityService } = require('./utils/discoverability-service');
const { version } = require('./package.json');
const { validateDeploymentEnv, serverFirewall } = require('./utils/server-security');
const chalk = require('chalk');

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
    this.activeJobs = new Map();
    this.nanoBananaJobs = new Map();
    this.freeThumbnailJobs = new Map();
    this.operator = null;
    this.autonomous = null;
    this.activation = null;
    this.telemetry = null;
    this.readiness = null;
    this.recovery = null;
    this.provenance = null;
    this.scenes = null;
    this.shorts = null;
    this.engagement = null;
    this.experiments = null;
    this.discoverability = null;
    this.setupRequired = false;
    this.channelMetrics = null;
    this.pixabay = new PixabayVideoService();
    this.topicScout = null;
    this.editorialAudit = null;
  }

  async initialize() {
    try {
      console.log(chalk.cyan.bold(`\n🎬 YouTube Automation Agent v${version}`));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Initialize database
      this.logger.info('Initializing database...');
      this.db = new Database();
      await this.db.initialize();
      this.topicScout = new AutonomousTopicScout(this.db);
      await this.db.markInterruptedJobs();
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
      this.operator = new OperatorService(this.db);
      this.provenance = new ProvenanceService(this.db);
      this.discoverability = new DiscoverabilityService(this.db, { logger: this.logger });
      this.autonomous = new AutonomousChannelOperator(this.db, {
        researchAndPlan: strategy => {
          if (!this.agents.strategy) throw new Error('The strategy agent is not configured');
          return this.agents.strategy.researchAndPlanChannel(strategy);
        },
        startGenerationJob: input => this.startGenerationJob(input),
        resumeGenerationJob: (jobId, options) => this.resumeGenerationJob(jobId, options),
        waitForGenerationJob: jobId => this.waitForGenerationJob(jobId),
        notify: notification => this.operator.notify(notification)
      });
      this.activation = new ActivationMetrics(this.db);
      this.telemetry = new AnonymousTelemetry(this.db, this.logger);
      
      // Load credentials
      this.logger.info('Loading credentials...');
      this.credentials = new CredentialManager();
      this.editorialAudit = new AutonomousEditorialAudit(this.db, this.credentials);
      const credentialsValid = await this.credentials.validateAll();
      this.channelMetrics = new ChannelMetricsService(this.credentials);
      this.readiness = new ProductionReadinessService(this.db, this.credentials);
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  Some credentials are missing or invalid.'));
        console.log(chalk.yellow('Run: npm run credentials:setup'));
        this.setupRequired = true;
        this.setupAPI();
        this.isInitialized = true;
        this.logger.warn('Dashboard started in setup mode; generation and publishing are disabled');
        return true;
      }
      
      // Initialize agents
      this.logger.info('Initializing agents...');
      await this.initializeAgents();
      this.scenes = this.agents.production?.sceneRepair || new SceneRepairService(
        this.db,
        this.agents.production?.aiVideoGenerator,
        { logger: this.logger }
      );
      this.shorts = new ShortsRepurposingService(this.db, this.agents.publishing, { logger: this.logger });
      this.engagement = new AudienceEngagementService(
        this.db,
        this.credentials,
        new AITextService(this.credentials?.credentials || {}),
        { logger: this.logger }
      );
      this.experiments = new GrowthExperimentService(
        this.db,
        this.agents.analytics,
        this.agents.publishing,
        { logger: this.logger }
      );

      // Show which pipeline stages will run for real vs. be simulated
      const capabilities = await this.logCapabilitySummary();
      if (capabilities.hasText && capabilities.hasFFmpeg && capabilities.hasUpload) {
        await this.activation.markSetupReady(capabilities);
      }
      
      // Setup API endpoints
      this.setupAPI();
      
      // Initialize scheduler
      this.logger.info('Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db, {
        generateContent: input => this.queueScheduledContent(input),
        resumeGenerationJob: jobId => this.resumeGenerationJob(jobId),
        refreshReadiness: () => this.readiness.run({ includePaidMedia: false, includePaidVideo: false }),
        engagement: this.engagement,
        experiments: this.experiments
      });
      await this.scheduler.initialize();

      if (await this.db.getSetting('automation_paused') !== 'false') {
        await this.db.setSetting('automation_paused', 'true');
        await this.scheduler.pauseAutomation();
      } else {
        await this.scheduler.resumeAutomation();
      }
      
      this.isInitialized = true;
      this.logger.success('YouTube Automation Agent initialized successfully!');
      
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize:', error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      publishing: new PublishingSchedulingAgent(this.db, this.credentials),
      analytics: new AnalyticsOptimizationAgent(this.db, this.credentials)
    };

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      await agent.initialize();
      this.logger.info(`✓ ${name} agent initialized`);
    }
  }

  async logCapabilitySummary() {
    const { checkFFmpeg, ffmpegInstallHint } = require('./utils/ffmpeg');
    const creds = this.credentials.credentials || {};

    const hasText = this.credentials.hasAITextProvider();
    const hasGemini = Boolean(creds.gemini?.apiKey || process.env.GEMINI_API_KEY);
    const hasFreeThumbnails = Boolean(getEditorialProfile() && await new PixabayVideoService().configured());
    const hasImages = Boolean(creds.openai?.apiKey || process.env.OPENAI_API_KEY || hasGemini || hasFreeThumbnails);
    const hasTTS = Boolean(
      creds.openai?.apiKey || process.env.OPENAI_API_KEY ||
      creds.elevenLabs?.apiKey || process.env.ELEVENLABS_API_KEY ||
      creds.azureSpeech?.subscriptionKey || process.env.AZURE_SPEECH_KEY ||
      hasGemini || (process.env.KOKORO_TTS_ENABLED === 'true' && ['darwin','linux'].includes(process.platform)) ||
      (process.env.LOCAL_MAC_TTS === 'true' && process.platform === 'darwin')
    );
    const hasFFmpeg = await checkFFmpeg();
    const hasUpload = Boolean(creds.youtube && this.credentials.tokens?.youtube);

    const capabilities = [
      { name: 'Script & strategy generation', ok: hasText, hint: 'configure an AI provider (npm run credentials:setup)' },
      { name: 'Thumbnail visuals (stock montage / AI)', ok: hasImages, hint: 'configure Pixabay for free stock montages, or use a paid image API' },
      { name: 'Voice narration (TTS)', ok: hasTTS, hint: 'configure Kokoro TTS local (macOS/Linux) ou um provedor de voz' },
      { name: 'Video assembly (FFmpeg)', ok: hasFFmpeg, hint: ffmpegInstallHint() },
      { name: 'YouTube upload', ok: hasUpload, hint: 'run: npm run credentials:setup' }
    ];

    console.log(chalk.cyan('\n🔎 Capability check:'));
    for (const cap of capabilities) {
      if (cap.ok) {
        console.log(chalk.green(`  ✓ ${cap.name}`));
      } else {
        console.log(chalk.yellow(`  ✗ ${cap.name} — ${cap.hint}`));
      }
    }

    if (!hasFFmpeg) {
      this.logger.warn('FFmpeg is missing: no .mp4 files can be produced until it is installed.');
    }
    console.log('');
    return { hasText, hasImages, hasTTS, hasFFmpeg, hasUpload };
  }

  requireAPIKey() {
    return (req, res, next) => {
      if (req.basicAuthenticated) return next();
      if (!process.env.API_KEY) {
        return next();
      }

      if (req.get('x-api-key') !== process.env.API_KEY) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      return next();
    };
  }

  validateGenerateRequestBody(body = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { valid: false, status: 400, error: 'Request body must be a JSON object' };
    }

    const value = {
      topic: null,
      style: null,
      length: typeof body.length === 'string' ? body.length.toLowerCase() : 'medium',
      strategyContext: null
    };

    // JSON has no `undefined`, so clients send `null` to mean "no value provided".
    // Both are treated as "not set" here: topic/style are optional and default to
    // auto-selection, which is exactly what `null` already represents internally.
    if (body.topic !== undefined && body.topic !== null) {
      if (typeof body.topic !== 'string') {
        return { valid: false, status: 400, error: 'topic must be a string' };
      }

      const topic = body.topic.trim();
      if (topic.length > 200) {
        return { valid: false, status: 400, error: 'topic must be 200 characters or less' };
      }
      value.topic = topic || null;
    }

    if (body.style !== undefined && body.style !== null) {
      if (typeof body.style !== 'string') {
        return { valid: false, status: 400, error: 'style must be a string' };
      }

      const allowedStyles = new Set([
        'tutorial',
        'explainer',
        'list',
        'review',
        'story',
        'educational',
        'informative',
        'engaging',
        'professional',
        'ethereal'
      ]);
      const style = body.style.trim();

      if (style.length > 50) {
        return { valid: false, status: 400, error: 'style must be 50 characters or less' };
      }

      value.style = allowedStyles.has(style.toLowerCase()) ? style.toLowerCase() : style || null;
    }

    if (!['short', 'medium', 'long'].includes(value.length)) {
      return { valid: false, status: 400, error: 'length must be short, medium, or long' };
    }

    if (body.strategyContext !== undefined && body.strategyContext !== null) {
      if (typeof body.strategyContext !== 'object' || Array.isArray(body.strategyContext)) {
        return { valid: false, status: 400, error: 'strategyContext must be an object' };
      }
      const limits = { angle: 500, rationale: 1000, audience: 500, objective: 1000, valueProposition: 1000, constraints: 2000, pillar: 100 };
      value.strategyContext = {};
      for (const [key, max] of Object.entries(limits)) {
        if (body.strategyContext[key] === undefined || body.strategyContext[key] === null) continue;
        if (typeof body.strategyContext[key] !== 'string' || body.strategyContext[key].length > max) {
          return { valid: false, status: 400, error: `strategyContext.${key} must be a string of ${max} characters or less` };
        }
        value.strategyContext[key] = body.strategyContext[key].trim();
      }
      // Critical: preserve the source catalog from the IN-PROCESS scheduler.
      // Manual /generate requests must never be able to inject "verified"
      // citations or untrusted webpages into the evidence gate.
      if (['scheduler','autonomous_operator'].includes(body.source)) {
        const provided = body.strategyContext.researchSources;
        if (Array.isArray(provided)) {
          value.strategyContext.researchSources = provided.slice(0,5)
            .filter(source => source && typeof source === 'object' && trustedUrl(source.url))
            .map(source => ({
              url:String(source.url).slice(0,500),
              title:String(source.title || '').slice(0,240),
              publisher:new URL(source.url).hostname,
              sourceType:['article','official'].includes(source.sourceType) ? source.sourceType : 'article',
              publishedAt:source.publishedAt || null,
              status:'pending',
              notes:'Original publisher URL; independently verified before any unattended upload.',
              excerpt:String(source.excerpt || '').slice(0,5600)
            }));
        }
      }
    }

    return { valid: true, value };
  }

  validateChannelStrategy(body = {}, current = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('Channel strategy must be a JSON object');
    }
    const text = (key, fallback, max) => {
      const value = String(body[key] ?? fallback ?? '').trim();
      if (value.length > max) throw new Error(`${key} must be ${max} characters or less`);
      return value;
    };
    const objective = text('objective', current.objective, 1000);
    const audience = text('audience', current.audience, 500);
    if (!objective) throw new Error('A channel objective is required');
    if (!audience) throw new Error('A target audience is required');

    const rawPillars = body.contentPillars ?? current.contentPillars ?? [];
    if (!Array.isArray(rawPillars)) throw new Error('contentPillars must be an array');
    const contentPillars = rawPillars.map(value => String(value).trim()).filter(Boolean);
    if (!contentPillars.length || contentPillars.length > 8 || contentPillars.some(value => value.length > 100)) {
      throw new Error('Provide 1 to 8 content pillars, each 100 characters or less');
    }

    const integer = (key, fallback, min, max) => {
      const value = Number(body[key] ?? fallback);
      if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${key} must be an integer from ${min} to ${max}`);
      }
      return value;
    };
    const defaultFormat = text('defaultFormat', current.default_format || 'explainer', 20).toLowerCase();
    const defaultLength = text('defaultLength', current.default_length || 'medium', 20).toLowerCase();
    const status = text('status', current.status || 'draft', 20).toLowerCase();
    const primaryKpi = text('primaryKpi', current.primary_kpi || 'views', 30).toLowerCase();
    const outcomeCurrency = text('outcomeCurrency', current.outcome_currency || 'USD', 3).toUpperCase();
    if (!['explainer', 'tutorial', 'list', 'review', 'story'].includes(defaultFormat)) {
      throw new Error('defaultFormat is not supported');
    }
    if (!['short', 'medium', 'long'].includes(defaultLength)) throw new Error('defaultLength is not supported');
    if (!['draft', 'active', 'paused'].includes(status)) throw new Error('status must be draft, active, or paused');
    if (!['views', 'watch_hours', 'subscribers', 'engagement', 'revenue'].includes(primaryKpi)) {
      throw new Error('primaryKpi is not supported');
    }
    if (!/^[A-Z]{3}$/.test(outcomeCurrency)) throw new Error('outcomeCurrency must be a three-letter currency code');
    const optionalNumber = (key, fallback, min, max) => {
      const raw = body[key] ?? fallback;
      if (raw === undefined || raw === null || raw === '') return null;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${key} must be a number from ${min} to ${max}`);
      }
      return value;
    };

    return {
      objective,
      audience,
      valueProposition: text('valueProposition', current.value_proposition, 1000),
      contentPillars,
      cadencePerWeek: integer('cadencePerWeek', current.cadence_per_week || 1, 1, 7),
      videosPerRun: integer('videosPerRun', current.videos_per_run || 1, 1, 5),
      defaultFormat,
      defaultLength,
      successMetric: text('successMetric', current.success_metric, 300),
      primaryKpi,
      targetValue: optionalNumber('targetValue', current.target_value, 0.01, 1000000000),
      targetWindowDays: integer('targetWindowDays', current.target_window_days || 28, 7, 365),
      monthlyBudget: optionalNumber('monthlyBudget', current.monthly_budget, 0, 10000000),
      outcomeCurrency,
      constraints: text('constraints', current.constraints, 2000),
      status
    };
  }
  async persistNanoBananaThumbnail(bundle, saved) {
    const updatedAssets = {...bundle.assets,thumbnail:{
      ...(bundle.assets?.thumbnail || {}),
      path:saved.path,source:saved.source,model:saved.model,
      headline:saved.headline,accent:saved.accent,
      placement:saved.placement,syntheticMedia:true,
      generatedAt:saved.generatedAt
    }};
    await this.db.executeQuery('UPDATE productions SET assets = ? WHERE id = ?', [
      JSON.stringify(updatedAssets), bundle.id
    ]);
    const experiment=bundle.editorData?.packagingExperiment;
    const updatedExperiment=experiment ? {
      ...experiment,
      thumbnailVariants:(experiment.thumbnailVariants||[]).map((variant,index)=>
        index===0 ? {...variant,path:saved.path,label:'Nano Banana'} : variant)
    } : null;
    const editorData={
      ...bundle.editorData,rightsConfirmed:false,
      ...(updatedExperiment?{packagingExperiment:updatedExperiment,selectedThumbnailVariant:0}:{}),
      thumbnailSource:saved.source,thumbnailHeadline:saved.headline
    };
    await this.db.saveContentReview(bundle.id,{
      status:'needs_review',editorData,
      qualityChecks:bundle.qualityChecks,
      reviewNotes:'Thumbnail Nano Banana alterada. Revise a composição e confirme os direitos antes da aprovação.',
      reviewedAt:null
    });
  }

  setupAPI() {
    this.app.use(serverFirewall());
    this.app.use(express.json({ limit: '1mb' }));
    this.app.use(express.static(path.join(__dirname, 'dashboard')));

    if (!process.env.API_KEY) {
      this.logger.warn('API_KEY is not set; mutating API routes are unprotected');
    }
    
    // Main dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: this.setupRequired ? 'setup_required' : 'healthy',
        initialized: this.isInitialized,
        setupRequired: this.setupRequired,
        agents: Object.keys(this.agents),
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
      });
    });

    // Open-source ChatGPT plan login: explicit local browser authorization only.
    // Never expose tokens to the dashboard or launch this from another origin.
    this.app.get('/api/chatgpt/status', (req, res) => {
      const { status } = require('./utils/chatgpt-plan-auth');
      res.json({ ...status(), enabled: process.env.CHATGPT_PLAN_ENABLED === 'true',
        loggingIn: Boolean(this.chatgptLoginProcess) });
    });
    this.app.post('/api/chatgpt/connect', (req, res) => {
      const host = req.get('host') || '';
      const origin = req.get('origin') || '';
      const allowedHost = ['127.0.0.1:3456', 'localhost:3456'].includes(host);
      if (!allowedHost || origin !== `http://${host}`) {
        return res.status(403).json({ error: 'Local dashboard origin required for authentication.' });
      }
      if (process.env.CHATGPT_PLAN_ENABLED !== 'true') {
        return res.status(400).json({ error: 'Enable CHATGPT_PLAN_ENABLED=true first.' });
      }
      if (this.chatgptLoginProcess) return res.status(409).json({ error: 'Login is already in progress.' });
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['scripts/chatgpt-plan.js', 'login'], {
        cwd: __dirname, stdio: 'ignore', env: process.env
      });
      this.chatgptLoginProcess = child;
      child.on('error', () => { this.chatgptLoginProcess = null; });
      child.on('exit', () => { this.chatgptLoginProcess = null; });
      res.json({ started: true, message: 'Complete the authorization in the browser window.' });
    });

    // Pixabay key is stored in a local, chmod 0600 file. Only the local dashboard
    // may update it. Never return the key or place it in general settings.
    this.app.get('/api/pixabay/status', async (_req, res) => {
      res.json({ configured: await this.pixabay.configured(),
        enabled: await this.db.getSetting('video_provider') === 'pixabay',
        docs: 'https://pixabay.com/api/docs/' });
    });
    this.app.post('/api/pixabay/key', this.requireAPIKey(), async (req, res) => {
      const host = req.get('host') || '';
      const origin = req.get('origin') || '';
      if (!req.basicAuthenticated &&
        (!['localhost:3456', '127.0.0.1:3456'].includes(host) || origin !== 'http://' + host))
        return res.status(403).json({ error: 'Chave permitida somente no painel local.' });
      try {
        await this.pixabay.saveKey(req.body?.key);
        await this.db.setSetting('video_provider', 'pixabay');
        await this.db.setSetting('video_generation_mode', 'slideshow');
        res.json({ configured: true, enabled: true });
      } catch (error) { res.status(400).json({ error: error.message }); }
    });

    // Manual content generation
    this.app.post('/generate', this.requireAPIKey(), async (req, res) => {
      try {
        if (this.setupRequired) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before generating content' });
        }
        const validation = this.validateGenerateRequestBody(req.body);
        if (!validation.valid) {
          return res.status(validation.status).json({ success: false, error: validation.error });
        }

        const { topic, style, length } = validation.value;
        const result = await this.startGenerationJob({ topic, style, length, source: 'manual' });
        res.status(202).json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    // Independent read-only channel metrics for historical YouTube content.
    this.app.get('/api/channel/metrics', async (req, res) => {
      if (this.setupRequired || !this.channelMetrics)
        return res.status(503).json({ error: 'Conecte o YouTube para consultar métricas.' });
      try {
        const snapshot = await this.channelMetrics.snapshot({ refresh: req.query.refresh === 'true' });
        return res.json(snapshot);
      } catch (error) {
        this.logger.warn('Channel metrics refresh failed: ' + error.message);
        return res.status(503).json({ error: 'Não foi possível obter os dados atuais do canal pelo YouTube.' });
      }
    });

    // Get analytics
    this.app.get('/analytics', async (req, res) => {
      try {
        if (!this.agents.analytics) return res.json({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [], learning: null });
        const analytics = await this.agents.analytics.getRecentAnalytics();
        const learning = await this.agents.analytics.getLearningSummary();
        res.json({ ...analytics, learning });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/outcomes', async (_req, res) => {
      try {
        const learning = this.agents.analytics?.getLearningSummary
          ? await this.agents.analytics.getLearningSummary()
          : { outcome: null };
        return res.json({ success: true, result: learning.outcome || null });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', this.requireAPIKey(), async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ success: false, error: 'YouTube publishing is not configured' });
        const { contentId } = req.params;
        const bundle = await this.db.getProductionBundle(contentId);
        const short = bundle ? null : await this.db.getShortClip(contentId);
        if ((!bundle || bundle.review_status !== 'approved') && (!short || !['scheduled', 'uploading', 'reconciliation_required'].includes(short.status))) {
          return res.status(409).json({ success: false, error: 'Content must pass review and be approved before publishing' });
        }
        const result = await this.agents.publishing.publishContent(contentId);
        res.json({ success: true, result });
      } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.setupOperatorAPI();
  }

  setupOperatorAPI() {
    const protect = this.requireAPIKey();

    this.app.get('/api/dashboard', async (_req, res) => {
      try {
        const [stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, activation, channelStrategy, operatorRuns, readiness, engagement, experiments] = await Promise.all([
          this.db.getStats(),
          this.db.listGenerationJobs(20),
          this.db.getPipelineOverview(50),
          this.db.getUpcomingSchedule(30),
          this.db.getRecentAutomationEvents(20),
          this.db.listNotifications(20),
          this.db.getChannelProfile(),
          this.db.getAllSettings(),
          this.db.listContentIdeas(),
          this.agents.analytics
            ? this.agents.analytics.getRecentAnalytics(30)
            : Promise.resolve({ totalVideos: 0, averagePerformanceScore: 0, topPerformers: [], insights: [] }),
          this.agents.analytics?.getLearningSummary
            ? this.agents.analytics.getLearningSummary()
            : Promise.resolve({ measuredVideos: 0, snapshotCount: 0, baseline: {}, recommendations: [], approvedCount: 0, pendingCount: 0 }),
          this.activation
            ? this.activation.getSummary()
            : Promise.resolve({ privacy: 'local-only', counts: {}, milestones: {} }),
          this.db.getChannelStrategy(),
          this.db.listOperatorRuns(10),
          this.readiness
            ? this.readiness.getSummary()
            : Promise.resolve({ status: 'unverified', stale: false, blockingFailures: [], checks: [] }),
          this.engagement
            ? this.engagement.getSummary()
            : Promise.resolve({
                videosTracked: 0, pendingDrafts: 0, postedToday: 0, needsAttentionCount: 0,
                pendingAudienceIdeas: 0, postingEnabled: false, postingDisabledReason: 'setup_required',
                insights: [], recentThemes: [],
                evidencePolicy: 'Comments are fetched read-only from YouTube. Replies post only after operator approval, and fallback analysis never proposes drafts or ideas.'
              }),
          this.experiments
            ? this.experiments.getSummary()
            : Promise.resolve({ experiments: [], candidates: [], activeCount: 0, awaitingDecisionCount: 0, evidencePolicy: 'Finish setup to create a controlled growth experiment.' })
        ]);
        if (this.telemetry) void this.telemetry.sync(activation);
        res.json({
          stats, jobs, pipeline, schedule, events, notifications, profile, settings, ideas, analytics, learning, activation,
          channelStrategy, operatorRuns, readiness, engagement, experiments,
          system: {
            initialized: this.isInitialized,
            setupRequired: this.setupRequired,
            uptime: process.uptime(),
            activeJobs: this.activeJobs.size,
            automationPaused: this.scheduler ? !this.scheduler.isEnabled : true,
            agents: Object.keys(this.agents),
            autonomousRunning: Boolean(await this.db.getActiveOperatorRun()),
            videoProviders: this.agents.production?.aiVideoGenerator?.mediaGeneration?.listProviders() || []
          }
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/api/jobs/:jobId', async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      job.checkpoints = await this.db.listGenerationCheckpoints(job.id);
      job.mediaTasks = await this.db.listMediaGenerationTasks(job.id);
      job.resumeFrom = this.recovery?.resumePoint(job.checkpoints);
      return res.json(job);
    });

    this.app.post('/api/jobs/:jobId/resume', protect, async (req, res) => {
      try {
        const result = await this.resumeGenerationJob(req.params.jobId, { stage: req.body?.stage });
        return res.status(202).json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    // Explicit, authenticated dry-run for testing the real autonomous pipeline.
    // Deliberately disabled when auto-upload is enabled, to prevent accidental
    // extra publications from a test button or a malicious replay.
    this.app.post('/api/topic-scout/test-generate', this.requireAPIKey(), async (_req, res) => {
      try {
        if (await this.db.getSetting('auto_publish_enabled') === 'true' ||
            await this.db.getSetting('automation_paused') !== 'true') {
          return res.status(409).json({error:'Dry-run requires paused scheduler and disabled upload.'});
        }
        const readiness = await this.readiness?.getSummary();
        if (readiness?.status === 'failed' || readiness?.status === 'unverified') {
          return res.status(409).json({error:'Production readiness must have no blocking failures'});
        }
        const job = await this.queueScheduledContent({source:'scheduler'});
        return res.status(202).json({success:true,jobId:job.id,source:'scheduler',publishing:'disabled'});
      } catch (error) {
        return res.status(error.status || 500).json({success:false,error:error.message});
      }
    });

    // Read-only preview: choose the next editorial candidate without
    // reserving it or starting a generation job.
    this.app.get('/api/topic-scout/preview', async (_req, res) => {
      try {
        const pick = await this.topicScout.selectTopic();
        return res.json({ ready: true, topic: pick.topic,
          selection: pick.selection, rationale: pick.rationale,
          sources: pick.researchSources });
      } catch (error) {
        return res.status(503).json({ ready: false, error: error.message });
      }
    });

    this.app.get('/api/readiness', async (_req, res) => {
      if (!this.readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
      return res.json(await this.readiness.getSummary());
    });

    this.app.post('/api/readiness/run', protect, async (req, res) => {
      try {
        if (!this.readiness) return res.status(503).json({ error: 'Readiness service is not initialized' });
        const result = await this.readiness.run({
          includePaidMedia: req.body?.includePaidMedia === true,
          includePaidVideo: req.body?.includePaidVideo === true
        });
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/jobs/:jobId/cancel', protect, async (req, res) => {
      const job = await this.db.getGenerationJob(req.params.jobId);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (!['queued', 'running'].includes(job.status)) {
        return res.status(409).json({ error: 'Only queued or running jobs can be cancelled' });
      }
      const updated = await this.db.updateGenerationJob(job.id, { cancelRequested: true, details: { cancelReason: req.body?.reason || 'Cancelled by operator' } });
      return res.json({ success: true, result: updated });
    });

    this.app.get('/api/content/:productionId', async (req, res) => {
      let bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      if (this.scenes && !bundle.scenes?.length) {
        await this.scenes.ensureManifest(bundle);
        bundle = await this.db.getProductionBundle(req.params.productionId);
      }
      return res.json(this.decorateContentBundle(bundle));
    });

    this.app.get('/api/content/:productionId/scenes/:sceneId/estimate', async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.regenerationEstimate(req.params.productionId, req.params.sceneId, {
          provider: req.query.provider
        });
        return res.json(result);
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.patch('/api/content/:productionId/scenes/:sceneId', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.updateScene(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Scene changes require review before scheduling');
        return res.json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/scenes/reorder', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.reorder(req.params.productionId, req.body?.sceneIds);
        await this.refreshContentReview(req.params.productionId, 'Timeline order changed; rebuild and review before scheduling');
        return res.json({ success: true, result: result.map(scene => this.scenes.decorateScene(scene, req.params.productionId)) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/scenes/:sceneId/regenerate', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.regenerate(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Regenerated scene must be rebuilt and reviewed');
        return res.status(202).json({ success: true, result: {
          ...result,
          scene: this.scenes.decorateScene(result.scene, req.params.productionId)
        } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/shorts/propose', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.propose(req.params.productionId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/content/:productionId/shorts/:clipId', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.update(req.params.productionId, req.params.clipId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/shorts/:clipId/render', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.render(req.params.productionId, req.params.clipId);
        return res.status(202).json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/shorts/:clipId/approve', protect, async (req, res) => {
      try {
        if (!this.shorts) return res.status(503).json({ error: 'Shorts repurposing requires completed setup' });
        const result = await this.shorts.approve(req.params.productionId, req.params.clipId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.get('/api/content/:productionId/shorts/:clipId/asset/:kind', async (req, res) => {
      try {
        const clip = await this.db.getShortClip(req.params.clipId);
        if (!clip || clip.productionId !== req.params.productionId) return res.status(404).json({ error: 'Short asset not found' });
        const filePath = req.params.kind === 'video' ? clip.outputPath : req.params.kind === 'captions' ? clip.captionsPath : null;
        if (!filePath) return res.status(404).json({ error: 'Short asset not found' });
        const resolved = path.resolve(filePath);
        const shortsRoot = path.resolve(__dirname, 'data', 'shorts');
        if (!resolved.startsWith(`${shortsRoot}${path.sep}`)) return res.status(403).json({ error: 'Short asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Short asset not found' });
      }
    });

    this.app.post('/api/content/:productionId/scenes/:sceneId/narration', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
        const result = await this.scenes.regenerateNarration(req.params.productionId, req.params.sceneId, req.body || {});
        await this.refreshContentReview(req.params.productionId, 'Narration regenerated; rebuild the final video before approval');
        return res.status(202).json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.post('/api/content/:productionId/narration/silence', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Narration recovery requires completed setup' });
        const result = await this.scenes.setSilenceOverride(req.params.productionId, req.body || {});
        await this.refreshContentReview(
          req.params.productionId,
          result.enabled ? 'Intentional silence recorded; rebuild and review before approval' : 'Narration is required again; regenerate it before approval'
        );
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.put(
      '/api/content/:productionId/scenes/:sceneId/asset',
      protect,
      express.raw({ type: ['image/*', 'video/*'], limit: '100mb' }),
      async (req, res) => {
        try {
          if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
          const result = await this.scenes.replaceAsset(req.params.productionId, req.params.sceneId, {
            buffer: req.body,
            contentType: req.get('content-type'),
            filename: req.get('x-file-name'),
            rightsConfirmed: req.get('x-rights-confirmed') === 'true',
            containsSyntheticMedia: req.get('x-synthetic-media') === 'true'
          });
          await this.refreshContentReview(req.params.productionId, 'Replacement scene asset must be rebuilt and reviewed');
          return res.json({ success: true, result: this.scenes.decorateScene(result, req.params.productionId) });
        } catch (error) {
          return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
        }
      }
    );

    this.app.post('/api/content/:productionId/scenes/rebuild', protect, async (req, res) => {
      try {
        if (!this.scenes) return res.status(503).json({ error: 'Scene repair requires completed setup' });
        const result = await this.scenes.rebuild(req.params.productionId);
        await this.refreshContentReview(req.params.productionId, 'Scene repair rebuilt; final approval is required');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code, details: error.details });
      }
    });

    this.app.get('/api/content/:productionId/scenes/:sceneId/asset', async (req, res) => {
      try {
        const scene = await this.db.getProductionScene(req.params.productionId, req.params.sceneId);
        if (!scene?.assetPath) return res.status(404).json({ error: 'Scene asset not found' });
        const resolved = path.resolve(scene.assetPath);
        const dataRoot = path.resolve(__dirname, 'data');
        if (!resolved.startsWith(`${dataRoot}${path.sep}`)) return res.status(403).json({ error: 'Scene asset path is not allowed' });
        await fs.access(resolved);
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Scene asset not found' });
      }
    });

    // Gemini key stays on this Mac; validation checks access, without billable image generation.
    this.app.get('/api/nanobanana/status', protect, async (_req,res)=>{
      try { return res.json(await NanoBananaAPI.status()); }
      catch (_error) { return res.status(500).json({error:'Não foi possível ler o status da API Gemini.'}); }
    });
    this.app.post('/api/nanobanana/key', protect, async (req,res)=>{
      const host=req.get('host')||'';
      const clientAddress=req.socket?.remoteAddress||'';
      if(!req.basicAuthenticated &&
        (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(clientAddress) ||
         !['127.0.0.1:3456','localhost:3456'].includes(host) ||
         req.get('origin')!=='http://'+host)) {
        return res.status(403).json({error:'Configuração permitida somente no painel local do Mac.'});
      }
      try {
        const configured=await NanoBananaAPI.saveKey(req.body?.key);
        return res.json({success:true,result:configured});
      } catch(error) {
        return res.status(400).json({success:false,error:error.message});
      }
    });

    this.app.get('/api/content/:productionId/thumbnail/nanobanana/status',protect,async(req,res)=>{
      const job=this.nanoBananaJobs.get(req.params.productionId);
      if(!job)return res.json({status:'idle'});
      return res.json({...job});
    });

    this.app.post('/api/content/:productionId/thumbnail/nanobanana/generate',protect,async(req,res)=>{
      const host=req.get('host')||'';
      const remote=req.socket?.remoteAddress||'';
      if(!req.basicAuthenticated &&
        (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote) ||
         !['127.0.0.1:3456','localhost:3456'].includes(host) ||
         req.get('origin')!=='http://'+host)) {
        return res.status(403).json({error:'Geração permitida somente no painel local.'});
      }
      try {
        if(req.body?.confirmed!==true)return res.status(400).json({error:'Confirme o uso da API paga para esta imagem.'});
        if(!getEditorialProfile())return res.status(409).json({error:'Conecte o canal IAgora primeiro.'});
        const active=this.nanoBananaJobs.get(req.params.productionId);
        if(active?.status==='processing')return res.status(409).json({
          error:'O Nano Banana já está gerando esta thumbnail. Aguarde o status atual antes de tentar novamente.',
          status:'processing',jobId:active.id
        });
        const bundle=await this.db.getProductionBundle(req.params.productionId);
        if(!bundle)return res.status(404).json({error:'Vídeo não encontrado.'});
        if(bundle.review_status==='approved'||
          ['scheduled','published','uploading','uploaded','reconciliation_required'].includes(bundle.schedule?.status)) {
          return res.status(409).json({error:'Vídeo aprovado/agendado não pode ter sua miniatura substituída.'});
        }
        if(!(await NanoBananaAPI.status()).configured) {
          return res.status(400).json({error:'A chave Nano Banana ainda não foi configurada.'});
        }
        const defaults=ThumbnailStudio.initialBrief(bundle.script);
        const input={
          prompt:String(req.body?.prompt||defaults.prompt).trim(),
          quality:req.body?.model||'balanced',
          headline:req.body?.headline||defaults.headline,
          accent:req.body?.accent||defaults.accent,
          placement:req.body?.placement||defaults.placement
        };
        if(input.prompt.length<80||input.prompt.length>4000)return res.status(400).json({error:'Prompt inválido. Crie a direção de arte novamente.'});
        const job={
          id:require('node:crypto').randomUUID(),
          status:'processing',
          phase:'google',
          message:'Solicitação enviada ao Google. A geração da cena pode levar alguns minutos.',
          startedAt:new Date().toISOString(),
          finishedAt:null,
          result:null,
          error:null
        };
        this.nanoBananaJobs.set(bundle.id,job);
        this.logger.info('Nano Banana image generation queued for production '+bundle.id+' (no secrets logged)');
        // Respond immediately. A background task tracks the one explicitly approved request.
        Promise.resolve().then(async()=>{
          const generated=await NanoBananaAPI.generateImage(input);
          job.phase='composing';
          job.message='Imagem recebida. Aplicando a manchete no padrão IAgora.';
          const saved=await ThumbnailStudio.applyNanoBananaImage(generated.buffer,{
            contentType:generated.contentType,
            headline:input.headline,accent:input.accent,placement:input.placement
          });
          saved.source='nanobanana-api';
          saved.model=generated.model;
          await this.persistNanoBananaThumbnail(bundle,saved);
          job.status='complete';
          job.phase='complete';
          job.message='Thumbnail pronta para revisão. Confira o resultado antes de aprovar.';
          job.result={
            thumbnailUrl:'/api/content/'+encodeURIComponent(bundle.id)+'/asset/thumbnail',
            source:saved.source,model:saved.model,headline:saved.headline,
            rightsReviewRequired:true
          };
          job.finishedAt=new Date().toISOString();
          this.logger.info('Nano Banana thumbnail saved for production '+bundle.id);
        }).catch(error=>{
          job.status='failed';
          job.phase='failed';
          job.message='A solicitação não foi concluída.';
          job.error=String(error.message||'Falha na geração').slice(0,400);
          job.finishedAt=new Date().toISOString();
          this.logger.warn('Nano Banana generation failed for production '+bundle.id+' (details available in review panel)');
        });
        return res.status(202).json({success:true,jobId:job.id,status:job.status,
          message:'Solicitação recebida. Acompanhe o progresso no Estúdio de Thumbnails.'});
      } catch(error){
        return res.status(error.status||400).json({error:String(error.message||'Falha').slice(0,400)});
      }
    });

    this.app.get('/api/content/:productionId/thumbnail/free/status', protect, async(req,res)=>{
      return res.json(this.freeThumbnailJobs.get(req.params.productionId) || {status:'idle'});
    });

    this.app.post('/api/content/:productionId/thumbnail/free/generate',protect,async(req,res)=>{
      const address=req.socket?.remoteAddress||'';
      const host=req.get('host')||'';
      if(!req.basicAuthenticated &&
        (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)||
         !['127.0.0.1:3456','localhost:3456'].includes(host)||
         req.get('origin')!=='http://'+host)){
        return res.status(403).json({error:'Geração local permitida somente pelo painel.'});
      }
      try{
        if(!getEditorialProfile())return res.status(409).json({error:'Conecte o canal IAgora primeiro.'});
        const bundle=await this.db.getProductionBundle(req.params.productionId);
        if(!bundle)return res.status(404).json({error:'Vídeo não encontrado.'});
        if(bundle.review_status==='approved'||
           ['scheduled','published','uploaded','uploading','reconciliation_required'].includes(bundle.schedule?.status)){
          return res.status(409).json({error:'A thumbnail está bloqueada após a aprovação/agendamento.'});
        }
        const running=this.freeThumbnailJobs.get(bundle.id);
        if(running?.status==='processing')return res.status(409).json({status:'processing',error:'Já estamos preparando três capas gratuitas para este vídeo.'});
        const job={status:'processing',startedAt:new Date().toISOString(),
          message:'Selecionando imagens licenciadas e montando três versões sem chamadas à API paga de imagens.'};
        this.freeThumbnailJobs.set(bundle.id,job);
        const options={
          ...(typeof req.body?.headline==='string'&&req.body.headline.trim()?{headline:req.body.headline.trim()}:{}),
          accent:req.body?.accent
        };
        Promise.resolve().then(async()=>{
          const result=await new FreeThumbnailService().generate(bundle.script,options);
          const old=bundle.assets?.thumbnail||{};
          const updated={
            ...bundle.assets,
            thumbnail:{...old,path:result.primary.path,source:result.source,
              variants:result.variants,stockSources:result.references,
              dimensions:{width:1280,height:720},
              fileSize:result.primary.fileSize,generatedWith:'Pixabay + Sharp',requiresEditorialReview:true}
          };
          await this.db.executeQuery('UPDATE productions SET assets = ? WHERE id = ?',
            [JSON.stringify(updated),bundle.id]);
          const originalExperiment=bundle.editorData?.packagingExperiment;
          const experiment=originalExperiment?{
            ...originalExperiment,thumbnailVariants:(originalExperiment.thumbnailVariants||[]).map((v,i)=>
              i===0?{...v,path:result.primary.path,label:'Pixabay (gratuita)'}:v)
          }:null;
          await this.db.saveContentReview(bundle.id,{
            status:bundle.review_status==='needs_attention'?'needs_attention':'needs_review',
            editorData:{...bundle.editorData,rightsConfirmed:false,
              ...(experiment?{packagingExperiment:experiment,selectedThumbnailVariant:0}:{}),
              selectedFreeThumbnailVariant:0,thumbnailSource:'pixabay-free-composite'},
            qualityChecks:bundle.qualityChecks,
            reviewNotes:'Três capas gratuitas criadas com imagens do Pixabay. Revise a imagem, o tema e os direitos antes de aprovar.',
            reviewedAt:null
          });
          Object.assign(job,{status:'complete',message:'Três capas gratuitas prontas para escolher.',finishedAt:new Date().toISOString()});
          this.logger.info('Free Pixabay thumbnail set ready for production '+bundle.id);
        }).catch(error=>{
          Object.assign(job,{status:'failed',error:String(error.message||'Falha de imagens gratuitas').slice(0,300),
            finishedAt:new Date().toISOString()});
          this.logger.warn('Free thumbnail creation failed for '+bundle.id+': '+job.error);
        });
        return res.status(202).json({success:true,status:'processing',message:job.message});
      }catch(error){
        return res.status(400).json({error:String(error.message||'Falha na capa gratuita').slice(0,300)});
      }
    });

    this.app.post('/api/content/:productionId/thumbnail/free/select',protect,async(req,res)=>{
      const address=req.socket?.remoteAddress||'';
      const host=req.get('host')||'';
      if(!req.basicAuthenticated &&
        (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)||
         !['127.0.0.1:3456','localhost:3456'].includes(host)||
         req.get('origin')!=='http://'+host)){
        return res.status(403).json({error:'Seleção permitida somente no painel local.'});
      }
      try{
        const bundle=await this.db.getProductionBundle(req.params.productionId);
        if(!bundle)return res.status(404).json({error:'Vídeo não encontrado.'});
        if(bundle.review_status==='approved'||
           ['scheduled','published','uploaded','uploading','reconciliation_required'].includes(bundle.schedule?.status)){
          return res.status(409).json({error:'A miniatura está bloqueada após aprovação/agendamento.'});
        }
        const index=Number(req.body?.index);
        const variants=bundle.assets?.thumbnail?.variants||[];
        if(!Number.isInteger(index)||index<0||index>=variants.length)return res.status(400).json({error:'Opção de capa inválida.'});
        const chosen=variants[index];
        const real=path.resolve(chosen.path);
        const root=path.resolve(__dirname,'uploads','thumbnails');
        if(!real.startsWith(root+path.sep))return res.status(400).json({error:'Arquivo de thumbnail fora do diretório permitido.'});
        await fs.access(real);
        const assets={...bundle.assets,thumbnail:{
          ...bundle.assets.thumbnail,path:real,source:'pixabay-free-composite',
          fileSize:chosen.fileSize,selectedFreeThumbnailVariant:index
        }};
        await this.db.executeQuery('UPDATE productions SET assets = ? WHERE id = ?',[JSON.stringify(assets),bundle.id]);
        const originalExperiment=bundle.editorData?.packagingExperiment;
        const experiment=originalExperiment?{
          ...originalExperiment,thumbnailVariants:(originalExperiment.thumbnailVariants||[]).map((v,i)=>
            i===0?{...v,path:real,label:'Pixabay (gratuita)'}:v)
        }:null;
        await this.db.saveContentReview(bundle.id,{
          status:bundle.review_status==='needs_attention'?'needs_attention':'needs_review',
          editorData:{...bundle.editorData,rightsConfirmed:false,
            ...(experiment?{packagingExperiment:experiment,selectedThumbnailVariant:0}:{}),
            selectedFreeThumbnailVariant:index,thumbnailSource:'pixabay-free-composite'},
          qualityChecks:bundle.qualityChecks,
          reviewNotes:'Capa gratuita selecionada. Revise o resultado e confirme os direitos antes de aprovar.',
          reviewedAt:null
        });
        return res.json({success:true,index,thumbnailUrl:'/api/content/'+encodeURIComponent(bundle.id)+'/asset/thumbnail'});
      }catch(error){return res.status(400).json({error:String(error.message||'Não foi possível selecionar a capa.').slice(0,250)})}
    });

    // Nano Banana studio: GPT designs the shot; the user generates it with the
    // Gemini subscription and imports the scene. No image-generation API calls.
    this.app.get('/api/content/:productionId/thumbnail/brief', protect, async (req, res) => {
      try {
        if (!getEditorialProfile()) return res.status(409).json({error:'Estúdio IAgora disponível apenas para o canal IAgora conectado.'});
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({error:'Vídeo não encontrado.'});
        return res.json({success:true,result:ThumbnailStudio.initialBrief(bundle.script)});
      } catch (error) {
        return res.status(400).json({error:error.message});
      }
    });

    this.app.post('/api/content/:productionId/thumbnail/brief', protect, async (req, res) => {
      try {
        if (!getEditorialProfile()) return res.status(409).json({error:'Estúdio IAgora disponível apenas para o canal IAgora conectado.'});
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({error:'Vídeo não encontrado.'});
        const studio = new ThumbnailStudio(this.credentials);
        return res.json({success:true,result:await studio.createDirectorBrief(bundle.script)});
      } catch (error) {
        return res.status(400).json({error:error.message});
      }
    });

    this.app.put(
      '/api/content/:productionId/thumbnail/nanobanana',
      protect,
      express.raw({type:['image/png','image/jpeg','image/webp'],limit:'15mb'}),
      async (req,res) => {
        try {
          if (!getEditorialProfile()) return res.status(409).json({error:'Estúdio IAgora disponível apenas para o canal IAgora conectado.'});
          const bundle = await this.db.getProductionBundle(req.params.productionId);
          if (!bundle) return res.status(404).json({error:'Vídeo não encontrado.'});
          if (bundle.review_status === 'approved' ||
              ['scheduled','published','uploading','uploaded','reconciliation_required'].includes(bundle.schedule?.status)) {
            return res.status(409).json({error:'Altere a thumbnail antes da aprovação ou agendamento do vídeo.'});
          }
          if (!Buffer.isBuffer(req.body) || req.body.length>MAX_IMAGE_BYTES) {
            return res.status(400).json({error:'Envie uma imagem PNG, JPG ou WebP válida de até 15 MB.'});
          }
          const saved = await ThumbnailStudio.applyNanoBananaImage(req.body,{
            contentType:req.get('content-type'),
            headline:req.get('x-thumbnail-headline') ? decodeURIComponent(req.get('x-thumbnail-headline')) : ThumbnailStudio.initialBrief(bundle.script).headline,
            accent:req.get('x-thumbnail-accent'),
            placement:req.get('x-thumbnail-placement')
          });
          await this.persistNanoBananaThumbnail(bundle,saved);
          return res.json({success:true,result:{
            thumbnailUrl:'/api/content/'+encodeURIComponent(bundle.id)+'/asset/thumbnail',
            headline:saved.headline,accent:saved.accent,placement:saved.placement,
            rightsReviewRequired:true
          }});
        } catch (error) {
          return res.status(error.status||400).json({error:error.message});
        }
      }
    );

    this.app.patch('/api/content/:productionId', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (bundle.review_status === 'approved' && bundle.schedule?.status === 'published') {
          return res.status(409).json({ error: 'Published content cannot be edited here' });
        }
        const editorData = this.validateEditorData(req.body, bundle.editorData);
        const result = await this.db.saveContentReview(bundle.id, {
          status: bundle.review_status || 'needs_review',
          editorData,
          qualityChecks: bundle.qualityChecks,
          reviewNotes: req.body.reviewNotes ?? bundle.review_notes,
          reviewedAt: bundle.reviewed_at
        });
        return res.json({ success: true, result: this.decorateContentBundle(result) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/content/:productionId/approve', protect, async (req, res) => {
      try {
        const result = await this.approveContent(req.params.productionId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, quality: error.quality });
      }
    });

    this.app.post('/api/content/:productionId/reject', protect, async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      await this.db.saveContentReview(bundle.id, {
        status: 'rejected',
        editorData: bundle.editorData,
        qualityChecks: bundle.qualityChecks,
        reviewNotes: req.body?.notes || 'Rejected by operator',
        reviewedAt: new Date().toISOString()
      });
      await this.db.updateProductionStatus(bundle.id, 'rejected');
      return res.json({ success: true });
    });

    this.app.post('/api/content/:productionId/retry', protect, async (req, res) => {
      const bundle = await this.db.getProductionBundle(req.params.productionId);
      if (!bundle) return res.status(404).json({ error: 'Content not found' });
      const job = await this.startGenerationJob({
        topic: bundle.strategy.topic || bundle.editorData.title || null,
        style: bundle.strategy.requestedStyle || bundle.strategy.contentType || null,
        length: bundle.strategy.requestedLengthKey || 'medium',
        source: 'retry'
      });
      return res.status(202).json({ success: true, result: job });
    });

    this.app.get('/api/content/:productionId/asset/:kind', async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        const allowed = {
          video: bundle.assets?.finalVideo?.path,
          thumbnail: bundle.assets?.thumbnail?.path,
          captions: bundle.assets?.captions?.path,
          script: bundle.assets?.script?.originalPath
        };
        const freeMatch = req.params.kind.match(/^free-thumbnail-(\d+)$/);
        const freePath = freeMatch
          ? bundle.assets?.thumbnail?.variants?.[Number(freeMatch[1])]?.path
          : null;
        const experimentMatch = req.params.kind.match(/^experiment-thumbnail-(\d+)$/);
        const experimentPath = experimentMatch
          ? bundle.editorData?.packagingExperiment?.thumbnailVariants?.[Number(experimentMatch[1])]?.path
          : null;
        const filePath = allowed[req.params.kind] || (req.params.kind === 'captions-vtt' ? allowed.captions : null) || experimentPath || freePath;
        if (!filePath) return res.status(404).json({ error: 'Asset not found' });
        const resolved = path.resolve(filePath);
        const dataRoot = path.resolve(__dirname, 'data');
        const experimentRoot = path.resolve(__dirname, 'uploads', 'thumbnails');
        const allowedPath = [dataRoot, experimentRoot]
          .some(root => resolved.startsWith(`${root}${path.sep}`));
        if (!allowedPath) return res.status(403).json({ error: 'Asset path is not allowed' });
        await fs.access(resolved);
        if (req.params.kind === 'captions-vtt') {
          const srt = await fs.readFile(resolved, 'utf8');
          const vtt = 'WEBVTT\n\n' + srt.replace(/\r\n/g, '\n')
            .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
          return res.type('text/vtt').send(vtt);
        }
        return res.sendFile(resolved);
      } catch (_error) {
        return res.status(404).json({ error: 'Asset not found' });
      }
    });

    this.app.put('/api/profile', protect, async (req, res) => {
      try {
        const profile = this.validateProfile(req.body || {});
        return res.json({ success: true, result: await this.db.saveChannelProfile(profile) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.put('/api/operator/strategy', protect, async (req, res) => {
      try {
        const current = await this.db.getChannelStrategy() || {};
        const strategy = this.validateChannelStrategy(req.body || {}, current);
        return res.json({ success: true, result: await this.db.saveChannelStrategy(strategy) });
      } catch (error) {
        return res.status(400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/start', protect, async (req, res) => {
      try {
        if (this.setupRequired || !this.agents.strategy) {
          return res.status(503).json({ success: false, error: 'Finish setup with npm run walkthrough before activating the autonomous operator' });
        }
        if (this.activeJobs.size) {
          return res.status(409).json({ success: false, error: 'Wait for the current generation job to finish before starting an autonomous run' });
        }
        await this.readiness?.assertReady('Autonomous production');
        const current = await this.db.getChannelStrategy() || {};
        const strategy = this.validateChannelStrategy({ ...(req.body || {}), status: 'active' }, current);
        const saved = await this.db.saveChannelStrategy(strategy);
        const run = await this.autonomous.start(saved);
        return res.status(202).json({ success: true, result: run });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/pause', protect, async (_req, res) => {
      const strategy = await this.db.getChannelStrategy();
      if (!strategy) return res.status(404).json({ error: 'Channel strategy not found' });
      const active = await this.db.getActiveOperatorRun();
      if (active) await this.autonomous.cancel(active.id);
      const saved = await this.db.saveChannelStrategy({ ...strategy, status: 'paused' });
      return res.json({ success: true, result: saved });
    });

    this.app.post('/api/operator/runs/:runId/cancel', protect, async (req, res) => {
      const run = await this.autonomous.cancel(req.params.runId);
      if (!run) return res.status(404).json({ error: 'Operator run not found' });
      return res.json({ success: true, result: run });
    });

    this.app.put('/api/content/:productionId/provenance', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ error: 'Content not found' });
        if (bundle.review_status === 'approved' || bundle.schedule) {
          return res.status(409).json({ error: 'Provenance is locked after content is approved or scheduled' });
        }
        if (!this.provenance) this.provenance = new ProvenanceService(this.db);
        await this.provenance.review(bundle.id, req.body || {});
        const updated = await this.db.getProductionBundle(bundle.id);
        const profile = await this.db.getChannelProfile() || {};
        const quality = await this.operator.runQualityChecks({
          ...updated,
          scheduledPublishTime: updated.scheduled_publish_time
        }, profile);
        const reviewStatus = quality.passed ? 'needs_review' : 'needs_attention';
        const result = await this.db.saveContentReview(bundle.id, {
          status: reviewStatus,
          editorData: updated.editorData,
          qualityChecks: quality.checks,
          reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
          reviewedAt: null
        });
        return res.json({ success: true, result: this.decorateContentBundle(result) });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/operator/runs/:runId/resume', protect, async (req, res) => {
      try {
        if (this.setupRequired || !this.agents.strategy) {
          return res.status(503).json({ success: false, error: 'Finish setup before resuming the autonomous operator' });
        }
        await this.readiness?.assertReady('Autonomous production recovery');
        const strategy = await this.db.getChannelStrategy();
        const run = await this.autonomous.resume(req.params.runId, strategy);
        return res.status(202).json({ success: true, result: run });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/learning/recommendations/:recommendationId/:action', protect, async (req, res) => {
      const { recommendationId, action } = req.params;
      if (!['approve', 'reject'].includes(action)) {
        return res.status(400).json({ error: 'Action must be approve or reject' });
      }
      const status = action === 'approve' ? 'approved' : 'rejected';
      const recommendation = await this.db.reviewLearningRecommendation(recommendationId, status);
      if (!recommendation) return res.status(404).json({ error: 'Learning recommendation not found' });
      await this.operator.notify({
        type: 'learning_recommendation_reviewed',
        level: action === 'approve' ? 'success' : 'info',
        title: action === 'approve' ? 'Channel learning approved' : 'Channel learning rejected',
        message: recommendation.title,
        data: { recommendationId, status }
      });
      return res.json({ success: true, result: recommendation });
    });

    this.app.post('/api/content/:productionId/discoverability/run', protect, async (req, res) => {
      try {
        const bundle = await this.db.getProductionBundle(req.params.productionId);
        if (!bundle) return res.status(404).json({ success: false, error: 'Content not found' });
        const profile = await this.db.getChannelProfile() || {};
        const audit = await this.discoverability.auditProduction(bundle, profile, req.body?.platform || 'youtube');
        if (bundle.review_status !== 'approved' && !bundle.schedule) {
          const updated = await this.db.getProductionBundle(bundle.id);
          const quality = await this.operator.runQualityChecks({
            ...updated,
            scheduledPublishTime: updated.scheduled_publish_time
          }, profile);
          await this.db.saveContentReview(bundle.id, {
            status: quality.passed ? 'needs_review' : 'needs_attention',
            editorData: updated.editorData,
            qualityChecks: quality.checks,
            reviewNotes: quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
            reviewedAt: null
          });
        }
        const result = await this.db.getProductionBundle(bundle.id);
        return res.json({ success: true, result: this.decorateContentBundle(result), audit });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.patch('/api/content/:productionId/schedule', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.rescheduleContent(req.params.productionId, req.body?.publishTime);
        await this.db.updateProductionStatus(req.params.productionId, 'scheduled');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/content/:productionId/publish-now', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.emergencyPublish(req.params.productionId);
        await this.db.updateProductionStatus(req.params.productionId, result.status);
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.delete('/api/content/:productionId/schedule', protect, async (req, res) => {
      try {
        if (!this.agents.publishing) return res.status(503).json({ error: 'Publishing requires completed setup' });
        const result = await this.agents.publishing.deleteScheduledContent(req.params.productionId);
        await this.db.updateProductionStatus(req.params.productionId, 'approved');
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/discoverability/findings/:findingId', protect, async (req, res) => {
      try {
        const finding = await this.discoverability.reviewFinding(req.params.findingId, req.body || {});
        const audit = await this.db.getLatestDiscoverabilityAudit(finding.production_id, finding.platform);
        return res.json({ success: true, result: { finding, audit } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.get('/api/experiments', async (_req, res) => {
      try {
        const summary = this.experiments
          ? await this.experiments.getSummary()
          : { experiments: [], candidates: [], activeCount: 0, awaitingDecisionCount: 0 };
        return res.json({ success: true, result: summary });
      } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/experiments', protect, async (req, res) => {
      try {
        if (!this.experiments) return res.status(503).json({ error: 'Finish setup before creating experiments' });
        const experiment = await this.experiments.create(req.body || {});
        return res.status(201).json({ success: true, result: experiment });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/experiments/:experimentId/:action', protect, async (req, res) => {
      try {
        if (!this.experiments) return res.status(503).json({ error: 'Finish setup before controlling experiments' });
        const actions = {
          approve: () => this.experiments.approve(req.params.experimentId, req.body),
          start: () => this.experiments.start(req.params.experimentId, req.body),
          refresh: () => this.experiments.refresh(req.params.experimentId),
          adopt: () => this.experiments.adoptWinner(req.params.experimentId, req.body),
          cancel: () => this.experiments.cancel(req.params.experimentId, req.body)
        };
        if (!actions[req.params.action]) return res.status(400).json({ error: 'Unsupported experiment action' });
        const experiment = await actions[req.params.action]();
        await this.operator.notify({
          type: 'growth_experiment_updated',
          level: ['adopt', 'approve'].includes(req.params.action) ? 'success' : 'info',
          title: `Growth experiment ${req.params.action}`,
          message: experiment.title,
          data: { experimentId: experiment.id, status: experiment.status }
        });
        return res.json({ success: true, result: experiment });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.get('/api/retention/:videoId', async (req, res) => {
      const videoId = String(req.params.videoId || '').trim();
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
        return res.status(400).json({ error: 'A valid YouTube video ID is required' });
      }
      const snapshots = await this.db.listRetentionSnapshots({ videoId, limit: 10 });
      return res.json({ success: true, result: snapshots });
    });

    this.app.post('/api/retention/:videoId/refresh', protect, async (req, res) => {
      try {
        const videoId = String(req.params.videoId || '').trim();
        const measurementWindow = String(req.body?.measurementWindow || 'rolling');
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        if (!['24h', '7d', 'rolling'].includes(measurementWindow)) {
          return res.status(400).json({ error: 'Measurement window must be 24h, 7d, or rolling' });
        }
        if (!this.agents.analytics) {
          return res.status(503).json({ error: 'YouTube Analytics is not initialized' });
        }
        const report = await this.agents.analytics.analyzeVideoPerformance(videoId, { measurementWindow });
        return res.json({
          success: true,
          result: report.retentionSnapshot || null,
          retention: report.retention
        });
      } catch (error) {
        return res.status(error.status || 400).json({ error: error.message });
      }
    });

    const ENGAGEMENT_VIDEO_ID = /^[A-Za-z0-9_-]{1,100}$/;

    this.app.get('/api/engagement/:videoId', async (req, res) => {
      try {
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const [insight, comments, drafts] = await Promise.all([
          this.db.getEngagementInsight(videoId),
          this.db.listAudienceComments({ videoId, limit: 200 }),
          this.db.listReplyDrafts({ videoId, limit: 100 })
        ]);
        return res.json({ success: true, result: { insight, comments, drafts } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
      }
    });

    this.app.post('/api/engagement/:videoId/sync', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const sync = await this.engagement.syncVideoComments(videoId, req.body || {});
        const insight = sync.fetched > 0 || req.body?.analyze === true
          ? await this.engagement.analyzeVideo(videoId)
          : sync.insight;
        return res.status(202).json({ success: true, result: { ...sync, insight } });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/engagement/:videoId/draft-replies', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const videoId = String(req.params.videoId || '').trim();
        if (!ENGAGEMENT_VIDEO_ID.test(videoId)) {
          return res.status(400).json({ error: 'A valid YouTube video ID is required' });
        }
        const result = await this.engagement.draftReplies(videoId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.patch('/api/engagement/replies/:draftId', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const result = await this.engagement.updateReplyDraft(req.params.draftId, req.body || {});
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/engagement/replies/:draftId/approve', protect, async (req, res) => {
      try {
        if (!this.engagement) return res.status(503).json({ error: 'Audience engagement requires completed setup' });
        const result = await this.engagement.approveReplyDraft(req.params.draftId, req.body || {});
        // The reply is already live on YouTube; a notification failure must not report an error.
        try {
          await this.operator.notify({
            type: 'audience_reply_posted',
            level: 'success',
            title: 'Audience reply posted',
            message: `A reply was posted on video ${result.videoId}`,
            data: { draftId: result.id, videoId: result.videoId, postedCommentId: result.postedCommentId }
          });
        } catch (notifyError) {
          this.logger.warn(`Posted reply notification failed: ${notifyError.message}`);
        }
        return res.json({ success: true, result });
      } catch (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message, code: error.code });
      }
    });

    this.app.post('/api/ideas', protect, async (req, res) => {
      const topic = String(req.body?.topic || '').trim();
      if (!topic || topic.length > 200) return res.status(400).json({ error: 'A topic of 200 characters or less is required' });
      const idea = await this.db.createContentIdea({ ...req.body, topic });
      return res.status(201).json({ success: true, result: idea });
    });

    this.app.patch('/api/ideas/:ideaId', protect, async (req, res) => {
      const idea = await this.db.updateContentIdea(req.params.ideaId, req.body || {});
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      return res.json({ success: true, result: idea });
    });

    this.app.post('/api/ideas/:ideaId/generate', protect, async (req, res) => {
      const idea = await this.db.updateContentIdea(req.params.ideaId, { status: 'generating' });
      if (!idea) return res.status(404).json({ error: 'Idea not found' });
      const job = await this.startGenerationJob({ topic: idea.topic, style: idea.style, length: req.body?.length || 'medium', source: 'idea' });
      await this.db.updateContentIdea(idea.id, { status: 'generated' });
      return res.status(202).json({ success: true, result: job });
    });

    this.app.post('/api/automation/:action', protect, async (req, res) => {
      if (!this.scheduler) return res.status(409).json({ error: 'Finish setup before controlling automation' });
      const { action } = req.params;
      if (action === 'pause') {
        await this.scheduler.pauseAutomation();
        await this.db.setSetting('automation_paused', 'true');
      } else if (action === 'resume') {
        await this.scheduler.resumeAutomation();
        await this.db.setSetting('automation_paused', 'false');
      } else {
        return res.status(400).json({ error: 'Action must be pause or resume' });
      }
      return res.json({ success: true, paused: !this.scheduler.isEnabled });
    });

    this.app.put('/api/settings', protect, async (req, res) => {
      const allowed = ['approval_required', 'notification_enabled', 'channel_timezone', 'max_daily_posts', 'content_buffer_days'];
      for (const key of allowed) {
        if (req.body?.[key] !== undefined) await this.db.setSetting(key, String(req.body[key]));
      }
      const provider = req.body?.video_provider;
      if (provider !== undefined) {
        const supported = ['slideshow', 'pixabay', 'auto', 'seedance', 'minimax_h3', 'google_omni', 'kling', 'wan'];
        if (!supported.includes(provider)) return res.status(400).json({ error: 'Unsupported video provider' });
        await this.db.setSetting('video_provider', provider);
      }
      const mode = req.body?.video_generation_mode;
      if (mode !== undefined) {
        if (!['hybrid', 'slideshow'].includes(mode)) return res.status(400).json({ error: 'Unsupported video generation mode' });
        await this.db.setSetting('video_generation_mode', mode);
      }
      if (req.body?.video_clip_duration !== undefined) {
        const value = Number(req.body.video_clip_duration);
        if (!Number.isInteger(value) || value < 3 || value > 30) return res.status(400).json({ error: 'Clip duration must be between 3 and 30 seconds' });
        await this.db.setSetting('video_clip_duration', String(value));
      }
      if (req.body?.video_max_generated_seconds !== undefined) {
        const value = Number(req.body.video_max_generated_seconds);
        if (!Number.isInteger(value) || value < 0 || value > 600) return res.status(400).json({ error: 'Generated seconds cap must be between 0 and 600' });
        await this.db.setSetting('video_max_generated_seconds', String(value));
      }
      return res.json({ success: true, result: await this.db.getAllSettings() });
    });

    this.app.post('/api/notifications/:notificationId/read', protect, async (req, res) => {
      await this.db.markNotificationRead(req.params.notificationId);
      return res.json({ success: true });
    });
  }

  async startGenerationJob(input = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before generating content');
      error.status = 503;
      throw error;
    }
    if (['scheduler', 'autonomous_operator'].includes(input.source)) {
      await this.readiness?.assertReady('Automated generation');
    }
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    if (this.activeJobs.size >= maxConcurrent) {
      const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }

    const validation = this.validateGenerateRequestBody(input);
    if (!validation.valid) {
      const error = new Error(validation.error);
      error.status = validation.status;
      throw error;
    }

    const job = await this.db.createGenerationJob({
      ...validation.value,
      source: input.source || 'manual'
    });

    const work = this.runGenerationJob(job.id, validation.value)
      .catch(error => this.logger.error(`Generation job ${job.id} failed:`, error))
      .finally(() => this.activeJobs.delete(job.id));
    this.activeJobs.set(job.id, work);
    return job;
  }

  async resumeGenerationJob(jobId, options = {}) {
    if (this.setupRequired || !this.agents.strategy) {
      const error = new Error('Finish setup with npm run walkthrough before resuming content generation');
      error.status = 503;
      throw error;
    }
    const job = await this.db.getGenerationJob(jobId);
    if (!job) {
      const error = new Error('Generation job not found');
      error.status = 404;
      throw error;
    }
    if (!['failed', 'interrupted'].includes(job.status)) {
      const error = new Error('Only failed or interrupted generation jobs can be resumed');
      error.status = 409;
      throw error;
    }
    if (this.activeJobs.has(job.id)) {
      const error = new Error('This generation job is already running');
      error.status = 409;
      throw error;
    }
    const maxConcurrent = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS || '1', 10));
    if (this.activeJobs.size >= maxConcurrent) {
      const error = new Error(`Generation is busy (${this.activeJobs.size}/${maxConcurrent} active jobs). Try again when the current job finishes.`);
      error.status = 429;
      throw error;
    }
    if (['scheduler', 'autonomous_operator'].includes(job.source)) {
      await this.readiness?.assertReady('Automated generation recovery');
    }

    const checkpoints = await this.db.listGenerationCheckpoints(job.id);
    const resumeFrom = options.stage || this.recovery.resumePoint(checkpoints);
    if (!GENERATION_STAGES.includes(resumeFrom)) {
      const error = new Error('Resume stage is not supported');
      error.status = 400;
      throw error;
    }
    if (options.stage) await this.recovery.resetFrom(job.id, resumeFrom);
    const input = {
      topic: job.topic,
      style: job.style,
      length: job.length || 'medium',
      strategyContext: job.details?.strategyContext || {}
    };
    const updated = await this.db.updateGenerationJob(job.id, {
      status: 'queued',
      stage: resumeFrom,
      error: null,
      cancelRequested: false,
      completedAt: null,
      details: {
        resumeCount: Number(job.details?.resumeCount || 0) + 1,
        resumeFrom,
        failedStage: null
      }
    });
    const work = this.runGenerationJob(job.id, input)
      .catch(error => this.logger.error(`Resumed generation job ${job.id} failed:`, error))
      .finally(() => this.activeJobs.delete(job.id));
    this.activeJobs.set(job.id, work);
    return updated;
  }

  async waitForGenerationJob(jobId) {
    const work = this.activeJobs.get(jobId);
    if (work) await work;
    const job = await this.db.getGenerationJob(jobId);
    if (!job) throw new Error(`Generation job ${jobId} was not found after it ran`);
    return job;
  }

  async queueScheduledContent(input = {}) {
    // A scheduled job must NEVER depend on a human choosing a topic.
    // The scout examines trusted editorial feeds, excludes previously covered
    // headlines, and falls back to a distinct evergreen topic when feeds fail.
    if (input.source !== 'scheduler') {
      return this.startGenerationJob(input);
    }
    if (!this.topicScout) this.topicScout = new AutonomousTopicScout(this.db);
    const pick = await this.topicScout.selectTopic();
    const strategy = await this.db.getChannelStrategy();
    const job = await this.startGenerationJob({
      topic: pick.topic,
      style: pick.style,
      length: strategy?.default_length || pick.length,
      source: 'scheduler',
      strategyContext: {
        angle: pick.topic,
        rationale: pick.rationale,
        audience: strategy?.audience,
        objective: strategy?.objective,
        constraints: strategy?.constraints,
        researchSources: pick.researchSources
      }
    });
    this.logger.info('Autonomous topic selected via ' + pick.selection + ': ' + pick.topic);
    // Record autonomous editorial decisions in the existing ideas view.
    try {
      const idea = await this.db.createContentIdea({
        topic: pick.topic, angle: pick.topic, style: pick.style,
        status: 'generating', rationale: pick.rationale
      });
      const work = this.activeJobs.get(job.id);
      if (work) void work.then(async () => {
        const completed = await this.db.getGenerationJob(job.id);
        await this.db.updateContentIdea(idea.id, {
          status: completed?.status === 'completed' ? 'generated' : 'failed'
        });
      }).catch(error => this.logger.warn('Autonomous idea status update: ' + error.message));
    } catch (error) {
      this.logger.warn('Autonomous idea ledger unavailable: ' + error.message);
    }
    return job;
  }

  async runGenerationJob(jobId, input) {
    try {
      await this.db.updateGenerationJob(jobId, { status: 'running', progress: 2, error: null, completedAt: null });
      const result = await this.generateContent(input.topic, input.style, input.length, {
        jobId,
        strategyContext: input.strategyContext
      });
      await this.db.updateGenerationJob(jobId, {
        status: 'completed',
        stage: result.reviewStatus === 'approved' ? 'scheduled' : result.reviewStatus,
        progress: 100,
        productionId: result.contentId,
        title: result.title,
        details: { reviewStatus: result.reviewStatus, qualityScore: result.qualityScore },
        completedAt: new Date().toISOString()
      });
      await this.db.setSetting('last_content_generation', new Date().toISOString());
      return result;
    } catch (error) {
      const cancelled = error.code === 'JOB_CANCELLED';
      const current = await this.db.getGenerationJob(jobId);
      const failedStage = current?.stage || 'starting';
      await this.db.updateGenerationJob(jobId, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: failedStage,
        error: error.message,
        details: { failedStage },
        completedAt: new Date().toISOString()
      });
      await this.operator.notify({
        type: cancelled ? 'generation_cancelled' : 'generation_failure',
        level: cancelled ? 'warning' : 'error',
        title: cancelled ? 'Generation cancelled' : 'Generation failed',
        message: error.message,
        data: { jobId }
      });
      throw error;
    }
  }

  async updateJobStage(jobId, stage, progress, details = {}) {
    if (!jobId) return;
    const job = await this.db.getGenerationJob(jobId);
    if (job?.cancelRequested) {
      const error = new Error(job.details?.cancelReason || 'Generation cancelled by operator');
      error.code = 'JOB_CANCELLED';
      throw error;
    }
    await this.db.updateGenerationJob(jobId, { stage, progress, details });
  }

  async generateEvidenceCheckedScript(strategy, jobId) {
    const job = jobId ? await this.db.getGenerationJob(jobId) : null;
    if (!['scheduler', 'autonomous_operator'].includes(job?.source) ||
        process.env.AUTONOMOUS_APPROVAL_ENABLED !== 'true') {
      return this.agents.scriptWriter.generateScript(strategy);
    }
    let rejection = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const script = await this.agents.scriptWriter.generateScript({ ...strategy, editorialCorrection: rejection });
      let provenance;
      const evidenceDb = {
        getContentProvenance: async () => provenance,
        saveContentProvenance: async (_id, value) => { provenance = value; }
      };
      await new ProvenanceService(evidenceDb).initialize('script_preflight', { script, strategy });
      const audit = await new AutonomousEditorialAudit(evidenceDb, this.credentials)
        .verifyFacts('script_preflight', { script });
      if (audit.passed) {
        script.metadata = { ...script.metadata, editorialPreflight: {
          checkedAt: new Date().toISOString(), attempts: attempt + 1,
          factualClaims: audit.claimCount, verifiedSources: audit.sourceCount
        } };
        return script;
      }
      rejection = { reason: audit.reason, uncheckedStatements: audit.uncheckedStatements || [] };
      this.logger.warn(`Script evidence preflight held attempt ${attempt + 1}: ${String(audit.reason).slice(0,200)}`);
    }
    const error = new Error('Autonomous editorial preflight blocked after three checked drafts: ' + String(rejection?.reason).slice(0,300));
    error.code = 'EDITORIAL_PREFLIGHT';
    throw error;
  }

  async ensureEvidenceCheckedPackaging(script, strategy, thumbnail, seo, jobId) {
    const job = jobId ? await this.db.getGenerationJob(jobId) : null;
    if (!['scheduler', 'autonomous_operator'].includes(job?.source) ||
        process.env.AUTONOMOUS_APPROVAL_ENABLED !== 'true') return { thumbnail, seo };
    let rejection;
    for (let attempt = 0; attempt < 3; attempt++) {
      let provenance;
      const evidenceDb = {
        getContentProvenance: async () => provenance,
        saveContentProvenance: async (_id, value) => { provenance = value; }
      };
      await new ProvenanceService(evidenceDb).initialize('packaging_preflight', { script, strategy });
      const audit = await new AutonomousEditorialAudit(evidenceDb, this.credentials)
        .verifyFacts('packaging_preflight', { script, thumbnail, seo });
      if (audit.passed) return { thumbnail, seo };
      rejection = { reason: audit.reason, uncheckedStatements: audit.uncheckedStatements || [] };
      this.logger.warn(`Published-copy preflight held attempt ${attempt + 1}: ${String(audit.reason).slice(0,200)}`);
      if (attempt < 2) {
        const correctedScript = { ...script, metadata: { ...script.metadata, packagingCorrection: rejection } };
        thumbnail = await this.agents.thumbnailDesigner.generateThumbnail(correctedScript);
        seo = await this.agents.seoOptimizer.optimize(correctedScript, { ...strategy, editorialCorrection: rejection });
      }
    }
    const error = new Error('Autonomous published-copy preflight blocked before rendering: ' + String(rejection?.reason).slice(0,300));
    error.code = 'EDITORIAL_PACKAGING_PREFLIGHT';
    throw error;
  }

  async generateContent(topic = null, style = null, length = 'medium', options = {}) {
    this.logger.info('Starting content generation pipeline...');
    const { jobId = null, strategyContext: rawStrategyContext = {} } = options;
    const strategyContext = rawStrategyContext || {};
    const profile = await this.db.getChannelProfile() || {};
    const lengthLabels = { short: '2-4 minutes', medium: '8-12 minutes', long: '15-20 minutes' };

    // Step 1: Strategy
    const strategy = await this.runGenerationStage(jobId, 'strategy', 10, async () => {
      const generated = await this.agents.strategy.generateContentStrategy(topic);
      const contentStyles = new Set(['tutorial', 'explainer', 'list', 'review', 'story']);
      const requestedStyle = style || profile.default_style || null;
      if (requestedStyle && contentStyles.has(requestedStyle.toLowerCase())) {
        generated.contentType = requestedStyle.charAt(0).toUpperCase() + requestedStyle.slice(1).toLowerCase();
      }
      generated.requestedStyle = requestedStyle;
      generated.requestedLengthKey = length;
      generated.requestedLength = lengthLabels[length] || lengthLabels.medium;
      generated.angle = strategyContext.angle || generated.angle;
      generated.planRationale = strategyContext.rationale || null;
      generated.targetAudience = strategyContext.audience || profile.target_audience || generated.targetAudience;
      generated.brandVoice = profile.brand_voice || null;
      generated.channelGoal = strategyContext.objective || profile.goal || null;
      generated.channelValueProposition = strategyContext.valueProposition || null;
      generated.channelConstraints = strategyContext.constraints || null;
      generated.contentPillar = strategyContext.pillar || null;
      generated.callToAction = profile.call_to_action || null;
      generated.researchSources = Array.isArray(strategyContext.researchSources)
        ? strategyContext.researchSources
        : [];
      return generated;
    });
    this.logger.info(`Strategy generated: ${strategy.topic}`);

    // Step 2: Script Writing
    const script = await this.runGenerationStage(
      jobId,
      'script',
      25,
      () => this.generateEvidenceCheckedScript(strategy, jobId)
    );
    this.logger.info(`Script generated: ${script.title}`);

    // Reject drafts that can never meet unattended factual approval *before*
    // spending minutes rendering video, audio and stock footage.
    const currentJob = jobId ? await this.db.getGenerationJob(jobId) : null;
    if (['scheduler','autonomous_operator'].includes(currentJob?.source) &&
        process.env.AUTONOMOUS_APPROVAL_ENABLED === 'true') {
      const sources = Array.isArray(strategy.researchSources) ? strategy.researchSources : [];
      const declared = Array.isArray(script.claims) ? script.claims : [];
      const allowed = new Set(sources.map(source => source.url));
      if (!sources.length || !declared.length ||
          declared.some(claim => claim.riskLevel === 'high' ||
            !Array.isArray(claim.sourceUrls) ||
            !claim.sourceUrls.some(url => allowed.has(url)))) {
        const error = new Error('Autonomous editorial preflight blocked the script: missing primary citations, unsupported statements or high-risk assertions.');
        error.code = 'EDITORIAL_PREFLIGHT';
        throw error;
      }
    }

    // Step 3: Thumbnail Design
    const thumbnail = await this.runGenerationStage(
      jobId,
      'thumbnail',
      40,
      () => this.agents.thumbnailDesigner.generateThumbnail(script)
    );
    this.logger.info('Thumbnail generated');

    // Step 4: SEO Optimization
    const seoData = await this.runGenerationStage(
      jobId,
      'seo',
      52,
      () => this.agents.seoOptimizer.optimize(script, strategy)
    );
    this.logger.info('SEO optimization complete');

    // Step 5: Production Management
    const productionData = await this.runGenerationStage(
      jobId,
      'production',
      62,
      async () => {
        const packaging = await this.ensureEvidenceCheckedPackaging(script, strategy, thumbnail, seoData, jobId);
        return this.agents.production.processContent({ strategy, script, thumbnail: packaging.thumbnail, seo: packaging.seo, jobId });
      }
    );
    this.logger.info('Production processing complete');

    // Re-persist reused production artifacts in case a restart happened between checkpointing and persistence.
    const contentId = await this.db.saveProductionData(productionData);
    await this.db.saveProductionSnapshot(productionData);
    if (!this.provenance) this.provenance = new ProvenanceService(this.db);
    productionData.provenance = await this.provenance.initialize(contentId, productionData);
    productionData.discoverability = this.discoverability
      ? await this.discoverability.auditProduction(productionData, profile, 'youtube')
      : null;
    this.logger.info(`Content saved with ID: ${contentId}`);

    // Step 6: Quality and approval gate
    return this.runGenerationStage(jobId, 'quality_review', 90, async () => {
      const approvalRequired = await this.db.getSetting('approval_required') !== 'false';
      const cadenceJob = jobId ? await this.db.getGenerationJob(jobId) : null;
      const unattended = ['scheduler', 'autonomous_operator'].includes(cadenceJob?.source);
      let autonomousAudit = null;
      if (unattended && process.env.AUTONOMOUS_APPROVAL_ENABLED === 'true') {
        try {
          autonomousAudit = await this.editorialAudit.audit(contentId, productionData);
          if (autonomousAudit.factual?.provenance) {
            productionData.provenance = autonomousAudit.factual.provenance;
          }
        } catch (error) {
          autonomousAudit = {passed:false,factual:{reason:String(error.message || error).slice(0,220)}};
        }
        this.logger.info('Automated editorial evidence gate: ' +
          (autonomousAudit.passed ? 'passed' : 'HELD FOR REVIEW'));
      }
      const packagingExperiment = approvalRequired && !unattended
        ? await this.preparePackagingExperiment(thumbnail, productionData, seoData, script)
        : null;
      const quality = await this.operator.runQualityChecks(productionData, profile);
      const autoApproved = unattended && process.env.AUTONOMOUS_APPROVAL_ENABLED === 'true' &&
        autonomousAudit?.passed === true && quality.passed;
      const reviewStatus = autoApproved ? 'approved' :
        quality.passed && !unattended && !approvalRequired ? 'approved' :
          quality.passed && !unattended ? 'needs_review' : 'needs_attention';
      // Never auto-approve manual drafts or silently bypass an unresolved
      // factual / rights check. A missing model, bad source, stock license or
      // incomplete media leaves a draft blocked.

      await this.db.saveContentReview(contentId, {
        status: reviewStatus,
        qualityChecks: quality.checks,
        editorData: autoApproved
          ? { factChecked: true, rightsConfirmed: true,
              autonomousApproval: {
                version: 2,
                ...await approvalFingerprints(productionData),
                checkedAt: new Date().toISOString(),
                factualClaims: autonomousAudit.factual.claimCount,
                verifiedSources: autonomousAudit.factual.sourceCount,
                licensedClips: autonomousAudit.media.videoClips,
                thumbnailSources: autonomousAudit.media.thumbnailImages
              } }
          : packagingExperiment
            ? { packagingExperiment, selectedTitleVariant: 0, selectedThumbnailVariant: 0 }
            : {},
        reviewNotes: autoApproved
          ? 'Approved by conservative autonomous factual evidence and licensed-media audit'
          : unattended
            ? String(autonomousAudit?.factual?.reason || autonomousAudit?.media?.reason ||
                `Blocking quality checks: ${quality.blockingFailures.join(', ')}`).slice(0,700)
            : quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`,
        reviewedAt: reviewStatus === 'approved' ? new Date().toISOString() : null
      });

      let scheduleEntry = null;
      if (reviewStatus === 'approved') {
        scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
        await this.db.updateProductionStatus(contentId, scheduleEntry ? 'scheduled' : productionData.status);
      } else {
        await this.db.updateProductionStatus(contentId, reviewStatus);
        await this.operator.notify({
          type: 'review_required',
          level: quality.passed ? 'info' : 'warning',
          title: quality.passed ? 'Content ready for review' : 'Content needs attention',
          message: `${script.title} ${quality.passed ? 'is ready for approval' : 'failed one or more quality checks'}`,
          data: { contentId, qualityScore: quality.score }
        });
      }

      return {
        contentId,
        title: script.title,
        status: productionData.status,
        reviewStatus,
        qualityScore: quality.score,
        scheduledFor: scheduleEntry ? scheduleEntry.publishTime : null
      };
    });
  }

  async runGenerationStage(jobId, stage, progress, producer) {
    if (!jobId) {
      await this.updateJobStage(jobId, stage, progress);
      return producer();
    }
    if (!this.recovery) {
      this.recovery = new GenerationRecoveryService(this.db, {
        logger: this.logger,
        updateJobStage: (...args) => this.updateJobStage(...args)
      });
    }
    return this.recovery.run(jobId, stage, progress, producer);
  }

  validateEditorData(input = {}, existing = {}) {
    const output = { ...existing };
    if (input.title !== undefined) {
      const title = String(input.title).trim();
      if (!title || title.length > 100) throw new Error('Title must be between 1 and 100 characters');
      output.title = title;
    }
    if (input.description !== undefined) {
      const description = String(input.description).trim();
      if (description.length > 5000) throw new Error('Description must be 5,000 characters or less');
      output.description = description;
    }
    if (input.tags !== undefined) {
      const tags = Array.isArray(input.tags)
        ? input.tags
        : String(input.tags).split(',');
      output.tags = tags.map(tag => String(tag).trim()).filter(Boolean).slice(0, 30);
    }
    if (input.publishTime !== undefined) {
      const date = new Date(input.publishTime);
      if (Number.isNaN(date.getTime())) throw new Error('Publish time must be a valid date');
      output.publishTime = date.toISOString();
    }
    if (input.privacyStatus !== undefined) {
      if (!['private', 'unlisted', 'public'].includes(input.privacyStatus)) throw new Error('Invalid privacy status');
      output.privacyStatus = input.privacyStatus;
    }
    if (input.factChecked !== undefined) output.factChecked = input.factChecked === true;
    if (input.rightsConfirmed !== undefined) output.rightsConfirmed = input.rightsConfirmed === true;
    const experiment = output.packagingExperiment;
    if (input.selectedTitleVariant !== undefined) {
      const selected = Number(input.selectedTitleVariant);
      if (!Number.isInteger(selected) || !experiment?.titleVariants?.[selected]) {
        throw new Error('Selected title variant is invalid');
      }
      output.selectedTitleVariant = selected;
    }
    if (input.selectedThumbnailVariant !== undefined) {
      const selected = Number(input.selectedThumbnailVariant);
      if (!Number.isInteger(selected) || !experiment?.thumbnailVariants?.[selected]) {
        throw new Error('Selected thumbnail variant is invalid');
      }
      output.selectedThumbnailVariant = selected;
    }
    return output;
  }

  buildTitleExperimentVariants(title) {
    const control = String(title || '').trim().slice(0, 100);
    const withoutPunctuation = control.replace(/[.!?]+$/, '');
    return [
      { label: 'Control', title: control },
      { label: 'Step-by-step', title: `${withoutPunctuation}: Step-by-Step`.slice(0, 100) },
      { label: 'Curiosity', title: `${withoutPunctuation}: What Most People Miss`.slice(0, 100) }
    ];
  }

  async preparePackagingExperiment(thumbnail, productionData, seoData, script) {
    const approved = await this.db.listLearningRecommendations({ status: 'approved', limit: 25 });
    const recommendation = approved.find(item => item.proposedChange?.experiment === 'title_thumbnail_variant');
    if (!recommendation) return null;
    try {
      const generated = await this.agents.thumbnailDesigner.generateABVariants(thumbnail.concept);
      return {
        sourceRecommendationId: recommendation.id,
        hypothesis: recommendation.title,
        status: 'draft',
        titleVariants: this.buildTitleExperimentVariants(seoData.title || script.title),
        thumbnailVariants: [
          { label: 'Control', path: productionData.assets?.thumbnail?.path, concept: thumbnail.concept },
          ...generated
        ],
        createdAt: new Date().toISOString()
      };
    } catch (error) {
      this.logger.warn(`Packaging experiment preparation failed without blocking production: ${error.message}`);
      return null;
    }
  }

  validateProfile(input) {
    const textFields = ['channelName', 'goal', 'targetAudience', 'brandVoice', 'defaultStyle', 'callToAction', 'visualStyle', 'timezone'];
    const result = {};
    for (const field of textFields) {
      if (input[field] !== undefined) {
        const value = String(input[field]).trim();
        if (value.length > 500) throw new Error(`${field} is too long`);
        result[field] = value;
      }
    }
    if (input.bannedTopics !== undefined) {
      const topics = Array.isArray(input.bannedTopics) ? input.bannedTopics : String(input.bannedTopics).split(',');
      result.bannedTopics = topics.map(topic => String(topic).trim()).filter(Boolean).slice(0, 50);
    }
    return result;
  }

  decorateContentBundle(bundle) {
    const experiment = bundle.editorData?.packagingExperiment;
    const sceneLabels = new Map((bundle.scenes || []).map(scene => [scene.id, scene.label]));
    return {
      ...bundle,
      scenes: (bundle.scenes || []).map(scene => this.scenes
        ? this.scenes.decorateScene(scene, bundle.id)
        : scene),
      shorts: (bundle.shorts || []).map(clip => ({
        ...clip,
        sourceSceneLabels: clip.sourceSceneIds.map(id => sceneLabels.get(id)).filter(Boolean),
        assetUrls: {
          video: clip.outputPath ? `/api/content/${bundle.id}/shorts/${clip.id}/asset/video` : null,
          captions: clip.captionsPath ? `/api/content/${bundle.id}/shorts/${clip.id}/asset/captions` : null
        }
      })),
      assetUrls: {
        video: bundle.assets?.finalVideo?.path && !bundle.assets?.finalVideo?.simulated ? `/api/content/${bundle.id}/asset/video` : null,
        thumbnail: bundle.assets?.thumbnail?.path ? `/api/content/${bundle.id}/asset/thumbnail` : null,
        experimentThumbnails: (experiment?.thumbnailVariants || []).map((_variant, index) =>
          `/api/content/${bundle.id}/asset/experiment-thumbnail-${index}`
        ),
        freeThumbnails: (bundle.assets?.thumbnail?.variants || []).map((_variant,index)=>
          `/api/content/${bundle.id}/asset/free-thumbnail-${index}`),
        captions: bundle.assets?.captions?.path ? `/api/content/${bundle.id}/asset/captions` : null,
        captionsVtt: bundle.assets?.captions?.path ? `/api/content/${bundle.id}/asset/captions-vtt` : null,
        script: bundle.assets?.script?.originalPath ? `/api/content/${bundle.id}/asset/script` : null
      }
    };
  }

  async refreshContentReview(productionId, reviewNotes) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) return null;
    const profile = await this.db.getChannelProfile() || {};
    const quality = await this.operator.runQualityChecks({
      ...bundle,
      scheduledPublishTime: bundle.scheduled_publish_time
    }, profile);
    const status = quality.passed ? 'needs_review' : 'needs_attention';
    return this.db.saveContentReview(productionId, {
      status,
      editorData: { ...(bundle.editorData || {}), factChecked: false, rightsConfirmed: false },
      qualityChecks: quality.checks,
      reviewNotes: reviewNotes || (quality.passed ? null : `Blocking checks failed: ${quality.blockingFailures.join(', ')}`),
      reviewedAt: null
    });
  }

  async approveContent(productionId, input) {
    const bundle = await this.db.getProductionBundle(productionId);
    if (!bundle) {
      const error = new Error('Content not found');
      error.status = 404;
      throw error;
    }
    if (bundle.schedule?.status === 'published') {
      const error = new Error('Content is already published');
      error.status = 409;
      throw error;
    }

    const editorData = this.validateEditorData(input, bundle.editorData);
    const packagingExperiment = editorData.packagingExperiment;
    const thumbnailVariant = packagingExperiment?.thumbnailVariants?.[editorData.selectedThumbnailVariant];
    const titleVariant = packagingExperiment?.titleVariants?.[editorData.selectedTitleVariant];
    if (titleVariant && input.title === undefined) editorData.title = titleVariant.title;
    if (!editorData.factChecked || !editorData.rightsConfirmed) {
      const error = new Error('Confirm the factual review and media rights checks before approval');
      error.status = 409;
      throw error;
    }
    const productionData = {
      id: bundle.id,
      status: bundle.status,
      strategy: bundle.strategy,
      script: { ...bundle.script, title: editorData.title || bundle.script.title },
      thumbnail: bundle.thumbnail,
      seo: {
        ...bundle.seo,
        title: editorData.title || bundle.seo.title,
        description: editorData.description || bundle.seo.description,
        tags: editorData.tags || bundle.seo.tags
      },
      assets: thumbnailVariant
        ? { ...bundle.assets, thumbnail: { ...bundle.assets.thumbnail, path: thumbnailVariant.path } }
        : bundle.assets,
      timeline: bundle.timeline,
      scheduledPublishTime: editorData.publishTime || input.publishTime || bundle.scheduled_publish_time,
      priority: bundle.priority,
      estimatedDuration: bundle.estimated_duration,
      privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
      provenance: bundle.provenance,
      containsSyntheticMedia: bundle.provenance?.containsSyntheticMedia === true,
      scenes: bundle.scenes || []
    };
    const profile = await this.db.getChannelProfile() || {};
    const quality = await this.operator.runQualityChecks(productionData, profile);
    if (!quality.passed) {
      await this.db.saveContentReview(bundle.id, {
        status: 'needs_attention', editorData, qualityChecks: quality.checks,
        reviewNotes: `Blocking checks failed: ${quality.blockingFailures.join(', ')}`
      });
      const error = new Error('Content still has blocking quality failures');
      error.status = 409;
      error.quality = quality;
      throw error;
    }

    let scheduleEntry = bundle.schedule;
    if (!scheduleEntry) {
      scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
    } else if (scheduleEntry.status !== 'published') {
      scheduleEntry.title = productionData.script.title;
      scheduleEntry.publishTime = productionData.scheduledPublishTime;
      scheduleEntry.status = 'scheduled';
      scheduleEntry.metadata = {
        ...scheduleEntry.metadata,
        seo: productionData.seo,
        thumbnail: productionData.assets.thumbnail,
        video: productionData.assets.finalVideo,
        audio: productionData.assets.audio,
        captions: productionData.assets.captions,
        privacyStatus: editorData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
        containsSyntheticMedia: productionData.containsSyntheticMedia
      };
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.agents.publishing.loadPublishQueue();
    }
    if (!scheduleEntry) {
      const error = new Error('A real MP4 is required before content can be approved for scheduling');
      error.status = 409;
      throw error;
    }

    await this.db.saveContentReview(bundle.id, {
      status: 'approved', editorData, qualityChecks: quality.checks,
      reviewNotes: input.reviewNotes || 'Approved by operator', reviewedAt: new Date().toISOString()
    });
    await this.db.updateProductionStatus(bundle.id, 'scheduled');
    await this.operator.notify({
      type: 'content_approved', level: 'success', title: 'Content approved',
      message: `${productionData.script.title} is scheduled for ${scheduleEntry.publishTime}`,
      data: { productionId, publishTime: scheduleEntry.publishTime }
    });
    return { productionId, reviewStatus: 'approved', qualityScore: quality.score, schedule: scheduleEntry };
  }

  async start() {
    validateDeploymentEnv();
    const initialized = await this.initialize();
    
    if (!initialized) {
      console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
      process.exit(1);
    }
    
    const PORT = process.env.PORT || 3456;
    this.app.listen(PORT, process.env.HOST || '127.0.0.1', () => {
      console.log(chalk.green(`\n✅ YouTube Automation Agent running on port ${PORT}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://localhost:${PORT}`));
      console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
      console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
      console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
      console.log(chalk.gray('─'.repeat(50)));
      if (this.setupRequired) {
        console.log(chalk.yellow('\n⚙️  Setup is required. The dashboard is available; run npm run walkthrough to enable generation.'));
      } else if (!this.scheduler?.isEnabled) {
        console.log(chalk.yellow('\n⏸️  Automação pausada. Nenhuma geração ou publicação automática será iniciada.'));
      } else if (process.env.AUTO_PUBLISH_ENABLED !== 'true') {
        console.log(chalk.yellow('\n🤖 Agendador em execução. Publicação automática ainda depende do controle no banco e da aprovação.'));
      } else {
        console.log(chalk.yellow('\n🤖 Agendador ativo. Só serão publicados conteúdos aprovados e dentro dos limites.'));
      }
    });
  }
}

// Start the agent
if (require.main === module) {
  const agent = new YouTubeAutomationAgent();
  agent.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

module.exports = { YouTubeAutomationAgent };
