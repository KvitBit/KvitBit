/** `workspace` group handlers (http-mcp-contracts 3.5.3): Issuing Entity, settings, bank accounts, numbering series and close. */
import { API_PREFIX, Api } from "@kvitbit/api-contract";
import {
  type BankAccountId,
  type BankAccountInput,
  type BankAccountView,
  Workspaces,
} from "@kvitbit/domain/contract";
import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { requestOptions, setLocation, withRevision } from "../conventions";
import { requireFreshSession } from "./workspace/freshSession";

const bankAccountIdOf = (view: BankAccountView): string | undefined =>
  typeof view === "object" &&
  view !== null &&
  "id" in view &&
  typeof (view as { readonly id?: unknown }).id === "string"
    ? (view as { readonly id: string }).id
    : undefined;

const bankAccountWithId = (
  payload: BankAccountInput,
  id: BankAccountId,
): BankAccountInput & { readonly id: BankAccountId } =>
  (typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? { ...(payload as unknown as Record<string, unknown>), id }
    : { id }) as unknown as BankAccountInput & { readonly id: BankAccountId };

export const WorkspaceGroupLive = HttpApiBuilder.group(Api, "workspace", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    return handlers
      .handle("current", () => workspaces.current)
      .handle("updateIssuingEntity", ({ headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          workspaces.updateIssuingEntity(payload, expectedRevision),
        ),
      )
      .handle("updateSettings", ({ headers, payload }) =>
        withRevision(headers["if-match"], (expectedRevision) =>
          workspaces.updateSettings(payload, expectedRevision),
        ),
      )
      .handle("listBankAccounts", () =>
        Effect.map(workspaces.current, (view) =>
          Array.isArray(view.bankAccounts)
            ? (view.bankAccounts as ReadonlyArray<BankAccountView>)
            : [],
        ),
      )
      .handle("createBankAccount", ({ params, headers, payload }) =>
        Effect.tap(workspaces.saveBankAccount(payload, requestOptions(headers)), (view) => {
          const id = bankAccountIdOf(view);
          return id === undefined
            ? Effect.void
            : setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/bank-accounts/${id}`);
        }),
      )
      .handle("updateBankAccount", ({ params, payload }) =>
        workspaces.saveBankAccount(bankAccountWithId(payload, params.bankAccountId)),
      )
      .handle("removeBankAccount", ({ params, query }) =>
        workspaces.removeBankAccount(params.bankAccountId, query.replacement),
      )
      .handle("listSeries", () => workspaces.listSeries)
      .handle("createSeries", ({ params, headers, payload }) =>
        Effect.tap(workspaces.configureSeries(payload, requestOptions(headers)), (view) =>
          setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/numbering-series/${view.id}`),
        ),
      )
      .handle("updateSeries", ({ params, payload }) =>
        workspaces.configureSeries({ ...payload, id: params.seriesId }),
      )
      .handle("close", ({ payload }) =>
        Effect.andThen(requireFreshSession, workspaces.close(payload.confirmName)),
      );
  }),
);
