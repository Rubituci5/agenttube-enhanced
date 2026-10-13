'use strict';

// Read-only live channel statistics, including videos published before AgentTube
// was installed. Detailed 28-day Analytics data is optional and never simulated.
const { google } = require('googleapis');

const DAY = 24 * 60 * 60 * 1000;
const CACHE_MS = 3 * 60 * 1000;

class ChannelMetricsService {
  constructor(credentials, options = {}) {
    this.credentials = credentials;
    this.google = options.google || google;
    this.now = options.now || (() => Date.now());
    this.cache = null;
    this.cachedAt = 0;
    this.inflight = null;
  }

  projectId() {
    const id = String(this.credentials?.credentials?.youtube?.client_id || '');
    const match = id.match(/^(\d+)-[a-z0-9-]+\.apps\.googleusercontent\.com$/);
    return match?.[1] || '';
  }

  async snapshot({ refresh = false } = {}) {
    if (this.inflight) return this.inflight;
    const age = this.now() - this.cachedAt;
    if (!refresh && this.cache && age < CACHE_MS) return this.cache;
    this.inflight = this.fetchSnapshot()
      .then(data => { this.cache = data; this.cachedAt = this.now(); return data; })
      .finally(() => { this.inflight = null; });
    return this.inflight;
  }

  async fetchSnapshot() {
    const auth = this.credentials.getYouTubeAuth();
    const yt = this.google.youtube({ version: 'v3', auth });
    const api = this.google.youtubeAnalytics({ version: 'v2', auth });
    const channelResponse = await yt.channels.list({
      part: 'snippet,statistics', mine: true
    });
    const channel = channelResponse.data.items?.[0];
    if (!channel) throw new Error('Nenhum canal associado à conta YouTube conectada.');
    const stat = channel.statistics || {};
    const summary = {
      id: channel.id,
      name: channel.snippet?.title || 'Canal do YouTube',
      subscriberCount: stat.hiddenSubscriberCount ? null : Number(stat.subscriberCount ?? 0),
      hiddenSubscriberCount: Boolean(stat.hiddenSubscriberCount),
      viewCount: Number(stat.viewCount ?? 0),
      videoCount: Number(stat.videoCount ?? 0)
    };

    // YouTube Analytics processing typically trails current date. Request a
    // historical 28-day window ending two days ago rather than current day.
    const ending = this.now() - 2 * DAY;
    const endDate = new Date(ending).toISOString().slice(0, 10);
    const startDate = new Date(ending - 27 * DAY).toISOString().slice(0, 10);
    const analytics = {
      available: false, status: 'unavailable', period: { startDate, endDate },
      views: null, watchHours: null, subscribersGained: null,
      subscribersLost: null, netSubscribers: null, message: null, enableUrl: null
    };
    try {
      const response = await api.reports.query({
        ids: 'channel==MINE', startDate, endDate,
        metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost'
      });
      const [views, minutes, gained, lost] = response.data.rows?.[0] || [0, 0, 0, 0];
      analytics.available = true;
      analytics.status = 'connected';
      analytics.views = Number(views || 0);
      analytics.watchHours = Math.round((Number(minutes || 0) / 60) * 10) / 10;
      analytics.subscribersGained = Number(gained || 0);
      analytics.subscribersLost = Number(lost || 0);
      analytics.netSubscribers = analytics.subscribersGained - analytics.subscribersLost;
    } catch (error) {
      const status = Number(error.response?.status || error.code);
      const text = String(error.response?.data?.error?.message || error.message || '');
      if (status === 403 && /not been used|disabled|has not been used|accessNotConfigured/i.test(text)) {
        analytics.status = 'api_disabled';
        analytics.message = 'Ative a YouTube Analytics API no projeto Google Cloud para obter os dados dos últimos 28 dias.';
        const project = this.projectId();
        analytics.enableUrl = 'https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com'
          + (project ? '?project=' + encodeURIComponent(project) : '');
      } else if (status === 403 || status === 401) {
        analytics.status = 'permission_denied';
        analytics.message = 'O YouTube Analytics não autorizou o acesso. Verifique as permissões OAuth e a conta conectada.';
      } else {
        analytics.status = 'error';
        analytics.message = 'Não foi possível consultar as métricas detalhadas neste momento.';
      }
    }
    return { channel: summary, analytics, fetchedAt: new Date(this.now()).toISOString() };
  }
}

module.exports = { ChannelMetricsService, CACHE_MS };
