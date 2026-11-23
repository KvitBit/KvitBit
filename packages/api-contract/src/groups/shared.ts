/** Helpers shared by the group definitions. */
import {
  Conflict,
  Forbidden,
  Invalid,
  NotFound,
  Unavailable,
  WorkspaceId,
} from "@kvitbit/domain/contract";

/**
 * Every Workspace endpoint declares `workspaceId` itself: the group prefix carries
 * `:workspaceId`, and HttpApiClient fills path segments only from the endpoint's `params`.
 */
export const WorkspaceParams = { workspaceId: WorkspaceId };

/** The five core errors, for endpoints whose tables say "core errors". */
export const CoreErrors = [
  NotFound.schema,
  Forbidden.schema,
  Invalid.schema,
  Conflict.schema,
  Unavailable.schema,
] as const;
