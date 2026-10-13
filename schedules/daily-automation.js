const cron = require('node-cron');
const { Logger } = require('../utils/logger');
const fs = require('node:fs/promises');
const path = require('node:path');

class DailyAutomation {
  constructor(agents, database, options = {}) {
    this.agents = agents;
    this.db = database;
    this.logger = new Logger('DailyAutomation');
    this.scheduledTasks = new Map();
    // Default OFF until the persisted operator setting explicitly resumes it.
    this.isEnabled = false;
    this.healthCheckInterval = null;
    this.lastHealthCheck = null;
    this.generateContent = options.generateContent || null;
    this.resumeGenerationJob = options.resumeGenerationJob || null;
    this.refreshReadiness = options.refreshReadiness || null;
    this.getFreeDiskBytes = options.getFreeDiskBytes || (async () => {
      const stat = await fs.statfs(path.resolve(__dirname, '..', 'data'));
      return Number(stat.bavail) * Number(stat.bsize);
    });
    this.engagement = options.engagement || null;
    this.experiments = options.experiments || null;
    this.generationRunning = false;
  }

  async initialize() {
    this.logger.info('Initializing daily automation scheduler...');
    
    await this.setupScheduledTasks();
    
    // Start monitoring loop
    this.startMonitoringLoop();
    
    this.logger.success('Daily automation initialized successfully');
    return true;
  }

  async setupScheduledTasks() {
    const configuredTarget=Number(process.env.DAILY_GENERATION_TARGET || '1');
    const target=Number.isInteger(configuredTarget)?Math.min(2,Math.max(1,configuredTarget)):1;
    this.dailyGenerationTarget=target;
    const configuredTimezone=await this.db.getSetting('channel_timezone');
    try {
      new Intl.DateTimeFormat('pt-BR',{timeZone:configuredTimezone || 'America/Sao_Paulo'});
      this.channelTimezone=configuredTimezone || 'America/Sao_Paulo';
    } catch (_) {
      this.channelTimezone='America/Sao_Paulo';
    }
    // Two slots can be enabled after readiness and autonomous publishing are
    // approved; they always follow the channel timezone, not the VPS timezone.
    const schedules=target===2
      ? [['daily-content-generation','0 6 * * *'],['second-daily-content-generation','0 15 * * *']]
      : [['daily-content-generation','0 6 * * *']];
    for(const [name,cronString] of schedules) {
      this.scheduledTasks.set(name,cron.schedule(cronString,async()=>{
        if(this.isEnabled)await this.runDailyContentGeneration();
      },{scheduled:false,timezone:this.channelTimezone}));
    }

    // Retry only safe, interrupted/infrastructure-failed generation stages.
    // Do not automatically replay uncertain YouTube uploads.
    this.scheduledTasks.set('generation-job-recovery',
      cron.schedule('10 * * * *', async () => {
        if (this.isEnabled) await this.recoverInterruptedJobs();
      }, { scheduled: false, timezone: this.channelTimezone })
    );

    // Publishing queue processing every 15 minutes
    this.scheduledTasks.set('publish-queue-processing',
      cron.schedule('*/15 * * * *', async () => {
        if (this.isEnabled) {
          await this.processPublishQueue();
        }
      }, { scheduled: false, timezone: this.channelTimezone })
    );

    // Analytics collection at 9:00 AM daily
    this.scheduledTasks.set('daily-analytics',
      cron.schedule('0 9 * * *', async () => {
        if (this.isEnabled) {
          await this.collectDailyAnalytics();
        }
      }, { scheduled: false, timezone: this.channelTimezone })
    );

    // Weekly strategy review on Sundays at 8:00 AM
    this.scheduledTasks.set('weekly-strategy-review',
      cron.schedule('0 8 * * 0', async () => {
        if (this.isEnabled) {
          await this.weeklyStrategyReview();
        }
      }, { scheduled: false, timezone: this.channelTimezone })
    );

    // Optimization tasks daily at 10:00 PM
    this.scheduledTasks.set('daily-optimization',
      cron.schedule('0 22 * * *', async () => {
        if (this.isEnabled) {
          await this.runDailyOptimization();
        }
      }, { scheduled: false, timezone: this.channelTimezone })
    );

    // Database maintenance weekly on Saturdays at 3:00 AM
    this.scheduledTasks.set('database-maintenance',
      cron.schedule('0 3 * * 6', async () => {
        if (this.isEnabled) {
          await this.databaseMaintenance();
        }
      }, { scheduled: false, timezone: this.channelTimezone })
    );

    // Audience comment sync every 4 hours; the service's own taper decides which videos are due
    this.scheduledTasks.set('audience-engagement-sync',
      cron.schedule('0 */4 * * *', async () => {
        if (this.isEnabled) {
          await this.collectAudienceEngagement();
        }
      }, { scheduled: false, timezone: this.channelTimezone })
    );

    // Collect controlled experiment evidence and advance only pre-approved arms.
    this.scheduledTasks.set('growth-experiment-refresh',
      cron.schedule('30 */4 * * *', async () => {
        if (this.isEnabled) {
          await this.refreshGrowthExperiments();
        }
      }, { scheduled: false, timezone: this.channelTimezone })
    );

    // Reverify real production dependencies before fixed publication slots.
    if (this.refreshReadiness) {
      this.scheduledTasks.set('production-readiness-refresh', cron.schedule(
        '45 5,11,17,23 * * *', () => this.refreshProductionReadiness(),
        { scheduled: false, timezone: this.channelTimezone }
      ));
    }

    // Start all scheduled tasks
    this.scheduledTasks.forEach((task, name) => {
      task.start();
      this.logger.info(`Started scheduled task: ${name}`);
    });
  }

