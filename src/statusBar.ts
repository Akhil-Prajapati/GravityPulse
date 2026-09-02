import * as vscode from 'vscode';
import { QuotaTracker } from './quotaTracker';
import { QuotaConfig, ModelQuotaInfo } from './types';

export class StatusBarManager implements vscode.Disposable {
  private itemsMap: Map<string, vscode.StatusBarItem> = new Map();
  private fallbackItem: vscode.StatusBarItem;
  private isDisposed = false;

  constructor(private quotaTracker: QuotaTracker) {
    this.fallbackItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    );
    this.fallbackItem.command = 'gravitypulse.showDashboard';
    this.fallbackItem.text = '$(zap) AGQ';

    this.updateDisplay();

    // Subscribe to live quota updates
    this.quotaTracker.onDidChangeQuotaState(() => {
      if (!this.isDisposed) {
        this.updateDisplay();
      }
    });
  }

  public updateDisplay(): void {
    const config = this.quotaTracker.getConfig();
    const allModels = this.quotaTracker.getModels();
    const pinnedLabels = this.quotaTracker.getPinnedModels();

    // If no snapshot yet or no models pinned, show fallback item
    if (allModels.length === 0 || pinnedLabels.length === 0) {
      this.clearSpecificItems();
      this.fallbackItem.text = '$(zap) AGQ: Connecting...';
      this.fallbackItem.tooltip = 'Click to select models to display';
      this.fallbackItem.show();
      return;
    }

    this.fallbackItem.hide();

    // Track active model labels to prune unpinned items
    const activePinned = new Set<string>();

    let priority = 100;
    for (const label of pinnedLabels) {
      const modelInfo = allModels.find(
        (m) => m.label.toLowerCase() === label.toLowerCase() || m.modelId.toLowerCase() === label.toLowerCase()
      );

      if (!modelInfo) {
        continue;
      }

      activePinned.add(label);
      let item = this.itemsMap.get(label);

      if (!item) {
        item = vscode.window.createStatusBarItem(
          vscode.StatusBarAlignment.Right,
          priority
        );
        item.command = 'gravitypulse.showDashboard';
        this.itemsMap.set(label, item);
      }

      priority--;
      this.renderModelItem(item, modelInfo, config);
      item.show();
    }

    // Dispose items for unpinned models
    for (const [key, item] of this.itemsMap.entries()) {
      if (!activePinned.has(key)) {
        item.dispose();
        this.itemsMap.delete(key);
      }
    }
  }

  private renderModelItem(
    item: vscode.StatusBarItem,
    model: ModelQuotaInfo,
    config: QuotaConfig
  ): void {
    const percent = model.remainingPercentage;
    const formattedPercent =
      config.precision === 'single-decimal' ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;

    const abbr = this.quotaTracker.getModelAbbreviation(model.label);
    const themeIcon = this.getThemeIcon(percent);
    const barVisual = this.renderVisualBar(percent);

    // Build text
    let text = '';
    switch (config.displayStyle) {
      case 'activity-percent':
        text = `$(activity) ${abbr}: ${formattedPercent}`;
        break;
      case 'battery-bar':
        text = `${themeIcon} ${abbr} ${barVisual} ${formattedPercent}`;
        break;
      case 'minimal':
        text = `${formattedPercent} ${themeIcon}`;
        break;
      case 'detailed':
        text = `${themeIcon} ${abbr}: ${formattedPercent} ${barVisual}`;
        break;
      case 'zap-percent':
      default:
        text = `${themeIcon} ${abbr}: ${formattedPercent}`;
        break;
    }

    item.text = text;

    // Apply color styling
    const colorHex = this.quotaTracker.getModelColor(percent);
    item.color = colorHex;

    if (percent <= config.criticalThreshold) {
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    } else if (percent <= config.warningThreshold) {
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
      item.backgroundColor = undefined;
    }

    // Dedicated single-model hover card (only this model)
    item.tooltip = this.buildSingleModelTooltip(model, formattedPercent, barVisual, themeIcon);
  }

  private getThemeIcon(percent: number): string {
    if (percent < 20) {
      return '$(flame)';
    }
    if (percent < 40) {
      return '$(warning)';
    }
    return '$(zap)';
  }

  private renderVisualBar(percent: number): string {
    const totalBlocks = 8;
    const filledCount = Math.round((percent / 100) * totalBlocks);
    const filled = '█'.repeat(Math.max(0, Math.min(totalBlocks, filledCount)));
    const empty = '░'.repeat(Math.max(0, totalBlocks - filledCount));
    return `[${filled}${empty}]`;
  }

  private buildSingleModelTooltip(
    model: ModelQuotaInfo,
    formattedPercent: string,
    barVisual: string,
    themeIcon: string
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    const percent = model.remainingPercentage;
    let healthBadge = '🟢 Optimal';
    if (percent < 20) {
      healthBadge = '🔴 Critical (< 20%)';
    } else if (percent < 40) {
      healthBadge = '🟠 Moderate Warning (20% - 40%)';
    } else if (percent < 70) {
      healthBadge = '🟡 Good (40% - 70%)';
    }

    md.appendMarkdown(`### ${themeIcon} **${model.label}**\n\n`);
    md.appendMarkdown(`**Battery Level:** \`${formattedPercent}\` &nbsp; \`${barVisual}\` &nbsp; **${healthBadge}**\n\n`);
    md.appendMarkdown(`---\n\n`);
    md.appendMarkdown(`- 🔄 **Auto-Refill Schedule:** ${model.timeUntilResetFormatted}\n`);
    md.appendMarkdown(`- 🔋 **Remaining Capacity:** \`${(model.remainingFraction * 100).toFixed(2)}%\`\n`);
    if (model.weeklyQuota) {
      const wPct = (model.weeklyQuota.remainingFraction * 100).toFixed(2);
      const refillCountdown = model.weeklyQuota.timeUntilResetFormatted.replace(/^Auto-refills in /, '');
      const wStatus = model.weeklyQuota.remainingFraction === 0
        ? `\`${wPct}%\` ⚠️ *(Exhausted — Refills in ${refillCountdown})*`
        : `\`${wPct}%\` *(Refills in ${refillCountdown})*`;
      md.appendMarkdown(`- 📅 **Weekly Limit:** ${wStatus}\n`);
    }

    try {
      const burnEstimate = this.quotaTracker.getBurnRateEstimate(model.label);
      if (burnEstimate?.formattedEta) {
        md.appendMarkdown(`- ⏳ **Estimated Pace:** \`${burnEstimate.formattedEta}\`\n`);
      }

      const trend = this.quotaTracker.getModelTrend(model.label);
      if (trend) {
        if (trend.direction === 'gathering') {
          md.appendMarkdown(`- 📈 **Recent Trend:** \`—\` *(gathering data)*\n`);
        } else {
          md.appendMarkdown(`- 📈 **Recent Trend:** \`${trend.sparkline}\` (${trend.direction}) *(Quota usage over last ${trend.pointsCount} polls)*\n`);
        }
      }
    } catch {
      // Passive features fail silently
    }

    md.appendMarkdown(`\n---\n\n`);
    md.appendMarkdown(`[$(paintcan) Select Models](command:gravitypulse.showDashboard) &nbsp;|&nbsp; [$(sync) Refresh](command:gravitypulse.syncAntigravityLogs)\n`);

    return md;
  }

  private clearSpecificItems(): void {
    for (const item of this.itemsMap.values()) {
      item.dispose();
    }
    this.itemsMap.clear();
  }

  public dispose(): void {
    this.isDisposed = true;
    this.clearSpecificItems();
    this.fallbackItem.dispose();
  }
}
