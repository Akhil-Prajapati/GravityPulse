import * as vscode from 'vscode';
import { QuotaConfig, DisplayStyle, PrecisionMode, LiveQuotaSnapshot, ModelQuotaInfo } from './types';
import { LiveQuotaClient } from './liveQuotaClient';

export const MODEL_ABBREVIATIONS: Record<string, string> = {
  'Gemini 3.7 Flash (High)': 'G3.7F',
  'Gemini 3.7 Flash (Medium)': 'G3.7F(M)',
  'Gemini 3.7 Flash (Low)': 'G3.7F(L)',
  'Gemini 3.6 Flash (High)': 'G3.6F',
  'Gemini 3.5 Flash (High)': 'G3.5F',
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

  constructor(private liveClient: LiveQuotaClient) {
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

  public getModels(): ModelQuotaInfo[] {
    return this.latestSnapshot?.models || [];
  }

  public getPinnedModels(): string[] {
    const configured = this.config.pinnedModels;
    if (configured && configured.length > 0) {
      return configured;
    }
    // Default to Gemini 3.6 Flash (Medium)
    const all = this.getModels();
    const flashMed = all.find(
      (m) =>
        m.label.includes('3.6 Flash (Medium)') ||
        (m.label.includes('3.6') && m.label.includes('Medium'))
    );
    if (flashMed) {
      return [flashMed.label];
    }
    return all.length > 0 ? [all[0].label] : ['Gemini 3.6 Flash (Medium)'];
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
    await vscode.workspace
      .getConfiguration('gravitypulse')
      .update('pinnedModels', current, vscode.ConfigurationTarget.Global);
    this.reloadConfig();
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
      return '#9ACD32'; // Slight Green-Yellow (Yellow-Green)
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
    return {
      displayStyle: wsConfig.get<DisplayStyle>('displayStyle', 'zap-percent'),
      precision: wsConfig.get<PrecisionMode>('precision', 'single-decimal'),
      pinnedModels: wsConfig.get<string[]>('pinnedModels', [
        'Gemini 3.6 Flash (Medium)'
      ]),
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
