import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { loadCharStats, loadConfusions, requestPersistence } from "./storage/db";
import { loadSettings } from "./storage/settings";
import { ConfusionTracker } from "./training/confusion";
import type { CharStat } from "./training/stats";
import { App } from "./ui/app";
import { showBanner } from "./ui/updateBanner";

function setupOffline(): void {
  const updateSW = registerSW({
    onNeedRefresh() {
      showBanner("新しいバージョンがあります", { label: "更新", onClick: () => void updateSW(true) });
    },
    onOfflineReady() {
      showBanner("オフラインでも使えるようになりました");
    },
  });
}

async function main(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app")!;
  void requestPersistence();
  setupOffline();
  const stats = await loadCharStats().catch((e): Map<string, CharStat> => {
    console.error("failed to load stats", e);
    return new Map();
  });
  const confusions = await loadConfusions().catch((e) => {
    console.error("failed to load confusions", e);
    return new ConfusionTracker();
  });
  new App(root, loadSettings(), stats, confusions).showHome();
}

void main();
