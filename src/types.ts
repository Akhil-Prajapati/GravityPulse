export type DisplayStyle =
  | 'zap-percent'
  | 'activity-percent'
  | 'battery-bar'
  | 'minimal'
  | 'detailed';

export type PrecisionMode = 'integer' | 'single-decimal';

export interface WeeklyQuotaInfo {
  remainingFraction: number;
  remainingPercentage: number;
  resetTime: Date;
  timeUntilResetFormatted: string;
  description?: string;
}

export interface ModelQuotaInfo {
  label: string;
  modelId: string;
  remainingFraction: number;
  remainingPercentage: number;
  isExhausted: boolean;
  resetTime: Date;
  timeUntilResetFormatted: string;
  weeklyQuota?: WeeklyQuotaInfo;
}

export interface PromptCreditsInfo {
  available: number;
  monthly: number;
  usedPercentage: number;
  remainingPercentage: number;
}

export interface QuotaGroupBucket {
  bucketId: string;
  displayName: string;
  description?: string;
  window: string;
  remainingFraction: number;
  remainingPercentage: number;
  resetTime: Date;
  timeUntilResetFormatted: string;
}

export interface QuotaGroup {
  displayName: string;
  description?: string;
  buckets: QuotaGroupBucket[];
}

export interface LiveQuotaSnapshot {
  timestamp: Date;
  models: ModelQuotaInfo[];
  promptCredits?: PromptCreditsInfo;
  quotaGroups?: QuotaGroup[];
}

export interface QuotaConfig {
  displayStyle: DisplayStyle;
  precision: PrecisionMode;
  pinnedModels: string[];
  pollingIntervalSeconds: number;
  warningThreshold: number;
  criticalThreshold: number;
  showToastOnLowBattery: boolean;
  infoThreshold: number;
  severeThreshold: number;
  globalAlertCooldownMinutes: number;
  burnRateSampleCount: number;
  creditsInfoThreshold: number;
  creditsCriticalThreshold: number;
  creditsSevereThreshold: number;
  showToastOnLowCredits: boolean;
}

export type AlertTier = 'info' | 'critical' | 'severe';

export interface QuotaAlertEvent {
  type: 'model' | 'credits';
  tier: AlertTier;
  threshold: number;
  currentPercentage: number;
  modelLabel?: string;
  modelId?: string;
  availableCredits?: number;
  monthlyCredits?: number;
}

export interface PollHistoryPoint {
  timestamp: number;
  percentage: number;
}

export interface BurnRateEstimate {
  ratePercentPerMinute: number;
  minutesToEmpty: number | null;
  formattedEta: string | null;
}

export type TrendDirection = 'declining' | 'rising' | 'stable' | 'gathering';

export interface ModelTrendInfo {
  sparkline: string;
  direction: TrendDirection;
  label: string;
  formatted: string;
  pointsCount: number;
}
