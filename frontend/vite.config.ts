/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const API = process.env.OCTOPUS_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "monaco-workers": path.resolve(__dirname, "node_modules/monaco-editor/esm/vs"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API, changeOrigin: true },
      "/ws": { target: API.replace("http", "ws"), ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ["monaco-editor"],
          flow: ["@xyflow/react", "@dagrejs/dagre"],
          md: ["react-markdown", "remark-gfm", "rehype-highlight", "highlight.js"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    css: false,
  },
});
