import { useLocalSearchParams } from "expo-router";
import { ExpensesListScreen } from "../../../../src/features/expenses/expenses-list-screen";
import { param } from "../../../../src/navigation/routes";

export default function Route() {
  const params = useLocalSearchParams<{ incomplete?: string; text?: string }>();
  const initialIncomplete = param(params.incomplete) === "true";
  const initialSearch = param(params.text);
  return (
    <ExpensesListScreen
      initialIncomplete={initialIncomplete}
      {...(initialSearch !== undefined ? { initialSearch } : {})}
    />
  );
}
