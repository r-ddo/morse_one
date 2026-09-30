import { GROUP_LEN } from "./groupDrill";

/** count 組の 5 字グループを作る。pick は直前の文字を受け取って次の文字を返す */
export function makeGroups(count: number, pick: (prev: string | undefined) => string): string[] {
  const groups: string[] = [];
  let prev: string | undefined;
  for (let g = 0; g < count; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LEN; i++) {
      prev = pick(prev);
      group += prev;
    }
    groups.push(group);
  }
  return groups;
}
