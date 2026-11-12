/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { existsSync } from "node:fs";

// npm workspaces hoist dependencies to the repository root
const monaco = [path.resolve(__dirname, "node_modules/monaco-editor"), path.resolve(__dirname, "../node_modules/monaco-editor")].find(existsSync)!;

// One public origin in every mode: this dev server owns the public port and forwards API requests to the backend's
// internal port. `changeOrigin: false` keeps the browser's Host header, which the backend records as its public URL.
const PORT = Number(process.env.OCTOPUS_PORT ?? 8000);
const API = process.env.OCTOPUS_API ?? `http://127.0.0.1:${PORT + 1}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "monaco-workers": path.join(monaco, "esm/vs"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: PORT,
    strictPort: true,
    proxy: {
      "/api": { target: API, changeOrigin: false },
      "/ws": { target: API.replace("http", "ws"), changeOrigin: false, ws: true },
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
