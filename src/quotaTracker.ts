import * as vscode from 'vscode';
import { QuotaConfig, DisplayStyle, PrecisionMode, LiveQuotaSnapshot, ModelQuotaInfo } from './types';
import { LiveQuotaClient } from './liveQuotaClient';

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

  constructor(
    private liveClient: LiveQuotaClient,
    private context: vscode.ExtensionContext
  ) {
    this.config = this.loadConfig();

    this.liveClient.onDidChangeSnapshot((snapshot) => {
      this.latestSnapshot = snapshot;
      this.checkThresholds();
      this._onDidChangeQuotaState.fire();
    });
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
      showToastOnLowBattery: wsConfig.get<boolean>('showToastOnLowBattery', true)
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
