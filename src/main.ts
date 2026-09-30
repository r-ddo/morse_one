import "./style.css";
import { loadCharStats, requestPersistence } from "./storage/db";
import { loadSettings } from "./storage/settings";
import type { CharStat } from "./training/stats";
import { App } from "./ui/app";

async function main(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app")!;
  void requestPersistence();
  const stats = await loadCharStats().catch((e): Map<string, CharStat> => {
    console.error("failed to load stats", e);
    return new Map();
  });
  new App(root, loadSettings(), stats).showHome();
}

void main();
