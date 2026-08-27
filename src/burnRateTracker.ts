import { BurnRateEstimate, PollHistoryPoint } from './types';

export class BurnRateTracker {
  private buffers: Map<string, PollHistoryPoint[]> = new Map();

  constructor() {}

  /**
   * Record a new quota reading for a model into its rolling buffer.
   */
  public recordSample(modelLabel: string, percentage: number, timestamp: number = Date.now(), maxSamples: number = 5): void {
    try {
      let buffer = this.buffers.get(modelLabel);
      if (!buffer) {
        buffer = [];
        this.buffers.set(modelLabel, buffer);
      }

      buffer.push({ timestamp, percentage });

      const limit = Math.max(3, maxSamples);
      if (buffer.length > limit) {
        buffer.splice(0, buffer.length - limit);
      }
    } catch (err) {
      console.error(`GravityPulse: Error recording burn rate sample for ${modelLabel}:`, err);
    }
  }

  /**
   * Clear all rolling buffers.
   */
  public clear(): void {
    this.buffers.clear();
  }

  /**
   * Get raw sample buffer for a model.
   */
  public getSamples(modelLabel: string): PollHistoryPoint[] {
    return this.buffers.get(modelLabel) || [];
  }

  /**
   * Compute burn rate and estimated time to empty (ETA) for a given model.
   * Returns null if quota is flat, increasing, noisy, or has insufficient samples (< 3).
   */
  public computeEstimate(modelLabel: string): BurnRateEstimate | null {
    try {
      const buffer = this.buffers.get(modelLabel);
      if (!buffer || buffer.length < 3) {
        return null;
      }

      const oldest = buffer[0];
      const newest = buffer[buffer.length - 1];

      const elapsedMs = newest.timestamp - oldest.timestamp;
      const elapsedMinutes = elapsedMs / (60 * 1000);

      if (elapsedMinutes <= 0) {
        return null;
      }

      // Drop in percentage over the window
      const deltaPercentage = oldest.percentage - newest.percentage;

      // Minimum decline threshold: ignore drops smaller than 0.05% to avoid noise
      if (deltaPercentage <= 0.05) {
        return null;
      }

      // Rate in percentage per minute (positive = declining)
      const ratePercentPerMinute = deltaPercentage / elapsedMinutes;
      if (ratePercentPerMinute <= 0) {
        return null;
      }

      const currentPercentage = newest.percentage;
      if (currentPercentage <= 0) {
        return {
          ratePercentPerMinute,
          minutesToEmpty: 0,
          formattedEta: '~0m until empty at current pace'
        };
      }

      const minutesToEmpty = Math.round(currentPercentage / ratePercentPerMinute);

      return {
        ratePercentPerMinute,
        minutesToEmpty,
        formattedEta: this.formatEta(minutesToEmpty)
      };
    } catch (err) {
      console.error(`GravityPulse: Error computing burn rate for ${modelLabel}:`, err);
      return null;
    }
  }

  public formatEta(minutes: number): string {
    if (minutes <= 0) {
      return '~0m until empty at current pace';
    }
    if (minutes < 60) {
      return `~${minutes}m until empty at current pace`;
    }
    const hours = Math.floor(minutes / 60);
    const remainingMins = minutes % 60;
    if (remainingMins === 0) {
      return `~${hours}h until empty at current pace`;
    }
    return `~${hours}h ${remainingMins}m until empty at current pace`;
  }
}
