import { withoutStackTrace } from "../helpers/run";
/** ShareWorkspacesLive over the real Workspaces layers (memory repo, memory BlobStorage). */

import { describe, expect, test } from "bun:test";
import { BlobStorage, BlobUnavailable } from "@kvitbit/domain/ports";
import * as EffectArray from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
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

const png = (byteLength = 64) => {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const size = (bytes: Stream.Stream<Uint8Array>) =>
  Effect.map(Stream.runCollect(bytes), (all) =>
    EffectArray.reduce(all, 0, (n, c) => n + c.byteLength),
  );
const SW = Effect.service(ShareWorkspaces);

describe("ShareWorkspacesLive", () => {
  test("isMember: live memberships of that Workspace only", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const other = yield* as(accountOf(OUTSIDER))(
          ws.create(accountOf(OUTSIDER), { name: "Jiná s.r.o." }),
        );
        yield* as(s.member)(ws.leave(s.member));
        const share = yield* SW;
        const isMemberResult = yield* share.isMember(s.workspaceId, OWNER);
        expect(isMemberResult).toBe(true);
        const isMemberResult2 = yield* share.isMember(s.workspaceId, OUTSIDER);
        expect(isMemberResult2).toBe(false);
        const isMemberResult3 = yield* share.isMember(s.workspaceId, MEMBER);
        // Left the Workspace: no longer a Member.
        expect(isMemberResult3).toBe(false);
        const isMemberResult4 = yield* share.isMember(other.workspaceId, OWNER);
        expect(isMemberResult4).toBe(false);
        const isMemberResult5 = yield* share.isMember(other.workspaceId, OUTSIDER);
        expect(isMemberResult5).toBe(true);
      }).pipe(Effect.provide(ShareWorkspacesLive)),
    ));

  test("branding and logo follow the Workspace's settings and image", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        const share = yield* SW;
        const current = yield* as(s.member)(ws.current(s.member));
        const brandingResult = yield* share.branding(s.workspaceId);
        expect(current.branding).toEqual(brandingResult);
        // No logo yet.
        (yield* share.logo(s.workspaceId)).pipe(Option.isNone, expect).toBe(true);

        const ref = yield* as(s.admin)(
          ws.setBrandingImage(s.admin, "logo", {
            contentType: "image/png",
            bytes: Stream.make(png(900)),
          }),
        );
        expect((yield* share.branding(s.workspaceId)).logo).toEqual(ref);
        const logo = yield* share.logo(s.workspaceId);
        if (Option.isNone(logo)) throw new Error("expected a logo");
        expect(logo.value).toMatchObject({ filename: "logo.png", contentType: "image/png" });
        const result = yield* size(logo.value.bytes);
        expect(result).toBe(900);

        // A missing blob reads as no logo (as brandingImage's NotFound).
        const blobs = yield* MemoryBlobStorage;
        yield* Ref.set(blobs.blobs, new Map());
        (yield* share.logo(s.workspaceId)).pipe(Option.isNone, expect).toBe(true);

        yield* as(s.admin)(ws.removeBrandingImage(s.admin, "logo"));
        expect((yield* share.branding(s.workspaceId)).logo).toBeNull();
      }).pipe(Effect.provide(ShareWorkspacesLive)),
    ));

  test("logo: a BlobStorage failure is BlobUnavailable", () =>
    scenario(
      Effect.gen(function* () {
        const ws = yield* W;
        const s = yield* seed();
        yield* as(s.admin)(
          ws.setBrandingImage(s.admin, "logo", {
            contentType: "image/png",
            bytes: Stream.make(png()),
          }),
        );
        const real = yield* BlobStorage;
        const failing = Layer.succeed(BlobStorage, {
          ...real,
          get: () => Effect.fail(BlobUnavailable.make({ cause: "down" })),
        });
        const exit = yield* Effect.exit(
          Effect.flatMap(SW, (share) => share.logo(s.workspaceId)).pipe(
            Effect.provide(ShareWorkspacesLive.pipe(Layer.provide(failing))),
          ),
        );
        expect(exit.pipe(withoutStackTrace)).toEqual(
          Exit.fail(BlobUnavailable.make({ cause: "down" })),
        );
      }),
    ));
});
