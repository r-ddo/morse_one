interface WakeLockSentinelLike {
  release(): Promise<void>;
}

interface WakeLockNavigator {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> };
}

/** 長い再生の間、画面が消えないようにする。非対応なら何もしない。解除する関数を返す */
export async function keepScreenOn(): Promise<() => void> {
  try {
    const sentinel = await (navigator as WakeLockNavigator).wakeLock?.request("screen");
    return () => void sentinel?.release().catch(() => {});
  } catch {
    return () => {};
  }
}
