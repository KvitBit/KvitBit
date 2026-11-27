import { UiSchema } from "@effect/ui";
import type { Html } from "@effect/ui/html";
/**
 * Screen 03 — /android download & Obtainium instructions + /app/ PWA link.
 */
import { ReleaseInfo } from "@kvitbit/api-contract";
import { Format } from "@kvitbit/ui-port";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { Failure, failureFromUnknown } from "../../app/api";
import { browserOrigin, fetchBrowserOk } from "../../app/browser";
import { defineApiCommand } from "../../app/commands";
import { copy, translator } from "../../app/i18n";
import { Intent_ } from "../../app/intent";
import {
  type MessageHandlers,
  type PageContext,
  type PageReturn,
  RouteCases,
} from "../../app/page";
import * as Remote from "../../app/remote";
import { svgImage } from "../../ui/html";
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

export const Route = RouteCases.AndroidDownload;
export type Route = typeof Route.Type;

const ReleaseRemote = Remote.remoteSchema(ReleaseInfo);

export const Model = Schema.Struct({
  route: Route,
  release: ReleaseRemote,
});
export type Model = typeof Model.Type;

export const Message = UiSchema.TaggedEnum({
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
  // biome-ignore lint/security/noSecrets: This is the inline Android icon.
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/><path d="M9 14l3 3 3-3"/></svg>';

const decodeRelease = HttpClientResponse.schemaBodyJson(ReleaseInfo);
const fetchLatestRelease = (seq: Remote.Seq) =>
  fetchBrowserOk(HttpClientRequest.get(`${browserOrigin()}/api/mobile/releases/latest`)).pipe(
    Effect.flatMap(decodeRelease),
    Effect.match({
      onSuccess: (release) => Message.GotRelease({ seq, release }),
      onFailure: (error) => Message.FailedRelease({ seq, failure: failureFromUnknown(error) }),
    }),
  );

const FetchRelease = defineApiCommand({
  message: Message,
  name: "AndroidFetchRelease",
  args: { seq: Remote.Seq },
  execute: ({ seq }) => fetchLatestRelease(seq),
});

const CopyCmd = defineApiCommand({
  message: Message,
  name: "AndroidCopy",
  args: { value: Schema.String },
  execute: ({ value }) => copyToClipboard(value, (ok) => Message.CopiedValue({ ok })),
});

const initImpl = (route: Route, _ctx: PageContext): PageReturn<Model, Message> => {
  const release = Remote.load(Remote.idle);
  const seq = Remote.seqOf(release);
  return {
    model: { route, release },
    commands: [FetchRelease({ seq })],
  };
};

export const init: {
  (_ctx: PageContext): (route: Route) => PageReturn<Model, Message>;
  (route: Route, _ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(2, initImpl);

const updateImpl = (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message> =>
  Message.match(message, {
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
      outMessage: ok ? Intent_.toast(translator(ctx.locale).t("common.toast.copied")) : undefined,
    }),
  } satisfies MessageHandlers<Message, PageReturn<Model, Message>>);

export const update: {
  (message: Message, ctx: PageContext): (model: Model) => PageReturn<Model, Message>;
  (model: Model, message: Message, ctx: PageContext): PageReturn<Model, Message>;
} = Fn.dual(3, updateImpl);

const titleImpl = (_model: Model, ctx: PageContext): string =>
  translator(ctx.locale).t("public.androidDownload.title");

export const title: {
  (ctx: PageContext): (_model: Model) => string;
  (_model: Model, ctx: PageContext): string;
} = Fn.dual(2, titleImpl);

const viewImpl = (model: Model, ctx: PageContext, h: Html.H<Message>) => {
  const t = translator(ctx.locale);
  const release = Remote.dataOf(model.release);
  const obtainiumHref = release?.obtainiumUrl ?? local(ctx.locale, "defaultObtainium");

  return h.div.class("kb-android").children([
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
    h.div.class("kb-android-grid").children([
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
        h.div.class("kb-stack").children([
          h.p.class("kb-muted").children([local(ctx.locale, "directBody")]),
          ...(model.release._tag === "Loading"
            ? [skeleton(h, "60%", "1.25rem"), skeleton(h, "45%", "2.25rem")]
            : release !== undefined
              ? [
                  dl(h, [
                    [
                      Str.trim(t.t("public.androidDownload.version", { version: "" })),
                      mono(h, `${release.version} (${release.versionCode})`),
                    ],
                    [
                      Str.trim(t.t("public.androidDownload.size", { size: "" })),
                      formatBytes(release.sizeBytes),
                    ],
                    [
                      local(ctx.locale, "releasedOn"),
                      Format.formatDate(ctx.locale, Str.slice(0, 10)(release.releasedAt)),
                    ],
                    [local(ctx.locale, "minSdk"), `API ${release.minAndroidSdk}+`],
                  ]),
                  h.div.class("kb-row").children([
                    h.a
                      .class("kb-btn kb-btn--primary")
                      .attr("href", release.apkUrl)
                      .attr("download", `kvitbit-${release.version}.apk`)
                      .children([icon(h, "download", 16), t.t("public.androidDownload.download")]),
                  ]),
                ]
              : []),
        ]),
      ]),
      card(h, [
        h.div
          .class("kb-row")
          .children([
            h.img
              .class("kb-obtainium-mark")
              .attr("src", svgImage(OBTAINIUM_MARK_SVG))
              .attr("alt", ""),
            h.h2.children([t.t("public.androidDownload.obtainium.title")]),
          ]),
        h.div
          .class("kb-stack")
          .style({ marginTop: "12px" })
          .children([
            h.p.class("kb-muted").children([t.t("public.androidDownload.obtainium.body")]),
            h.div
              .class("kb-stack")
              .style({ "--kb-gap": "4px" })
              .children([
                h.strong.class("kb-small").children([local(ctx.locale, "obtainiumStepsTitle")]),
                h.span.class("kb-small kb-muted").children([local(ctx.locale, "obtainiumStep1")]),
                h.span.class("kb-small kb-muted").children([local(ctx.locale, "obtainiumStep2")]),
                h.span.class("kb-small kb-muted").children([local(ctx.locale, "obtainiumStep3")]),
              ]),
            h.div.class("kb-row").children([
              h.a
                .class("kb-btn kb-btn--primary")
                .attr("href", obtainiumHref)
                .children([t.t("public.androidDownload.obtainium.cta")]),
            ]),
          ]),
      ]),
    ]),
    ...(release !== undefined
      ? [
          card(h, [
            cardTitle(h, local(ctx.locale, "verifyTitle")),
            h.div.class("kb-stack").children([
              h.div.class("kb-field").children([
                h.span.class("kb-field__label").children([t.t("public.androidDownload.checksum")]),
                h.div.class("kb-checksum-row").children([
                  mono(h, release.apkSha256),
                  button(h, {
                    label: t.t("public.androidDownload.copyChecksum"),
                    onClick: Message.ClickedCopy({ value: release.apkSha256 }),
                    small: true,
                  }),
                ]),
              ]),
              h.div.class("kb-field").children([
                h.span
                  .class("kb-field__label")
                  .children([t.t("public.androidDownload.signingCert")]),
                h.div.class("kb-checksum-row").children([
                  mono(h, release.signingCertSha256),
                  button(h, {
                    label: local(ctx.locale, "copyCert"),
                    onClick: Message.ClickedCopy({ value: release.signingCertSha256 }),
                    small: true,
                  }),
                ]),
              ]),
            ]),
          ]),
        ]
      : []),
    card(
      h,
      [
        h.div.class("kb-spread").children([
          h.div
            .class("kb-stack")
            .style({ "--kb-gap": "4px" })
            .children([
              h.h2.children([local(ctx.locale, "pwaTitle")]),
              h.p.class("kb-muted").children([local(ctx.locale, "pwaBody")]),
            ]),
          h.a
            .class("kb-btn kb-btn--secondary")
            .attr("href", "/app/")
            .attr("rel", "external")
            .children([local(ctx.locale, "pwaCta")]),
        ]),
      ],
      [],
      true,
    ),
  ]);
};

export const view: {
  (ctx: PageContext, h: Html.H<Message>): (model: Model) => ReturnType<typeof viewImpl>;
  (model: Model, ctx: PageContext, h: Html.H<Message>): ReturnType<typeof viewImpl>;
} = Fn.dual(3, viewImpl);
