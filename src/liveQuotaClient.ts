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
    const connected = await this.discoverAndConnect();
    const intervalSec = vscode.workspace
      .getConfiguration('gravitypulse')
      .get<number>('pollingIntervalSeconds', 30);

    // If connected, poll at standard interval. If not connected yet, retry every 3.5 seconds
    this.startPolling(connected ? intervalSec * 1000 : 3500);
  }

  public async forceRefresh(): Promise<LiveQuotaSnapshot | null> {
    if (!this.port || !this.csrfToken) {
      await this.discoverAndConnect();
    }
    const res = await this.fetchQuota();
    if (!res) {
      // Retry discovery once more on failure
      this.port = 0;
      this.csrfToken = '';
      await this.discoverAndConnect();
      return this.fetchQuota();
    }
    return res;
  }

  private async discoverAndConnect(): Promise<boolean> {
    try {
      const isWin = process.platform === 'win32';
      const processes = await this.discoverLanguageServers(isWin);

      if (processes.length === 0) {
        return false;
      }

      for (const proc of processes) {
        const ports = await this.getListeningPorts(proc.pid, isWin);

        for (const p of ports) {
          const ok = await this.testPort(p, proc.csrfToken);
          if (ok) {
            this.port = p;
            this.csrfToken = proc.csrfToken;
            await this.fetchQuota();
            return true;
          }
        }
      }
    } catch {
      // Fallback
    }
    return false;
  }

  private async discoverLanguageServers(isWin: boolean): Promise<{ pid: number; csrfToken: string }[]> {
    const results: { pid: number; csrfToken: string }[] = [];
    const seenPids = new Set<number>();

    const addCandidate = (pid: number, cmdLine: string) => {
      if (!cmdLine || seenPids.has(pid)) {
        return;
      }
      const tokenMatch = cmdLine.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);
      if (tokenMatch) {
        seenPids.add(pid);
        results.push({ pid, csrfToken: tokenMatch[1] });
      }
    };

    if (isWin) {
      // 1. PowerShell CIM / WMI JSON query
      try {
        const psCmd = 'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like \'*language_server*\' -or $_.CommandLine -like \'*csrf_token*\' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"';
        const { stdout } = await execAsync(psCmd, { timeout: 4000 });
        const trimmed = stdout.trim();
        if (trimmed) {
          try {
            const parsed = JSON.parse(trimmed);
            const list = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of list) {
              const pid = Number(item.ProcessId || item.processId || 0);
              const cmd = String(item.CommandLine || item.commandLine || '');
              if (pid > 0 && cmd) {
                addCandidate(pid, cmd);
              }
            }
          } catch {
            // Regex fallback on raw output
            const matches = trimmed.matchAll(/"ProcessId":\s*(\d+).*?"CommandLine":\s*"(.*?)"/g);
            for (const m of matches) {
              addCandidate(parseInt(m[1], 10), m[2]);
            }
          }
        }
      } catch {
        // Fall through to WMIC
      }

      // 2. WMIC fallback
      if (results.length === 0) {
        try {
          const wmicCmd = 'wmic process where "name like \'%language_server%\' or commandline like \'%csrf_token%\'" get ProcessId,CommandLine /format:csv';
          const { stdout } = await execAsync(wmicCmd, { timeout: 4000 });
          const lines = stdout.split('\n');
          for (const line of lines) {
            const parts = line.split(',');
            if (parts.length >= 3) {
              const cmd = parts[1];
              const pid = parseInt(parts[2]?.trim(), 10);
              if (pid > 0 && cmd) {
                addCandidate(pid, cmd);
              }
            }
          }
        } catch {
          // Ignore
        }
      }
    } else {
      // Linux / macOS: ps / pgrep
      try {
        const cmd = 'ps -eo pid,command 2>/dev/null || ps aux 2>/dev/null || pgrep -af language_server 2>/dev/null';
        const { stdout } = await execAsync(cmd, { timeout: 3000 });
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.includes('language_server') || line.includes('--csrf_token')) {
            const pidMatch = line.trim().match(/^(\d+)\s+(.+)$/);
            if (pidMatch) {
              addCandidate(parseInt(pidMatch[1], 10), pidMatch[2]);
            }
          }
        }
      } catch {
        // Ignore
      }
    }

    return results;
  }

  private async getListeningPorts(pid: number, isWin: boolean): Promise<number[]> {
    const ports: number[] = [];
    const allLocalPorts: number[] = [];

    try {
      if (isWin) {
        // 1. Fast netstat -ano -p tcp on Windows
        const { stdout } = await execAsync('netstat -ano -p tcp', { timeout: 3000 }).catch(() => ({ stdout: '' }));
        const lines = stdout.split('\n');
        for (const line of lines) {
          // Format: TCP    127.0.0.1:46583    0.0.0.0:0    LISTENING    12345
          const match = line.match(/^\s*TCP\s+(?:127\.0\.0\.1|0\.0\.0\.0|\[::1\]|\[::\]):(\d+)\s+.*?LISTENING\s+(\d+)/i);
          if (match) {
            const portNum = parseInt(match[1], 10);
            const linePid = parseInt(match[2], 10);
            if (portNum > 0) {
              if (!allLocalPorts.includes(portNum)) {
                allLocalPorts.push(portNum);
              }
              if (linePid === pid && !ports.includes(portNum)) {
                ports.push(portNum);
              }
            }
          }
        }

        // 2. PowerShell Get-NetTCPConnection fallback if no specific ports found for PID
        if (ports.length === 0 && pid > 0) {
          const psPortCmd = `powershell -NoProfile -NonInteractive -Command "Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object -ExpandProperty LocalPort"`;
          const { stdout: psOut } = await execAsync(psPortCmd, { timeout: 3000 }).catch(() => ({ stdout: '' }));
          psOut.split('\n').forEach((l) => {
            const num = parseInt(l.trim(), 10);
            if (num > 0 && !ports.includes(num)) {
              ports.push(num);
            }
          });
        }
      } else {
        const pidFilter = pid > 0 ? `grep "pid=${pid}"` : 'grep "language_server"';
        const { stdout } = await execAsync(
          `ss -tlnp 2>/dev/null | ${pidFilter} || lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null || netstat -tlnp 2>/dev/null`
        ).catch(() => ({ stdout: '' }));
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

    // Return specific PID ports first, followed by other active local listening ports as fallback
    const combined = [...ports];
    for (const p of allLocalPorts) {
      if (!combined.includes(p)) {
        combined.push(p);
      }
    }
    return combined;
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
      const ok = await this.discoverAndConnect();
      if (!ok) {
        return null;
      }
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
            this.port = 0;
            this.csrfToken = '';
            resolve(null);
          });
        }
      );

      req.on('error', () => {
        this.port = 0;
        this.csrfToken = '';
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy();
        this.port = 0;
        this.csrfToken = '';
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

  private currentPollingInterval: number = 0;

  public startPolling(intervalMs: number): void {
    this.stopPolling();
    this.currentPollingInterval = intervalMs;
    this.pollingTimer = setInterval(async () => {
      if (!this.isDisposed) {
        const snap = await this.fetchQuota();
        if (snap) {
          const standardSec = vscode.workspace
            .getConfiguration('gravitypulse')
            .get<number>('pollingIntervalSeconds', 30);
          const standardMs = standardSec * 1000;
          if (this.currentPollingInterval !== standardMs) {
            this.startPolling(standardMs);
          }
        }
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
