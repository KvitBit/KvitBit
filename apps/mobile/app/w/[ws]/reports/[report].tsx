import { useLocalSearchParams } from "expo-router";
import {
  currentMonthPeriod,
  isValidPeriod,
  parseReportKind,
} from "../../../../src/features/reports/model";
import { ReportsScreen } from "../../../../src/features/reports/reports-screen";
import { param } from "../../../../src/navigation/routes";

export default function Route() {
  const params = useLocalSearchParams<{ report?: string; period?: string }>();
  const report = parseReportKind(param(params.report));
  const rawPeriod = param(params.period);
  const initialPeriod = isValidPeriod(rawPeriod) ? rawPeriod : currentMonthPeriod();
  return <ReportsScreen report={report} initialPeriod={initialPeriod} />;
}
