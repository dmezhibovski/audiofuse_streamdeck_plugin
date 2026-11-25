import streamDeck, {
  action,
  KeyDownEvent,
  SingletonAction,
  WillAppearEvent,
} from "@elgato/streamdeck";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { AnalogInputState, audioFuse, MonitoringState } from "./audiofuse-client.js";

streamDeck.logger.setLevel("debug");
const logger = streamDeck.logger.createScope("Plugin");

// Start Bonjour service discovery once when the plugin starts
audioFuse.start();

@action({ UUID: "com.daniel-mezhibovski.audiofuse-controller.mute" })
export class ToggleMuteAction extends SingletonAction {
  private unsubscribe: (() => void) | null = null;
  private unsubscribeConnect: (() => void) | null = null;

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!ev.action.isKey()) return;

    this.unsubscribeConnect = audioFuse.onConnect(async () => {
      try {
        const { monitoring } = await audioFuse.get<{ monitoring: MonitoringState }>("/monitoring");
        logger.info("Mute initial state fetched", monitoring);
        if (ev.action.isKey()) {
          await ev.action.setState(monitoring.mute ? 1 : 0);
        }
      } catch (err) {
        logger.warn("Mute initial fetch failed", err);
      }
    });

    this.unsubscribe = audioFuse.subscribe<boolean>("/monitoring/mute", async (isMuted) => {
      logger.info(`Mute SSE state update: ${isMuted}`);
      if (ev.action.isKey()) {
        await ev.action.setState(isMuted ? 1 : 0);
      }
    });
  }

  override onWillDisappear(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeConnect?.();
    this.unsubscribeConnect = null;
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try {
      const { monitoring } = await audioFuse.get<{ monitoring: MonitoringState }>("/monitoring");
      logger.info(`Toggling mute to ${!monitoring.mute}`);
      await audioFuse.put("/monitoring", { mute: !monitoring.mute });
    } catch (err) {
      logger.error("ToggleMute onKeyDown failed", err);
      await ev.action.showAlert();
    }
  }
}

@action({ UUID: "com.daniel-mezhibovski.audiofuse-controller.phantom1" })
export class TogglePhantom2Action extends SingletonAction {
  private unsubscribe: (() => void) | null = null;
  private unsubscribeConnect: (() => void) | null = null;

  override async onWillAppear(ev: WillAppearEvent): Promise<void> {
    if (!ev.action.isKey()) return;

    this.unsubscribeConnect = audioFuse.onConnect(async () => {
      try {
        const data = await audioFuse.get<AnalogInputState | Record<"2", AnalogInputState>>(
          "/input/analog/2"
        );
        logger.info("Phantom Input 2 initial state fetched", data);
        const state = "2" in data ? data["2"] : data;
        if (ev.action.isKey()) {
          await ev.action.setState(state["48v"] ? 1 : 0);
        }
      } catch (err) {
        logger.warn("Phantom initial fetch failed", err);
      }
    });

    this.unsubscribe = audioFuse.subscribe<boolean>("/input/analog/2/48v", async (isOn) => {
      logger.info(`Phantom Input 2 SSE state update: ${isOn}`);
      if (ev.action.isKey()) {
        await ev.action.setState(isOn ? 1 : 0);
      }
    });
  }

  override onWillDisappear(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeConnect?.();
    this.unsubscribeConnect = null;
  }

  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try {
      const data = await audioFuse.get<AnalogInputState | Record<"2", AnalogInputState>>(
        "/input/analog/2"
      );
      const state = "2" in data ? data["2"] : data;
      logger.info(`Toggling Phantom Input 2 to ${!state["48v"]}`);
      await audioFuse.put("/input/analog/2", { "48v": !state["48v"] });
    } catch (err) {
      logger.error("TogglePhantom onKeyDown failed", err);
      // Shows yellow warning triangle if no XLR mic is connected (403 Invalid Request)
      await ev.action.showAlert();
    }
  }
}

const WIN_AFCC_PATHS = [
  "C:\\Program Files (x86)\\Arturia\\AudioFuse Control Center\\AudioFuse Control Center.exe",
  "C:\\Program Files\\Arturia\\AudioFuse Control Center\\AudioFuse Control Center.exe",
];

@action({ UUID: "com.daniel-mezhibovski.audiofuse-controller.open-acc" })
export class OpenACCAction extends SingletonAction {
  override async onKeyDown(ev: KeyDownEvent): Promise<void> {
    try {
      if (process.platform === "win32") {
        const exePath = WIN_AFCC_PATHS.find((p) => existsSync(p));
        if (!exePath) {
          throw new Error("AudioFuse Control Center executable not found");
        }
        logger.info(`Launching AudioFuse Control Center: ${exePath}`);
        const child = spawn(exePath, [], { detached: true, stdio: "ignore" });
        child.unref();
      } else if (process.platform === "darwin") {
        logger.info("Launching AudioFuse Control Center (macOS)");
        const child = spawn("open", ["-a", "AudioFuse Control Center"], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      } else {
        throw new Error(`Unsupported platform: ${process.platform}`);
      }
    } catch (err) {
      logger.error("OpenACC onKeyDown failed", err);
      await ev.action.showAlert();
    }
  }
}


streamDeck.actions.registerAction(new ToggleMuteAction());
streamDeck.actions.registerAction(new TogglePhantom2Action());
streamDeck.actions.registerAction(new OpenACCAction());
streamDeck.connect();