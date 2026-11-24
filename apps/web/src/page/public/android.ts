/**
 * Screen 03 — /android download & Obtainium instructions + /app/ PWA link.
 */
import { ReleaseInfo } from "@kvitbit/api-contract";
import { Format, ViewModels } from "@kvitbit/ui-port";
import { Effect, Schema } from "effect";
import { Command, Submodel } from "foldkit";
import { defineMessageUnion } from "foldkit/message";
import { Failure, failureFromUnknown } from "../../app/api";
import { copy, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import type { PageContext, PageReturn, RouteOf } from "../../app/page";
import * as Remote from "../../app/remote";
import { icon } from "../../ui/icons";
import {
  badge,
  banner,
  button,
  card,
  cardTitle,
  dl,
  mono,
  pageHeader,
  skeleton,
} from "../../ui/kit";
import { copyToClipboard, formatBytes } from "./_shared";

export type Route = RouteOf<"AndroidDownload">;

const ReleaseRemote = Remote.remoteSchema(ReleaseInfo);

export const Model = Schema.Struct({
  route: ViewModels.Route,
  release: ReleaseRemote,
});
export type Model = typeof Model.Type;

export const Message = defineMessageUnion({
  GotRelease: { seq: Remote.Seq, release: ReleaseInfo },
  FailedRelease: { seq: Remote.Seq, failure: Failure },
  ClickedRetry: {},
  ClickedCopy: { value: Schema.String },
  CopiedValue: { ok: Schema.Boolean },
});
export type Message = typeof Message.Type;

const local = copy({
  cs: {
    directTitle: "Přímé stažení APK",
    directBody: "Podepsaný balíček APK pro Android. Po stažení povolte instalaci z tohoto zdroje.",
    releasedOn: "Vydáno",
    minSdk: "Minimální Android API",
    verifyTitle: "Ověření balíčku",
    copyCert: "Kopírovat otisk",
    obtainiumStepsTitle: "Jak přidat Kvitbit do Obtainium",
    obtainiumStep1: "1. Nainstalujte Obtainium (z GitHubu nebo F-Droidu).",
    obtainiumStep2:
      "2. Klepněte na tlačítko Přidat do Obtainium níže, nebo zadejte adresu této instance.",
    obtainiumStep3: "3. Obtainium bude automaticky sledovat nové verze a ověřovat podpis APK.",
    pwaTitle: "Mobilní webová aplikace (/app/)",
    pwaBody:
      "Používáte iPhone nebo nechcete instalovat APK? Otevřete mobilní rozhraní Kvitbit přímo v prohlížeči a přidejte si ho na plochu.",
    pwaCta: "Otevřít /app/",
    defaultObtainium: "obtainium://add/https://kvitbit.cz/api/mobile/releases/latest",
  },
  en: {
    directTitle: "Direct APK download",
    directBody: "Signed Android APK package. Allow installation from your browser when prompted.",
    releasedOn: "Released",
    minSdk: "Minimum Android API",
    verifyTitle: "Package verification",
    copyCert: "Copy fingerprint",
    obtainiumStepsTitle: "How to add Kvitbit in Obtainium",
    obtainiumStep1: "1. Install Obtainium (from GitHub or F-Droid).",
    obtainiumStep2: "2. Tap Add to Obtainium below, or paste this server's release URL.",
    obtainiumStep3: "3. Obtainium tracks new releases and checks the APK signature automatically.",
    pwaTitle: "Mobile web app (/app/)",
    pwaBody:
      "On iPhone or prefer not to install an APK? Open the mobile Kvitbit web app directly in your browser and add it to your home screen.",
    pwaCta: "Open /app/",
    defaultObtainium: "obtainium://add/https://kvitbit.cz/api/mobile/releases/latest",
  },
});

const OBTAINIUM_MARK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/><path d="M9 14l3 3 3-3"/></svg>';

const origin = (): string =>
  typeof location === "undefined" || location.origin === "null"
    ? "http://localhost"
    : location.origin;

const decodeRelease = Schema.decodeUnknownSync(ReleaseInfo);

const fetchLatestRelease = (seq: Remote.Seq) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${origin()}/api/mobile/releases/latest`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw Object.assign(new Error(`release ${res.status}`), { status: res.status });
      return decodeRelease(await res.json());
    },
    catch: (e) => e,
  }).pipe(
    Effect.map((release) => Message.GotRelease({ seq, release })),
    Effect.catch((e) =>
      Effect.succeed(Message.FailedRelease({ seq, failure: failureFromUnknown(e) })),
    ),
  );

const FetchRelease = Command.define("AndroidFetchRelease", {
  args: { seq: Remote.Seq },
  messages: [Message.GotRelease, Message.FailedRelease],
  execute: ({ seq }) => fetchLatestRelease(seq),
});

const CopyCmd = Command.define("AndroidCopy", {
  args: { value: Schema.String },
  messages: [Message.CopiedValue],
  execute: ({ value }) => copyToClipboard(value, (ok) => Message.CopiedValue({ ok })),
});

export const init = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => {
  const release = Remote.load(Remote.idle);
  const seq = Remote.seqOf(release);
  return {
    model: { route, release },
    commands: [FetchRelease({ seq })],
  };
};

export const update = (
  model: Model,
  message: Message,
  ctx: PageContext,
): PageReturn<Model, Message> =>
  Message.match<PageReturn<Model, Message>>(message, {
    GotRelease: ({ seq, release }) => ({
      model: { ...model, release: Remote.succeed(model.release, seq, release) },
    }),
    FailedRelease: ({ seq, failure }) => ({
      model: { ...model, release: Remote.fail(model.release, seq, failure) },
    }),
    ClickedRetry: () => {
      const release = Remote.load(model.release);
      const seq = Remote.seqOf(release);
      return {
        model: { ...model, release },
        commands: [FetchRelease({ seq })],
      };
    },
    ClickedCopy: ({ value }) => ({
      model,
      commands: [CopyCmd({ value })],
    }),
    CopiedValue: ({ ok }) => ({
      model,
      ...(ok ? { outMessage: Intent_.toast(translator(ctx.locale).t("common.toast.copied")) } : {}),
    }),
  });

export const title = (_model: Model, ctx: PageContext): string =>
  translator(ctx.locale).t("public.androidDownload.title");

export const view = Submodel.defineView<Model, Message, PageContext>((model, ctx, h) => {
  const t = translator(ctx.locale);
  const release = Remote.dataOf(model.release);
  const obtainiumHref = release?.obtainiumUrl ?? local(ctx.locale, "defaultObtainium");

  return h.div(
    [h.Class("kb-android")],
    [
      pageHeader(h, {
        title: t.t("public.androidDownload.title"),
        subtitle: t.t("public.androidDownload.subtitle"),
      }),
      ...(model.release._tag === "Failed"
        ? [
            banner(h, {
              text: t.t("public.androidDownload.releaseFailed"),
              tone: "error",
              action: button(h, {
                label: t.t("common.action.retry"),
                onClick: Message.ClickedRetry(),
                small: true,
              }),
            }),
          ]
        : []),
      h.div(
        [h.Class("kb-android-grid")],
        [
          card(h, [
            cardTitle(
              h,
              local(ctx.locale, "directTitle"),
              release !== undefined
                ? [
                    badge(
                      h,
                      t.t("public.androidDownload.version", { version: release.version }),
                      "paid",
                    ),
                  ]
                : [],
            ),
            h.div(
              [h.Class("kb-stack")],
              [
                h.p([h.Class("kb-muted")], [local(ctx.locale, "directBody")]),
                ...(model.release._tag === "Loading"
                  ? [skeleton(h, "60%", "1.25rem"), skeleton(h, "45%", "2.25rem")]
                  : release !== undefined
                    ? [
                        dl(h, [
                          [
                            t.t("public.androidDownload.version", { version: "" }).trim(),
                            mono(h, `${release.version} (${release.versionCode})`),
                          ],
                          [
                            t.t("public.androidDownload.size", { size: "" }).trim(),
                            formatBytes(release.sizeBytes),
                          ],
                          [
                            local(ctx.locale, "releasedOn"),
                            Format.formatDate(ctx.locale, release.releasedAt.slice(0, 10)),
                          ],
                          [local(ctx.locale, "minSdk"), `API ${release.minAndroidSdk}+`],
                        ]),
                        h.div(
                          [h.Class("kb-row")],
                          [
                            h.a(
                              [
                                h.Class("kb-btn kb-btn--primary"),
                                h.Href(release.apkUrl),
                                h.Download(`kvitbit-${release.version}.apk`),
                              ],
                              [icon(h, "download", 16), t.t("public.androidDownload.download")],
                            ),
                          ],
                        ),
                      ]
                    : []),
              ],
            ),
          ]),
          card(h, [
            h.div(
              [h.Class("kb-row")],
              [
                h.span([h.Class("kb-obtainium-mark"), h.InnerHTML(OBTAINIUM_MARK_SVG)]),
                h.h2([], [t.t("public.androidDownload.obtainium.title")]),
              ],
            ),
            h.div(
              [h.Class("kb-stack"), h.Style({ marginTop: "12px" })],
              [
                h.p([h.Class("kb-muted")], [t.t("public.androidDownload.obtainium.body")]),
                h.div(
                  [h.Class("kb-stack"), h.Style({ "--kb-gap": "4px" })],
                  [
                    h.strong([h.Class("kb-small")], [local(ctx.locale, "obtainiumStepsTitle")]),
                    h.span([h.Class("kb-small kb-muted")], [local(ctx.locale, "obtainiumStep1")]),
                    h.span([h.Class("kb-small kb-muted")], [local(ctx.locale, "obtainiumStep2")]),
                    h.span([h.Class("kb-small kb-muted")], [local(ctx.locale, "obtainiumStep3")]),
                  ],
                ),
                h.div(
                  [h.Class("kb-row")],
                  [
                    h.a(
                      [h.Class("kb-btn kb-btn--primary"), h.Href(obtainiumHref)],
                      [t.t("public.androidDownload.obtainium.cta")],
                    ),
                  ],
                ),
              ],
            ),
          ]),
        ],
      ),
      ...(release !== undefined
        ? [
            card(h, [
              cardTitle(h, local(ctx.locale, "verifyTitle")),
              h.div(
                [h.Class("kb-stack")],
                [
                  h.div(
                    [h.Class("kb-field")],
                    [
                      h.span(
                        [h.Class("kb-field__label")],
                        [t.t("public.androidDownload.checksum")],
                      ),
                      h.div(
                        [h.Class("kb-checksum-row")],
                        [
                          mono(h, release.apkSha256),
                          button(h, {
                            label: t.t("public.androidDownload.copyChecksum"),
                            onClick: Message.ClickedCopy({ value: release.apkSha256 }),
                            small: true,
                          }),
                        ],
                      ),
                    ],
                  ),
                  h.div(
                    [h.Class("kb-field")],
                    [
                      h.span(
                        [h.Class("kb-field__label")],
                        [t.t("public.androidDownload.signingCert")],
                      ),
                      h.div(
                        [h.Class("kb-checksum-row")],
                        [
                          mono(h, release.signingCertSha256),
                          button(h, {
                            label: local(ctx.locale, "copyCert"),
                            onClick: Message.ClickedCopy({ value: release.signingCertSha256 }),
                            small: true,
                          }),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
            ]),
          ]
        : []),
      card(
        h,
        [
          h.div(
            [h.Class("kb-spread")],
            [
              h.div(
                [h.Class("kb-stack"), h.Style({ "--kb-gap": "4px" })],
                [
                  h.h2([], [local(ctx.locale, "pwaTitle")]),
                  h.p([h.Class("kb-muted")], [local(ctx.locale, "pwaBody")]),
                ],
              ),
              h.a(
                [h.Class("kb-btn kb-btn--secondary"), h.Href("/app/")],
                [local(ctx.locale, "pwaCta")],
              ),
            ],
          ),
        ],
        [],
        true,
      ),
    ],
  );
});
