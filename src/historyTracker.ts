import * as vscode from 'vscode';
import { PollHistoryPoint, ModelTrendInfo, TrendDirection } from './types';

const GLOBAL_STATE_KEY = 'gravitypulse.modelHistory';
const MAX_HISTORY_POINTS_PER_MODEL = 100;
const RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

const SPARKLINE_BLOCKS = [' ', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export class HistoryTracker {
  private historyMap: Map<string, PollHistoryPoint[]> = new Map();

  constructor(private context: vscode.ExtensionContext) {
    this.loadHistory();
  }

  /**
   * Safely load and migrate existing history from globalState.
   */
  private loadHistory(): void {
    try {
      const raw = this.context.globalState.get<Record<string, any>>(GLOBAL_STATE_KEY);
      if (raw && typeof raw === 'object') {
        const now = Date.now();
        const cutoff = now - RETENTION_MS;

        for (const [key, points] of Object.entries(raw)) {
          if (Array.isArray(points)) {
            const validPoints: PollHistoryPoint[] = points
              .filter(
                (p) =>
                  p &&
                  typeof p.timestamp === 'number' &&
                  typeof p.percentage === 'number' &&
                  !isNaN(p.timestamp) &&
                  !isNaN(p.percentage) &&
                  p.timestamp >= cutoff
              )
              .map((p) => ({
                timestamp: p.timestamp,
                percentage: Number(p.percentage)
              }))
              .slice(-MAX_HISTORY_POINTS_PER_MODEL);

            if (validPoints.length > 0) {
              this.historyMap.set(key, validPoints);
            }
          }
        }
      }
    } catch (err) {
      console.error('GravityPulse: Error loading history from globalState:', err);
      this.historyMap.clear();
    }
  }

  /**
   * Persist current in-memory history to globalState.
   */
  public async persistHistory(): Promise<void> {
    try {
      const serialized: Record<string, PollHistoryPoint[]> = {};
      for (const [key, points] of this.historyMap.entries()) {
        serialized[key] = points;
      }
      await this.context.globalState.update(GLOBAL_STATE_KEY, serialized);
    } catch (err) {
      console.error('GravityPulse: Error persisting history to globalState:', err);
    }
  }

  /**
   * Record a new poll point for a model and prune entries older than 24 hours.
   */
  public recordPoint(modelLabel: string, percentage: number, timestamp: number = Date.now()): void {
    try {
      let points = this.historyMap.get(modelLabel);
      if (!points) {
        points = [];
        this.historyMap.set(modelLabel, points);
      }

      points.push({ timestamp, percentage });

      // Prune > 24 hours
      const cutoff = timestamp - RETENTION_MS;
      points = points.filter((p) => p.timestamp >= cutoff);

      // Cap at 100 points
      if (points.length > MAX_HISTORY_POINTS_PER_MODEL) {
        points = points.slice(-MAX_HISTORY_POINTS_PER_MODEL);
      }

      this.historyMap.set(modelLabel, points);
    } catch (err) {
      console.error(`GravityPulse: Error recording history point for ${modelLabel}:`, err);
    }
  }

  /**
   * Retrieve history points for a given model.
   */
  public getHistory(modelLabel: string): PollHistoryPoint[] {
    return this.historyMap.get(modelLabel) || [];
  }

  /**
   * Render a unicode sparkline string (e.g. "██▇▆▅▄▃ ") from recent history points.
   */
  public getSparkline(modelLabel: string, length: number = 8): string {
    try {
      const points = this.getHistory(modelLabel);
      if (!points || points.length === 0) {
        return '';
      }

      // Take recent points (up to length)
      const sampled = points.slice(-length);
      return sampled.map((p) => this.percentageToBlock(p.percentage)).join('');
    } catch (err) {
      console.error(`GravityPulse: Error generating sparkline for ${modelLabel}:`, err);
      return '';
    }
  }

  /**
   * Compute multi-point trend direction and formatted sparkline with plain-language label.
   */
  public getTrendInfo(modelLabel: string, length: number = 8): ModelTrendInfo {
    try {
      const points = this.getHistory(modelLabel);
      if (!points || points.length < 2) {
        return {
          sparkline: '—',
          direction: 'gathering',
          label: '(gathering data)',
          formatted: '— (gathering data)',
          pointsCount: points ? points.length : 0
        };
      }

      const sampled = points.slice(-Math.max(2, length));
      const oldest = sampled[0].percentage;
      const newest = sampled[sampled.length - 1].percentage;
      const diff = newest - oldest;

      let direction: TrendDirection = 'stable';
      if (diff < -1.0) {
        direction = 'declining';
      } else if (diff > 1.0) {
        direction = 'rising';
      }

      const sparkline = sampled.map((p) => this.percentageToBlock(p.percentage)).join('');

      return {
        sparkline,
        direction,
        label: `(${direction})`,
        formatted: `${sparkline} (${direction})`,
        pointsCount: sampled.length
      };
    } catch (err) {
      console.error(`GravityPulse: Error computing trend info for ${modelLabel}:`, err);
      return {
        sparkline: '—',
        direction: 'gathering',
        label: '(gathering data)',
        formatted: '— (gathering data)',
        pointsCount: 0
      };
    }
  }

  /**
   * Convert a percentage [0..100] to a corresponding unicode block char.
   */
  public percentageToBlock(percentage: number): string {
    const clamped = Math.max(0, Math.min(100, percentage));
    const index = Math.min(SPARKLINE_BLOCKS.length - 1, Math.floor((clamped / 100) * SPARKLINE_BLOCKS.length));
    return SPARKLINE_BLOCKS[index];
  }
}

