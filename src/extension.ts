import * as vscode from 'vscode';
import { LiveQuotaClient } from './liveQuotaClient';
import { QuotaTracker } from './quotaTracker';
import { StatusBarManager } from './statusBar';
import { DashboardManager } from './ui/dashboard';

export function activate(context: vscode.ExtensionContext): void {
  // 1. Initialize Live Antigravity Language Server Client
  const liveClient = new LiveQuotaClient();
  context.subscriptions.push(liveClient);

  // 2. Initialize Quota Tracker connected to live client and persistent context
  const quotaTracker = new QuotaTracker(liveClient, context);

  // 3. Initialize Status Bar Multi-Model Battery Display
  const statusBarManager = new StatusBarManager(quotaTracker);
  context.subscriptions.push(statusBarManager);

  // 4. Initialize Interactive Multi-Model Dashboard
  const dashboardManager = new DashboardManager(quotaTracker, liveClient);

  // 5. Register Commands
  const cmdShowDashboard = vscode.commands.registerCommand('gravitypulse.showDashboard', () => {
    dashboardManager.showDashboard();
  });

  const cmdSwitchModel = vscode.commands.registerCommand('gravitypulse.switchModel', () => {
    dashboardManager.showDashboard();
  });

  const cmdSyncLogs = vscode.commands.registerCommand('gravitypulse.syncAntigravityLogs', () => {
    liveClient.forceRefresh();
    vscode.window.showInformationMessage('GravityPulse: Refreshed live model quota from Antigravity.');
  });

  context.subscriptions.push(
    cmdShowDashboard,
    cmdSwitchModel,
    cmdSyncLogs
  );

  // 6. Handle Configuration Changes
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('gravitypulse')) {
      quotaTracker.reloadConfig();
      statusBarManager.updateDisplay();
    }
  });
  context.subscriptions.push(configListener);

  // 7. Handle Multi-Tier Quota & Credits Alerts (Anti-Spam, Non-Modal)
  const quotaAlertListener = quotaTracker.onQuotaAlert(async (event) => {
    try {
      const cfg = quotaTracker.getConfig();
      if (!cfg.showToastOnLowBattery && event.type === 'model') {
        return;
      }
      if (!cfg.showToastOnLowCredits && event.type === 'credits') {
        return;
      }
      if (quotaTracker.isAlertMuted(event.modelLabel)) {
        return;
      }

      if (event.type === 'credits') {
        const formatted = `${event.currentPercentage.toFixed(1)}%`;
        const tierName = event.tier.charAt(0).toUpperCase() + event.tier.slice(1);
        const creditsDetail =
          event.availableCredits !== undefined && event.monthlyCredits !== undefined
            ? ` (${event.availableCredits.toLocaleString()} / ${event.monthlyCredits.toLocaleString()} available)`
            : '';
        
        const selection = await vscode.window.showWarningMessage(
          `GravityPulse: Available Credits are low [${tierName} Alert] at ${formatted}${creditsDetail}.`,
          'Manage Models',
          'Mute for 1 Hour',
          'Turn Off Alerts'
        );

        if (selection === 'Manage Models') {
          dashboardManager.showDashboard();
        } else if (selection === 'Mute for 1 Hour') {
          quotaTracker.muteAlerts(60 * 60 * 1000);
          vscode.window.showInformationMessage('GravityPulse: Credits alerts muted for 1 hour.');
        } else if (selection === 'Turn Off Alerts') {
          await vscode.workspace
            .getConfiguration('gravitypulse')
            .update('showToastOnLowCredits', false, vscode.ConfigurationTarget.Global);
          quotaTracker.reloadConfig();
          vscode.window.showInformationMessage('GravityPulse: Low credits alerts turned off. You can re-enable them in settings anytime.');
        }
      } else {
        const formatted = `${event.currentPercentage.toFixed(1)}%`;
        const tierName = event.tier.charAt(0).toUpperCase() + event.tier.slice(1);
        const modelName = event.modelLabel || 'Model';

        const selection = await vscode.window.showWarningMessage(
          `GravityPulse: ${modelName} quota is low [${tierName} Alert] at ${formatted}.`,
          'Manage Models',
          'Mute for 1 Hour',
          'Turn Off Alerts'
        );

        if (selection === 'Manage Models') {
          dashboardManager.showDashboard();
        } else if (selection === 'Mute for 1 Hour') {
          quotaTracker.muteAlerts(60 * 60 * 1000);
          vscode.window.showInformationMessage(`GravityPulse: Alerts muted for 1 hour.`);
        } else if (selection === 'Turn Off Alerts') {
          await vscode.workspace
            .getConfiguration('gravitypulse')
            .update('showToastOnLowBattery', false, vscode.ConfigurationTarget.Global);
          quotaTracker.reloadConfig();
          vscode.window.showInformationMessage('GravityPulse: Low battery alerts turned off. You can re-enable them in settings anytime.');
        }
      }
    } catch (err) {
      console.error('GravityPulse: Error displaying alert notification:', err);
    }
  });
  context.subscriptions.push(quotaAlertListener);
}

export function deactivate(): void {
  // Disposables are automatically cleaned up via context.subscriptions
}
