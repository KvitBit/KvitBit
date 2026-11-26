import type { ExpenseId } from "@kvitbit/domain/contract";
import { useLocalSearchParams } from "expo-router";
import { ExpenseCaptureScreen } from "../../../../src/features/expenses/expense-capture-screen";
import { param } from "../../../../src/navigation/routes";

export default function Route() {
  const params = useLocalSearchParams<{ expenseId?: string; captureId?: string }>();
  const targetExpenseId = param(params.expenseId) as ExpenseId | undefined;
  const captureId = param(params.captureId);
  return (
    <ExpenseCaptureScreen
      {...(targetExpenseId === undefined ? {} : { targetExpenseId })}
      {...(captureId === undefined ? {} : { captureId })}
    />
  );
}
