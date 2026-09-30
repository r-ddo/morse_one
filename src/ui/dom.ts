type Child = Node | string | null | undefined | false;

/** 小さな DOM 生成ヘルパー */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<Omit<HTMLElementTagNameMap[K], "style" | "dataset">> & {
    class?: string;
    dataset?: Record<string, string>;
  } = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: className, dataset, ...rest } = props;
  if (className) el.className = className;
  if (dataset) Object.assign(el.dataset, dataset);
  Object.assign(el, rest);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c);
  }
  return el;
}

/** 符号を表示用の記号に変換する（例: ".-" → "·−"） */
export function prettyCode(code: string | undefined): string {
  return (code ?? "").replaceAll(".", "·").replaceAll("-", "−");
}
