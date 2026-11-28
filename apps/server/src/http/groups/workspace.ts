import { RequestCaller } from "@kvitbit/api-contract";
/** `workspace` group handlers (http-mcp-contracts 3.5.3): Issuing Entity, settings, bank accounts, numbering series and close. */

import { API_PREFIX, Api } from "@kvitbit/api-contract";
import {
  type BankAccountId,
  BankAccountInput,
  BankAccountView,
  Workspaces,
} from "@kvitbit/domain/contract";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Predicate from "effect/Predicate";
import { requestOptions, setLocation, withRevision } from "../conventions";
import { requireFreshSession } from "./workspace/freshSession";

const bankAccountIdOf = (view: BankAccountView): string | undefined =>
  Predicate.isObjectOrArray(view) &&
  Predicate.hasProperty(view, "id") &&
  Predicate.isString(view.id)
    ? view.id
    : undefined;

const bankAccountWithId = (
  payload: BankAccountInput,
  id: BankAccountId,
): BankAccountInput & { readonly id: BankAccountId } => {
  const fields = Predicate.isObject(payload) ? payload : {};
  return { ...BankAccountInput.make(fields), id };
};

export const WorkspaceGroupLive = HttpApiBuilder.group(
  Api,
  "workspace",
  Effect.fnUntraced(function* (handlers) {
    const workspaces = yield* Workspaces;
    return handlers
      .handle("current", () => Effect.flatMap(RequestCaller, workspaces.current))
      .handle("updateIssuingEntity", ({ headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withRevision(headers["if-match"], (expectedRevision) =>
            workspaces.updateIssuingEntity(caller, payload, expectedRevision),
          ),
        ),
      )
      .handle("updateSettings", ({ headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          withRevision(headers["if-match"], (expectedRevision) =>
            workspaces.updateSettings(caller, payload, expectedRevision),
          ),
        ),
      )
      .handle("listBankAccounts", () =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.map(workspaces.current(caller), (view) =>
            Arr.isArray(view["bankAccounts"])
              ? Arr.map(view["bankAccounts"], (account) => BankAccountView.make(account))
              : [],
          ),
        ),
      )
      .handle("createBankAccount", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.tap(
            workspaces.saveBankAccount(caller, payload, requestOptions(headers)),
            (view) => {
              const id = bankAccountIdOf(view);
              if (id === undefined) return Effect.void;
              return setLocation(
                `${API_PREFIX}/workspaces/${params.workspaceId}/bank-accounts/${id}`,
              );
            },
          ),
        ),
      )
      .handle("updateBankAccount", ({ params, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          workspaces.saveBankAccount(caller, bankAccountWithId(payload, params.bankAccountId)),
        ),
      )
      .handle("removeBankAccount", ({ params, query }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          workspaces.removeBankAccount(caller, params.bankAccountId, query.replacement),
        ),
      )
      .handle("listSeries", () => Effect.flatMap(RequestCaller, workspaces.listSeries))
      .handle("createSeries", ({ params, headers, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.tap(workspaces.configureSeries(caller, payload, requestOptions(headers)), (view) =>
            setLocation(
              `${API_PREFIX}/workspaces/${params.workspaceId}/numbering-series/${view.id}`,
            ),
          ),
        ),
      )
      .handle("updateSeries", ({ params, payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          workspaces.configureSeries(caller, { ...payload, id: params.seriesId }),
        ),
      )
      .handle("close", ({ payload }) =>
        Effect.flatMap(RequestCaller, (caller) =>
          Effect.andThen(requireFreshSession, workspaces.close(caller, payload.confirmName)),
        ),
      );
  }),
);
