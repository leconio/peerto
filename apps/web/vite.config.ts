import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: [
        "peerto-icon.svg",
        "peerto-180.png",
        "peerto-192.png",
        "peerto-512.png",
      ],
      manifest: {
        name: "Peerto",
        short_name: "Peerto",
        description: "Private peer-to-peer messages and file transfers",
        id: "/",
        start_url: "/",
        scope: "/",
        display: "standalone",
        display_override: ["standalone", "minimal-ui"],
        background_color: "#f5f7f8",
        theme_color: "#138a75",
        categories: ["social", "utilities"],
        icons: [
          {
            src: "/peerto-192.png",
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: "/peerto-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        cleanupOutdatedCaches: true,
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        // Preserve browser Host/Origin for the server's same-origin check.
        changeOrigin: false,
      },
      "/ws": {
        target: "ws://127.0.0.1:3000",
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
