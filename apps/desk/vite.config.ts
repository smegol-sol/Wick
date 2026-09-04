import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

const PORT = Number(process.env.PORT) || 8080;

export default defineConfig(({ command, isPreview }) => ({
  server: {
    host: process.env.HOST || "127.0.0.1",
    port: PORT,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: PORT + 1,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [nitro({ preset: process.env.NITRO_PRESET || "vercel" })]
      : []),
    viteReact(),
  ],
}));
