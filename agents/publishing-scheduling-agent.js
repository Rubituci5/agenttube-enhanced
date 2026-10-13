const { google } = require('googleapis');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { Logger } = require('../utils/logger');
const { assertValidYouTubeMetadata } = require('../utils/youtube-metadata-validator');
const { allocateSlot, parts, inZone } = require('../utils/publishing-cadence-service');
const { PublishedVideoCleanup } = require('../utils/published-video-cleanup');

class PublishingSchedulingAgent {
  constructor(db, credentials) {
    this.db = db;
    this.credentials = credentials;
    this.logger = new Logger('PublishingScheduling');
    this.youtube = null;
    this.publishQueue = [];
    this.videoCleanup = new PublishedVideoCleanup();
  }

  async initialize() {
    this.logger.info('Initializing Publishing & Scheduling Agent...');
    await this.setupYouTubeAPI();
    await this.loadPublishQueue();
    return true;
  }

  async setupYouTubeAPI() {
    try {
      const auth = this.credentials.getYouTubeAuth();
      this.youtube = google.youtube({ version: 'v3', auth });
      this.logger.info('YouTube API initialized');
    } catch (error) {
      this.logger.error('Failed to initialize YouTube API:', error);
      throw error;
    }
  }

  async loadPublishQueue() {
    try {
      const queue = await this.db.getPublishQueue();
      this.publishQueue = queue || [];
      this.logger.info(`Loaded ${this.publishQueue.length} items in publish queue`);
    } catch (error) {
      this.logger.warn('No existing publish queue found');
    }
  }

  async scheduleContent(productionData) {
    try {
      const finalVideo = productionData.assets?.finalVideo;
      if (!finalVideo || finalVideo.simulated || path.extname(finalVideo.path || '').toLowerCase() !== '.mp4') {
        this.logger.warn(`Not scheduling ${productionData.id}: no real video file was produced (placeholder/simulated output). Fix your AI provider keys and FFmpeg, then regenerate.`);
        return null;
      }
      if (!await this.isNarrationReady(productionData.assets?.audio)) {
        this.logger.warn(`Not scheduling ${productionData.id}: narration is missing. Regenerate narration or explicitly confirm an intentional silent video.`);
        return null;
      }

      this.logger.info(`Scheduling content: ${productionData.id}`);
      const existing = await this.db.getLatestScheduleEntry?.(productionData.id);
      if (existing) {
        if (['scheduled', 'paused'].includes(existing.status) && !this.publishQueue.some(entry => entry.id === existing.id)) {
          this.publishQueue.push(existing);
          this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
        }
        this.logger.info(`Reusing existing ${existing.status} schedule entry for: ${productionData.id}`);
        return existing;
      }

      let publishTime=productionData.scheduledPublishTime;
      // Only autonomous/scheduled jobs use the two fixed slots. Manual user
      // choices always preserve the publish time selected in the editor.
      const cadenceJob=productionData.jobId && this.db.getGenerationJob
        ? await this.db.getGenerationJob(productionData.jobId) : null;
      if (String(process.env.DAILY_GENERATION_TARGET || '1') === '2' &&
          ['scheduler','autonomous_operator'].includes(cadenceJob?.source)) {
        const timezone=await this.db.getSetting('channel_timezone') || 'America/Sao_Paulo';
        const occupied=await this.db.getAllRows(
          `SELECT publish_time FROM publish_schedule
           WHERE status IN ('scheduled','paused','uploading','uploaded','published')
           AND publish_time >= datetime('now','-1 day')`);
        publishTime=allocateSlot(occupied.map(x=>x.publish_time),{
          timezone,slots:process.env.PUBLISH_SLOTS || '12:00,19:00'
        });
        this.logger.info('Automatic publishing slot reserved (local channel timezone): '+publishTime);
      }
      const scheduleEntry = {
        productionId: productionData.id,
        title: productionData.script.title,
        publishTime,
        status: 'scheduled',
        priority: productionData.priority,
        metadata: {
          seo: productionData.seo,
          thumbnail: productionData.assets.thumbnail,
          video: productionData.assets.finalVideo,
          audio: productionData.assets.audio,
          captions: productionData.assets.captions,
          privacyStatus: productionData.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private',
          containsSyntheticMedia: productionData.containsSyntheticMedia === true,
          contentType: productionData.contentType || 'long_form',
          sourceProductionId: productionData.sourceProductionId || productionData.id,
          shortClipId: productionData.shortClipId || null
        },
        createdAt: new Date().toISOString()
      };
      
      const saved = await this.db.saveScheduleEntry(scheduleEntry) || scheduleEntry;
      this.publishQueue.push(saved);
      this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
      
      this.logger.info(`Content scheduled for: ${saved.publishTime}`);
      return saved;
    } catch (error) {
      this.logger.error('Failed to schedule content:', error);
      throw error;
    }
  }

