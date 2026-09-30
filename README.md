# morse_one

iPhone 向けモールス符号（欧文）受信練習 PWA。計画は [docs/PLAN.md](docs/PLAN.md) を参照。

## 開発

```sh
npm install
npm run dev      # 同じ Wi-Fi の iPhone から表示された Network URL で確認
npm run build
npm test         # 単体テスト
```

## 公開

`main` ブランチに push すると GitHub Actions で GitHub Pages にデプロイされる
（リポジトリの Settings → Pages → Source を「GitHub Actions」に設定）。