  async refreshProductionReadiness() {
    if (!this.isEnabled || !this.refreshReadiness ||
        await this.db.getSetting('automation_paused') !== 'false') return null;
    try {
      const result = await this.refreshReadiness();
      await this.logAutomationEvent('production_readiness_refresh',
        result.status === 'failed' ? 'error' : 'success', { status: result.status, summary: result.summary });
      if (result.status === 'failed') {
        await this.sendFailureNotification('Production readiness',
          new Error('Production readiness failed; generation and publishing remain blocked.'));
      }
      return result;
    } catch (error) {
      await this.sendFailureNotification('Production readiness', error);
      return null;
    }
  }

  async runDailyContentGeneration() {
    if (!this.isEnabled || this.generationRunning) return;
    this.generationRunning = true;
    try {
      if (await this.db.getSetting('automation_paused') !== 'false') return;
      this.logger.info('Starting daily content generation...');
      
      const free = await this.getFreeDiskBytes();
      const requiredGiB = Number(process.env.DAILY_GENERATION_TARGET || '1') === 2 ? 20 : 4;
      if (!Number.isFinite(free) || free < requiredGiB * 1024 ** 3) {
        const error = new Error(`Low video-production disk space: keep at least ${requiredGiB} GiB free`);
        error.code = 'LOW_DISK';
        throw error;
      }

      const timer = this.logger.startTimer('Daily Content Generation');
      
      // Check if we should generate content today
      const shouldGenerate = await this.shouldGenerateContentToday();
      
      if (!shouldGenerate) {
        this.logger.info('Skipping content generation - sufficient content in pipeline');
        return;
      }

      if (this.generateContent) {
        const job = await this.generateContent({ source: 'scheduler' });
        await this.db.setSetting('last_content_generation', new Date().toISOString());
        timer.end();
        this.logger.success(`Daily content generation queued: ${job.id}`);
        await this.logAutomationEvent('daily_content_generation', 'queued', { jobId: job.id });
        return;
      }

      // Generate content strategy
      const strategy = await this.agents.strategy.generateContentStrategy();
      this.logger.info(`Generated strategy: ${strategy.topic}`);

      // Generate script
      const script = await this.agents.scriptWriter.generateScript(strategy);
      this.logger.info(`Generated script: ${script.title}`);

      // Generate thumbnail
      const thumbnail = await this.agents.thumbnailDesigner.generateThumbnail(script);
      this.logger.info('Generated thumbnail');

      // Optimize SEO
      const seoData = await this.agents.seoOptimizer.optimize(script, strategy);
      this.logger.info('Completed SEO optimization');

      // Process through production
      const productionData = await this.agents.production.processContent({
        strategy,
        script,
        thumbnail,
        seo: seoData
      });
      this.logger.info(`Production completed: ${productionData.id}`);

      // Schedule for publishing (returns null when only placeholder assets were produced)
      const scheduleEntry = await this.agents.publishing.scheduleContent(productionData);
      if (scheduleEntry) {
        this.logger.info('Content scheduled for publishing');
      } else {
        this.logger.warn('Content was NOT scheduled — production produced placeholder assets. See warnings above.');
      }

      timer.end();
      this.logger.success('Daily content generation completed successfully');

      // Log the event
      await this.logAutomationEvent('daily_content_generation', 'success', {
        contentId: productionData.id,
        topic: strategy.topic,
        scheduledFor: productionData.scheduledPublishTime
      });

    } catch (error) {
      this.logger.error('Daily content generation failed:', error);
      
      await this.logAutomationEvent('daily_content_generation', 'error', {
        error: error.message
      });

      // Send notification about failure
      await this.sendFailureNotification('Daily Content Generation', error);
    } finally {
      this.generationRunning = false;
    }
  }

