/** ShareWorkspacesLive over the real Workspaces layers (memory repo, memory BlobStorage). */
import { describe, expect, test } from "bun:test";
import { BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import { Effect, Exit, Layer, Option, Ref, Stream } from "effect";
import { ShareWorkspacesLive } from "../../src/compose/shareWorkspaces";
import { ShareWorkspaces } from "../../src/modules/sharelinks";
import { MemoryBlobStorage } from "../../src/testing";
import {
  accountOf,
  as,
  MEMBER,
  OUTSIDER,
  OWNER,
  scenario,
  seed,
  W,
} from "../modules/workspaces/harness";

const png = (size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const size = (bytes: Stream.Stream<Uint8Array>) =>
  Effect.map(Stream.runCollect(bytes), (all) => all.reduce((n, c) => n + c.byteLength, 0));
const SW = Effect.service(ShareWorkspaces);

describe("ShareWorkspacesLive", () => {
  test("isMember: live memberships of that Workspace only", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const other = yield* as(accountOf(OUTSIDER))(ws.create({ name: "Jiná s.r.o." } as never));
        yield* as(s.member)(ws.leave);
        const share = yield* SW;
        expect(yield* share.isMember(s.workspaceId, OWNER)).toBe(true);
        expect(yield* share.isMember(s.workspaceId, OUTSIDER)).toBe(false);
        // Left the Workspace: no longer a Member.
        expect(yield* share.isMember(s.workspaceId, MEMBER)).toBe(false);
        expect(yield* share.isMember(other.workspaceId, OWNER)).toBe(false);
        expect(yield* share.isMember(other.workspaceId, OUTSIDER)).toBe(true);
      }).pipe(Effect.provide(ShareWorkspacesLive)),
    ));

  test("branding and logo follow the Workspace's settings and image", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const share = yield* SW;
        const current = (yield* as(s.member)(ws.current)) as unknown as {
          readonly branding: unknown;
        };
        expect(yield* share.branding(s.workspaceId)).toEqual(current.branding as never);
        // No logo yet.
        expect(Option.isNone(yield* share.logo(s.workspaceId))).toBe(true);

        const ref = yield* as(s.admin)(
          ws.setBrandingImage("logo", { contentType: "image/png", bytes: Stream.make(png(900)) }),
        );
        expect((yield* share.branding(s.workspaceId)).logo).toEqual(ref);
        const logo = yield* share.logo(s.workspaceId);
        if (Option.isNone(logo)) throw new Error("expected a logo");
        expect(logo.value).toMatchObject({ filename: "logo.png", contentType: "image/png" });
        expect(yield* size(logo.value.bytes)).toBe(900);

        // A missing blob reads as no logo (as brandingImage's NotFound).
        const blobs = yield* MemoryBlobStorage;
        yield* Ref.set(blobs.blobs, new Map());
        expect(Option.isNone(yield* share.logo(s.workspaceId))).toBe(true);

        yield* as(s.admin)(ws.removeBrandingImage("logo"));
        expect((yield* share.branding(s.workspaceId)).logo).toBeNull();
      }).pipe(Effect.provide(ShareWorkspacesLive)),
    ));

  test("logo: a BlobStorage failure is BlobUnavailable", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.admin)(
          ws.setBrandingImage("logo", { contentType: "image/png", bytes: Stream.make(png()) }),
        );
        const real = yield* BlobStorage;
        const failing = Layer.succeed(BlobStorage, {
          ...real,
          get: () => Effect.fail(new BlobUnavailable({ cause: "down" })),
        });
        const exit = yield* Effect.exit(
          Effect.flatMap(SW, (share) => share.logo(s.workspaceId)).pipe(
            Effect.provide(ShareWorkspacesLive.pipe(Layer.provide(failing))),
          ),
        );
        expect(exit).toEqual(Exit.fail(new BlobUnavailable({ cause: "down" })));
      }),
    ));
});
