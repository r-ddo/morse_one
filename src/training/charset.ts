export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const DIGITS = "0123456789";
export const SYMBOLS = "./?,-()";

export type CharsetId = "letters" | "alnum" | "all";

export const CHARSET_LABELS: Record<CharsetId, string> = {
  letters: "英字",
  alnum: "英字＋数字",
  all: "英字＋数字＋記号",
};

export function charsetChars(id: CharsetId): string[] {
  switch (id) {
    case "letters":
      return [...LETTERS];
    case "alnum":
      return [...LETTERS, ...DIGITS];
    case "all":
      return [...LETTERS, ...DIGITS, ...SYMBOLS];
  }
}
