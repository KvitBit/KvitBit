import { ExpenseId } from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";
import { useLocalSearchParams } from "expo-router";
import { ErrorScreen } from "../../../../src/features/auth/error-screen";
import { ExpenseCaptureScreen } from "../../../../src/features/expenses/expense-capture-screen";
import { param } from "../../../../src/navigation/routes";

export default function Route() {
  const params = useLocalSearchParams<{ expenseId?: string; captureId?: string }>();
  const target = Schema.decodeOption(Schema.UndefinedOr(ExpenseId))(param(params.expenseId));
  if (target._tag === "None") return <ErrorScreen kind="not_found" />;
  const targetExpenseId = target.value;
  const captureId = param(params.captureId);
  return (
    <ExpenseCaptureScreen
      {...(targetExpenseId === undefined ? {} : { targetExpenseId })}
      {...(captureId === undefined ? {} : { captureId })}
    />
  );
}
