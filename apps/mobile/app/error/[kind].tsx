import { useLocalSearchParams } from "expo-router";
import { ErrorScreen, parseErrorKind } from "../../src/features/auth/error-screen";
import { param } from "../../src/navigation/routes";

export default function ErrorRoute() {
  const params = useLocalSearchParams<{
    readonly kind?: string | string[];
    readonly requestId?: string | string[];
  }>();
  const requestId = param(params.requestId);
  return (
    <ErrorScreen
      kind={parseErrorKind(param(params.kind))}
      {...(requestId !== undefined ? { requestId } : {})}
    />
  );
}
