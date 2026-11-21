import streamDeck from "@elgato/streamdeck";
import Bonjour, { Service } from "bonjour-service";
import { EventSource } from "eventsource";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const logger = streamDeck.logger.createScope("AudioFuseClient");

type UpdateCallback<T = unknown> = (value: T) => void | Promise<void>;

interface SseChange {
  key: string;
  value: unknown;
}

interface SseUpdatePayload {
  payload: SseChange[];
}

export interface MonitoringState {
  mute: boolean;
  dim: boolean;
  volume: number;
  mono: boolean;
  ab_speaker_set: boolean;
}

export interface AnalogInputState {
  gain?: number;
  link?: boolean;
  phase_invert?: boolean;
  inst?: boolean;
  "48v"?: boolean;
}

function getLocalIpSet(): Set<string> {
  const ips = new Set<string>();
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries ?? []) {
      if (e.family === "IPv4" && !e.internal) {
        ips.add(e.address);
      }
    }
  }
  return ips;
}

class AudioFuseClient {
  private port: number | null = null;
  private es: EventSource | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private listeners = new Map<string, Set<UpdateCallback>>();
  private connectListeners = new Set<() => void | Promise<void>>();
  private bonjour = new Bonjour();
  private localIps = getLocalIpSet();

  public get baseUrl(): string | null {
    return this.port ? `http://127.0.0.1:${this.port}/api/v1` : null;
  }

  public start(): void {
    logger.info("Starting Bonjour discovery for audiofusehttp...", {
      localIps: [...this.localIps],
    });
    const browser = this.bonjour.find({ type: "audiofusehttp" }, (service: Service) => {
      const addrs = new Set(service.addresses ?? []);
      const isLocal = [...addrs].some((ip) => this.localIps.has(ip));
      logger.info("Found mDNS service", {
        name: service.name,
        port: service.port,
        addresses: service.addresses,
        isLocal,
      });
      if (!isLocal || !service.name?.includes("audiofusehttp")) return;

      this.setPort(service.port, "bonjour");
    });

    browser.on("down", (service: Service) => {
      if (service.port === this.port) {
        logger.warn(`AudioFuse service on port ${this.port} went down`);
        this.disconnectSse();
        this.port = null;
        this.startWindowsFallback();
      }
    });

    this.startWindowsFallback();
  }

  private setPort(port: number, source: "bonjour" | "windows-fallback"): void {
    if (this.port === port) return;
    this.port = port;
    if (this.fallbackTimer) {
      clearInterval(this.fallbackTimer);
      this.fallbackTimer = null;
    }
    logger.info(`Connected to AudioFuse HTTP API on port ${this.port} (${source})`);
    this.connectSse();
    for (const cb of this.connectListeners) {
      void cb();
    }
  }

  private startWindowsFallback(): void {
    if (process.platform !== "win32" || this.port !== null || this.fallbackTimer) return;

    void this.tryWindowsPortDiscovery();
    this.fallbackTimer = setInterval(() => {
      void this.tryWindowsPortDiscovery();
    }, 5000);
  }

  private async tryWindowsPortDiscovery(): Promise<void> {
    if (this.port !== null) return;
    try {
      const { stdout: taskOut } = await execFileAsync("tasklist", [
        "/FI",
        "IMAGENAME eq AudioFuseControlCenterAgent.exe",
        "/FO",
        "CSV",
        "/NH",
      ]);
      const pids = new Set<string>();
      for (const line of taskOut.split(/\r?\n/)) {
        const match = line.match(/"AudioFuseControlCenterAgent\.exe","(\d+)"/i);
        if (match) pids.add(match[1]);
      }
      if (pids.size === 0) return;

      const { stdout: netOut } = await execFileAsync("netstat", ["-ano", "-p", "TCP"]);
      for (const line of netOut.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        // Expected: TCP 127.0.0.1:<port> 0.0.0.0:0 LISTENING <pid>
        if (parts.length >= 5 && parts[3] === "LISTENING" && pids.has(parts[4])) {
          const addrMatch = parts[1].match(/^127\.0\.0\.1:(\d+)$/);
          if (!addrMatch) continue;
          const candidatePort = Number(addrMatch[1]);
          const res = await fetch(`http://127.0.0.1:${candidatePort}/api/v1/monitoring`);
          if (res.ok) {
            this.setPort(candidatePort, "windows-fallback");
            return;
          }
        }
      }
    } catch (err) {
      logger.debug("Windows fallback discovery attempt failed", err);
    }
  }

  public onConnect(callback: () => void | Promise<void>): () => void {
    this.connectListeners.add(callback);
    if (this.port !== null) {
      void callback();
    }
    return () => {
      this.connectListeners.delete(callback);
    };
  }

  public subscribe<T = unknown>(endpointPath: string, callback: UpdateCallback<T>): () => void {
    if (!this.listeners.has(endpointPath)) {
      this.listeners.set(endpointPath, new Set());
      void this.pushSubscriptions();
    }
    const typedCallback = callback as UpdateCallback;
    this.listeners.get(endpointPath)!.add(typedCallback);

    return () => {
      const set = this.listeners.get(endpointPath);
      if (set) {
        set.delete(typedCallback);
        if (set.size === 0) {
          this.listeners.delete(endpointPath);
        }
      }
    };
  }

  private async pushSubscriptions(): Promise<void> {
    if (!this.baseUrl || this.listeners.size === 0) return;
    try {
      await fetch(`${this.baseUrl}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoints: [...this.listeners.keys()] }),
      });
    } catch {
      // Handled automatically by SSE reconnect loop
    }
  }

  private connectSse(): void {
    this.disconnectSse();
    if (!this.baseUrl) return;

    logger.info(`Connecting SSE to ${this.baseUrl}/events`);
    void this.pushSubscriptions();
    this.es = new EventSource(`${this.baseUrl}/events`);

    this.es.addEventListener("update", (e: MessageEvent) => {
      logger.debug("SSE update received", e.data);
      const { payload } = JSON.parse(e.data as string) as SseUpdatePayload;
      for (const change of payload) {
        const callbacks = this.listeners.get(change.key);
        if (callbacks) {
          for (const cb of callbacks) {
            void cb(change.value);
          }
        }
      }
    });

    this.es.onerror = (err) => {
      logger.warn("SSE connection error, reconnecting in 2s...", err);
      this.disconnectSse();
      this.reconnectTimer = setTimeout(() => this.connectSse(), 2000);
    };

    // Refresh subscription every 40s (server expires inactive sets at ~50s)
    this.refreshTimer = setInterval(() => {
      void this.pushSubscriptions();
    }, 40_000);
  }

  private disconnectSse(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.refreshTimer = null;
    this.reconnectTimer = null;
    if (this.es) {
      this.es.close();
      this.es = null;
    }
  }

  public async get<T>(path: string): Promise<T> {
    if (!this.baseUrl) throw new Error("AudioFuse API not discovered");
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  public async put<T extends Record<string, unknown>>(parentPath: string, body: T): Promise<void> {
    if (!this.baseUrl) throw new Error("AudioFuse API not discovered");
    const res = await fetch(`${this.baseUrl}${parentPath}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`PUT ${parentPath} failed: ${res.status}`);
  }
}

export const audioFuse = new AudioFuseClient();