  async recoverInterruptedJobs() {
    if (!this.isEnabled || !this.resumeGenerationJob ||
        await this.db.getSetting('automation_paused') !== 'false' ||
        this.generationRunning) return 0;
    const jobs = await this.db.listGenerationJobs(30);
    const now=Date.now();
    const recoverable = jobs.find(job => {
      if (!['scheduler','autonomous_operator'].includes(job.source)) return false;
      if (Number(job.details?.resumeCount || 0) >= 2) return false;
      if (!['interrupted','failed'].includes(job.status)) return false;
      // Do not retry deliberate factual, rights or policy rejections.
      if (job.status === 'failed' &&
          !/(?:timeout|ETIMEDOUT|ECONNRESET|EAI_AGAIN|temporary|socket hang up|503|502|429|rate limit)/i
            .test(String(job.error || ''))) return false;
      const updated = Date.parse(String(job.updated_at || '').replace(' ','T') + (
        /[zZ]$|[+-]\d{2}:\d{2}$/.test(String(job.updated_at || '')) ? '' : 'Z'));
      return !Number.isFinite(updated) || now - updated >= 30 * 60000;
    });
    if (!recoverable) return 0;
    const freeBytes = Number(await this.getFreeDiskBytes());
    const requiredGiB = Number(process.env.DAILY_GENERATION_TARGET || '1') === 2 ? 20 : 4;
    if (!Number.isFinite(freeBytes) || freeBytes < requiredGiB * 1024 ** 3) {
      this.logger.warn('Skipping recovery: low disk capacity');
      return 0;
    }
    try {
      await this.resumeGenerationJob(recoverable.id);
      this.logger.info('Autonomous generation safely resumed: ' + recoverable.id);
      await this.logAutomationEvent('generation_job_recovery','queued',{jobId:recoverable.id});
      return 1;
    } catch (error) {
      await this.sendFailureNotification('Generation recovery',error);
      return 0;
    }
  }

