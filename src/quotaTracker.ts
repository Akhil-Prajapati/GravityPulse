import * as vscode from 'vscode';
import { QuotaConfig, DisplayStyle, PrecisionMode, LiveQuotaSnapshot, ModelQuotaInfo, QuotaAlertEvent, BurnRateEstimate, ModelTrendInfo } from './types';
import { LiveQuotaClient } from './liveQuotaClient';
import { AlertManager } from './alertManager';
import { BurnRateTracker } from './burnRateTracker';
import { HistoryTracker } from './historyTracker';

export const MODEL_ABBREVIATIONS: Record<string, string> = {
  'Gemini 3.7 Flash (High)': 'G3.7F',
  'Gemini 3.7 Flash (Medium)': 'G3.7F(M)',
  'Gemini 3.7 Flash (Low)': 'G3.7F(L)',
  'Gemini 3.6 Flash (High)': 'G3.6F',
  'Gemini 3.6 Flash (Medium)': 'G3.6F(M)',
  'Gemini 3.6 Flash (Low)': 'G3.6F(L)',
  'Gemini 3.5 Flash (High)': 'G3.5F',
  'Gemini 3.5 Flash (Medium)': 'G3.5F(M)',
  'Gemini 3.5 Flash (Low)': 'G3.5F(L)',
  'Gemini 3.1 Pro (High)': 'G3.1P',
  'Gemini 3.1 Pro (Low)': 'G3.1P(L)',
  'Claude Sonnet 4.6 (Thinking)': 'Claude',
  'Claude Opus 4.6 (Thinking)': 'Opus',
  'GPT-OSS 120B (Medium)': 'GPT'
};

export class QuotaTracker {
  private config: QuotaConfig;
  private latestSnapshot: LiveQuotaSnapshot | null = null;

  private readonly _onDidChangeQuotaState = new vscode.EventEmitter<void>();
  public readonly onDidChangeQuotaState = this._onDidChangeQuotaState.event;

  private readonly _onLowBatteryWarning = new vscode.EventEmitter<{ level: number; model: string; critical: boolean }>();
  public readonly onLowBatteryWarning = this._onLowBatteryWarning.event;

  private readonly _onQuotaAlert = new vscode.EventEmitter<QuotaAlertEvent>();
  public readonly onQuotaAlert = this._onQuotaAlert.event;

  private alertManager: AlertManager;
  private burnRateTracker: BurnRateTracker;
  private historyTracker: HistoryTracker;

  constructor(
    private liveClient: LiveQuotaClient,
    private context: vscode.ExtensionContext
  ) {
    this.alertManager = new AlertManager();
    this.burnRateTracker = new BurnRateTracker();
    this.historyTracker = new HistoryTracker(this.context);

    this.config = this.loadConfig();

    this.liveClient.onDidChangeSnapshot((snapshot) => {
      this.latestSnapshot = snapshot;
      this.processNewSnapshot(snapshot);
      this.checkThresholds();
      this._onDidChangeQuotaState.fire();
    });
  }

  private processNewSnapshot(snapshot: LiveQuotaSnapshot): void {
    const now = Date.now();

    // 1. Record burn rate & history per model
    if (snapshot.models && Array.isArray(snapshot.models)) {
      for (const m of snapshot.models) {
        try {
          this.burnRateTracker.recordSample(
            m.label,
            m.remainingPercentage,
            now,
            this.config.burnRateSampleCount
          );
          this.historyTracker.recordPoint(m.label, m.remainingPercentage, now);
        } catch (err) {
          console.error(`GravityPulse: Error recording metrics for ${m.label}:`, err);
        }
      }
      this.historyTracker.persistHistory().catch((err) => {
        console.error('GravityPulse: Error persisting history:', err);
      });
    }

    // 2. Process multi-tier & credits alerts
    try {
      const alerts = this.alertManager.processSnapshot(
        snapshot.models,
        this.getPinnedModels(),
        snapshot.promptCredits,
        this.config,
        now
      );

      if (this.config.showToastOnLowBattery) {
        for (const alert of alerts) {
          this._onQuotaAlert.fire(alert);
        }
      }
    } catch (err) {
      console.error('GravityPulse: Error processing alerts from snapshot:', err);
    }
  }

  public getAlertManager(): AlertManager {
    return this.alertManager;
  }

  public getBurnRateTracker(): BurnRateTracker {
    return this.burnRateTracker;
  }

  public getHistoryTracker(): HistoryTracker {
    return this.historyTracker;
  }

  public getBurnRateEstimate(modelLabel: string): BurnRateEstimate | null {
    try {
      return this.burnRateTracker.computeEstimate(modelLabel);
    } catch (err) {
      console.error(`GravityPulse: Error getting burn rate estimate for ${modelLabel}:`, err);
      return null;
    }
  }

  public getModelSparkline(modelLabel: string, length: number = 8): string {
    try {
      return this.historyTracker.getSparkline(modelLabel, length);
    } catch (err) {
      console.error(`GravityPulse: Error getting sparkline for ${modelLabel}:`, err);
      return '';
    }
  }

  public getModelTrend(modelLabel: string, length: number = 8): ModelTrendInfo {
    try {
      return this.historyTracker.getTrendInfo(modelLabel, length);
    } catch (err) {
      console.error(`GravityPulse: Error getting trend info for ${modelLabel}:`, err);
      return {
        sparkline: '—',
        direction: 'gathering',
        label: '(gathering data)',
        formatted: '— (gathering data)',
        pointsCount: 0
      };
    }
  }

  public getConfig(): QuotaConfig {
    return this.config;
  }

  public getLatestSnapshot(): LiveQuotaSnapshot | null {
    return this.latestSnapshot;
  }

