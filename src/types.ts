export type DisplayStyle =
  | 'zap-percent'
  | 'activity-percent'
  | 'battery-bar'
  | 'minimal'
  | 'detailed';

export type PrecisionMode = 'integer' | 'single-decimal';

export interface ModelQuotaInfo {
  label: string;
  modelId: string;
  remainingFraction: number;
  remainingPercentage: number;
  isExhausted: boolean;
  resetTime: Date;
  timeUntilResetFormatted: string;
}

export interface PromptCreditsInfo {
  available: number;
  monthly: number;
  usedPercentage: number;
  remainingPercentage: number;
}

export interface LiveQuotaSnapshot {
  timestamp: Date;
  models: ModelQuotaInfo[];
  promptCredits?: PromptCreditsInfo;
}

export interface QuotaConfig {
  displayStyle: DisplayStyle;
  precision: PrecisionMode;
  pinnedModels: string[];
  pollingIntervalSeconds: number;
  warningThreshold: number;
  criticalThreshold: number;
  showToastOnLowBattery: boolean;
}
