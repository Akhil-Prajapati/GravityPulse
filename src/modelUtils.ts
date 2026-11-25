import { ModelQuotaInfo, QuotaGroup, WeeklyQuotaInfo, isObsoleteModel } from './types';

export interface DaemonHubEntry {
  pid: number;
  httpsPort: number;
  httpPort: number;
  csrfToken: string;
  lsVersion?: string;
  mtimeMs: number;
  filePath: string;
}

export const MODEL_ABBREVIATIONS: Record<string, string> = {
  'Gemini 4 Hydrogen (High)': 'G4H',
  'Gemini 4 Hydrogen (XHigh)': 'G4H(XH)',
  'Gemini 4 Hydrogen (Medium)': 'G4H(M)',
  'Gemini 4 Hydrogen (Low)': 'G4H(L)',
  'Gemini 4 Neon': 'G4N',
  'Gemini 4 Carbon': 'G4C',
  'Gemini 4 Argon': 'G4A',
  'Gemini 3.8 Flash (High)': 'G3.8F',
  'Gemini 3.8 Flash (Medium)': 'G3.8F(M)',
  'Gemini 3.8 Flash (Low)': 'G3.8F(L)',
  'Claude Sonnet 5.5 (Thinking)': 'Claude5.5',
  'Claude Opus 5.5 (Thinking)': 'Opus5.5',
  'Claude Sonnet 4.6 (Thinking)': 'Claude',
  'Claude Opus 4.6 (Thinking)': 'Opus',
  'GPT-OSS 120B (Medium)': 'GPT'
};

export const DEFAULT_PINNED_MODEL = 'Gemini 4 Hydrogen (High)';

const GEMINI_SERIES_CODES: Record<string, string> = {
  hydrogen: 'H',
  neon: 'N',
  carbon: 'C',
  argon: 'A',
  flash: 'F',
  pro: 'P'
};

export function getModelAbbreviation(label: string): string {
  if (MODEL_ABBREVIATIONS[label]) {
    return MODEL_ABBREVIATIONS[label];
  }

  const trimmed = label.trim();

  // Dynamic Gemini parser for named series (Hydrogen, Neon, Carbon, Argon) and Flash/Pro
  const geminiMatch = trimmed.match(
    /gemini\s*(\d+\.?\d*)\s*(hydrogen|neon|carbon|argon|flash|pro)(?:\s*\((XHigh|High|Medium|Low)\))?/i
  );
  if (geminiMatch) {
    const ver = geminiMatch[1] || '';
    const seriesKey = geminiMatch[2].toLowerCase();
    const seriesCode = GEMINI_SERIES_CODES[seriesKey] || geminiMatch[2].charAt(0).toUpperCase();
    const tier = geminiMatch[3]?.toLowerCase();

    let tierSuffix = '';
    if (tier === 'xhigh') {
      tierSuffix = '(XH)';
    } else if (tier === 'medium') {
      tierSuffix = '(M)';
    } else if (tier === 'low') {
      tierSuffix = '(L)';
    }
    return `G${ver}${seriesCode}${tierSuffix}`;
  }

  // Claude Parser
  if (/claude\s*opus/i.test(trimmed)) {
    const verMatch = trimmed.match(/(\d+\.?\d*)/);
    if (verMatch && parseFloat(verMatch[1]) >= 5.0) {
      return `Opus${verMatch[1]}`;
    }
    return 'Opus';
  }
  if (/claude/i.test(trimmed)) {
    const verMatch = trimmed.match(/(\d+\.?\d*)/);
    if (verMatch && parseFloat(verMatch[1]) >= 5.0) {
      return `Claude${verMatch[1]}`;
    }
    return 'Claude';
  }

  // GPT Parser
  if (/gpt/i.test(trimmed)) {
    return 'GPT';
  }

  if (trimmed.includes('Flash')) {
    return 'Flash';
  }
  if (trimmed.includes('Pro')) {
    return 'Pro';
  }

  return trimmed.substring(0, 6);
}

export function getModelRank(label: string): number {
  const l = label.toLowerCase();

  const getTierOffset = (): number => {
    if (/\bxhigh\b/.test(l)) return 0.015;
    if (/\bhigh\b/.test(l)) return 0.01;
    if (/\bmedium\b/.test(l)) return 0.02;
    if (/\blow\b/.test(l)) return 0.03;
    return 0.04;
  };

  if (l.includes('gemini')) {
    const vMatch = l.match(/(\d+\.?\d*)/);
    const version = vMatch ? parseFloat(vMatch[1]) : 3.0;
    const tierOffset = getTierOffset();

    if (l.includes('pro')) {
      return 200 - version * 10 + tierOffset;
    }

    let familyOffset = 0.5;
    if (l.includes('hydrogen') || l.includes('flash')) familyOffset = 0.0;
    else if (l.includes('neon')) familyOffset = 0.1;
    else if (l.includes('carbon')) familyOffset = 0.2;
    else if (l.includes('argon')) familyOffset = 0.3;

    // Higher version gets lower rank number (sorted first)
    return 100 - version * 10 + familyOffset + tierOffset;
  }

  if (l.includes('claude')) {
    const vMatch = l.match(/(\d+\.?\d*)/);
    const version = vMatch ? parseFloat(vMatch[1]) : 4.0;
    if (l.includes('sonnet')) {
      return 300 - version * 10;
    }
    if (l.includes('opus')) {
      return 300 - version * 10 + 0.5;
    }
    return 350 - version * 10;
  }

  if (l.includes('gpt')) {
    return 400;
  }

  return 500;
}

export function isGeminiFamilyLabel(labelLower: string): boolean {
  return (
    labelLower.includes('gemini') ||
    labelLower.includes('hydrogen') ||
    labelLower.includes('neon') ||
    labelLower.includes('carbon') ||
    labelLower.includes('argon')
  );
}

