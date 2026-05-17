import fs from 'node:fs';
import path from 'node:path';
import type { SettingsAccess } from './settings.js';
import { buildElasticProfile, renderElasticProfile, type ElasticProfile } from './elastic-profiler.js';
import { buildTrinoProfile, renderTrinoProfile, type TrinoProfile } from './trino-profiler.js';
import { logger } from './logger.js';

export type AnalyticsProfileTarget = 'elastic' | 'trino';

export type AnalyticsProfileEntry<TProfile> = {
  target: AnalyticsProfileTarget;
  status: 'idle' | 'running' | 'ready' | 'stale' | 'error' | 'skipped';
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastSuccessfulAt?: string;
  nextRunAt?: string;
  runCount: number;
  error?: string;
  profile?: TProfile;
};

export type AnalyticsProfileSnapshot = {
  enabled: boolean;
  scheduleMs: number;
  staleAfterMs: number;
  running: boolean;
  elastic: AnalyticsProfileEntry<ElasticProfile>;
  trino: AnalyticsProfileEntry<TrinoProfile>;
};

export class AnalyticsProfileService {
  private timer?: NodeJS.Timeout;
  private runningPromise?: Promise<void>;
  private nextRunAt?: number;
  private readonly elastic: AnalyticsProfileEntry<ElasticProfile> = {
    target: 'elastic',
    status: 'idle',
    runCount: 0
  };
  private readonly trino: AnalyticsProfileEntry<TrinoProfile> = {
    target: 'trino',
    status: 'idle',
    runCount: 0
  };

  constructor(
    private settings: SettingsAccess,
    private readonly storagePath?: string
  ) {}

