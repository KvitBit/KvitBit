import type { ExpenseId } from "@kvitbit/domain/contract";
import { useLocalSearchParams } from "expo-router";
import { ExpenseCaptureScreen } from "../../../../src/features/expenses/expense-capture-screen";
import { param } from "../../../../src/navigation/routes";

export default function Route() {
  const params = useLocalSearchParams<{ expenseId?: string }>();
  const targetExpenseId = param(params.expenseId) as ExpenseId | undefined;
  return <ExpenseCaptureScreen {...(targetExpenseId !== undefined ? { targetExpenseId } : {})} />;
}
