import type { CsSection } from "../../types";
import type { errors as en } from "../en/errors";

export const errors = {
  "error.network": "Nelze se spojit s Kvitbitem. Zkontrolujte připojení a zkuste to znovu.",
  "error.offline": "Jste offline.",
  "error.timeout": "Server neodpověděl včas. Zkuste to prosím znovu.",
  "error.cancelled": "Požadavek byl zrušen.",
  "error.unknown": "Na naší straně se něco pokazilo. Zkuste to prosím znovu.",
  "error.unknownWithId": "Na naší straně se něco pokazilo. ID požadavku: {requestId}",
  "error.invalid": "Některá pole vyžadují vaši pozornost.",
  "error.notFound": "Tato položka neexistuje nebo byla odstraněna.",
  "error.forbidden": "Vaše role tuto akci neumožňuje.",
  "error.unauthorized.missing": "Pro pokračování se přihlaste.",
  "error.unauthorized.invalid": "Vaše přihlášení už neplatí. Přihlaste se prosím znovu.",
  "error.unauthorized.expired": "Platnost přihlášení vypršela. Přihlaste se prosím znovu.",
  "error.unauthorized.credential_not_allowed":
    "Tento způsob přihlášení nelze pro tuto akci použít.",
  "error.unauthorized.reauthentication_required":
    "Z bezpečnostních důvodů se prosím přihlaste znovu.",
  "error.invalidBotProof": "Ověření, že nejste robot, vypršelo. Zkuste to znovu.",
  "error.originRejected": "Požadavek přišel z nedůvěryhodné stránky a byl zablokován.",
  "error.preconditionFailed": "Mezitím to změnil někdo jiný.",
  "error.preconditionRequired":
    "Aplikace je zastaralá. Načtěte stránku znovu a zkuste to ještě jednou.",
  "error.payloadTooLarge": "Soubor je příliš velký. Limit je {megabytes} MB.",
  "error.rateLimited": "Příliš mnoho pokusů. Zkuste to znovu za {seconds} s.",
  "error.conflict.revision_changed": "Mezitím to změnil někdo jiný. Načtěte nejnovější verzi.",
  "error.conflict.document_locked": "Tento doklad je uzamčený proti úpravám.",
  "error.conflict.illegal_transition": "Tuto akci nelze v současném stavu provést.",
  "error.conflict.duplicate": "Toto už existuje.",
  "error.conflict.idempotency_mismatch":
    "Tento požadavek už byl odeslán s jinými údaji. Načtěte stránku a zkuste to znovu.",
  "error.unavailable.company_registry": "Registr ARES neodpovídá. Údaje můžete vyplnit ručně.",
  "error.unavailable.exchange_rates": "Kurzy ČNB teď nejsou k dispozici.",
  "error.unavailable.blob_storage": "Úložiště souborů teď není k dispozici. Zkuste to později.",
  "error.unavailable.database": "Kvitbit je dočasně nedostupný. Zkuste to za chvíli.",
  "error.unavailable.retryIn": "Zkuste to znovu za {seconds} s.",
  "error.staleRevision.title": "Stránka není aktuální",
  "error.staleRevision.body":
    "Někdo jiný uložil změny. Načtěte nejnovější verzi a své úpravy proveďte znovu.",
} as const satisfies CsSection<typeof en>;
