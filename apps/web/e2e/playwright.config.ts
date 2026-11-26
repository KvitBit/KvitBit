import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.KVITBIT_WEB_E2E_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WEB_ROOT = resolve(import.meta.dirname, "..");

const CHROMIUM_EXECUTABLE = process.env.KVITBIT_CHROMIUM_PATH;

/**
 * Nightly Playwright E2E configuration for @kvitbit/web (ADR-0005 Tier 2).
 * Serves the static build with the demo API fixtures.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
    ...(CHROMIUM_EXECUTABLE ? { launchOptions: { executablePath: CHROMIUM_EXECUTABLE } } : {}),
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
      ...process.env,
      VITE_KVITBIT_DEMO: "0",
    },
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
