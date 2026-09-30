import "./style.css";
import { loadCharStats, loadConfusions, requestPersistence } from "./storage/db";
import { loadSettings } from "./storage/settings";
import { ConfusionTracker } from "./training/confusion";
import type { CharStat } from "./training/stats";
import { App } from "./ui/app";

async function main(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app")!;
  void requestPersistence();
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
