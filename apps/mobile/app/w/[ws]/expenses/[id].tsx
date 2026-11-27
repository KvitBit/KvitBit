import { ExpenseId } from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";
import { useLocalSearchParams } from "expo-router";
import { ErrorScreen } from "../../../../src/features/auth/error-screen";
import { ExpenseDetailScreen } from "../../../../src/features/expenses/expense-detail-screen";
import { param } from "../../../../src/navigation/routes";

export default function Route() {
  const params = useLocalSearchParams<{ id?: string; mode?: string }>();
  const rawId = param(params.id) ?? "new";
  const mode = param(params.mode) === "edit" ? "edit" : "view";
  const key = `${rawId}:${mode}`;
  if (rawId === "new") return <ExpenseDetailScreen key={key} id={rawId} initialMode={mode} />;
  const id = Schema.decodeOption(ExpenseId)(rawId);
  return id._tag === "Some" ? (
    <ExpenseDetailScreen key={key} id={id.value} initialMode={mode} />
  ) : (
    <ErrorScreen kind="not_found" />
  );
}
