import * as vscode from 'vscode';
import * as https from 'https';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LiveQuotaSnapshot, ModelQuotaInfo, PromptCreditsInfo } from './types';

const execAsync = promisify(exec);

export class LiveQuotaClient implements vscode.Disposable {
  private port: number = 0;
  private csrfToken: string = '';
  private pollingTimer: NodeJS.Timeout | null = null;
  private isDisposed = false;
  private disposables: vscode.Disposable[] = [];

  private readonly _onDidChangeSnapshot = new vscode.EventEmitter<LiveQuotaSnapshot>();
  public readonly onDidChangeSnapshot = this._onDidChangeSnapshot.event;

  private lastSnapshot: LiveQuotaSnapshot | null = null;

  constructor() {
    this.init();

    // Auto-refresh when window regains focus
    const windowListener = vscode.window.onDidChangeWindowState((e) => {
      if (e.focused) {
        this.forceRefresh();
      }
    });
    this.disposables.push(windowListener);
  }

  public getLastSnapshot(): LiveQuotaSnapshot | null {
    return this.lastSnapshot;
  }

  public async init(): Promise<void> {
    await this.discoverAndConnect();
    const intervalSec = vscode.workspace
      .getConfiguration('gravitypulse')
      .get<number>('pollingIntervalSeconds', 30);
    this.startPolling(intervalSec * 1000);
  }

  public async forceRefresh(): Promise<LiveQuotaSnapshot | null> {
    if (!this.port || !this.csrfToken) {
      await this.discoverAndConnect();
    }
    return this.fetchQuota();
  }

