import type { CsSection } from "../../types";
import type { publicScreens as en } from "../en/public";

export const publicScreens = {
  "public.landing.title": "Fakturace pro české živnostníky a malé firmy",
  "public.landing.subtitle":
    "Vystavte správnou fakturu během pár vteřin z počítače, telefonu nebo AI asistenta.",
  "public.landing.cta.signUp": "Začít zdarma",
  "public.landing.cta.signIn": "Už mám účet",
  "public.landing.feature.compliance.title": "V souladu s českými a unijními předpisy",
  "public.landing.feature.compliance.body":
    "Všechny tři daňové režimy, zákonné náležitosti, opravné daňové doklady i daňové doklady k přijaté platbě.",
  "public.landing.feature.ares.title": "Vyhledání v ARES",
  "public.landing.feature.ares.body": "Zadejte IČO a údaje o firmě se vyplní samy.",
  "public.landing.feature.qr.title": "QR platby",
  "public.landing.feature.qr.body": "QR Platba pro CZK a EPC QR pro EUR na každé faktuře.",
  "public.landing.feature.fx.title": "Cizí měny",
  "public.landing.feature.fx.body": "Denní kurzy ČNB použité přesně tak, jak to vyžaduje zákon.",
  "public.landing.feature.mobile.title": "Hlavně v telefonu",
  "public.landing.feature.mobile.body":
    "Vyfoťte účtenku, odešlete fakturu a zapište platbu kdekoli.",
  "public.landing.feature.mcp.title": "Spolupracuje s AI asistenty",
  "public.landing.feature.mcp.body":
    "Připojte Claude nebo jiného MCP klienta přesně s oprávněními, která zvolíte.",
  "public.landing.selfHosted":
    "Připraveno i pro vlastní hosting: provozujte Kvitbit na svém serveru.",
  "public.landing.signUpDisabled":
    "Registrace je na této instalaci vypnutá. Požádejte provozovatele o pozvánku.",
  "public.landing.language": "Jazyk",

  "public.legal.terms": "Obchodní podmínky",
  "public.legal.privacy": "Ochrana osobních údajů",
  "public.legal.cookies": "Cookies",
  "public.legal.loadFailed": "Tuto stránku se nepodařilo načíst.",
  "public.legal.fallbackLink": "Otevřít jednoduchou verzi",
  "public.footer.copyright": "© {year} Kvitbit",

  "public.androidDownload.title": "Kvitbit pro Android",
  "public.androidDownload.subtitle":
    "Nainstalujte aplikaci přímo nebo ji aktualizujte přes Obtainium.",
  "public.androidDownload.download": "Stáhnout APK",
  "public.androidDownload.version": "Verze {version}",
  "public.androidDownload.size": "Velikost {size}",
  "public.androidDownload.checksum": "Kontrolní součet SHA-256",
  "public.androidDownload.copyChecksum": "Kopírovat kontrolní součet",
  "public.androidDownload.signingCert": "Otisk podpisového certifikátu",
  "public.androidDownload.obtainium.title": "Automatické aktualizace přes Obtainium",
  "public.androidDownload.obtainium.body":
    "Přidejte si Kvitbit do Obtainia a aktualizace dostanete hned po vydání.",
  "public.androidDownload.obtainium.cta": "Přidat do Obtainia",
  "public.androidDownload.releaseFailed":
    "Informace o verzi teď nejsou k dispozici. Obtainium můžete použít i tak.",

  "public.error.not_found.title": "Stránka nenalezena",
  "public.error.not_found.body": "Adresa je možná překlep, nebo stránka byla odstraněna.",
  "public.error.no_access.title": "Bez přístupu",
  "public.error.no_access.body":
    "Nejste členem tohoto pracovního prostoru, nebo vám byl přístup odebrán.",
  "public.error.no_access.switch": "Přepnout pracovní prostor",
  "public.error.server.title": "Něco se pokazilo",
  "public.error.server.body": "Požadavek se nepodařilo dokončit. Zkuste to prosím znovu.",
  "public.error.server.requestId": "ID požadavku: {requestId}",
  "public.error.offline.title": "Jste offline",
  "public.error.offline.body": "Pro pokračování se připojte k internetu.",

  "share.view.title": "{kind} {number}",
  "share.view.from": "Dodavatel: {issuer}",
  "share.view.amountDue": "K úhradě",
  "share.view.dueOn": "Splatnost {date}",
  "share.view.issuedOn": "Vystaveno {date}",
  "share.view.payWithQr": "Zaplaťte QR kódem",
  "share.view.scanHint": "Naskenujte kód v bankovní aplikaci.",
  "share.view.bankDetails": "Platební údaje",
  "share.view.copyIban": "Kopírovat IBAN",
  "share.view.copyVs": "Kopírovat variabilní symbol",
  "share.view.copyAmount": "Kopírovat částku",
  "share.view.notTaxDocument": "Toto je zálohová faktura, nikoli daňový doklad.",
  "share.view.creditNoteFor": "Opravný daňový doklad k dokladu {number}",
  "share.view.paidThanks": "Uhrazeno. Děkujeme!",
  "share.view.cancelled": "Tento doklad byl stornován.",
  "share.view.gone.title": "Tento odkaz už není dostupný",
  "share.view.gone.body": "Požádejte odesílatele o nový odkaz.",
  "share.view.language": "Jazyk dokladu",
  "share.view.downloadFailed": "PDF se nepodařilo stáhnout. Zkuste to znovu.",
  "share.view.issuerPreview": "Prohlížíte si vlastní doklad. Zobrazení se nezapočítávají.",
  "share.view.poweredBy": "Odesláno přes Kvitbit",

  "mcp.consent.title": "{client} žádá o přístup ke Kvitbitu",
  "mcp.consent.redirectHost": "Po schválení se vrátíte na {host}.",
  "mcp.consent.workspace": "Pracovní prostor",
  "mcp.consent.pickWorkspace": "Zvolte pracovní prostor, který aplikace smí používat",
  "mcp.consent.permissions": "Oprávnění",
  "mcp.consent.approve": "Povolit přístup",
  "mcp.consent.deny": "Zamítnout",
  "mcp.consent.noWorkspace": "Nejprve si vytvořte pracovní prostor.",
  "mcp.consent.roleCannotGrant": "Vaše role zde nemůže udělit to, co aplikace požaduje.",
  "mcp.consent.accountantReadOnly": "Jako účetní můžete udělit pouze přístup ke čtení.",
  "mcp.consent.unknownRedirect":
    "Návratová adresa aplikace není registrovaná. Přístup nelze udělit.",
  "mcp.consent.revokeHint": "Přístup můžete kdykoli odebrat v Nastavení, Připojené aplikace.",
  "mcp.consent.expired": "Platnost žádosti vypršela. Spusťte připojení v aplikaci znovu.",

  "invitation.landing.title": "Pozvánka do pracovního prostoru {workspace}",
  "invitation.landing.body": "{inviter} vás zve do pracovního prostoru {workspace} s rolí {role}.",
  "invitation.landing.accept": "Přijmout pozvánku",
  "invitation.landing.signInToAccept": "Pro přijetí se přihlaste",
  "invitation.landing.signUpToAccept": "Pro přijetí si vytvořte účet",
  "invitation.landing.wrongAccount":
    "Pozvánka byla odeslána na {email}. Pro přijetí se přihlaste touto adresou.",
  "invitation.landing.expired": "Platnost pozvánky vypršela. Požádejte o novou.",
  "invitation.landing.revoked": "Tato pozvánka byla zrušena.",
  "invitation.landing.accepted": "Tato pozvánka už byla přijata.",
  "invitation.landing.open": "Otevřít pracovní prostor",
  "invitation.landing.notFound": "Tato pozvánka neexistuje.",
} as const satisfies CsSection<typeof en>;
