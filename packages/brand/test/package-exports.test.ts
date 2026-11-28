import { expect, test } from "bun:test";

import * as Brand from "@kvitbit/brand";

test("the package entry point exposes brand geometry, inks, and options", () => {
  const master: Brand.MarkMaster = "light";
  const geometry: Brand.MarkMasterGeometry = Brand.markMasters[master];
  const fill: Brand.MarkFill = Brand.markFills[master][0];
  const ink: Brand.BrandColor = Brand.brandColors.inkOnDark;
  const asset: Brand.BrandAssetPath = Brand.brandAssets.mark.light;
  const pattern: Brand.PatternOptions = { ink };
  const definition: Brand.PatternDefOptions = { ...pattern, id: "brand-test" };

  expect(Brand.MARK_GRID_SIZE).toBe(256);
  expect(geometry.gap).toBe(10);
  expect(Brand.markDefaultFill[master]).toBe(fill);
  expect(Brand.brandAssetPaths).toContain(asset);
  expect(Brand.t4PatternSvg(pattern)).toContain(`viewBox="${Brand.PATTERN_VIEW_BOX}"`);
  expect(Brand.t4PatternDef(definition)).toContain('id="brand-test"');
});
