/**
 * Workspaces module (core-ports 4.1). The parent integration wires `WorkspacesLive` into the
 * package entry point; until then everything is exported from here.
 *
 * `WorkspacesLive` requires CoreStore | IdGenerator | WorkspacesRepo | WorkspaceSeries |
 * UserDirectory | RegistryLookup | BlobStorage | InvitationDelivery | BrandingPreview |
 * BankAccountReferences. `RegistryLookup` is shared with `Contacts.fromIco` (W9), so it is
 * required, never provided here.
 */
import { Layer } from "effect";
import { WorkspacesLive } from "./live";
import {
  BankAccountReferencesFake,
  BrandingPreviewFake,
  CaptureInvitationDelivery,
  type DirectoryUser,
  UserDirectoryFake,
  WorkspaceSeriesMemory,
} from "./ports";
import { RegistryLookup } from "./registry";
import { WorkspacesRepoMemory } from "./repo";
import { WorkspaceSnapshotsLive } from "./snapshots";

export type { WorkspacesImpl, WorkspacesRequirements } from "./live";
export { MemberCallerSchema, makeWorkspaces, WorkspacesLive } from "./live";
export * from "./model";
export * from "./ports";
export {
  icoChecksumInvalid,
  isValidIco,
  REGISTRY_CACHE_TTL,
  RegistryLookup,
  validateIco,
} from "./registry";
export * from "./repo";
export { isValidIban, pragueDate, regimeOn, slugify } from "./rules";
export * from "./snapshots";

/**
 * `WorkspacesLive` + `WorkspaceSnapshotsLive` on in-memory repositories and fakes. Requires the
 * ports of `InMemoryPortsLive` (CoreStore | MemoryTables | IdGenerator | CompanyRegistry |
 * BlobStorage); provides the fakes' controls too.
 */
export const WorkspacesTestLayer = (users: ReadonlyArray<DirectoryUser> = []) => {
  const deps = Layer.mergeAll(
    WorkspacesRepoMemory,
    WorkspaceSeriesMemory,
    UserDirectoryFake.layer(users),
    RegistryLookup.layer,
    CaptureInvitationDelivery.layer,
    BrandingPreviewFake,
    BankAccountReferencesFake.layer,
  );
  return Layer.mergeAll(WorkspacesLive, WorkspaceSnapshotsLive).pipe(Layer.provideMerge(deps));
};
