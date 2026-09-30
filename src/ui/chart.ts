import { h } from "./dom";

export interface Point {
  label: string;
  value: number | null;
}

export interface ChartOptions {
  title: string;
  /** 値の表示（読み取り欄・表） */
  format: (v: number) => string;
  /** 縦軸の目盛りの表示。単位はタイトルに書き、ここは数字だけにする（既定: 整数） */
  axisFormat?: (v: number) => string;
  kind: "column" | "line";
  /** 値がないときの読み取り欄の表示 */
  empty?: string;
}

const SVG = "http://www.w3.org/2000/svg";
const W = 360;
const H = 150;
const PAD = { top: 10, right: 8, bottom: 22, left: 34 };
const BAR_MAX = 24;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** 0 から始まるきりのよい目盛りの上限 */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const step = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (max <= m * step) return m * step;
  return 10 * step;
}

/** 1 系列の縦棒・折れ線グラフ。タップ（ホバー）した点の値を上に表示し、表でも見られる */
export function chart(points: Point[], opts: ChartOptions): HTMLElement {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  const top = niceMax(Math.max(0, ...values));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const band = plotW / points.length;
  const x = (i: number) => PAD.left + band * (i + 0.5);
  const y = (v: number) => PAD.top + plotH * (1 - v / top);

  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": opts.title });

  // 目盛り線と軸の値
  for (const t of [0, top / 2, top]) {
    root.append(svg("line", { x1: PAD.left, x2: W - PAD.right, y1: y(t), y2: y(t), class: "chart-grid" }));
    const label = svg("text", { x: PAD.left - 6, y: y(t) + 4, class: "chart-axis", "text-anchor": "end" });
    label.textContent = (opts.axisFormat ?? ((v: number) => String(Math.round(v))))(t);
    root.append(label);
  }
  // 横軸は最初・中央・最後の日付だけ
  for (const i of new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])) {
    const label = svg("text", { x: x(i), y: H - 6, class: "chart-axis", "text-anchor": "middle" });
    label.textContent = points[i].label;
    root.append(label);
  }

  const marks: SVGElement[] = [];
  if (opts.kind === "column") {
    const bw = Math.min(BAR_MAX, band - 2);
    points.forEach((p, i) => {
      if (!p.value) return marks.push(svg("g", {}));
      const x0 = x(i) - bw / 2;
      const y0 = y(p.value);
      const r = Math.min(4, bw / 2, y(0) - y0);
      // 上端だけ角丸、基線側は四角
      const d = `M${x0},${y(0)} V${y0 + r} Q${x0},${y0} ${x0 + r},${y0} H${x0 + bw - r} Q${x0 + bw},${y0} ${x0 + bw},${y0 + r} V${y(0)} Z`;
      const bar = svg("path", { d, class: "chart-mark" });
      root.append(bar);
      marks.push(bar);
    });
  } else {
    // 値のない日は線をつながない
    let path = "";
    points.forEach((p, i) => {
      if (p.value === null) return;
      const prev = points[i - 1];
      path += `${prev && prev.value !== null ? "L" : "M"}${x(i)},${y(p.value)} `;
    });
    root.append(svg("path", { d: path, class: "chart-line" }));
    points.forEach((p, i) => {
      if (p.value === null) return marks.push(svg("g", {}));
      const dot = svg("circle", { cx: x(i), cy: y(p.value), r: 4, class: "chart-dot" });
      root.append(dot);
      marks.push(dot);
    });
  }

  const crosshair = svg("line", { x1: 0, x2: 0, y1: PAD.top, y2: y(0), class: "chart-crosshair", visibility: "hidden" });
  root.append(crosshair);

  const readout = h("div", { class: "chart-readout" });
  const latest = [...points.keys()].reverse().find((i) => points[i].value !== null);
  const show = (i: number | undefined, active: boolean) => {
    marks.forEach((m, j) => m.classList.toggle("active", active && j === i));
    crosshair.setAttribute("visibility", active && i !== undefined ? "visible" : "hidden");
    if (i === undefined) {
      readout.textContent = opts.empty ?? "記録なし";
      return;
    }
    crosshair.setAttribute("x1", String(x(i)));
    crosshair.setAttribute("x2", String(x(i)));
    const v = points[i].value;
    readout.textContent = `${points[i].label}　${v === null ? "記録なし" : opts.format(v)}`;
  };
  const indexAt = (e: PointerEvent) => {
    const rect = root.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    return Math.max(0, Math.min(points.length - 1, Math.floor((px - PAD.left) / band)));
  };
  root.addEventListener("pointermove", (e) => show(indexAt(e), true));
  root.addEventListener("pointerdown", (e) => show(indexAt(e), true));
  root.addEventListener("pointerleave", () => show(latest, false));
  show(latest, false);

  const table = h("details", { class: "chart-table" },
    h("summary", {}, "表で見る"),
    h("table", { class: "stats" },
      h("tbody", {}, ...points.map((p) => h("tr", {},
        h("td", {}, p.label),
        h("td", {}, p.value === null ? "―" : opts.format(p.value)),
      ))),
    ),
  );

  return h("section", { class: "chart-card" },
    h("div", { class: "chart-head" }, h("h2", {}, opts.title), readout),
    root,
    table,
  );
}
