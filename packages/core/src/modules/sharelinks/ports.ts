/**
 * Narrow driven ports of the share-links module and their in-memory fakes. Integration binds
 * them in apps/server: `ShareLinkKeys` from the versioned share-key configuration and the public
 * origin, `ShareWorkspaces` from Workspaces (members, branding, `brandingImage("logo")`),
 * `ShareVisitorDevice` per request from the user agent.
 */
import type {
  FileDownload,
  ShareToken,
  UserId,
  WorkspaceBranding,
  WorkspaceId,
} from "@kvitbit/domain/contract";
import type { BlobUnavailable } from "@kvitbit/domain/ports";
import { Context, Effect, Layer, Option, Ref, Stream } from "effect";
import { StoreUnavailable } from "../../store/CoreStore";
import type { ShareDevice } from "./record";

/**
 * The current share-token HMAC key (core-ports section 1) and the public URLs. Only the
 * current version is valid: rotating the key version invalidates every old link, so tokens of
 * any other version are expired and return `NotFound`.
 */
export class ShareLinkKeys extends Context.Service<
  ShareLinkKeys,
  {
    readonly version: number;
    readonly secret: Uint8Array;
    /** The Public Share Link page, e.g. `https://kvitbit.cz/s/{token}`. */
    readonly pageUrl: (token: ShareToken) => string;
    /** The page's PDF download link. */
    readonly pdfUrl: (token: ShareToken) => string;
  }
>()("kvitbit/core/sharelinks/ShareLinkKeys") {}

/** What the share page needs about the issuing Workspace. No authorize; Workspace scoped. */
export class ShareWorkspaces extends Context.Service<
  ShareWorkspaces,
  {
    /** True when the user is a Member of the Workspace (viewerIsIssuer, nothing recorded). */
    readonly isMember: (
      workspaceId: WorkspaceId,
      userId: UserId,
    ) => Effect.Effect<boolean, StoreUnavailable>;
    readonly branding: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<WorkspaceBranding, StoreUnavailable>;
    /** The logo download; `None` when the Workspace has no logo. */
    readonly logo: (
      workspaceId: WorkspaceId,
    ) => Effect.Effect<Option.Option<FileDownload>, StoreUnavailable | BlobUnavailable>;
  }
>()("kvitbit/core/sharelinks/ShareWorkspaces") {}

/**
 * The visitor's coarse device class, derived from the user agent by the share route (the
 * `ShareLinkVisitor` caller carries no user agent). Defaults to `unknown`.
 */
export const ShareVisitorDevice = Context.Reference<ShareDevice>(
  "kvitbit/core/sharelinks/ShareVisitorDevice",
  { defaultValue: () => "unknown" },
);

/** Test keys for `version` (default 1); a test rotates by providing `shareLinkKeysTest(2)`. */
export const shareLinkKeysTest = (version = 1): ShareLinkKeys["Service"] =>
  ShareLinkKeys.of({
    version,
    secret: new TextEncoder().encode(`test-share-key-v${version}`),
    pageUrl: (token) => `https://share.test/s/${token}`,
    pdfUrl: (token) => `https://share.test/s/${token}/pdf`,
  });

export const ShareLinkKeysTest: Layer.Layer<ShareLinkKeys> = Layer.succeed(
  ShareLinkKeys,
  shareLinkKeysTest(),
);

export const DEFAULT_BRANDING: WorkspaceBranding = {
  pdfTemplate: "classic",
  accentColor: "#1F6FEB",
  footerText: null,
  theme: null,
  logo: null,
  stamp: null,
};

type Logo = { readonly contentType: string; readonly bytes: Uint8Array };

/** State of the `ShareWorkspaces` fake; tests seed it. */
export class ShareFixtures extends Context.Service<
  ShareFixtures,
  {
    /** `${workspaceId}/${userId}` of every Member. */
    readonly members: Ref.Ref<ReadonlySet<string>>;
    readonly brandings: Ref.Ref<ReadonlyMap<WorkspaceId, WorkspaceBranding>>;
    readonly logos: Ref.Ref<ReadonlyMap<WorkspaceId, Logo>>;
    /** When true, every `ShareWorkspaces` call fails with `StoreUnavailable`. */
    readonly unavailable: Ref.Ref<boolean>;
    readonly addMember: (workspaceId: WorkspaceId, userId: UserId) => Effect.Effect<void>;
    readonly setBranding: (
      workspaceId: WorkspaceId,
      branding: WorkspaceBranding,
    ) => Effect.Effect<void>;
    readonly setLogo: (workspaceId: WorkspaceId, logo: Logo) => Effect.Effect<void>;
  }
>()("kvitbit/core/sharelinks/ShareFixtures") {}

const memberKey = (workspaceId: WorkspaceId, userId: UserId) => `${workspaceId}/${userId}`;

const fixtures = Layer.effect(
  ShareFixtures,
  Effect.gen(function* () {
    const members = yield* Ref.make<ReadonlySet<string>>(new Set());
    const brandings = yield* Ref.make<ReadonlyMap<WorkspaceId, WorkspaceBranding>>(new Map());
    const logos = yield* Ref.make<ReadonlyMap<WorkspaceId, Logo>>(new Map());
    const unavailable = yield* Ref.make(false);
    return ShareFixtures.of({
      members,
      brandings,
      logos,
      unavailable,
      addMember: (workspaceId, userId) =>
        Ref.update(members, (all) => new Set(all).add(memberKey(workspaceId, userId))),
      setBranding: (workspaceId, branding) =>
        Ref.update(brandings, (all) => new Map(all).set(workspaceId, branding)),
      setLogo: (workspaceId, logo) =>
        Ref.update(logos, (all) => new Map(all).set(workspaceId, logo)),
    });
  }),
);

/** In-memory `ShareWorkspaces` plus its `ShareFixtures`; branding defaults to `DEFAULT_BRANDING`. */
export const ShareWorkspacesFake: Layer.Layer<ShareWorkspaces | ShareFixtures> = Layer.provideMerge(
  Layer.effect(
    ShareWorkspaces,
    Effect.map(ShareFixtures, (f) => {
      const up = <A>(effect: Effect.Effect<A>) =>
        Effect.flatMap(Ref.get(f.unavailable), (down) =>
          down ? Effect.fail(new StoreUnavailable({})) : effect,
        );
      return ShareWorkspaces.of({
        isMember: (workspaceId, userId) =>
          up(Effect.map(Ref.get(f.members), (all) => all.has(memberKey(workspaceId, userId)))),
        branding: (workspaceId) =>
          up(Effect.map(Ref.get(f.brandings), (all) => all.get(workspaceId) ?? DEFAULT_BRANDING)),
        logo: (workspaceId) =>
          up(
            Effect.map(Ref.get(f.logos), (all) =>
              Option.map(Option.fromNullishOr(all.get(workspaceId)), (logo) => ({
                filename: "logo",
                contentType: logo.contentType,
                bytes: Stream.make(logo.bytes),
              })),
            ),
          ),
      });
    }),
  ),
  fixtures,
);