  async shouldGenerateContentToday() {
    const bufferDays=Math.max(1,Math.min(7,Number(await this.db.getSetting('content_buffer_days'))||3));
    const target=this.dailyGenerationTarget||1;
    const upcomingContent=await this.agents.publishing.getUpcomingSchedule(bufferDays);
    if(upcomingContent.length>=bufferDays*target)return false;
    if(target===2){
      // Prevent unbounded drafts when research/fact checking prevents approval.
      const pending=await this.db.getRow(
        `SELECT COUNT(*) AS count FROM content_reviews
         WHERE status IN ('needs_review','needs_attention')`);
      if(Number(pending?.count||0)>=Math.max(4,bufferDays*target)){
        this.logger.warn('Automatic content buffer full of pending reviews. Holding new generation.');
        return false;
      }
      // Use the channel's calendar date, not the VPS host timezone.
      const currentDay=new Intl.DateTimeFormat('en-CA',{
        timeZone:this.channelTimezone||'America/Sao_Paulo',
        year:'numeric',month:'2-digit',day:'2-digit'
      }).format(new Date());
      const recent=await this.db.getAllRows(
        `SELECT created_at FROM generation_jobs
         WHERE source IN ('scheduler','autonomous_operator')
         AND status IN ('queued','running','completed')
         AND created_at >= datetime('now','-2 days')`);
      const dayOf=row=>{
        const raw=String(row.created_at||'').replace(' ','T');
        const value=new Date(raw.endsWith('Z')?raw:raw+'Z');
        return Number.isNaN(value.getTime())?'':new Intl.DateTimeFormat('en-CA',{
          timeZone:this.channelTimezone||'America/Sao_Paulo',
          year:'numeric',month:'2-digit',day:'2-digit'
        }).format(value);
      };
      if(recent.filter(row=>dayOf(row)===currentDay).length>=target)return false;
      if(Number((await this.db.getRow(
        `SELECT COUNT(*) AS count FROM generation_jobs
         WHERE status IN ('queued','running')`))?.count||0)>=1)return false;
      const strategy=this.db.getChannelStrategy?await this.db.getChannelStrategy():null;
      if(strategy?.status==='active'){
        const week=await this.db.getRow(
          `SELECT COUNT(*) AS count FROM generation_jobs
           WHERE source='autonomous_operator' AND status='completed'
           AND created_at >= datetime('now','-7 days')`);
        if(Number(week?.count||0)>=strategy.cadence_per_week)return false;
      }
      return true;
    }

    // Check posting frequency settings
    const lastGeneration = await this.db.getSetting('last_content_generation');
    const channelStrategy = this.db.getChannelStrategy ? await this.db.getChannelStrategy() : null;

    if (channelStrategy?.status === 'active') {
      const weeklyOutput = await this.db.getRow(
        `SELECT COUNT(*) AS count FROM generation_jobs
         WHERE source = 'autonomous_operator' AND status = 'completed'
         AND created_at >= datetime('now', '-7 days')`
      );
      if (Number(weeklyOutput?.count || 0) >= channelStrategy.cadence_per_week) return false;
      if (!lastGeneration) return true;
      const daysSinceLastGeneration = Math.floor(
        (new Date() - new Date(lastGeneration)) / (1000 * 60 * 60 * 24)
      );
      return daysSinceLastGeneration >= 1;
    }

    const frequency = await this.db.getSetting('posting_frequency') || 'daily';
    
    if (lastGeneration) {
      const lastDate = new Date(lastGeneration);
      const today = new Date();
      const daysSinceLastGeneration = Math.floor((today - lastDate) / (1000 * 60 * 60 * 24));
      
      switch (frequency) {
        case 'daily':
          return daysSinceLastGeneration >= 1;
        case 'every-2-days':
          return daysSinceLastGeneration >= 2;
        case '3-per-week':
          return daysSinceLastGeneration >= 2 || [1, 3, 5].includes(today.getDay());
        case 'weekly':
          return daysSinceLastGeneration >= 7;
        default:
          return true;
      }
    }

    return true;
  }

  async processPublishQueue() {
    try {
      const published = await this.agents.publishing.processPublishQueue();
      
      if (published > 0) {
        this.logger.info(`Published ${published} videos from queue`);
        
        await this.logAutomationEvent('queue_processing', 'success', {
          publishedCount: published
        });
      }
    } catch (error) {
      this.logger.error('Failed to process publish queue:', error);
      
      await this.logAutomationEvent('queue_processing', 'error', {
        error: error.message
      });
      await this.sendFailureNotification('Publishing Queue', error);
    }
  }

