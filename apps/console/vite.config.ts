import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const PORT = Number(process.env.PORT) || 8090;

export default defineConfig({
  server: { host: process.env.HOST || "127.0.0.1", port: PORT, strictPort: true },
  preview: { host: "127.0.0.1", port: PORT + 1, strictPort: true },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  plugins: [tailwindcss(), react()],
  build: {
    target: "es2022",
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: (id) => (id.includes("lightweight-charts") ? "charts" : undefined),
      },
    },
  },
});
