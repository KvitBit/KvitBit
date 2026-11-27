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
          Arr.isArray(view.bankAccounts)
            ? Arr.map(view.bankAccounts, (account) => BankAccountView.make(account))
            : [],
        ),
      )
      .handle("createBankAccount", ({ params, headers, payload }) =>
        Effect.tap(workspaces.saveBankAccount(payload, requestOptions(headers)), (view) => {
          const id = bankAccountIdOf(view);
          if (id === undefined) return Effect.void;
          return setLocation(`${API_PREFIX}/workspaces/${params.workspaceId}/bank-accounts/${id}`);
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