  async collectDailyAnalytics() {
    try {
      this.logger.info('Starting daily analytics collection...');
      
      // Keep a 30-day catch-up window so new installs can backfill 24-hour and 7-day evidence.
      const recentVideos = await this.getRecentlyPublishedVideos(30);
      
      let processedCount = 0;
      
      for (const video of recentVideos) {
        try {
          const windows = await this.agents.analytics.getDueMeasurementWindows(video);
          for (const measurementWindow of windows) {
            await this.agents.analytics.analyzeVideoPerformance(video.youtube_id, { measurementWindow });
            processedCount++;
            this.logger.info(`Captured ${measurementWindow} learning evidence for: ${video.title}`);

            // Small delay to avoid API rate limits
            await this.sleep(2000);
          }
        } catch (error) {
          this.logger.error(`Failed to analyze video ${video.youtube_id}:`, error);
        }
      }

      this.logger.success(`Analytics collection completed. Processed ${processedCount} videos`);
      
      await this.logAutomationEvent('analytics_collection', 'success', {
        videosProcessed: processedCount
      });

    } catch (error) {
      this.logger.error('Daily analytics collection failed:', error);
      
      await this.logAutomationEvent('analytics_collection', 'error', {
        error: error.message
      });
      await this.sendFailureNotification('Analytics Collection', error);
    }
  }

  async collectAudienceEngagement() {
    if (!this.engagement) return;
    try {
      this.logger.info('Starting audience comment sync...');
      const recentVideos = await this.getRecentlyPublishedVideos(30);
      const results = await this.engagement.syncDueVideos(recentVideos.map(video => ({
        youtubeId: video.youtube_id,
        title: video.title,
        publishedAt: video.published_at,
        productionId: video.production_id || null
      })));
      this.logger.success(`Audience engagement sync completed: ${results.synced} synced, ${results.skipped} skipped, ${results.failed} failed`);
      await this.logAutomationEvent('audience_engagement_sync', 'success', results);
    } catch (error) {
      this.logger.error('Audience engagement sync failed:', error);
      await this.logAutomationEvent('audience_engagement_sync', 'error', { error: error.message });
    }
  }

  async refreshGrowthExperiments() {
    if (!this.experiments) return;
    try {
      const result = await this.experiments.refreshDue();
      if (result.refreshed || result.failed) {
        await this.logAutomationEvent('growth_experiment_refresh', result.failed ? 'warning' : 'success', result);
      }
    } catch (error) {
      this.logger.error('Growth experiment refresh failed:', error);
      await this.logAutomationEvent('growth_experiment_refresh', 'error', { error: error.message });
    }
  }

  async weeklyStrategyReview() {
    try {
      this.logger.info('Starting weekly strategy review...');
      
      // Analyze performance of last week's content
      const weeklyAnalytics = await this.agents.analytics.getRecentAnalytics(7);
      
      // Update content strategy based on performance
      if (weeklyAnalytics.topPerformers.length > 0) {
        const bestPerformingTopics = weeklyAnalytics.topPerformers
          .map(video => video.videoDetails.title)
          .slice(0, 3);
        
        this.logger.info(`Top performing topics: ${bestPerformingTopics.join(', ')}`);
      }

      // Optimize publishing times
      await this.agents.publishing.optimizePublishTimes();
      
      // Generate strategy insights
      const insights = await this.generateWeeklyInsights(weeklyAnalytics);
      
      this.logger.success('Weekly strategy review completed');
      
      await this.logAutomationEvent('weekly_strategy_review', 'success', {
        insights
      });

    } catch (error) {
      this.logger.error('Weekly strategy review failed:', error);
      
      await this.logAutomationEvent('weekly_strategy_review', 'error', {
        error: error.message
      });
    }
  }

