import type { DocumentId, TemplateId } from "@kvitbit/domain/contract";
import { useLocalSearchParams } from "expo-router";
import { DocumentEditorScreen } from "../../../../../src/features/documents/editor-screen";
import { param } from "../../../../../src/navigation/routes";

export default function DocumentEditRoute() {
  const params = useLocalSearchParams<{
    id?: string | string[];
    template?: string | string[];
    revision?: string | string[];
  }>();
  const documentId = (param(params.id) ?? "") as DocumentId;
  const templateId = param(params.template) as TemplateId | undefined;
  const revision = Number(param(params.revision));
  return (
    <DocumentEditorScreen
      key={documentId}
      mode="edit"
      documentId={documentId}
      {...(templateId !== undefined && Number.isSafeInteger(revision)
        ? { templateSource: { id: templateId, revision } }
        : {})}
    />
  );
}
