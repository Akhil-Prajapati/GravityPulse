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

  // 7. Handle Low Battery Warnings
  const lowBatteryListener = quotaTracker.onLowBatteryWarning(({ level, model, critical }) => {
    const formatted = `${level.toFixed(1)}%`;
    if (critical) {
      vscode.window.showErrorMessage(
        `GravityPulse: Critical Quota Alert! ${model} is at ${formatted}.`,
        'Manage Models'
      ).then((selection) => {
        if (selection === 'Manage Models') {
          dashboardManager.showDashboard();
        }
      });
    } else {
      vscode.window.showWarningMessage(
        `GravityPulse: Low Quota Warning! ${model} is at ${formatted}.`,
        'Manage Models'
      ).then((selection) => {
        if (selection === 'Manage Models') {
          dashboardManager.showDashboard();
        }
      });
    }
  });
  context.subscriptions.push(lowBatteryListener);
}

export function deactivate(): void {
  // Disposables are automatically cleaned up via context.subscriptions
}