  async runDailyOptimization() {
    try {
      this.logger.info('Starting daily optimization tasks...');
      
      // Optimize existing content SEO
      await this.optimizeExistingContent();
      
      // Update keyword performance data
      await this.updateKeywordPerformance();
      
      // Clean up old files
      await this.cleanupOldFiles();
      
      this.logger.success('Daily optimization completed');
      
      await this.logAutomationEvent('daily_optimization', 'success');

    } catch (error) {
      this.logger.error('Daily optimization failed:', error);
      
      await this.logAutomationEvent('daily_optimization', 'error', {
        error: error.message
      });
    }
  }

  async databaseMaintenance() {
    try {
      this.logger.info('Starting database maintenance...');
      
      // Create backup
      const backupPath = await this.db.backup();
      this.logger.info(`Database backed up to: ${backupPath}`);
      
      // Get database stats
      const stats = await this.db.getStats();
      this.logger.info(`Database stats: ${JSON.stringify(stats)}`);
      
      // Clean old analytics data (older than 90 days)
      await this.cleanOldAnalytics();
      
      this.logger.success('Database maintenance completed');
      
      await this.logAutomationEvent('database_maintenance', 'success', {
        backupPath,
        stats
      });

    } catch (error) {
      this.logger.error('Database maintenance failed:', error);
      
      await this.logAutomationEvent('database_maintenance', 'error', {
        error: error.message
      });
    }
  }

