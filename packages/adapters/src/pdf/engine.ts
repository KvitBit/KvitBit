/**
 * HTML to PDF. `PdfEngine` is the seam; `ChromiumPdfEngine` prints with headless Chromium via
 * playwright-core (loaded lazily, so composition roots that never render PDFs don't load it), and
 * `FakePdfEngine` returns a fixed one-page PDF for tests.
 */

import * as Arr from "effect/Array";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type { LaunchOptions } from "playwright-core";

export class PdfEngineError extends Schema.TaggedError<
  PdfEngineError,
  { readonly brand: unique symbol }
>()("PdfEngineError", {
  stage: Schema.Literals(["launch", "render"]),
  cause: Schema.Unknown,
}) {}

export class PdfEngine extends Context.Service<
  PdfEngine,
  {
    /** Prints a self-contained HTML page to A4 PDF bytes, honouring its `@page` rules. */
    readonly htmlToPdf: (html: string) => Effect.Effect<Uint8Array, PdfEngineError>;
  }
>()("@kvitbit/adapters/pdf/engine/PdfEngine") {}

export interface ChromiumOptions {
  /** Chromium or Chrome binary. Omitted uses playwright's own browser cache. */
  readonly executablePath?: string;
  /** Per-render timeout. Default 30 s. */
  readonly timeoutMs?: number;
}

/**
 * Launches one headless browser for the scope's lifetime; each render gets a fresh context
 * with JavaScript disabled and every network request blocked (templates are self-contained).
 */
export const makeChromiumPdfEngine = Effect.fn("makeChromiumPdfEngine")(function* (
  options: ChromiumOptions = {},
) {
  const timeout = options.timeoutMs ?? 30_000;
  const { chromium } = yield* Effect.tryPromise({
    try: () => import("playwright-core"),
    catch: (cause) => PdfEngineError.make({ stage: "launch", cause }),
  });
  const launchOptions: LaunchOptions = { headless: true };
  if (options.executablePath !== undefined) launchOptions.executablePath = options.executablePath;
  const browser = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => chromium.launch(launchOptions),
      catch: (cause) => PdfEngineError.make({ stage: "launch", cause }),
    }),
    (b) => Effect.promise(() => b.close()).pipe(Effect.ignore),
  );

  const renderPromise = <A>(run: () => PromiseLike<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => PdfEngineError.make({ stage: "render", cause }),
    });
  const htmlToPdf = (html: string) =>
    Effect.acquireUseRelease(
      renderPromise(() => browser.newContext({ javaScriptEnabled: false, offline: true })),
      Effect.fnUntraced(function* (context) {
        const page = yield* renderPromise(() => context.newPage());
        yield* Effect.try({
          try: () => page.setDefaultTimeout(timeout),
          catch: (cause) => PdfEngineError.make({ stage: "render", cause }),
        });
        yield* renderPromise(() =>
          page.route("**/*", (route) =>
            Str.startsWith("data:")(route.request().url()) ? route.continue() : route.abort(),
          ),
        );
        yield* renderPromise(() => page.setContent(html, { waitUntil: "load", timeout }));
        const pdf = yield* renderPromise(() =>
          page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true }),
        );
        return new Uint8Array(pdf);
      }),
      (context) => renderPromise(() => context.close()),
    );

  return PdfEngine.of({ htmlToPdf });
});

/** `CHROMIUM_PATH` (optional) selects the browser binary. */
export const ChromiumPdfEngine = Layer.effect(
  PdfEngine,
  Effect.gen(function* () {
    const path = yield* Config.option(Config.String("CHROMIUM_PATH"));
    return yield* makeChromiumPdfEngine(Option.isSome(path) ? { executablePath: path.value } : {});
  }),
);

/** A minimal valid one-page A4 PDF with a correct cross-reference table. */
const fakePdf = (): Uint8Array => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << >> >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: Array<number> = [];
  Arr.forEach(objects, (body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${Str.padStart(10, "0")(String(o))} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
};

/** Test engine: records every HTML it is given and returns the same one-page PDF. */
export const makeFakePdfEngine = (): {
  service: typeof PdfEngine.Service;
  rendered: ReadonlyArray<string>;
} => {
  const rendered: Array<string> = [];
  const service = PdfEngine.of({
    htmlToPdf: Effect.fn("PdfEngine.htmlToPdf")((html) =>
      Effect.sync(() => {
        rendered.push(html);
        return fakePdf();
      }),
    ),
  });
  return { service, rendered };
};

export const FakePdfEngine = Layer.sync(PdfEngine, () => makeFakePdfEngine().service);
