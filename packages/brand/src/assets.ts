/** Repo-relative paths of the committed brand files (DESIGN.md "Brand Identity"). */
export const brandAssets = {
  mark: {
    light: "assets/brand/kvitbit-mark-light.svg",
    black: "assets/brand/kvitbit-mark-black.svg",
    currentLight: "assets/brand/kvitbit-mark-current-light.svg",
    dark: "assets/brand/kvitbit-mark-dark.svg",
    white: "assets/brand/kvitbit-mark-white.svg",
    currentDark: "assets/brand/kvitbit-mark-current-dark.svg",
  },
  lockup: {
    horizontalLight: "assets/brand/lockup/kvitbit-lockup-horizontal-light.svg",
    horizontalDark: "assets/brand/lockup/kvitbit-lockup-horizontal-dark.svg",
    stackedLight: "assets/brand/lockup/kvitbit-lockup-stacked-light.svg",
    stackedDark: "assets/brand/lockup/kvitbit-lockup-stacked-dark.svg",
    wordmarkFont: "assets/brand/lockup/ClashDisplay-Semibold.woff2",
    wordmarkFontLicense: "assets/brand/lockup/FONT-LICENSE.md",
  },
  pattern: {
    current: "assets/brand/pattern/kvitbit-pattern-t4.svg",
    light: "assets/brand/pattern/kvitbit-pattern-t4-light.svg",
    dark: "assets/brand/pattern/kvitbit-pattern-t4-dark.svg",
  },
  web: {
    faviconSvg: "assets/brand/web/favicon.svg",
    faviconIco: "assets/brand/web/favicon.ico",
    favicon16: "assets/brand/web/favicon-16.png",
    favicon32: "assets/brand/web/favicon-32.png",
    favicon48: "assets/brand/web/favicon-48.png",
    appleTouchIcon: "assets/brand/web/apple-touch-icon.png",
    icon192: "assets/brand/web/icon-192.png",
    icon512: "assets/brand/web/icon-512.png",
    maskable512: "assets/brand/web/maskable-512.png",
    manifest: "assets/brand/web/site.webmanifest",
    headSnippet: "assets/brand/web/head-snippet.html",
  },
  mobile: {
    adaptiveForeground: "assets/brand/mobile/adaptive-foreground.svg",
    adaptiveForeground1024: "assets/brand/mobile/adaptive-foreground-1024.png",
    adaptiveBackground: "assets/brand/mobile/adaptive-background.svg",
    adaptiveMonochrome: "assets/brand/mobile/adaptive-monochrome.svg",
    icon1024: "assets/brand/mobile/icon-1024.png",
    splashIcon1024: "assets/brand/mobile/splash-icon-1024.png",
  },
} as const;

type Leaves<T> = T extends string ? T : { [K in keyof T]: Leaves<T[K]> }[keyof T];

export type BrandAssetPath = Leaves<typeof brandAssets>;

/** Every manifest path, flattened. */
export const brandAssetPaths: readonly BrandAssetPath[] = Object.values(brandAssets).flatMap(
  (group): BrandAssetPath[] => Object.values(group),
);
