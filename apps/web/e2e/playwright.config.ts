import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const WEB_ROOT = resolve(import.meta.dirname, "..");

const CHROMIUM_EXECUTABLE = process.env.KVITBIT_CHROMIUM_PATH;

/**
 * Nightly Playwright E2E configuration for @kvitbit/web (ADR-0005 Tier 2).
 * Boots Vite in demo mode (`VITE_KVITBIT_DEMO=1`) so no external API server is required.
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
    command: `bun run dev -- --port ${PORT} --strictPort --host 127.0.0.1`,
    cwd: WEB_ROOT,
    env: {
      ...process.env,
      VITE_KVITBIT_DEMO: "1",
    },
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