  private async discoverAndConnect(): Promise<boolean> {
    try {
      const isWin = process.platform === 'win32';
      let cmd = 'pgrep -af language_server || ps aux | grep language_server';
      if (isWin) {
        cmd = 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name like \'%language_server%\'\\" | Select-Object ProcessId,CommandLine | ConvertTo-Json"';
      }

      const { stdout } = await execAsync(cmd).catch(() => ({ stdout: '' }));
      if (!stdout) {
        return false;
      }

      const tokenMatch = stdout.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);
      if (!tokenMatch) {
        return false;
      }
      this.csrfToken = tokenMatch[1];

      // Extract PID
      let pid = 0;
      const pidMatch = stdout.match(/(\d+)\s+.*language_server/);
      if (pidMatch) {
        pid = parseInt(pidMatch[1], 10);
      }

      // Discover listening ports
      const portList = await this.getListeningPorts(pid, isWin);

      for (const p of portList) {
        const ok = await this.testPort(p, this.csrfToken);
        if (ok) {
          this.port = p;
          await this.fetchQuota();
          return true;
        }
      }
    } catch {
      // Fallback
    }
    return false;
  }

  private async getListeningPorts(pid: number, isWin: boolean): Promise<number[]> {
    const ports: number[] = [];
    try {
      if (isWin) {
        const { stdout } = await execAsync(
          `powershell -NoProfile -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort"`
        ).catch(() => ({ stdout: '' }));
        stdout.split('\n').forEach((l) => {
          const num = parseInt(l.trim(), 10);
          if (num > 0 && !ports.includes(num)) {
            ports.push(num);
          }
        });
      } else {
        const pidFilter = pid > 0 ? `grep "pid=${pid}"` : 'grep "language_server"';
        const { stdout } = await execAsync(`ss -tlnp 2>/dev/null | ${pidFilter} || lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null`).catch(() => ({ stdout: '' }));
        const matches = stdout.match(/:(\d+)/g);
        if (matches) {
          matches.forEach((m) => {
            const num = parseInt(m.replace(':', ''), 10);
            if (num > 0 && !ports.includes(num)) {
              ports.push(num);
            }
          });
        }
      }
    } catch {
      // Ignore
    }
    return ports;
  }

  private testPort(port: number, token: string): Promise<boolean> {
    return new Promise((resolve) => {
      const data = JSON.stringify({
        metadata: {
          ideName: 'antigravity',
          extensionName: 'antigravity',
          locale: 'en'
        }
      });

      const req = https.request(
        {
          hostname: '127.0.0.1',
          port: port,
          path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'X-Codeium-Csrf-Token': token,
            'Content-Length': Buffer.byteLength(data)
          },
          rejectUnauthorized: false,
          timeout: 4000
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const parsed = JSON.parse(body);
                if (parsed.userStatus) {
                  resolve(true);
                  return;
                }
              } catch {
                // Ignore
              }
            }
            resolve(false);
          });
        }
      );

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.write(data);
      req.end();
    });
  }

  public async fetchQuota(): Promise<LiveQuotaSnapshot | null> {
    if (!this.port || !this.csrfToken) {
      return null;
    }

    return new Promise((resolve) => {
      const postData = JSON.stringify({
        metadata: {
          ideName: 'antigravity',
          extensionName: 'antigravity',
          locale: 'en'
        }
      });

      const req = https.request(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'X-Codeium-Csrf-Token': this.csrfToken,
            'Content-Length': Buffer.byteLength(postData)
          },
          rejectUnauthorized: false,
          timeout: 5000
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => {
            if (res.statusCode === 200) {
              try {
                const raw = JSON.parse(body);
                const snapshot = this.parseResponse(raw);
                this.lastSnapshot = snapshot;
                this._onDidChangeSnapshot.fire(snapshot);
                resolve(snapshot);
                return;
              } catch {
                // Ignore
              }
            }
            resolve(null);
          });
        }
      );

      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.write(postData);
      req.end();
    });
  }

  private parseResponse(data: any): LiveQuotaSnapshot {
    const userStatus = data.userStatus || {};
    const planInfo = userStatus.planStatus?.planInfo;
    const availableCredits = userStatus.planStatus?.availablePromptCredits;

    let promptCredits: PromptCreditsInfo | undefined;
    if (planInfo && availableCredits !== undefined) {
      const monthly = Number(planInfo.monthlyPromptCredits || 0);
      const available = Number(availableCredits);
      if (monthly > 0) {
        promptCredits = {
          available,
          monthly,
          usedPercentage: ((monthly - available) / monthly) * 100,
          remainingPercentage: (available / monthly) * 100
        };
      }
    }

    const rawModels = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
    const models: ModelQuotaInfo[] = [];

    for (const m of rawModels) {
      const quotaInfo = m.quotaInfo ?? m.quota_info;
      const remFrac = quotaInfo?.remainingFraction ?? quotaInfo?.remaining_fraction;
      const resetTimeStr = quotaInfo?.resetTime ?? quotaInfo?.reset_time;
      const resetTime = resetTimeStr ? new Date(resetTimeStr) : new Date(0);
      const now = new Date();
      const diffMs = resetTime.getTime() - now.getTime();

      const fraction = remFrac !== undefined ? Number(remFrac) : 1.0;
      const percent = fraction * 100;

      models.push({
        label: m.label || 'Unknown Model',
        modelId: m.modelOrAlias?.model ?? m.model_or_alias?.model ?? 'unknown',
        remainingFraction: fraction,
        remainingPercentage: percent,
        isExhausted: fraction === 0,
        resetTime: resetTime,
        timeUntilResetFormatted: quotaInfo ? this.formatTimeDiff(diffMs, resetTime) : 'Full / Ready'
      });
    }

    const getRank = (label: string): number => {
      const l = label.toLowerCase();
      if (l.includes('3.7 flash') && l.includes('high')) return 1;
      if (l.includes('3.7 flash') && l.includes('medium')) return 2;
      if (l.includes('3.7 flash') && l.includes('low')) return 3;
      if (l.includes('3.7 flash')) return 4;
      if (l.includes('3.6 flash') && l.includes('high')) return 5;
      if (l.includes('3.6 flash') && l.includes('medium')) return 6;
      if (l.includes('3.6 flash') && l.includes('low')) return 7;
      if (l.includes('3.6 flash')) return 8;
      if (l.includes('3.5 flash') && l.includes('high')) return 9;
      if (l.includes('3.5 flash') && l.includes('medium')) return 10;
      if (l.includes('3.5 flash') && l.includes('low')) return 11;
      if (l.includes('3.5 flash')) return 12;
      if (l.includes('3.1 pro') && l.includes('high')) return 13;
      if (l.includes('3.1 pro') && l.includes('low')) return 14;
      if (l.includes('pro')) return 15;
      if (l.includes('claude sonnet') && l.includes('4.6')) return 16;
      if (l.includes('claude opus') && l.includes('4.6')) return 17;
      if (l.includes('claude sonnet')) return 18;
      if (l.includes('claude opus')) return 19;
      if (l.includes('claude')) return 20;
      if (l.includes('gpt')) return 21;
      return 100;
    };

    models.sort((a, b) => getRank(a.label) - getRank(b.label) || a.label.localeCompare(b.label));

    return {
      timestamp: new Date(),
      models,
      promptCredits
    };
  }

  private formatTimeDiff(ms: number, resetTime: Date): string {
    if (ms <= 0) {
      return 'Auto-Refilled / Full';
    }
    const mins = Math.ceil(ms / 60000);
    let duration = '';
    if (mins < 60) {
      duration = `${mins}m`;
    } else {
      const hours = Math.floor(mins / 60);
      duration = `${hours}h ${mins % 60}m`;
    }

    const timeStr = resetTime.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });

    return `Auto-refills in ${duration} (${timeStr})`;
  }

  public startPolling(intervalMs: number): void {
    this.stopPolling();
    this.pollingTimer = setInterval(() => {
      if (!this.isDisposed) {
        this.fetchQuota();
      }
    }, intervalMs);
  }

  public stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  public dispose(): void {
    this.isDisposed = true;
    this.stopPolling();
    this.disposables.forEach((d) => d.dispose());
  }
}
