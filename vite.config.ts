import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    VitePWA({
      // 練習中に勝手に再読み込みしないよう、更新は利用者が選ぶ
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["icons/apple-touch-icon.png", "icons/icon.svg"],
      manifest: {
        name: "morse_one",
        short_name: "morse_one",
        description: "モールス符号（欧文）受信練習",
        lang: "ja",
        start_url: ".",
        scope: ".",
        display: "standalone",
        background_color: "#121212",
        theme_color: "#121212",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg}"],
      },
    }),
  ],
});
