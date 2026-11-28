import { brandColors } from "@kvitbit/brand";
import * as EffectArray from "effect/Array";

/** Path the server mounts the web export at (app.json `experiments.baseUrl` plus a slash). */
export const APP_BASE = "/app/";

/** Icons copied from repo `assets/brand/web` into `dist/icons`. `file` is the source and target name. */
export const pwaIcons: ReadonlyArray<{
  readonly file: string;
  readonly size: number;
  readonly purpose: "any" | "maskable";
}> = [
  { file: "icon-192.png", size: 192, purpose: "any" },
  { file: "icon-512.png", size: 512, purpose: "any" },
  { file: "maskable-512.png", size: 512, purpose: "maskable" },
];

/** Linked from index.html for iOS home-screen installs; copied next to the manifest icons. */
export const appleTouchIcon = "apple-touch-icon.png";

/** Same colours as app.json `web.themeColor` / `web.backgroundColor`. */
export const pwaColors = {
  theme: brandColors.inkOnLight,
  background: brandColors.splashBackground,
} as const;

/** The installed app's identity: everything lives on `/app/`. */
export const pwaManifest = () => ({
  id: APP_BASE,
  name: "Kvitbit",
  short_name: "Kvitbit",
  start_url: APP_BASE,
  scope: APP_BASE,
  display: "standalone",
  theme_color: pwaColors.theme,
  background_color: pwaColors.background,
  icons: EffectArray.map(pwaIcons, (icon) => ({
    src: `${APP_BASE}icons/${icon.file}`,
    sizes: `${icon.size}x${icon.size}`,
    type: "image/png" as const,
    purpose: icon.purpose,
  })),
});