export function findWeeklyQuotaForModel(modelLabel: string, groups: QuotaGroup[]): WeeklyQuotaInfo | undefined {
  const l = modelLabel.toLowerCase();
  const modelIsGemini = isGeminiFamilyLabel(l);
  const modelIsClaude = l.includes('claude') || l.includes('sonnet') || l.includes('opus');
  const modelIsGpt = l.includes('gpt');

  // 1. Match by group description or group name
  for (const g of groups) {
    const gName = g.displayName.toLowerCase();
    const gDesc = (g.description || '').toLowerCase();
    const isGemini = modelIsGemini && (gName.includes('gemini') || gDesc.includes('gemini'));
    const isClaude = modelIsClaude && (gName.includes('claude') || gDesc.includes('claude'));
    const isGpt = modelIsGpt && (gName.includes('gpt') || gDesc.includes('gpt'));

    if (isGemini || isClaude || isGpt) {
      const weeklyBucket = g.buckets.find((b) => b.window === 'weekly' || b.bucketId.toLowerCase().includes('weekly'));
      if (weeklyBucket) {
        return {
          remainingFraction: weeklyBucket.remainingFraction,
          remainingPercentage: weeklyBucket.remainingPercentage,
          resetTime: weeklyBucket.resetTime,
          timeUntilResetFormatted: weeklyBucket.timeUntilResetFormatted,
          description: weeklyBucket.description
        };
      }
    }
  }

  // 2. Fallback: match by bucketId substring
  for (const g of groups) {
    for (const b of g.buckets) {
      const bId = b.bucketId.toLowerCase();
      if (b.window === 'weekly' || bId.includes('weekly')) {
        if (modelIsGemini && bId.includes('gemini')) {
          return {
            remainingFraction: b.remainingFraction,
            remainingPercentage: b.remainingPercentage,
            resetTime: b.resetTime,
            timeUntilResetFormatted: b.timeUntilResetFormatted,
            description: b.description
          };
        }
        if ((modelIsClaude || modelIsGpt) && (bId.includes('3p') || bId.includes('claude') || bId.includes('gpt'))) {
          return {
            remainingFraction: b.remainingFraction,
            remainingPercentage: b.remainingPercentage,
            resetTime: b.resetTime,
            timeUntilResetFormatted: b.timeUntilResetFormatted,
            description: b.description
          };
        }
      }
    }
  }

  return undefined;
}

export function parseClientModelConfigs(
  rawModels: any[],
  quotaGroups: QuotaGroup[],
  formatTimeDiff: (ms: number, resetTime: Date) => string,
  now: Date = new Date()
): ModelQuotaInfo[] {
  const models: ModelQuotaInfo[] = [];

  for (const m of rawModels) {
    if (m.disabled) {
      continue;
    }
    if (m.label && isObsoleteModel(m.label)) {
      continue;
    }
    const quotaInfo = m.quotaInfo ?? m.quota_info;
    const remFrac = quotaInfo?.remainingFraction ?? quotaInfo?.remaining_fraction;
    const resetTimeStr = quotaInfo?.resetTime ?? quotaInfo?.reset_time;
    const resetTime = resetTimeStr ? new Date(resetTimeStr) : new Date(0);
    const diffMs = resetTime.getTime() - now.getTime();

    const weekly = findWeeklyQuotaForModel(m.label || '', quotaGroups);

    // When quota is exhausted, proto3 omits remainingFraction from JSON (default 0.0 value).
    // If resetTime is in future (diffMs > 0), the missing field represents 0.0, NOT 1.0!
    let fraction: number;
    if (remFrac !== undefined) {
      fraction = Number(remFrac);
    } else if (quotaInfo && diffMs > 0) {
      fraction = 0.0;
    } else {
      fraction = 1.0;
    }

    let isExhausted = fraction === 0;
    let effectiveResetTime = resetTime;
    let effectiveDiffMs = diffMs;

    if (weekly && weekly.remainingFraction === 0) {
      isExhausted = true;
      fraction = 0.0;
      effectiveResetTime = weekly.resetTime;
      effectiveDiffMs = weekly.resetTime.getTime() - now.getTime();
    }

    models.push({
      label: m.label || 'Unknown Model',
      modelId: m.modelId ?? m.modelOrAlias?.model ?? m.model_or_alias?.model ?? 'unknown',
      remainingFraction: fraction,
      remainingPercentage: fraction * 100,
      isExhausted,
      resetTime: effectiveResetTime,
      timeUntilResetFormatted:
        quotaInfo || weekly ? formatTimeDiff(effectiveDiffMs, effectiveResetTime) : 'Full / Ready',
      weeklyQuota: weekly
    });
  }

  models.sort((a, b) => getModelRank(a.label) - getModelRank(b.label) || a.label.localeCompare(b.label));
  return models;
}

export function parseDaemonHubJson(rawText: string, filePath: string, mtimeMs: number): DaemonHubEntry | null {
  try {
    const parsed = JSON.parse(rawText);
    const csrfToken = typeof parsed?.csrfToken === 'string' ? parsed.csrfToken.trim() : '';
    const httpsPort = Number(parsed?.httpsPort || 0);
    const httpPort = Number(parsed?.httpPort || 0);
    const pid = Number(parsed?.pid || 0);
    if (!csrfToken || (httpsPort <= 0 && httpPort <= 0)) {
      return null;
    }
    return {
      pid,
      httpsPort,
      httpPort,
      csrfToken,
      lsVersion: typeof parsed?.lsVersion === 'string' ? parsed.lsVersion : undefined,
      mtimeMs,
      filePath
    };
  } catch {
    return null;
  }
}
