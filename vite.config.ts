import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { WebSocketServer } from 'ws';

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: true,
  },
  // 3. Configure explicit WebSocket server for HMR
  webSocketServer: {
    plugin: WebSocketServer,
    options: {
      port: 1420,
      host: "localhost",
    },
  },
  // 4. tell vite to ignore watching `src-tauri`
  watch: {
    ignored: ["**/src-tauri/**"],
  },
}));
