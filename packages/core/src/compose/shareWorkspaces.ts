/**
 * `ShareWorkspacesLive`: the share-links `ShareWorkspaces` port (core-ports 4.6, board #585)
 * over the Workspaces repo and BlobStorage. No authorize: the share page reads the Workspace
 * that issued the shared document, which the token already identified.
 *
 * - `isMember`: a live membership (removed members are not Members).
 * - `branding`: the stored `WorkspaceBranding`.
 * - `logo`: the logo blob, served like `Workspaces.brandingImage("logo")`; `None` when the
 *   Workspace has no logo or its content-addressed blob is gone.
 *
 * The Workspace always exists (a shared document belongs to it), so a missing one is a defect.
 *
 * Requires WorkspacesRepo | BlobStorage.
 */
import type { FileDownload, WorkspaceBranding, WorkspaceId } from "@kvitbit/domain/contract";
import type { BlobKey } from "@kvitbit/domain/ports";
import { BlobStorage } from "@kvitbit/domain/ports";
import { Effect, Layer, Option } from "effect";
import { ShareWorkspaces } from "../modules/sharelinks";
import { WorkspacesRepo } from "../modules/workspaces";

/** The key `WorkspacesLive.setBrandingImage` stores the logo under (live.ts `brandingKey`). */
const logoKey = (workspaceId: WorkspaceId, sha256: string) =>
  `branding/${workspaceId}/logo/${sha256}` as BlobKey;

export const ShareWorkspacesLive: Layer.Layer<
  ShareWorkspaces,
  never,
  WorkspacesRepo | BlobStorage
> = Layer.effect(
  ShareWorkspaces,
  Effect.gen(function* () {
    const repo = yield* WorkspacesRepo;
    const blobs = yield* BlobStorage;
    const workspace = (workspaceId: WorkspaceId) =>
      Effect.catchTag(repo.getWorkspace(workspaceId), "NotFound", (e) => Effect.die(e));
    return ShareWorkspaces.of({
      isMember: (workspaceId, userId) =>
        Effect.map(repo.findMembership(workspaceId, userId), Option.isSome),
      branding: (workspaceId) =>
        Effect.map(workspace(workspaceId), (row) => row.branding as WorkspaceBranding),
      logo: (workspaceId) =>
        Effect.gen(function* () {
          const ref = (yield* workspace(workspaceId)).branding.logo;
          if (ref === null) return Option.none<FileDownload>();
          return yield* blobs.get(logoKey(workspaceId, ref.sha256)).pipe(
            Effect.map((bytes) =>
              Option.some<FileDownload>({
                filename: `logo.${ref.contentType === "image/png" ? "png" : "jpg"}`,
                contentType: ref.contentType,
                bytes,
              }),
            ),
            Effect.catchTag("BlobMissing", () => Effect.succeed(Option.none<FileDownload>())),
          );
        }),
    });
  }),
);
