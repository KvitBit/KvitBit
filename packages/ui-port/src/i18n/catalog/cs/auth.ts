import type { CsSection } from "../../types";
import type { auth as en } from "../en/auth";

export const auth = {
  "auth.signUp.title": "Vytvořte si účet",
  "auth.signUp.subtitle": "Zdarma, bez platební karty.",
  "auth.signUp.methodPassword": "Použít heslo",
  "auth.signUp.methodPasskey": "Použít přístupový klíč",
  "auth.signUp.passwordHint": "Alespoň 10 znaků.",
  "auth.signUp.acceptTerms": "Souhlasím s obchodními podmínkami a zásadami ochrany osobních údajů",
  "auth.signUp.submit": "Vytvořit účet",
  "auth.signUp.haveAccount": "Už máte účet?",
  "auth.signUp.invitationNote": "Připojíte se k pracovnímu prostoru, do kterého jste byli pozváni.",

  "auth.signIn.title": "Přihlášení do Kvitbitu",
  "auth.signIn.submit": "Přihlásit se",
  "auth.signIn.methodPassword": "Heslo",
  "auth.signIn.methodMagicLink": "Odkaz e-mailem",
  "auth.signIn.methodPasskey": "Přístupový klíč",
  "auth.signIn.withPasskey": "Přihlásit se přístupovým klíčem",
  "auth.signIn.withMagicLink": "Poslat přihlašovací odkaz e-mailem",
  "auth.signIn.withPassword": "Přihlásit se heslem",
  "auth.signIn.sendLink": "Poslat odkaz",
  "auth.signIn.forgotPassword": "Zapomněli jste heslo?",
  "auth.signIn.noAccount": "Jste v Kvitbitu noví?",
  "auth.signIn.or": "nebo",

  "auth.checkEmail.title": "Zkontrolujte e-mail",
  "auth.checkEmail.body":
    "Poslali jsme odkaz na {email}. Pro pokračování jej otevřete na tomto zařízení.",
  "auth.checkEmail.resend": "Poslat e-mail znovu",
  "auth.checkEmail.resendIn": "Znovu odeslat můžete za {seconds} s",
  "auth.checkEmail.resent": "E-mail byl odeslán znovu.",
  "auth.checkEmail.wrongEmail": "Špatná adresa? Vraťte se zpět",

  "auth.link.verifying": "Přihlašujeme vás…",
  "auth.link.expired.title": "Platnost odkazu vypršela",
  "auth.link.expired.body": "Odkazy fungují jen jednou a po čase vyprší. Vyžádejte si nový.",
  "auth.link.sendNew": "Poslat nový odkaz",
  "auth.link.verified": "Váš e-mail je potvrzený.",

  "auth.resetPassword.title": "Obnovení hesla",
  "auth.resetPassword.requestBody": "Zadejte svůj e-mail a pošleme vám odkaz pro obnovení.",
  "auth.resetPassword.send": "Poslat odkaz pro obnovení",
  "auth.resetPassword.newPassword": "Nové heslo",
  "auth.resetPassword.confirmPassword": "Nové heslo znovu",
  "auth.resetPassword.submit": "Nastavit nové heslo",
  "auth.resetPassword.done": "Heslo bylo změněno. Nyní se můžete přihlásit.",

  "auth.botProof.verifying": "Ověřujeme, že nejste robot…",
  "auth.botProof.progress": "Ověřujeme, že nejste robot… {percent} %",
  "auth.botProof.verified": "Ověřeno",
  "auth.botProof.failed": "Ověření se nezdařilo. Zkuste to znovu.",
  "auth.botProof.label": "Ověření, že nejste robot (bez hádanek, probíhá ve vašem zařízení)",

  "auth.passkey.prompt": "Potvrďte otiskem prstu, obličejem nebo bezpečnostním klíčem.",
  "auth.passkey.unsupported": "Toto zařízení nepodporuje přístupové klíče.",
  "auth.genericError": "Přihlášení se nezdařilo. Zkontrolujte údaje a zkuste to znovu.",
} as const satisfies CsSection<typeof en>;
