import { describe, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import {
  brandAssetPaths,
  brandAssets,
  brandColors,
  MARK_VIEW_BOX,
  type MarkSvgOptions,
  markMasters,
  markSvg,
  PATTERN_TILE_SIZE,
  t4PatternDef,
  t4PatternSvg,
} from "../src/index";

const repoRoot = `${import.meta.dir}/../../..`;
const assetFile = (repoPath: string) => Bun.file(`${repoRoot}/${repoPath}`);

const PATH_DATA_PATTERN = /<path d="(?<path>[^"]+)"/gu;
const VIEW_BOX_PATTERN = /viewBox="(?<viewBox>[^"]+)"/u;
const TILE_BODY_LINE_PATTERN = /^\s+<(?:path|g|rect|\/g)/u;

const pathData = (svg: string): string[] => {
  const matches = Arr.fromIterable(Str.matchAll(PATH_DATA_PATTERN)(svg));
  return Arr.map(matches, (match) => match.groups?.path ?? "");
};
const viewBox = (svg: string): string | undefined => VIEW_BOX_PATTERN.exec(svg)?.groups?.viewBox;

describe("N2 mark masters", () => {
  const files: ReadonlyArray<MarkSvgOptions & { readonly path: string }> = [
    { master: "light", fill: "#111111", path: brandAssets.mark.light },
    { master: "light", fill: "#000000", path: brandAssets.mark.black },
    { master: "light", fill: "currentColor", path: brandAssets.mark.currentLight },
    { master: "dark", fill: "#FAFAFA", path: brandAssets.mark.dark },
    { master: "dark", fill: "#FFFFFF", path: brandAssets.mark.white },
    { master: "dark", fill: "currentColor", path: brandAssets.mark.currentDark },
  ];

  test.each(files)("$path path data and viewBox match the $master master", async (file) => {
    const svg = await assetFile(file.path).text();
    expect(pathData(svg)).toEqual([...markMasters[file.master].paths]);
    expect(viewBox(svg)).toBe(MARK_VIEW_BOX);
  });

  test.each(files)("markSvg reproduces $path byte for byte", async (file) => {
    expect(markSvg(file)).toBe(await assetFile(file.path).text());
  });

  test("default fills are the brand inks", async () => {
    expect(markSvg({ master: "light" })).toBe(await assetFile(brandAssets.mark.light).text());
    expect(markSvg({ master: "dark" })).toBe(await assetFile(brandAssets.mark.dark).text());
  });

  test("masters differ only by gap: 10 units light, 14 units dark", () => {
    // Stem right edge (x=84/82) to chevron's leftmost vertex (x=94/96).
    expect(markMasters.light.gap).toBe(94 - 84);
    expect(markMasters.dark.gap).toBe(96 - 82);
  });

  test("rejects paints and sizes that would corrupt the SVG", () => {
    // @ts-expect-error not a shipped ink
    expect(() => markSvg({ master: "light", fill: '#111" onload="x' })).toThrow(TypeError);
    // @ts-expect-error the mark is never recoloured
    expect(() => markSvg({ master: "light", fill: "#FF0000" })).toThrow(TypeError);
    // @ts-expect-error light master ink is never used for light-on-dark
    expect(() => markSvg({ master: "light", fill: "#FAFAFA" })).toThrow(TypeError);
    // @ts-expect-error dark master ink is never used for dark-on-light
    expect(() => markSvg({ master: "dark", fill: "#111111" })).toThrow(TypeError);
    expect(() => markSvg({ master: "light", size: 0 })).toThrow(RangeError);
    expect(markSvg({ master: "light", title: "<K&B>" })).toContain("&lt;K&amp;B&gt;");
  });
});

describe("T4 Micro-Glyph Graph pattern", () => {
  test("default output is 96x96 and equals the committed currentColor tile", async () => {
    const svg = t4PatternSvg();
    expect(PATTERN_TILE_SIZE).toBe(96);
    expect(viewBox(svg)).toBe("0 0 96 96");
    expect(svg).toContain('width="96" height="96"');
    expect(svg).toBe(await assetFile(brandAssets.pattern.current).text());
  });

  test("brand inks reproduce the light and dark tiles", async () => {
    expect(t4PatternSvg({ ink: brandColors.inkOnLight })).toBe(
      await assetFile(brandAssets.pattern.light).text(),
    );
    expect(t4PatternSvg({ ink: brandColors.inkOnDark })).toBe(
      await assetFile(brandAssets.pattern.dark).text(),
    );
  });

  test("pattern def carries the same geometry in a 96x96 userSpaceOnUse tile", async () => {
    const def = t4PatternDef({ id: "kb-t4", ink: "#123456" });
    expect(def).toStartWith(
      '<pattern id="kb-t4" patternUnits="userSpaceOnUse" width="96" height="96" viewBox="0 0 96 96">',
    );
    expect(def).toEndWith("</pattern>");
    const committedSvg = await assetFile(brandAssets.pattern.light).text();
    const committed = Str.replaceAll("#111111", "#123456")(committedSvg);
    const body = (svg: string): string =>
      Fn.pipe(
        svg,
        Str.split("\n"),
        Arr.filter((line) => TILE_BODY_LINE_PATTERN.test(line)),
        Arr.join("\n"),
      );
    const definitionBody = body(def);
    expect(definitionBody).toBe(body(committed));
    expect(definitionBody.length).toBeGreaterThan(0);
  });

  test("rejects unsafe inks and ids", () => {
    expect(() => t4PatternSvg({ ink: "red" })).toThrow(TypeError);
    expect(() => t4PatternDef({ id: 'a" x="', ink: "#fff" })).toThrow(TypeError);
  });
});

describe("brand tokens", () => {
  test("match DESIGN.md brand colors", () => {
    expect(brandColors).toEqual({
      inkOnLight: "#111111",
      inkOnDark: "#FAFAFA",
      iconTile: "#111111",
      black: "#000000",
      white: "#FFFFFF",
      splashBackground: "#F4F4F5",
    });
  });

  test("icon tile matches the committed adaptive background", async () => {
    const svg = await assetFile(brandAssets.mobile.adaptiveBackground).text();
    expect(svg).toContain(brandColors.iconTile);
  });
});

describe("asset manifest", () => {
  test.each([...brandAssetPaths])("%s exists", async (path) => {
    expect(Str.startsWith("assets/brand/")(path)).toBe(true);
    expect(await assetFile(path).exists()).toBe(true);
  });

  test("covers every committed mark, pattern, web and mobile file", () => {
    // Lockups are listed by path only; they may change on main independently.
    const onDisk = new Bun.Glob("assets/brand/**/*").scanSync({
      cwd: repoRoot,
      dot: true,
      followSymlinks: true,
      throwErrorOnBrokenSymlink: true,
    });
    const listed = new Set<string>(brandAssetPaths);
    const unlisted = Arr.filter(
      onDisk,
      (path) => !(Str.startsWith("assets/brand/lockup/")(path) || listed.has(path)),
    );
    expect(unlisted).toEqual([]);
  });

  test("paths are unique", () => {
    expect(new Set(brandAssetPaths).size).toBe(brandAssetPaths.length);
  });
});
