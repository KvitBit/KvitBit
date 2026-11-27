import { defineConfig, devices } from "@playwright/test";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

const port = Effect.runSync(Config.Int("KVITBIT_WEB_E2E_PORT").pipe(Config.withDefault(4173)));
const BASE_URL = `http://127.0.0.1:${port}`;
const paths = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));
const WEB_ROOT = paths.resolve(import.meta.dirname, "..");

const chromiumExecutable = Effect.runSync(
  Config.String("KVITBIT_CHROMIUM_PATH").pipe(Config.withDefault("")),
);
const ci = Effect.runSync(Config.String("CI").pipe(Config.withDefault(""))) !== "";

/**
 * Nightly Playwright E2E configuration for @kvitbit/web (ADR-0005 Tier 2).
 * Serves the static build with the demo API fixtures.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  workers: 1,
  forbidOnly: ci,
  retries: ci ? 2 : 0,
  reporter: ci ? [["github"], ["list"]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    launchOptions: chromiumExecutable === "" ? {} : { executablePath: chromiumExecutable },
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: "mobile",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: "bun run build && bun e2e/server.ts",
    cwd: WEB_ROOT,
    env: {
      VITE_KVITBIT_DEMO: "0",
    },
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