  public isConnected(): boolean {
    return !!(this.latestSnapshot && this.latestSnapshot.models.length > 0);
  }

  public getDefaultModels(): ModelQuotaInfo[] {
    const defaultLabels = [
      'Gemini 3.7 Flash (High)',
      'Gemini 3.6 Flash (Medium)',
      'Gemini 3.5 Flash (Medium)',
      'Gemini 3.1 Pro (High)',
      'Claude Sonnet 4.6 (Thinking)',
      'Claude Opus 4.6 (Thinking)'
    ];
    return defaultLabels.map((lbl) => ({
      label: lbl,
      modelId: lbl.toLowerCase().replace(/[^a-z0-9]/g, '_'),
      remainingFraction: 1.0,
      remainingPercentage: 100,
      isExhausted: false,
      resetTime: new Date(),
      timeUntilResetFormatted: 'Connecting to server...'
    }));
  }

  public getModels(): ModelQuotaInfo[] {
    if (this.latestSnapshot && this.latestSnapshot.models.length > 0) {
      return this.latestSnapshot.models;
    }
    return this.getDefaultModels();
  }

  public getPinnedModels(): string[] {
    if (this.config.pinnedModels && this.config.pinnedModels.length > 0) {
      return this.config.pinnedModels;
    }
    return ['Gemini 3.6 Flash (Medium)'];
  }

  public async togglePinnedModel(label: string): Promise<void> {
    const current = [...this.getPinnedModels()];
    const index = current.indexOf(label);
    if (index >= 0) {
      current.splice(index, 1);
    } else {
      current.push(label);
    }
    this.config.pinnedModels = current;

    // Persist permanently in ExtensionContext globalState Memento
    await this.context.globalState.update('gravitypulse.pinnedModels', current);

    // Also persist in global configuration
    try {
      await vscode.workspace
        .getConfiguration('gravitypulse')
        .update('pinnedModels', current, vscode.ConfigurationTarget.Global);
    } catch {
      // Ignore if configuration update is delayed
    }

    this._onDidChangeQuotaState.fire();
  }

  public getModelAbbreviation(label: string): string {
    if (MODEL_ABBREVIATIONS[label]) {
      return MODEL_ABBREVIATIONS[label];
    }
    if (label.includes('Claude')) {
      return 'Claude';
    }
    if (label.includes('Flash')) {
      return 'Flash';
    }
    if (label.includes('Pro')) {
      return 'Pro';
    }
    return label.substring(0, 6);
  }

  /**
   * 4-Tier Color Scheme:
   * >= 70%: Green (#34A853)
   * 40% - 70%: Slight Green-Yellow (#9ACD32)
   * 20% - 40%: Orange (#FB8C00)
   * < 20%: Red (#EA4335)
   */
  public getModelColor(percent: number): string {
    if (percent >= 70) {
      return '#34A853'; // Green
    }
    if (percent >= 40) {
      return '#9ACD32'; // Slight Green-Yellow
    }
    if (percent >= 20) {
      return '#FB8C00'; // Orange
    }
    return '#EA4335'; // Red
  }

  public reloadConfig(): void {
    this.config = this.loadConfig();
    this._onDidChangeQuotaState.fire();
  }

  private loadConfig(): QuotaConfig {
    const wsConfig = vscode.workspace.getConfiguration('gravitypulse');
    const savedPinned = this.context.globalState.get<string[]>('gravitypulse.pinnedModels');
    const configPinned = wsConfig.get<string[]>('pinnedModels');

    // Priority: 1. Saved globalState -> 2. Config -> 3. Default ['Gemini 3.6 Flash (Medium)']
    let pinned: string[];
    if (savedPinned && Array.isArray(savedPinned) && savedPinned.length > 0) {
      pinned = savedPinned;
    } else if (configPinned && Array.isArray(configPinned) && configPinned.length > 0) {
      pinned = configPinned;
    } else {
      pinned = ['Gemini 3.6 Flash (Medium)'];
    }

    return {
      displayStyle: wsConfig.get<DisplayStyle>('displayStyle', 'battery-bar'),
      precision: wsConfig.get<PrecisionMode>('precision', 'single-decimal'),
      pinnedModels: pinned,
      pollingIntervalSeconds: wsConfig.get<number>('pollingIntervalSeconds', 30),
      warningThreshold: wsConfig.get<number>('warningThreshold', 20),
      criticalThreshold: wsConfig.get<number>('criticalThreshold', 10),
      showToastOnLowBattery: wsConfig.get<boolean>('showToastOnLowBattery', true),
      infoThreshold: wsConfig.get<number>('infoThreshold', 20),
      severeThreshold: wsConfig.get<number>('severeThreshold', 5),
      globalAlertCooldownMinutes: wsConfig.get<number>('globalAlertCooldownMinutes', 2),
      burnRateSampleCount: wsConfig.get<number>('burnRateSampleCount', 5),
      creditsInfoThreshold: wsConfig.get<number>('creditsInfoThreshold', 25),
      creditsCriticalThreshold: wsConfig.get<number>('creditsCriticalThreshold', 10),
      creditsSevereThreshold: wsConfig.get<number>('creditsSevereThreshold', 3)
    };
  }

  private checkThresholds(): void {
    const models = this.getModels();
    const pinned = this.getPinnedModels();

    for (const m of models) {
      if (pinned.includes(m.label)) {
        if (m.remainingPercentage <= this.config.criticalThreshold && this.config.showToastOnLowBattery) {
          this._onLowBatteryWarning.fire({
            level: m.remainingPercentage,
            model: m.label,
            critical: true
          });
        }
      }
    }
  }
}

