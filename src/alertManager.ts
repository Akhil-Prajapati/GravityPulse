import { AlertTier, QuotaAlertEvent, QuotaConfig, ModelQuotaInfo, PromptCreditsInfo } from './types';

export interface ThresholdDefinition {
  tier: AlertTier;
  threshold: number;
}

export interface TrackedAlertState {
  lastAlertedThreshold: number | null;
  lastAlertedTier: AlertTier | null;
  lastPercentage: number | null;
  pendingCrossing: {
    threshold: number;
    tier: AlertTier;
    cycles: number;
  } | null;
}

export class AlertManager {
  private modelStates: Map<string, TrackedAlertState> = new Map();
  private creditsState: TrackedAlertState = {
    lastAlertedThreshold: null,
    lastAlertedTier: null,
    lastPercentage: null,
    pendingCrossing: null
  };

  private lastAlertTimestamp: number = 0;

  constructor() {}

  public getLastAlertTimestamp(): number {
    return this.lastAlertTimestamp;
  }

  public setLastAlertTimestamp(ts: number): void {
    this.lastAlertTimestamp = ts;
  }

  public resetAll(): void {
    this.modelStates.clear();
    this.creditsState = {
      lastAlertedThreshold: null,
      lastAlertedTier: null,
      lastPercentage: null,
      pendingCrossing: null
    };
    this.lastAlertTimestamp = 0;
  }

  public getModelState(key: string): TrackedAlertState | undefined {
    return this.modelStates.get(key);
  }

  public getCreditsState(): TrackedAlertState {
    return this.creditsState;
  }

  /**
   * Process a full snapshot and return any alert events that should be fired.
   */
  public processSnapshot(
    models: ModelQuotaInfo[],
    pinnedModels: string[],
    credits: PromptCreditsInfo | undefined,
    config: QuotaConfig,
    now: number = Date.now()
  ): QuotaAlertEvent[] {
    const events: QuotaAlertEvent[] = [];

    // 1. Process Model Quotas
    const modelThresholds: ThresholdDefinition[] = [
      { tier: 'info' as AlertTier, threshold: config.infoThreshold },
      { tier: 'critical' as AlertTier, threshold: config.criticalThreshold },
      { tier: 'severe' as AlertTier, threshold: config.severeThreshold }
    ].sort((a, b) => b.threshold - a.threshold); // descending

    for (const model of models) {
      try {
        const isPinned = pinnedModels.some(
          (p) => p.toLowerCase() === model.label.toLowerCase() || p.toLowerCase() === model.modelId.toLowerCase()
        );

        if (!isPinned) {
          // If unpinned, remove or clear pending crossings
          this.modelStates.delete(model.label);
          continue;
        }

        let state = this.modelStates.get(model.label);
        if (!state) {
          state = {
            lastAlertedThreshold: null,
            lastAlertedTier: null,
            lastPercentage: null,
            pendingCrossing: null
          };
          this.modelStates.set(model.label, state);
        }

        const event = this.evaluateEntity(
          state,
          model.remainingPercentage,
          modelThresholds,
          config.globalAlertCooldownMinutes,
          now,
          {
            type: 'model',
            modelLabel: model.label,
            modelId: model.modelId
          }
        );

        if (event) {
          events.push(event);
        }
      } catch (err) {
        console.error(`GravityPulse: Error evaluating alert for model ${model.label}:`, err);
      }
    }

    // 2. Process Available Credits
    if (credits && credits.monthly > 0) {
      try {
        const creditsThresholds: ThresholdDefinition[] = [
          { tier: 'info' as AlertTier, threshold: config.creditsInfoThreshold },
          { tier: 'critical' as AlertTier, threshold: config.creditsCriticalThreshold },
          { tier: 'severe' as AlertTier, threshold: config.creditsSevereThreshold }
        ].sort((a, b) => b.threshold - a.threshold); // descending

        const creditsPct = credits.remainingPercentage;
        const creditsEvent = this.evaluateEntity(
          this.creditsState,
          creditsPct,
          creditsThresholds,
          config.globalAlertCooldownMinutes,
          now,
          {
            type: 'credits',
            availableCredits: credits.available,
            monthlyCredits: credits.monthly
          }
        );

        if (creditsEvent) {
          events.push(creditsEvent);
        }
      } catch (err) {
        console.error('GravityPulse: Error evaluating alert for prompt credits:', err);
      }
    }

    return events;
  }

  private evaluateEntity(
    state: TrackedAlertState,
    currentPercentage: number,
    thresholds: ThresholdDefinition[],
    cooldownMinutes: number,
    now: number,
    extra: Partial<QuotaAlertEvent>
  ): QuotaAlertEvent | null {
    // 1. Check for Refill / Quota Increase
    if (state.lastPercentage !== null && currentPercentage > state.lastPercentage) {
      state.lastAlertedThreshold = null;
      state.lastAlertedTier = null;
      state.pendingCrossing = null;
    }
    state.lastPercentage = currentPercentage;

    // 2. Find most severe active threshold (lowest threshold that currentPercentage <= threshold)
    let matchingThreshold: ThresholdDefinition | null = null;
    for (const t of thresholds) {
      if (currentPercentage <= t.threshold) {
        if (!matchingThreshold || t.threshold < matchingThreshold.threshold) {
          matchingThreshold = t;
        }
      }
    }

    // If no threshold is met (e.g. quota is above info threshold)
    if (!matchingThreshold) {
      state.pendingCrossing = null;
      return null;
    }

    // 3. Check if this is a clean downward crossing below a threshold not yet alerted this cycle
    if (state.lastAlertedThreshold !== null && matchingThreshold.threshold >= state.lastAlertedThreshold) {
      // Already alerted at this or a more severe threshold
      state.pendingCrossing = null;
      return null;
    }

    // 4. Debounce check: require 2 polling cycles
    if (state.pendingCrossing && state.pendingCrossing.threshold === matchingThreshold.threshold) {
      state.pendingCrossing.cycles++;
    } else {
      state.pendingCrossing = {
        threshold: matchingThreshold.threshold,
        tier: matchingThreshold.tier,
        cycles: 1
      };
    }

    if (state.pendingCrossing.cycles < 2) {
      // Needs one more cycle to confirm
      return null;
    }

    // Debounce satisfied!
    const targetThreshold = matchingThreshold.threshold;
    const targetTier = matchingThreshold.tier;
    state.pendingCrossing = null;

    // 5. Global Cooldown check across all sources
    const cooldownMs = Math.max(0, cooldownMinutes * 60 * 1000);
    const timeSinceLastAlert = now - this.lastAlertTimestamp;

    // Always update lastAlertedThreshold so we don't spam or re-fire this tier
    state.lastAlertedThreshold = targetThreshold;
    state.lastAlertedTier = targetTier;

    if (this.lastAlertTimestamp !== 0 && timeSinceLastAlert < cooldownMs) {
      // Within cooldown window: suppress toast silently
      return null;
    }

    // Update global cooldown timestamp and fire event
    this.lastAlertTimestamp = now;

    return {
      type: extra.type || 'model',
      tier: targetTier,
      threshold: targetThreshold,
      currentPercentage,
      modelLabel: extra.modelLabel,
      modelId: extra.modelId,
      availableCredits: extra.availableCredits,
      monthlyCredits: extra.monthlyCredits
    };
  }
}
