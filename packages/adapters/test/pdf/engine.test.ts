import { describe, expect, test } from "bun:test";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  ChromiumPdfEngine,
  FakePdfEngine,
  makeChromiumPdfEngine,
  makeFakePdfEngine,
  PdfEngine,
  renderDocumentHtml,
  renderDocumentPdf,
  renderReportPdf,
} from "../../src/pdf";
import { czkModel, eurModel, reportModel } from "./fixtures";

const XREF_OFFSET = /startxref\n(\d+)/;
const A4_MEDIA_BOX = /\/MediaBox \[0 0 59\d\.\d+ 84\d\.\d+\]/;

const startsWithPdf = (bytes: Uint8Array) =>
  new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";

describe("FakePdfEngine", () => {
  test("returns a valid one-page PDF and records the HTML it printed", async () => {
    const fake = makeFakePdfEngine();
    const bytes = await Effect.runPromise(
      renderDocumentPdf(czkModel(), "classic", "cs").pipe(
        Effect.provideService(PdfEngine, fake.service),
      ),
    );
    expect(startsWithPdf(bytes)).toBe(true);
    const pdf = new TextDecoder().decode(bytes);
    expect(pdf).toContain("/Count 1");
    expect(Str.endsWith("%%EOF")(Str.trimEnd(pdf))).toBe(true);
    const xref = Number(XREF_OFFSET.exec(pdf)?.[1]);
    expect(Str.slice(xref, xref + 4)(pdf)).toBe("xref");
    expect(fake.rendered).toEqual([renderDocumentHtml(czkModel(), "classic", "cs")]);
  });

  test("layer form serves reports too", async () => {
    const bytes = await Effect.runPromise(
      renderReportPdf(reportModel(), "en").pipe(Effect.provide(FakePdfEngine)),
    );
    expect(startsWithPdf(bytes)).toBe(true);
  });
});

/** CHROMIUM_PATH, then a system Chromium or Chrome, then playwright's browser cache. */
const findChromium = async (): Promise<string | null> => {
  const fromEnv = Config.String("CHROMIUM_PATH").pipe(Config.option, Effect.runSync);
  if (Option.isSome(fromEnv) && fromEnv.value !== "" && (await Bun.file(fromEnv.value).exists())) {
    return fromEnv.value;
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    const found = Bun.which(name);
    if (found !== null) return found;
  }
  try {
    const { chromium } = await import("playwright-core");
    const cached = chromium.executablePath();
    return (await Bun.file(cached).exists()) ? cached : null;
  } catch {
    return null;
  }
};

const chromiumPath = await findChromium();
if (chromiumPath === null) {
  process.stderr.write(
    "[pdf] Chromium smoke test skipped: no CHROMIUM_PATH, chromium, chromium-browser, google-chrome or playwright browser found\n",
  );
}

describe.skipIf(chromiumPath === null)("ChromiumPdfEngine (smoke)", () => {
  test("prints every template and the report to PDF bytes", async () => {
    const program = Effect.gen(function* () {
      const engine = yield* makeChromiumPdfEngine({ executablePath: chromiumPath ?? "" });
      const layer = Layer.succeed(PdfEngine, engine);
      const classic = yield* renderDocumentPdf(
        { ...czkModel(), status: "draft", number: null },
        "classic",
        "cs",
      ).pipe(Effect.provide(layer));
      const modern = yield* renderDocumentPdf(eurModel(), "modern_minimal", "en").pipe(
        Effect.provide(layer),
      );
      const layerConfig = ConfigProvider.layer(
        ConfigProvider.fromUnknown({ CHROMIUM_PATH: chromiumPath ?? "" }),
      );
      const report = yield* renderReportPdf(reportModel(), "cs").pipe(
        Effect.provide(Layer.provide(ChromiumPdfEngine, layerConfig)),
      );
      return [classic, modern, report];
    });
    const outputs = await program.pipe(Effect.scoped, Effect.runPromise);
    for (const bytes of outputs) {
      expect(startsWithPdf(bytes)).toBe(true);
      expect(bytes.length).toBeGreaterThan(1000);
    }
    // A4 portrait media box (595 x 842 pt).
    expect(new TextDecoder("latin1").decode(outputs[0])).toMatch(A4_MEDIA_BOX);
  }, 60_000);
});
