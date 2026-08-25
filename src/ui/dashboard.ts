import * as vscode from 'vscode';
import { QuotaTracker } from '../quotaTracker';
import { LiveQuotaClient } from '../liveQuotaClient';

export class DashboardManager {
  constructor(
    private quotaTracker: QuotaTracker,
    private liveClient: LiveQuotaClient
  ) {}

  public async showDashboard(): Promise<void> {
    const pick = vscode.window.createQuickPick();
    pick.title = '⚡ GravityPulse — Antigravity Quota';
    pick.placeholder = 'Click a model to toggle its visibility in the status bar';
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    pick.canSelectMany = false;

    const buildItems = (): (vscode.QuickPickItem & { modelLabel?: string; action?: string })[] => {
      const items: (vscode.QuickPickItem & { modelLabel?: string; action?: string })[] = [];
      const models = this.quotaTracker.getModels();
      const pinned = this.quotaTracker.getPinnedModels();
      const snapshot = this.quotaTracker.getLatestSnapshot();

      const isConnected = this.quotaTracker.isConnected();

      if (!isConnected) {
        items.push({
          label: '$(sync~spin) Antigravity Server: Connecting / Offline',
          description: 'Click to scan and reconnect to local Language Server',
          detail: '   Attempts discovery across Windows, Linux & macOS processes and localhost ports',
          action: 'sync'
        });
      }

      items.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: isConnected ? '⚡ Models Quota (Click to Pin/Unpin)' : 'Models Selection (Click to Pin/Unpin)'
      });

      for (const m of models) {
        const isPinned = pinned.includes(m.label);
        const checkIcon = isPinned ? '$(check) ' : '$(circle-outline) ';
        const statusIcon = !isConnected
          ? '$(symbol-misc) '
          : m.isExhausted
          ? '$(flame) '
          : m.remainingPercentage < 20
          ? '$(warning) '
          : '$(zap) ';

        const bar = isConnected ? this.drawProgressBar(m.remainingPercentage) : '[----------]';
        const pct = isConnected ? `${m.remainingPercentage.toFixed(1)}%` : 'Ready';

        items.push({
          label: `${checkIcon}${statusIcon}${m.label}`,
          description: `${bar} ${pct}`,
          detail: isConnected ? `   Auto-refill: ${m.timeUntilResetFormatted}` : '   Will show exact battery once server connects',
          modelLabel: m.label
        });
      }

      if (snapshot?.promptCredits) {
        const pc = snapshot.promptCredits;
        items.push({
          kind: vscode.QuickPickItemKind.Separator,
          label: 'Prompt Credits'
        });
        items.push({
          label: `$(credit-card) Available Credits: ${pc.available.toLocaleString()} / ${pc.monthly.toLocaleString()}`,
          description: `${pc.remainingPercentage.toFixed(1)}% remaining`,
          detail: 'Monthly prompt credit balance'
        });
      }

      items.push({
        kind: vscode.QuickPickItemKind.Separator,
        label: 'Quick Controls'
      });

      items.push(
        {
          label: '$(sync) Force Refresh Live Quota',
          description: 'Scan and query Antigravity Language Server for latest quota',
          action: 'sync'
        },
        {
          label: '$(symbol-color) Change Status Bar Display Style',
          description: `Current: ${this.quotaTracker.getConfig().displayStyle}`,
          action: 'changeStyle'
        },
        {
          label: '$(symbol-numeric) Change Percentage Precision',
          description: `Current: ${this.quotaTracker.getConfig().precision}`,
          action: 'changePrecision'
        },
        {
          label: '$(settings-gear) Open Extension Settings',
          description: 'Configure thresholds, notifications, and auto-regen rates',
          action: 'settings'
        }
      );

      return items;
    };

    pick.items = buildItems();

    // Re-render when active model changes or user accepts
    let currentActiveItem: (vscode.QuickPickItem & { modelLabel?: string; action?: string }) | undefined;
    pick.onDidChangeActive((items) => {
      currentActiveItem = items[0] as any;
    });

    pick.onDidAccept(async () => {
      if (!currentActiveItem) {
        return;
      }

      if (currentActiveItem.modelLabel) {
        await this.quotaTracker.togglePinnedModel(currentActiveItem.modelLabel);
        // Refresh menu items in place to show updated checkmark
        pick.items = buildItems();
      } else if (currentActiveItem.action) {
        const action = currentActiveItem.action;
        pick.hide();

        if (action === 'sync') {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: '⚡ GravityPulse: Connecting to Antigravity Language Server...',
              cancellable: false
            },
            async () => {
              const res = await this.liveClient.forceRefresh();
              if (res) {
                vscode.window.showInformationMessage('⚡ GravityPulse: Successfully connected to Antigravity Language Server!');
              } else {
                vscode.window.showWarningMessage('⚡ GravityPulse: Searching for Antigravity Language Server... Please ensure Google Antigravity IDE is running.');
              }
            }
          );
        } else if (action === 'changeStyle') {
          await this.promptChangeStyle();
        } else if (action === 'changePrecision') {
          await this.promptChangePrecision();
        } else if (action === 'settings') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'gravitypulse');
        }
      }
    });

    pick.onDidHide(() => {
      pick.dispose();
    });

    pick.show();
  }

  private drawProgressBar(percentage: number): string {
    const total = 10;
    const filled = Math.round((percentage / 100) * total);
    const empty = total - filled;
    return '▓'.repeat(Math.max(0, filled)) + '░'.repeat(Math.max(0, empty));
  }

  public async promptChangeStyle(): Promise<void> {
    const styleOptions = [
      { label: '$(zap) G3.7F: 94.1%', description: 'Zap Energy ThemeIcon (Default)', value: 'zap-percent' },
      { label: '$(activity) G3.7F: 94.1%', description: 'Activity Pulse ThemeIcon', value: 'activity-percent' },
      { label: '$(zap) G3.7F [███████░] 94.1%', description: 'Battery Bar with Segments', value: 'battery-bar' },
      { label: '94.1% $(zap)', description: 'Minimalist', value: 'minimal' },
      { label: '$(zap) G3.7F: 94.1% [███████░]', description: 'Detailed with Bar', value: 'detailed' }
    ];

    const pick = await vscode.window.showQuickPick(styleOptions, {
      title: 'Select Battery Display Style'
    });

    if (pick) {
      await vscode.workspace
        .getConfiguration('gravitypulse')
        .update('displayStyle', pick.value, vscode.ConfigurationTarget.Global);
      this.quotaTracker.reloadConfig();
    }
  }

  public async promptChangePrecision(): Promise<void> {
    const precisionOptions = [
      { label: 'Single Decimal (94.1%)', description: 'Real-time exact point-to-point floating decimal', value: 'single-decimal' },
      { label: 'Exact Integer (94%)', description: 'Point-to-point 1% step precision (No 5% rounding)', value: 'integer' }
    ];

    const pick = await vscode.window.showQuickPick(precisionOptions, {
      title: 'Select Percentage Precision Mode'
    });

    if (pick) {
      await vscode.workspace
        .getConfiguration('gravitypulse')
        .update('precision', pick.value, vscode.ConfigurationTarget.Global);
      this.quotaTracker.reloadConfig();
    }
  }
}
