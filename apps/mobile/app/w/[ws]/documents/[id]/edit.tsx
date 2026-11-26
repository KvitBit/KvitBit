import type { DocumentId } from "@kvitbit/domain/contract";
import { useLocalSearchParams } from "expo-router";
import { DocumentEditorScreen } from "../../../../../src/features/documents/editor-screen";
import { param } from "../../../../../src/navigation/routes";

export default function DocumentEditRoute() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const documentId = (param(params.id) ?? "") as DocumentId;
  return <DocumentEditorScreen key={documentId} mode="edit" documentId={documentId} />;
}