  start() {
    if (!this.isEnabled()) {
      logger.info('analytics profiler disabled');
      return;
    }

    this.loadFromDisk();
    this.scheduleNextRun();
    if (this.isRunOnStartupEnabled()) {
      void this.refreshNow('startup');
    }
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  updateSettings(settings: SettingsAccess) {
    this.settings = settings;
    this.stop();
    this.start();
  }

  async refreshNow(reason = 'manual') {
    if (!this.isEnabled()) return;
    if (this.runningPromise) return this.runningPromise;

    this.runningPromise = this.runProfiles(reason)
      .catch(error => {
        logger.error('analytics profiler run failed', { error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        this.saveToDisk();
        this.runningPromise = undefined;
        this.scheduleNextRun();
      });
    return this.runningPromise;
  }

  snapshot(): AnalyticsProfileSnapshot {
    this.markStaleIfNeeded(this.elastic);
    this.markStaleIfNeeded(this.trino);
    return {
      enabled: this.isEnabled(),
      scheduleMs: this.scheduleMs(),
      staleAfterMs: this.staleAfterMs(),
      running: Boolean(this.runningPromise),
      elastic: cloneEntry(this.elastic),
      trino: cloneEntry(this.trino)
    };
  }

  getPromptContext() {
    const snapshot = this.snapshot();
    const lines = ['Rubberband shared analytics profile cache:'];
    for (const entry of [snapshot.elastic, snapshot.trino]) {
      if (!entry.profile) {
        lines.push(`- ${entry.target}: ${entry.status}${entry.error ? ` (${entry.error})` : ''}`);
        continue;
      }
      if (entry.target === 'elastic') {
        const profile = entry.profile as ElasticProfile;
        lines.push(
          `- elastic: ${entry.status}, ${profile.analyzedIndices.length} profiled indices, last successful ${entry.lastSuccessfulAt || 'unknown'}.`,
          ...profile.analyzedIndices.slice(0, 6).map(index => `  - ${index.name}: domains ${index.domains.join(', ') || 'unknown'}, fields ${index.notableFields.slice(0, 6).join(', ') || 'none sampled'}`)
        );
      } else {
        const profile = entry.profile as TrinoProfile;
        lines.push(
          `- trino: ${entry.status}, ${profile.catalogs.length} catalogs, ${profile.analyzedTables.length} profiled tables, last successful ${entry.lastSuccessfulAt || 'unknown'}.`,
          ...profile.analyzedTables.slice(0, 8).map(table => `  - ${table.catalog}.${table.schema}.${table.name}: domains ${table.domains.join(', ') || 'unknown'}, columns ${table.columns.slice(0, 6).map(column => column.name).join(', ') || 'not inspected'}`)
        );
      }
    }
    return lines.join('\n');
  }

  renderProfile(target: 'elastic' | 'trino' | 'all') {
    const snapshot = this.snapshot();
    const sections: string[] = [];
    if (target === 'elastic' || target === 'all') {
      sections.push(renderProfileEntry(snapshot.elastic, renderElasticProfile));
    }
    if (target === 'trino' || target === 'all') {
      sections.push(renderProfileEntry(snapshot.trino, renderTrinoProfile));
    }
    return sections.join('\n\n');
  }

  private async runProfiles(reason: string) {
    logger.info('analytics profiler run started', { reason });
    const targets = this.enabledTargets();
    await Promise.all(targets.map(target => this.runTarget(target)));
    logger.info('analytics profiler run completed', { reason });
  }

  private async runTarget(target: AnalyticsProfileTarget) {
    const entry = target === 'elastic' ? this.elastic : this.trino;
    if (!this.hasConfiguration(target)) {
      entry.status = 'skipped';
      entry.error = target === 'elastic' ? 'Elasticsearch is not configured.' : 'Trino / Starburst is not configured.';
      return;
    }

    entry.status = 'running';
    entry.lastStartedAt = new Date().toISOString();
    entry.error = undefined;
    entry.runCount += 1;
    try {
      if (target === 'elastic') {
        entry.profile = (await buildElasticProfile(this.settings)) as never;
      } else {
        entry.profile = (await buildTrinoProfile(this.settings)) as never;
      }
      entry.status = 'ready';
      entry.lastCompletedAt = new Date().toISOString();
      entry.lastSuccessfulAt = entry.lastCompletedAt;
      entry.error = undefined;
    } catch (error) {
      entry.status = entry.profile ? 'stale' : 'error';
      entry.lastCompletedAt = new Date().toISOString();
      entry.error = error instanceof Error ? error.message : String(error);
      logger.warn('analytics profiler target failed', { target, error: entry.error });
    }
  }

  private scheduleNextRun() {
    this.stop();
    if (!this.isEnabled()) return;
    const scheduleMs = this.scheduleMs();
    if (scheduleMs <= 0) return;
    this.nextRunAt = Date.now() + scheduleMs;
    this.applyNextRunAt(this.elastic);
    this.applyNextRunAt(this.trino);
    this.timer = setTimeout(() => {
      void this.refreshNow('schedule');
    }, scheduleMs);
    this.timer.unref?.();
  }

  private loadFromDisk() {
    if (!this.storagePath || !fs.existsSync(this.storagePath)) return;
    try {
      const stored = JSON.parse(fs.readFileSync(this.storagePath, 'utf8')) as Partial<AnalyticsProfileSnapshot>;
      if (stored.elastic?.profile) Object.assign(this.elastic, stored.elastic);
      if (stored.trino?.profile) Object.assign(this.trino, stored.trino);
      this.markStaleIfNeeded(this.elastic);
      this.markStaleIfNeeded(this.trino);
      logger.info('loaded analytics profile snapshot', { storagePath: this.storagePath });
    } catch (error) {
      logger.warn('failed to load analytics profile snapshot', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private saveToDisk() {
    if (!this.storagePath) return;
    try {
      fs.mkdirSync(path.dirname(this.storagePath), { recursive: true });
      fs.writeFileSync(this.storagePath, JSON.stringify(this.snapshot(), null, 2));
    } catch (error) {
      logger.warn('failed to save analytics profile snapshot', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private applyNextRunAt(entry: AnalyticsProfileEntry<unknown>) {
    entry.nextRunAt = this.nextRunAt ? new Date(this.nextRunAt).toISOString() : undefined;
  }

  private markStaleIfNeeded(entry: AnalyticsProfileEntry<unknown>) {
    if (entry.status !== 'ready' || !entry.lastSuccessfulAt) return;
    const staleAfterMs = this.staleAfterMs();
    if (staleAfterMs > 0 && Date.now() - Date.parse(entry.lastSuccessfulAt) > staleAfterMs) {
      entry.status = 'stale';
    }
  }

  private hasConfiguration(target: AnalyticsProfileTarget) {
    if (target === 'elastic') {
      return Boolean(this.settings.get('ELASTICSEARCH_URL') || this.settings.get('ELASTICSEARCH_CLOUD_ID'));
    }
    return Boolean(this.settings.get('TRINO_HOST') || this.settings.get('STARBURST_HOST'));
  }

  private enabledTargets() {
    const raw = this.settings.get('ANALYTICS_PROFILER_TARGETS').toLowerCase();
    if (raw === 'elastic') return ['elastic'] as const;
    if (raw === 'trino') return ['trino'] as const;
    return ['elastic', 'trino'] as const;
  }

  private isEnabled() {
    return isTruthy(this.settings.get('ANALYTICS_PROFILER_ENABLED'));
  }

  private isRunOnStartupEnabled() {
    return isTruthy(this.settings.get('ANALYTICS_PROFILER_RUN_ON_STARTUP'));
  }

  private scheduleMs() {
    return readNumber(this.settings.get('ANALYTICS_PROFILER_SCHEDULE_MS'), 86_400_000);
  }

  private staleAfterMs() {
    return readNumber(this.settings.get('ANALYTICS_PROFILER_STALE_AFTER_MS'), 86_400_000);
  }
}

function renderProfileEntry<TProfile>(entry: AnalyticsProfileEntry<TProfile>, render: (profile: TProfile) => string) {
  if (entry.profile) {
    const freshness = entry.status === 'stale' ? 'This profile is stale; Rubberband is using the last successful background snapshot.' : 'This profile is from the latest successful background snapshot.';
    return `${freshness}\n\n${render(entry.profile)}`;
  }
  if (entry.status === 'running') return `${entry.target} profile is still running in the background. Try again shortly.`;
  if (entry.status === 'skipped') return `${entry.target} profile is skipped: ${entry.error}`;
  return `${entry.target} profile is not available yet${entry.error ? `: ${entry.error}` : '.'}`;
}

function cloneEntry<TProfile>(entry: AnalyticsProfileEntry<TProfile>): AnalyticsProfileEntry<TProfile> {
  return JSON.parse(JSON.stringify(entry)) as AnalyticsProfileEntry<TProfile>;
}

function readNumber(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isTruthy(value: string) {
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
