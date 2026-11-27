// Vite provides native synchronous filesystem hooks to build-config plugins.
// @effect-diagnostics-next-line nodeBuiltinImport:off The Vite middleware reads assets synchronously on its Node host.
import { cpSync, existsSync, readFileSync, statSync } from "node:fs";
// Use native paths for the Vite host, including Windows.
// @effect-diagnostics-next-line nodeBuiltinImport:off Resolve host-native paths in Vite, including Windows paths.
import { extname, join, resolve } from "node:path";
import * as Str from "effect/String";
import { defineConfig, type Plugin } from "vite";

const brandRoot = resolve(import.meta.dirname, "../../assets/brand");

const MIME: Readonly<Record<string, string>> = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

/**
 * Serves `assets/brand/**` at `/assets/brand/**` in dev and copies it into `dist/assets/brand`
 * on build, so the committed brand files stay the single source (DESIGN.md "Web assets").
 */
const brandAssets = (): Plugin => ({
  name: "kvitbit-brand-assets",
  configureServer(server) {
    server.middlewares.use("/assets/brand", (req, res, next) => {
      const file = join(brandRoot, decodeURIComponent(Str.split(req.url ?? "/", "?")[0] ?? "/"));
      if (!(Str.startsWith(brandRoot)(file) && existsSync(file) && statSync(file).isFile())) {
        next();
        return;
      }
      res.setHeader("content-type", MIME[extname(file)] ?? "application/octet-stream");
      res.end(readFileSync(file));
    });
  },
  writeBundle(options) {
    const out = options.dir ?? resolve(import.meta.dirname, "dist");
    for (const dir of ["web", "lockup", "pattern"]) {
      cpSync(join(brandRoot, dir), join(out, "assets/brand", dir), { recursive: true });
    }
    for (const mark of ["kvitbit-mark-current-light.svg", "kvitbit-mark-current-dark.svg"]) {
      cpSync(join(brandRoot, mark), join(out, "assets/brand", mark));
    }
  },
});

export default defineConfig({
  plugins: [brandAssets()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8080", "/mcp": "http://localhost:8080" },
  },
});
