/** キャンバスを表示サイズに合わせ、描画用のコンテキストと色を返す */
export function prepareCanvas(canvas: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number; color: (name: string) => string } | null {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (w === 0 || h === 0) return null;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext("2d");
  if (!g) return null;
  g.clearRect(0, 0, w, h);
  const style = getComputedStyle(canvas);
  return { g, w, h, color: (name) => style.getPropertyValue(name).trim() };
}
