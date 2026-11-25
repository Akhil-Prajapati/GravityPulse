import * as vscode from 'vscode';
import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { LiveQuotaSnapshot, PromptCreditsInfo, QuotaGroup, QuotaGroupBucket } from './types';
import { DaemonHubEntry, parseClientModelConfigs, parseDaemonHubJson } from './modelUtils';

const execAsync = promisify(exec);

export class LiveQuotaClient implements vscode.Disposable {
  private port: number = 0;
  private csrfToken: string = '';
  private useHttps: boolean = true;
  private pollingTimer: NodeJS.Timeout | null = null;
  private isDisposed = false;
  private disposables: vscode.Disposable[] = [];

  private readonly _onDidChangeSnapshot = new vscode.EventEmitter<LiveQuotaSnapshot>();
  public readonly onDidChangeSnapshot = this._onDidChangeSnapshot.event;

  private lastSnapshot: LiveQuotaSnapshot | null = null;
  private lastQuotaGroups: QuotaGroup[] = [];

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
      this.useHttps = true;
      await this.discoverAndConnect();
      return this.fetchQuota();
    }
    return res;
  }

  private async discoverAndConnect(): Promise<boolean> {
    try {
      // 1. Check direct environment variables if present
      const envAddress = process.env.ANTIGRAVITY_LS_ADDRESS;
      const envToken = process.env.ANTIGRAVITY_CSRF_TOKEN;
      if (envAddress && envToken) {
        const portPart = parseInt(envAddress.split(':').pop() || '', 10);
        if (portPart > 0) {
          for (const useHttps of [false, true]) {
            if (await this.testPort(portPart, envToken, useHttps)) {
              this.port = portPart;
              this.csrfToken = envToken;
              this.useHttps = useHttps;
              await this.fetchQuota();
              return true;
            }
          }
        }
      }

      // 2. Discover Antigravity 2.0 / agy --hub daemon discovery files (~/.gemini/antigravity/daemon/hub_*.json)
      const daemonEntries = this.discoverDaemonHubEntries();
      for (const entry of daemonEntries) {
        const endpoints: Array<{ port: number; useHttps: boolean }> = [];
        if (entry.httpsPort > 0) {
          endpoints.push({ port: entry.httpsPort, useHttps: true });
        }
        if (entry.httpPort > 0) {
          endpoints.push({ port: entry.httpPort, useHttps: false });
        }

        for (const ep of endpoints) {
          if (await this.testPort(ep.port, entry.csrfToken, ep.useHttps)) {
            this.port = ep.port;
            this.csrfToken = entry.csrfToken;
            this.useHttps = ep.useHttps;
            await this.fetchQuota();
            return true;
          }
        }
      }

      // 3. Legacy fallback: process inspection for language_server / --csrf_token
      const isWin = process.platform === 'win32';
      const processes = await this.discoverLanguageServers(isWin);

      if (processes.length === 0) {
        return false;
      }

      for (const proc of processes) {
        const ports = await this.getListeningPorts(proc.pid, isWin);

        for (const p of ports) {
          for (const useHttps of [true, false]) {
            if (await this.testPort(p, proc.csrfToken, useHttps)) {
              this.port = p;
              this.csrfToken = proc.csrfToken;
              this.useHttps = useHttps;
              await this.fetchQuota();
              return true;
            }
          }
        }
      }
    } catch {
      // Fallback
    }
    return false;
  }

  private isProcessAlive(pid: number): boolean {
    if (!pid || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // EPERM means process exists without signal permission; ESRCH means dead
      return err?.code === 'EPERM';
    }
  }

  private discoverDaemonHubEntries(): DaemonHubEntry[] {
    const home = os.homedir();
    const daemonDirs = [
      path.join(home, '.gemini', 'antigravity', 'daemon'),
      path.join(home, '.gemini', 'antigravity-ide', 'daemon')
    ];

    const entries: DaemonHubEntry[] = [];
    for (const dir of daemonDirs) {
      try {
        if (!fs.existsSync(dir)) {
          continue;
        }
        const files = fs.readdirSync(dir);
        for (const file of files) {
          if (!file.endsWith('.json')) {
            continue;
          }
          const fullPath = path.join(dir, file);
          try {
            const stat = fs.statSync(fullPath);
            const raw = fs.readFileSync(fullPath, 'utf8');
            const parsed = parseDaemonHubJson(raw, fullPath, stat.mtimeMs);
            if (!parsed) {
              continue;
            }
            if (parsed.pid > 0 && !this.isProcessAlive(parsed.pid)) {
              continue;
            }
            entries.push(parsed);
          } catch {
            // Skip unreadable/stale file
          }
        }
      } catch {
        // Ignore missing directory
      }
    }

    // Prefer most recently started hub
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries;
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

  private sendRpcRequest<T = any>(
    port: number,
    token: string,
    useHttps: boolean,
    rpcPath: string,
    payload: any,
    timeoutMs: number
  ): Promise<{ statusCode?: number; data: T | null }> {
    return new Promise((resolve) => {
      const postData = JSON.stringify(payload);
      const transport = useHttps ? https : http;
      const options: https.RequestOptions = {
        hostname: '127.0.0.1',
        port,
        path: rpcPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': token,
          'x-antigravity-csrf-token': token,
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: timeoutMs
      };
      if (useHttps) {
        options.rejectUnauthorized = false;
      }

      const req = transport.request(options, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve({ statusCode: res.statusCode, data: JSON.parse(body) as T });
              return;
            } catch {
              // Ignore parse error
            }
          }
          resolve({ statusCode: res.statusCode, data: null });
        });
      });

      req.on('error', () => resolve({ data: null }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ data: null });
      });
      req.write(postData);
      req.end();
    });
  }

  private async testPort(port: number, token: string, useHttps: boolean = true): Promise<boolean> {
    const res = await this.sendRpcRequest<any>(
      port,
      token,
      useHttps,
      '/exa.language_server_pb.LanguageServerService/GetUserStatus',
      {
        metadata: {
          ideName: 'antigravity',
          extensionName: 'antigravity',
          locale: 'en'
        }
      },
      4000
    );
    return Boolean(res.statusCode === 200 && res.data?.userStatus);
  }

  private async makeRpcRequest<T = any>(rpcPath: string, payload: any): Promise<T | null> {
    if (!this.port || !this.csrfToken) {
      return null;
    }
    const res = await this.sendRpcRequest<T>(this.port, this.csrfToken, this.useHttps, rpcPath, payload, 5000);
    return res.data;
  }

  public async fetchQuota(): Promise<LiveQuotaSnapshot | null> {
    if (!this.port || !this.csrfToken) {
      const ok = await this.discoverAndConnect();
      if (!ok) {
        return null;
      }
    }

    const payload = {
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
        locale: 'en'
      }
    };

    // Query both GetUserStatus and RetrieveUserQuotaSummary concurrently
    const [userStatusRaw, quotaSummaryRaw] = await Promise.all([
      this.makeRpcRequest('/exa.language_server_pb.LanguageServerService/GetUserStatus', payload),
      this.makeRpcRequest('/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary', payload).catch(() => null)
    ]);

    if (!userStatusRaw) {
      this.port = 0;
      this.csrfToken = '';
      this.useHttps = true;
      return null;
    }

    const snapshot = this.parseResponse(userStatusRaw, quotaSummaryRaw);
    this.lastSnapshot = snapshot;
    this._onDidChangeSnapshot.fire(snapshot);
    return snapshot;
  }

  private parseResponse(userData: any, quotaSummaryData?: any): LiveQuotaSnapshot {
    const userStatus = userData?.userStatus || {};
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

    const now = new Date();

    // Parse Quota Groups from RetrieveUserQuotaSummary
    const rawGroups = quotaSummaryData?.response?.groups || [];
    const quotaGroups: QuotaGroup[] = [];
    for (const g of rawGroups) {
      const buckets: QuotaGroupBucket[] = [];
      for (const b of g.buckets || []) {
        const remFrac = b.remainingFraction !== undefined ? Number(b.remainingFraction) : 0.0;
        const bResetStr = b.resetTime || b.reset_time;
        const bResetTime = bResetStr ? new Date(bResetStr) : new Date(0);
        const bDiffMs = bResetTime.getTime() - now.getTime();
        buckets.push({
          bucketId: b.bucketId || b.bucket_id || '',
          displayName: b.displayName || b.display_name || '',
          description: b.description || '',
          window: b.window || '',
          remainingFraction: remFrac,
          remainingPercentage: remFrac * 100,
          resetTime: bResetTime,
          timeUntilResetFormatted: this.formatTimeDiff(bDiffMs, bResetTime)
        });
      }
      quotaGroups.push({
        displayName: g.displayName || g.display_name || '',
        description: g.description || '',
        buckets
      });
    }

    if (quotaGroups.length > 0) {
      this.lastQuotaGroups = quotaGroups;
    } else if (this.lastQuotaGroups.length > 0) {
      // Retain previously cached groups to avoid weekly quota dropping to null on temporary RPC timeout
      quotaGroups.push(...this.lastQuotaGroups);
    }

    const rawModels = userStatus.cascadeModelConfigData?.clientModelConfigs || [];
    const models = parseClientModelConfigs(
      rawModels,
      quotaGroups,
      (ms, rt) => this.formatTimeDiff(ms, rt),
      now
    );

    return {
      timestamp: new Date(),
      models,
      promptCredits,
      quotaGroups
    };
  }

  public formatTimeDiff(ms: number, resetTime: Date): string {
    if (ms <= 0) {
      return 'Auto-Refilled / Full';
    }
    const totalMinutes = Math.ceil(ms / 60000);
    const days = Math.floor(totalMinutes / (24 * 60));
    const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
    const mins = totalMinutes % 60;

    let duration = '';
    if (days > 0) {
      if (hours > 0) {
        duration = `${days}d ${hours}h`;
      } else {
        duration = `${days}d`;
      }
    } else if (hours > 0) {
      if (mins > 0) {
        duration = `${hours}h ${mins}m`;
      } else {
        duration = `${hours}h`;
      }
    } else {
      duration = `${mins}m`;
    }

    const isDifferentDay = resetTime.toDateString() !== new Date().toDateString();
    const timeStr = isDifferentDay
      ? resetTime.toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        })
      : resetTime.toLocaleTimeString(undefined, {
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