  // Helper methods
  async getRecentlyPublishedVideos(days) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);
    
    const rows = await this.db.getAllRows(
      `SELECT * FROM publish_schedule 
       WHERE status = 'published' AND published_at > ?
       ORDER BY published_at DESC`,
      [cutoffDate.toISOString()]
    );
    
    return rows;
  }

  async generateWeeklyInsights(analytics) {
    const insights = [];
    
    if (analytics.averagePerformanceScore > 80) {
      insights.push('Content performance is excellent this week');
    } else if (analytics.averagePerformanceScore < 50) {
      insights.push('Content performance needs improvement');
    }
    
    if (analytics.topPerformers.length > 0) {
      insights.push(`Best performing video: ${analytics.topPerformers[0].videoDetails.title}`);
    }
    
    return insights;
  }

  async optimizeExistingContent() {
    // Get videos published in last 30 days with low performance
    const lowPerformingVideos = await this.db.getAllRows(
      `SELECT ar.* FROM analytics_reports ar
       JOIN publish_schedule ps ON ar.video_id = ps.id
       WHERE ar.performance_score < 50 
       AND ps.published_at > datetime('now', '-30 days')
       LIMIT 5`
    );
    
    for (const video of lowPerformingVideos) {
      // Re-analyze and generate optimization suggestions
      await this.agents.analytics.analyzeVideoPerformance(video.video_id);
      this.logger.info(`Re-analyzed low performing video: ${video.video_id}`);
    }
  }

  async updateKeywordPerformance() {
    // Update keyword performance based on recent analytics
    const recentVideos = await this.getRecentlyPublishedVideos(7);
    
    for (const video of recentVideos) {
      const analyticsData = await this.db.getRow(
        'SELECT * FROM analytics_reports WHERE video_id = ?',
        [video.id]
      );
      
      if (analyticsData) {
        const videoDetails = JSON.parse(analyticsData.video_details);
        const keywords = videoDetails.tags || [];
        
        for (const keyword of keywords) {
          await this.db.updateKeywordPerformance(
            keyword,
            videoDetails.statistics.viewCount,
            video.youtube_id
          );
        }
      }
    }
  }

  async cleanupOldFiles() {
    // Clean up temporary files older than 7 days
    const path = require('path');
    
    const tempDir = path.join(__dirname, '..', 'temp');
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    
    try {
      await this.cleanDirectoryOldFiles(tempDir, 7);
      await this.cleanDirectoryOldFiles(uploadsDir, 30);
      this.logger.info('Old files cleaned up');
    } catch (error) {
      this.logger.error('Failed to clean up old files:', error);
    }
  }

  async cleanDirectoryOldFiles(directory, days) {
    const fs = require('fs').promises;
    const path = require('path');
    
    try {
      const files = await fs.readdir(directory);
      const cutoffTime = Date.now() - (days * 24 * 60 * 60 * 1000);
      
      for (const file of files) {
        const filePath = path.join(directory, file);
        const stats = await fs.stat(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          await fs.unlink(filePath);
        }
      }
    } catch (error) {
      // Directory might not exist, which is fine
    }
  }

  async cleanOldAnalytics() {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - 90);
    
    await this.db.executeQuery(
      'DELETE FROM analytics_reports WHERE analyzed_at < ?',
      [cutoffDate.toISOString()]
    );
  }

  async logAutomationEvent(eventType, status, data = {}) {
    await this.db.executeQuery(
      'INSERT INTO automation_events (event_type, status, data, created_at) VALUES (?, ?, ?, datetime("now"))',
      [eventType, status, JSON.stringify(data)]
    );
  }

  async sendFailureNotification(taskName, error) {
    // This would integrate with notification services (email, Slack, etc.)
    this.logger.error(`AUTOMATION FAILURE - ${taskName}: ${error.message}`);
    if (this.db.createNotification) {
      await this.db.createNotification({
        type: 'automation_failure',
        level: 'error',
        title: `${taskName} failed`,
        message: error.message
      });
    }
  }

  startMonitoringLoop() {
    // Monitor system health every hour
    this.healthCheckInterval = setInterval(async () => {
      try {
        await this.performHealthCheck();
      } catch (error) {
        this.logger.error('Health check failed:', error);
      }
    }, 60 * 60 * 1000); // 1 hour
  }

  async performHealthCheck() {
    this.lastHealthCheck = new Date();

    const health = {
      timestamp: new Date().toISOString(),
      database: false,
      agents: {},
      scheduledTasks: {},
      systemResources: {}
    };

    // Check database
    try {
      await this.db.getAllRows('SELECT 1');
      health.database = true;
    } catch (error) {
      health.database = false;
    }

    // Check scheduled tasks
    this.scheduledTasks.forEach((task, name) => {
      health.scheduledTasks[name] = task.running;
    });

    // Get system resources (simplified)
    health.systemResources = {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      nodeVersion: process.version
    };

    // Log health status
    const healthScore = this.calculateHealthScore(health);
    
    if (healthScore < 80) {
      this.logger.warn(`System health score: ${healthScore}/100`, health);
    } else {
      this.logger.info(`System health check passed: ${healthScore}/100`);
    }
    
    return health;
  }

  calculateHealthScore(health) {
    let score = 100;
    
    if (!health.database) score -= 30;
    
    const tasksRunning = Object.values(health.scheduledTasks).filter(Boolean).length;
    const totalTasks = Object.keys(health.scheduledTasks).length;
    
    if (totalTasks > 0 && tasksRunning < totalTasks) {
      score -= ((totalTasks - tasksRunning) / totalTasks) * 20;
    }
    
    return Math.max(0, Math.round(score));
  }

  // Control methods
  async pauseAutomation() {
    this.isEnabled = false;
    this.logger.info('Automation paused');
  }

  async resumeAutomation() {
    this.isEnabled = true;
    this.logger.info('Automation resumed');
  }

  async stopAutomation() {
    this.scheduledTasks.forEach((task, name) => {
      task.stop();
      this.logger.info(`Stopped scheduled task: ${name}`);
    });
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    this.isEnabled = false;
    this.logger.info('All automation tasks stopped');
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async getAutomationStatus() {
    return {
      enabled: this.isEnabled,
      scheduledTasks: Array.from(this.scheduledTasks.keys()).map(name => ({
        name,
        running: typeof this.scheduledTasks.get(name).getStatus === 'function'
          ? this.scheduledTasks.get(name).getStatus() !== 'stopped'
          : Boolean(this.scheduledTasks.get(name).running)
      })),
      lastHealthCheck: this.lastHealthCheck,
      uptime: process.uptime()
    };
  }
}

module.exports = { DailyAutomation };
