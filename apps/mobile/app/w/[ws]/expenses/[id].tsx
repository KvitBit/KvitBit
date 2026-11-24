import type { ExpenseId } from "@kvitbit/domain/contract";
import { useLocalSearchParams } from "expo-router";
import { ExpenseDetailScreen } from "../../../../src/features/expenses/expense-detail-screen";
import { param } from "../../../../src/navigation/routes";

export default function Route() {
  const params = useLocalSearchParams<{ id?: string; mode?: string }>();
  const rawId = param(params.id) ?? "new";
  const mode = param(params.mode) === "edit" ? "edit" : "view";
  return (
    <ExpenseDetailScreen id={rawId === "new" ? "new" : (rawId as ExpenseId)} initialMode={mode} />
  );
}