  async publishContent(contentId, options = {}) {
    try {
      let productionBundle = null;
      if (this.db.getLatestReadinessRun) {
        const readiness = await this.db.getLatestReadinessRun();
        if (readiness?.status === 'failed') {
          const failures = readiness.checks
            .filter(check => check.blocking && check.status === 'failed')
            .map(check => check.id);
          const error = new Error(`Publishing is blocked by the production readiness gate. Fix ${failures.join(', ')} and run the check again.`);
          error.status = 409;
          error.code = 'READINESS_BLOCKED';
          throw error;
        }
      }
      if (this.db.getProductionBundle) {
        productionBundle = await this.db.getProductionBundle(contentId);
        if (productionBundle && !['verified', 'not_required'].includes(productionBundle.provenance?.status || 'not_required')) {
          const error = new Error('Publishing is blocked until every factual claim is supported or explicitly waived');
          error.status = 409;
          error.code = 'PROVENANCE_BLOCKED';
          throw error;
        }
        if (productionBundle?.editorData?.autonomousApproval) {
          const { ProductionReadinessService } = require('../utils/production-readiness-service');
          if (!this.db.getLatestReadinessRun) {
            const error = new Error('Autonomous publishing requires a current production readiness record');
            error.status = 409; error.code = 'READINESS_BLOCKED';
            throw error;
          }
          await new ProductionReadinessService(this.db, this.credentials).assertReady('Autonomous publishing');
          const stamp = productionBundle.editorData.autonomousApproval;
          const {matchesApproval} = require('../utils/autonomous-editorial-audit');
          if (stamp.version !== 2 ||
              productionBundle.provenance?.status !== 'verified' ||
              !productionBundle.provenance?.claims?.length ||
              !productionBundle.editorData.factChecked ||
              !productionBundle.editorData.rightsConfirmed ||
              !await matchesApproval(productionBundle, stamp)) {
            const error = new Error('Autonomous upload blocked: factual approval record missing or stale');
            error.status = 409; error.code = 'AUTONOMOUS_AUDIT_BLOCKED';
            throw error;
          }
          const disk = await fs.statfs(path.join(__dirname, '..', 'data'));
          const freeBytes = disk.bavail * disk.bsize;
          const requiredGiB = Number(process.env.DAILY_GENERATION_TARGET || '1') === 2 ? 20 : 4;
          if (!Number.isFinite(freeBytes) || freeBytes < requiredGiB * 1024 ** 3) {
            const error = new Error(`Autonomous upload blocked: storage requires ${requiredGiB} GiB free`);
            error.status = 409; error.code = 'AUTONOMOUS_STORAGE_BLOCKED';
            throw error;
          }
          // Detect changed/replaced media after approval. The source manifests
          // and actual files are checked again immediately before YouTube.
          const { AutonomousEditorialAudit } = require('../utils/autonomous-editorial-audit');
          const rights = await new AutonomousEditorialAudit(this.db, this.credentials)
            .verifyMediaRights(productionBundle);
          if (!rights.passed) {
            const error = new Error('Autonomous upload blocked: ' + rights.reason);
            error.status = 409; error.code = 'AUTONOMOUS_MEDIA_BLOCKED';
            throw error;
          }
        }
        if (productionBundle && productionBundle.review_status !== 'approved') {
          const error = new Error('YouTube upload blocked: production is not approved.');
          error.status = 409; error.code = 'APPROVAL_REQUIRED';
          throw error;
        }
        if (productionBundle && (productionBundle.qualityChecks || []).some(c => c.blocking && !c.passed)) {
          const error = new Error('YouTube upload blocked: unresolved blocking quality checks.');
          error.status = 409; error.code = 'QUALITY_BLOCKED';
          throw error;
        }
      }
      this.logger.info(`Publishing content: ${contentId}`);
      
      let scheduleEntry = this.publishQueue.find(entry =>
        entry.productionId === contentId || entry.id === contentId
      );
      if (!scheduleEntry && this.db.getLatestScheduleEntry) {
        scheduleEntry = await this.db.getLatestScheduleEntry(contentId);
      }
      
      if (!scheduleEntry) {
        throw new Error(`Content not found in queue: ${contentId}`);
      }
      if (scheduleEntry.status === 'published') return scheduleEntry;
      if (productionBundle?.editorData?.autonomousApproval) {
        const {matchesApproval} = require('../utils/autonomous-editorial-audit');
        const actualUpload = { ...productionBundle, seo: scheduleEntry.metadata?.seo, assets: {
          ...productionBundle.assets, finalVideo: scheduleEntry.metadata?.video,
          audio: scheduleEntry.metadata?.audio, thumbnail: scheduleEntry.metadata?.thumbnail
        } };
        if (!await matchesApproval(actualUpload, productionBundle.editorData.autonomousApproval)) {
          const error = new Error('Autonomous upload blocked: queued copy or media differs from approved content');
          error.status = 409; error.code = 'AUTONOMOUS_AUDIT_BLOCKED';
          throw error;
        }
      }
      if (!await this.isNarrationReady(scheduleEntry.metadata?.audio || productionBundle?.assets?.audio)) {
        const error = new Error('Publishing is blocked because narration is missing or the intentional-silence override is incomplete');
        error.status = 409;
        error.code = 'NARRATION_REQUIRED';
        throw error;
      }
      if (scheduleEntry.youtubeId) {
        return this.reconcileUploadedVideo(scheduleEntry);
      }
      if (['uploading', 'reconciliation_required'].includes(scheduleEntry.status)) {
        const error = new Error('A previous upload may have reached YouTube without returning a video ID. Reconcile the channel before attempting another upload.');
        error.status = 409;
        error.code = 'UPLOAD_OUTCOME_UNKNOWN';
        throw error;
      }

      this.assertPublicPublishingOnly(scheduleEntry, options);
      scheduleEntry.status = 'uploading';
      scheduleEntry.error = null;
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.syncShortStatus(scheduleEntry, 'uploading');
      
      let uploadResult;
      try {
        uploadResult = await this.uploadToYouTube(scheduleEntry, options);
      } catch (error) {
        if (scheduleEntry.uploadAttempted && this.isUploadOutcomeUnknown(error)) {
          scheduleEntry.status = 'reconciliation_required';
          scheduleEntry.error = 'Upload outcome is unknown; verify the YouTube channel before retrying';
          await this.db.updateScheduleEntry(scheduleEntry);
          await this.syncShortStatus(scheduleEntry, 'reconciliation_required', scheduleEntry.error);
          error.code = 'UPLOAD_OUTCOME_UNKNOWN';
          error.status = 409;
        } else {
          scheduleEntry.status = 'failed';
          scheduleEntry.error = error.message;
          await this.db.updateScheduleEntry(scheduleEntry);
          await this.syncShortStatus(scheduleEntry, 'failed', error.message);
        }
        throw error;
      }
      
      // An uploaded file is not necessarily public or processed yet.
      // Confirm it with YouTube before marking it published and cleaning MP4s.
      scheduleEntry.youtubeId = uploadResult.id;
      scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${uploadResult.id}`;
      return this.reconcileUploadedVideo(scheduleEntry);
    } catch (error) {
      this.logger.error('Failed to publish content:', error);
      throw error;
    }
  }

  async uploadToYouTube(scheduleEntry, options = {}) {
    const { metadata } = scheduleEntry;
    const validation = assertValidYouTubeMetadata(metadata.seo);
    if (validation.warnings.length) {
      this.logger.warn(`YouTube metadata warnings: ${validation.warnings.join(' ')}`);
    }
    const safeMetadata = validation.value;
    
    // Prepare video metadata
    this.assertPublicPublishingOnly(scheduleEntry, options);
    const requestedPrivacy = 'public';
    const videoMetadata = {
      snippet: {
        title: safeMetadata.title,
        description: safeMetadata.description,
        tags: safeMetadata.tags,
        categoryId: safeMetadata.categoryId,
        defaultLanguage: safeMetadata.defaultLanguage,
        defaultAudioLanguage: safeMetadata.defaultAudioLanguage
      },
      status: {
        privacyStatus: requestedPrivacy,
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: metadata.containsSyntheticMedia === true
      }
    };
    
    // Resolve the file before marking the network upload as attempted.
    const videoStream = await this.getVideoStream(metadata.video.path);
    scheduleEntry.uploadAttempted = true;
    const videoUpload = await this.youtube.videos.insert({
      part: 'snippet,status',
      requestBody: videoMetadata,
      media: {
        body: videoStream
      }
    });
    
    const videoId = videoUpload.data.id;
    this.logger.info(`Video uploaded with ID: ${videoId}`);
    scheduleEntry.status = 'uploaded';
    scheduleEntry.youtubeId = videoId;
    scheduleEntry.youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    scheduleEntry.error = null;
    await this.db.updateScheduleEntry(scheduleEntry);
    
    // Upload thumbnail
    if (metadata.thumbnail && metadata.thumbnail.path) {
      await this.uploadThumbnail(videoId, metadata.thumbnail.path);
    }
    
    // Upload captions
    if (metadata.captions && metadata.captions.path) {
      await this.uploadCaptions(videoId, metadata.captions.path, safeMetadata.defaultAudioLanguage || safeMetadata.defaultLanguage);
    }
    
    return videoUpload.data;
  }

  async isNarrationReady(audio = {}) {
    if (audio.intentionalSilence === true) {
      return String(audio.silenceReason || '').trim().length >= 10 && Boolean(audio.silenceConfirmedAt);
    }
    if (!audio.path || audio.simulated || String(audio.path).endsWith('.info')) return false;
    try {
      const stats = await fs.stat(audio.path);
      return stats.isFile() && stats.size > 0;
    } catch (_error) {
      return false;
    }
  }

  isUploadOutcomeUnknown(error) {
    const status = Number(error.status || error.response?.status || 0);
    return !status || status >= 500;
  }

  assertPublicPublishingOnly(entry, options = {}) {
    const privacy = entry?.metadata?.privacyStatus || process.env.DEFAULT_PRIVACY_STATUS || 'private';
    if (privacy !== 'public') {
      const error = new Error('Only public videos may be uploaded to YouTube');
      error.code = 'PUBLIC_ONLY'; error.status = 409; throw error;
    }
    const scheduledAt = Date.parse(entry?.publishTime || '');
    if (!options.publishNow && (!Number.isFinite(scheduledAt) ||
        scheduledAt > Date.now() + 60_000)) {
      const error = new Error('Public publishing is scheduled for a future slot');
      error.code = 'PUBLISH_NOT_DUE'; error.status = 409; throw error;
    }
  }

  async reconcileUploadedVideo(scheduleEntry) {
    // A recorded YouTube ID may only be checked, never re-uploaded.
    const id = scheduleEntry.youtubeId;
    if (!id) throw Error('A YouTube video ID is required for reconciliation');
    const response = await this.youtube.videos.list({ part: 'id,status,processingDetails', id });
    const video = response.data.items?.find(v => v.id === id);
    if (!video) {
      scheduleEntry.status = 'reconciliation_required';
      scheduleEntry.error = 'Recorded YouTube ID could not be verified';
      await this.db.updateScheduleEntry(scheduleEntry);
      await this.syncShortStatus(scheduleEntry, 'reconciliation_required', scheduleEntry.error);
      this.logger.warn(scheduleEntry.error);
      return scheduleEntry;
    }
    const publicNow = video.status?.privacyStatus === 'public';
    const finished = video.processingDetails?.processingStatus === 'succeeded' ||
      video.status?.uploadStatus === 'processed';
    if (!publicNow || !finished) {
      scheduleEntry.status = 'uploaded';
      scheduleEntry.error = !publicNow ? 'Waiting for confirmed public visibility'
        : 'Waiting for YouTube processing to finish';
      await this.db.updateScheduleEntry(scheduleEntry);
      this.logger.info(scheduleEntry.error + ' (video ' + id + ')');
      return scheduleEntry;
    }
    const alreadyPublished = scheduleEntry.status === 'published';
    scheduleEntry.status = 'published';
    scheduleEntry.publishedAt = scheduleEntry.publishedAt || new Date().toISOString();
    scheduleEntry.youtubeUrl = scheduleEntry.youtubeUrl || `https://www.youtube.com/watch?v=${id}`;
    scheduleEntry.error = null;
    scheduleEntry.metadata = {
      ...(scheduleEntry.metadata || {}),
      publicVerifiedAt: scheduleEntry.metadata?.publicVerifiedAt || new Date().toISOString(),
      processingVerifiedAt: scheduleEntry.metadata?.processingVerifiedAt || new Date().toISOString()
    };
    await this.db.updateScheduleEntry(scheduleEntry);
    if (!alreadyPublished) await this.syncShortStatus(scheduleEntry, 'published');
    this.publishQueue = this.publishQueue.filter(entry => entry.productionId !== scheduleEntry.productionId);
    // Cleanup errors never turn an already-confirmed public upload into a failed
    // upload and cannot cause a duplicate YouTube insert.
    if (!scheduleEntry.metadata.localCleanupCompletedAt) {
      try {
        const cleaned = await this.videoCleanup.remove(scheduleEntry);
        scheduleEntry.metadata.localCleanupCompletedAt = new Date().toISOString();
        scheduleEntry.metadata.localCleanupBytes = cleaned.bytes;
        scheduleEntry.metadata.localCleanupFiles = cleaned.removed;
        await this.db.updateScheduleEntry(scheduleEntry);
        this.logger.info('Deleted local MP4 after verified public publication: ' +
          cleaned.removed.join(', ') + ' (' + cleaned.bytes + ' bytes)');
      } catch (error) {
        this.logger.warn('Retained video for later cleanup: ' + error.message);
      }
    }
    this.logger.success('Confirmed public YouTube publication: ' + scheduleEntry.youtubeUrl);
    return scheduleEntry;
  }

  async reconcilePendingPublications() {
    if (!this.db.getAllRows || !this.db.deserializeScheduleEntry) return 0;
    const rows = await this.db.getAllRows(
      `SELECT * FROM publish_schedule
       WHERE youtube_id IS NOT NULL
         AND (status = 'uploaded' OR (status = 'published' AND metadata NOT LIKE '%localCleanupCompletedAt%'))
       ORDER BY created_at DESC LIMIT 15`
    );
    let confirmed = 0;
    for (const row of rows) {
      const entry = this.db.deserializeScheduleEntry(row);
      try {
        const previous = entry.status;
        const current = await this.reconcileUploadedVideo(entry);
        if (previous !== 'published' && current.status === 'published') confirmed++;
      } catch (error) {
        this.logger.warn('Delayed YouTube public confirmation for ' + entry.youtubeId +
          ': ' + error.message);
      }
    }
    return confirmed;
  }

  async syncShortStatus(scheduleEntry, status, error = null) {
    const clipId = scheduleEntry.metadata?.shortClipId;
    if (!clipId || !this.db.updateShortClip) return null;
    return this.db.updateShortClip(clipId, {
      status,
      scheduleId: scheduleEntry.id,
      youtubeId: scheduleEntry.youtubeId || null,
      youtubeUrl: scheduleEntry.youtubeUrl || null,
      error
    });
  }

  async getVideoStream(videoPath) {
    try {
      const stats = await fs.stat(videoPath);
      if (!stats.isFile() || path.extname(videoPath).toLowerCase() !== '.mp4') {
        throw new Error('placeholder asset');
      }

      return fsSync.createReadStream(videoPath);
    } catch (error) {
      throw new Error('video file not found — refusing to upload placeholder');
    }
  }
  async uploadThumbnail(videoId, thumbnailPath) {
    try {
      const thumbnailBuffer = await fs.readFile(thumbnailPath);
      
      await this.youtube.thumbnails.set({
        videoId: videoId,
        media: {
          body: thumbnailBuffer
        }
      });
      
      this.logger.info(`Thumbnail uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`Failed to upload thumbnail: ${error.message}`);
    }
  }

  async applyVideoPackaging(videoId, packaging = {}, previousPackaging = null) {
    const title = String(packaging.title || '').trim();
    if (!videoId || !title || title.length > 100 || !packaging.thumbnailPath) {
      const error = new Error('A valid video ID, title, and thumbnail are required for a packaging change');
      error.status = 400;
      error.code = 'PACKAGING_INVALID';
      throw error;
    }
    const thumbnail = await fs.readFile(packaging.thumbnailPath);
    const current = await this.youtube.videos.list({ part: 'snippet', id: videoId });
    const snippet = current.data.items?.[0]?.snippet;
    if (!snippet) {
      const error = new Error(`YouTube video not found: ${videoId}`);
      error.status = 404;
      error.code = 'PACKAGING_VIDEO_NOT_FOUND';
      throw error;
    }

    const updateTitle = async nextTitle => this.youtube.videos.update({
      part: 'snippet',
      requestBody: {
        id: videoId,
        snippet: {
          title: nextTitle,
          description: snippet.description || '',
          tags: snippet.tags || [],
          categoryId: snippet.categoryId || '22',
          defaultLanguage: snippet.defaultLanguage,
          defaultAudioLanguage: snippet.defaultAudioLanguage
        }
      }
    });

    await updateTitle(title);
    try {
      await this.youtube.thumbnails.set({
        videoId,
        media: { body: thumbnail }
      });
    } catch (error) {
      try {
        await updateTitle(String(previousPackaging?.title || snippet.title || '').trim());
      } catch (rollbackError) {
        error.message = `${error.message}; title rollback also failed: ${rollbackError.message}`;
      }
      throw error;
    }
    this.logger.info(`Applied approved growth-experiment packaging to video: ${videoId}`);
    return { videoId, title, thumbnailPath: packaging.thumbnailPath };
  }

  async uploadCaptions(videoId, captionsPath, language = 'en') {
    try {
      const captionsContent = await fs.readFile(captionsPath, 'utf8');
      
      await this.youtube.captions.insert({
        part: 'snippet',
        requestBody: {
          snippet: {
            videoId: videoId,
            language,
            name: language.toLowerCase().startsWith('pt') ? 'Legendas em português' : 'Captions',
            isDraft: false
          }
        },
        media: {
          body: captionsContent
        }
      });
      
      this.logger.info(`Captions uploaded for video: ${videoId}`);
    } catch (error) {
      this.logger.error(`Failed to upload captions: ${error.message}`);
    }
  }

  async processPublishQueue() {
    // Confirm previously uploaded videos and release their local MP4s only
    // after YouTube reports successful processing and PUBLIC visibility.
    try { await this.reconcilePendingPublications(); }
    catch (error) { this.logger.warn('YouTube status retry delayed: '+error.message); }
    // Defense-in-depth: resuming the scheduler must NEVER silently enable
    // public uploads. This switch requires a separate explicit decision.
    if (!this.db?.getSetting || await this.db.getSetting('auto_publish_enabled') !== 'true') {
      this.logger.info('YouTube auto-upload disabled. Queue is not processed.');
      return 0;
    }
    if (await this.db.getSetting('automation_paused') === 'true') return 0;
    const now = new Date();
    const scheduled = this.publishQueue
      .filter(entry => entry.status === 'scheduled')
      .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
    const readyToPublish = scheduled.filter(entry => new Date(entry.publishTime) <= now);

    if (readyToPublish.length === 0) {
      if (scheduled.length > 0) {
        this.logger.info(`Publish queue: ${scheduled.length} item(s) waiting, next publish at ${scheduled[0].publishTime}`);
      } else {
        this.logger.info('Publish queue is empty — nothing scheduled yet.');
      }
      return 0;
    }

    this.logger.info(`Processing publish queue: ${readyToPublish.length} item(s) ready to publish...`);

    let successCount=0;
    const maxPosts=Math.min(4,Math.max(1,Number(await this.db.getSetting('max_daily_posts')) || 1));
    const zone=await this.db.getSetting('channel_timezone') || 'America/Sao_Paulo';
    const local=parts(now,zone);
    const localDay=[local.year,String(local.month).padStart(2,'0'),String(local.day).padStart(2,'0')].join('-');
    const startOfDay=inZone(localDay,'00:00',zone).toISOString();
    let publishedToday=Number((await this.db.getRow?.(
      `SELECT COUNT(*) AS count FROM publish_schedule
       WHERE (status = 'published' OR status = 'uploaded'
         OR status = 'uploading' OR status = 'reconciliation_required')
         AND (publish_time >= ? OR published_at >= ?)`,
      [startOfDay, startOfDay]
    ))?.count || 0);
    for (const entry of readyToPublish) {
      if (publishedToday >= maxPosts) {
        this.logger.warn(`Daily upload cap ${maxPosts} reached. ${readyToPublish.length-successCount} item(s) stay queued.`);
        break;
      }
      if (await this.db.getSetting('auto_publish_enabled') !== 'true' ||
          await this.db.getSetting('automation_paused') === 'true') break;
      try {
        // Reload before upload; in-memory queues can hold stale review statuses.
        if (this.db.getProductionBundle) {
          const current=await this.db.getProductionBundle(entry.productionId);
          if (!current || current.review_status!=='approved' ||
              (current.qualityChecks||[]).some(c=>c.blocking&&!c.passed)) {
            this.logger.warn('Skipping unapproved/unsafe production '+entry.productionId);
            continue;
          }
        }
        const outcome = await this.publishContent(entry.productionId);
        if (outcome.status === 'published') {
          successCount++;publishedToday++;
          this.logger.info(`Public video published: ${entry.title}`);
        }
      } catch (error) {
        if (error.code === 'READINESS_BLOCKED') {
          this.logger.warn(error.message);
          continue;
        }
        this.logger.error(`Failed to auto-publish ${entry.title}:`, error);
        // Mark as failed but don't stop processing other items
        if (error.code !== 'UPLOAD_OUTCOME_UNKNOWN') {
          entry.status = 'failed';
          entry.error = error.message;
          await this.db.updateScheduleEntry(entry);
        }
      }
    }
    
    return successCount;
  }

  async getUpcomingSchedule(days = 7) {
    const now = new Date();
    const endDate = new Date(now.getTime() + (days * 24 * 60 * 60 * 1000));
    
    return this.publishQueue
      .filter(entry => {
        const publishTime = new Date(entry.publishTime);
        return publishTime >= now && publishTime <= endDate;
      })
      .sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
  }

  async optimizePublishTimes() {
    if (Number(process.env.DAILY_GENERATION_TARGET || '1') === 2) {
      this.logger.info('Keeping the authorized fixed publication slots; analytics will not move them.');
      return;
    }
    // Analyze channel analytics to find optimal publish times
    const analytics = await this.getChannelAnalytics();
    const optimalTimes = this.calculateOptimalTimes(analytics);
    
    // Update scheduled content with better times
    for (const entry of this.publishQueue) {
      if (entry.status === 'scheduled') {
        const currentTime = new Date(entry.publishTime);
        const betterTime = this.findBetterTime(currentTime, optimalTimes);
        
        if (betterTime && betterTime.getTime() !== currentTime.getTime()) {
          entry.publishTime = betterTime.toISOString();
          await this.db.updateScheduleEntry(entry);
          this.logger.info(`Optimized publish time for: ${entry.title}`);
        }
      }
    }
  }

  async getChannelAnalytics() {
    try {
      // Get channel analytics for the last 30 days
      const response = await this.youtube.channels.list({
        part: 'statistics',
        mine: true
      });
      
      // In a full implementation, you'd use YouTube Analytics API
      // For now, we'll return simulated data
      return {
        totalViews: response.data.items[0]?.statistics?.viewCount || 0,
        subscribers: response.data.items[0]?.statistics?.subscriberCount || 0,
        videos: response.data.items[0]?.statistics?.videoCount || 0,
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'], // Most active days
        optimalHours: [14, 15, 16, 20] // Most active hours
      };
    } catch (error) {
      this.logger.error('Failed to get channel analytics:', error);
      return {
        optimalDays: ['Tuesday', 'Wednesday', 'Thursday'],
        optimalHours: [14, 15, 16]
      };
    }
  }

  calculateOptimalTimes(analytics) {
    const { optimalDays, optimalHours } = analytics;
    
    return {
      bestDays: optimalDays,
      bestHours: optimalHours,
      worstDays: ['Monday', 'Friday'],
      worstHours: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22, 23]
    };
  }

  findBetterTime(currentTime, optimalTimes) {
    const currentDay = currentTime.toLocaleDateString('en-US', { weekday: 'long' });
    const currentHour = currentTime.getHours();
    
    // If current time is already optimal, return null
    if (optimalTimes.bestDays.includes(currentDay) && 
        optimalTimes.bestHours.includes(currentHour)) {
      return null;
    }
    
    // Find the next optimal time
    const nextOptimalTime = new Date(currentTime);
    
    // Try to find an optimal hour on the same day
    for (const hour of optimalTimes.bestHours) {
      if (hour > currentHour) {
        nextOptimalTime.setHours(hour, 0, 0, 0);
        if (optimalTimes.bestDays.includes(currentDay)) {
          return nextOptimalTime;
        }
      }
    }
    
    // Find next optimal day
    for (let i = 1; i <= 7; i++) {
      const testDate = new Date(currentTime.getTime() + (i * 24 * 60 * 60 * 1000));
      const testDay = testDate.toLocaleDateString('en-US', { weekday: 'long' });
      
      if (optimalTimes.bestDays.includes(testDay)) {
        testDate.setHours(optimalTimes.bestHours[0], 0, 0, 0);
        return testDate;
      }
    }
    
    return null; // No better time found
  }

  async createPublishingReport() {
    const report = {
      queueStatus: {
        total: this.publishQueue.length,
        scheduled: this.publishQueue.filter(e => e.status === 'scheduled').length,
        published: this.publishQueue.filter(e => e.status === 'published').length,
        failed: this.publishQueue.filter(e => e.status === 'failed').length
      },
      upcomingPublications: await this.getUpcomingSchedule(7),
      recentPublications: this.publishQueue
        .filter(e => e.status === 'published' && 
                new Date(e.publishedAt) > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000))
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)),
      performance: await this.getPublishingPerformance(),
      generatedAt: new Date().toISOString()
    };
    
    return report;
  }

  async getPublishingPerformance() {
    const published = this.publishQueue.filter(e => e.status === 'published');
    
    if (published.length === 0) {
      return {
        totalPublished: 0,
        averageScheduleAccuracy: 0,
        publishingFrequency: 0
      };
    }
    
    // Calculate schedule accuracy
    let totalDelay = 0;
    let accuratePublishes = 0;
    
    published.forEach(entry => {
      const scheduledTime = new Date(entry.publishTime);
      const actualTime = new Date(entry.publishedAt);
      const delay = Math.abs(actualTime - scheduledTime) / (1000 * 60); // minutes
      
      totalDelay += delay;
      if (delay <= 5) accuratePublishes++; // Within 5 minutes is considered accurate
    });
    
    const averageDelay = totalDelay / published.length;
    const accuracyRate = (accuratePublishes / published.length) * 100;
    
    return {
      totalPublished: published.length,
      averageScheduleAccuracy: `${accuracyRate.toFixed(1)}%`,
      averageDelay: `${averageDelay.toFixed(1)} minutes`,
      publishingFrequency: this.calculatePublishingFrequency(published)
    };
  }

  calculatePublishingFrequency(published) {
    if (published.length < 2) return 'Insufficient data';
    
    const dates = published.map(p => new Date(p.publishedAt)).sort((a, b) => a - b);
    const totalDays = (dates[dates.length - 1] - dates[0]) / (1000 * 60 * 60 * 24);
    const frequency = published.length / totalDays;
    
    if (frequency >= 1) return `${frequency.toFixed(1)} videos per day`;
    if (frequency >= 0.14) return `${(frequency * 7).toFixed(1)} videos per week`;
    return `${(frequency * 30).toFixed(1)} videos per month`;
  }

  async emergencyPublish(contentId, delayMinutes = 0) {
    // For urgent publishing needs
    this.logger.info(`Emergency publish requested: ${contentId}`);

    if (delayMinutes > 0) {
      const entry = this.publishQueue.find(e => e.productionId === contentId || e.id === contentId) ||
        await this.db.getLatestScheduleEntry?.(contentId);
      if (!entry) throw new Error(`Content not found: ${contentId}`);
      const newPublishTime = new Date(Date.now() + (delayMinutes * 60 * 1000));
      entry.publishTime = newPublishTime.toISOString();
      await this.db.updateScheduleEntry(entry);
      this.logger.info(`Emergency scheduled for: ${entry.publishTime}`);
      return entry;
    }
    return this.publishContent(contentId, { publishNow: true });
  }

  async pauseScheduledContent(contentId) {
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    entry.status = 'paused';
    await this.db.updateScheduleEntry(entry);
    
    this.logger.info(`Content paused: ${entry.title}`);
    return entry;
  }

  async resumeScheduledContent(contentId, newPublishTime = null) {
    const entry = this.publishQueue.find(e => 
      e.productionId === contentId || e.id === contentId
    );
    
    if (!entry) {
      throw new Error(`Content not found: ${contentId}`);
    }
    
    entry.status = 'scheduled';
    if (newPublishTime) {
      entry.publishTime = new Date(newPublishTime).toISOString();
    }
    
    await this.db.updateScheduleEntry(entry);
    
    this.logger.info(`Content resumed: ${entry.title}`);
    return entry;
  }

  async rescheduleContent(contentId, newPublishTime) {
    const publishTime = new Date(newPublishTime);
    if (!Number.isFinite(publishTime.getTime()) || publishTime.getTime() <= Date.now()) {
      const error = new Error('Choose a future publish time');
      error.status = 400;
      throw error;
    }
    const entry = this.publishQueue.find(item => item.productionId === contentId || item.id === contentId) ||
      await this.db.getLatestScheduleEntry?.(contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    if (['uploading', 'uploaded', 'published', 'reconciliation_required'].includes(entry.status)) {
      const error = new Error(`Content cannot be rescheduled while it is ${entry.status}`);
      error.status = 409;
      throw error;
    }
    entry.publishTime = publishTime.toISOString();
    entry.status = 'scheduled';
    entry.error = null;
    await this.db.updateScheduleEntry(entry);
    if (!this.publishQueue.some(item => item.id === entry.id)) this.publishQueue.push(entry);
    this.publishQueue.sort((a, b) => new Date(a.publishTime) - new Date(b.publishTime));
    return entry;
  }

  async deleteScheduledContent(contentId) {
    const entry = this.publishQueue.find(item => item.productionId === contentId || item.id === contentId) ||
      await this.db.getLatestScheduleEntry?.(contentId);
    if (!entry) {
      const error = new Error(`Scheduled content not found: ${contentId}`);
      error.status = 404;
      throw error;
    }
    if (['uploading', 'uploaded', 'published', 'reconciliation_required'].includes(entry.status)) {
      const error = new Error(`The schedule cannot be deleted while content is ${entry.status}`);
      error.status = 409;
      throw error;
    }
    await this.db.deleteScheduleEntry(entry.id);
    this.publishQueue = this.publishQueue.filter(item => item.id !== entry.id);
    await this.syncShortStatus(entry, 'rendered');
    return entry;
  }
}

module.exports = { PublishingSchedulingAgent };
