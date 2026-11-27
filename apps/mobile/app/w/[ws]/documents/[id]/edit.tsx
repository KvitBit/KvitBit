import { DocumentId } from "@kvitbit/domain/contract";
import * as Schema from "effect/Schema";
import { useLocalSearchParams } from "expo-router";
import { ErrorScreen } from "../../../../../src/features/auth/error-screen";
import { DocumentEditorScreen } from "../../../../../src/features/documents/editor-screen";
import { param } from "../../../../../src/navigation/routes";

export default function DocumentEditRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const documentId = Schema.decodeUnknownOption(DocumentId)(param(params.id));
  if (documentId._tag === "None") return <ErrorScreen kind="not_found" />;
  return <DocumentEditorScreen key={documentId.value} mode="edit" documentId={documentId.value} />;
}
