import type { Localized } from "@/lib/i18n";
import type { InviteRefusal } from "@/lib/invite";

/** The join page: what a visit to ghostly.tools/#ghostly1… shows over the page. */
const en = {
  title: "You're invited to a chat",
  lead: "Someone sent you a Ghostly invite. Open it where you use Ghostly.",
  browser: "Open in your browser",
  desktop: "Open in the desktop app",
  desktopCopied: "Invite copied. In Ghostly, choose Join, then Paste.",
  desktopCopyFailed: "Could not copy. Copy this invite, then choose Join in Ghostly:",
  download: "Download Ghostly",
  private: "The invite stays in this browser. It was never sent to ghostly.tools.",
  close: "Close",
  refusedTitle: "This invite can't be opened",
  refused: {
    typo: "This code has a typo. Check it, or ask for the code again.",
    update: "This invite was made by a newer Ghostly. Update to join.",
    "not-ghostly": "This is not a Ghostly invite.",
    damaged: "This invite is damaged. Ask for a new one.",
  } satisfies Record<InviteRefusal, string>,
};

export type JoinCopy = typeof en;

const ptBr: JoinCopy = {
  title: "Você recebeu um convite para conversar",
  lead: "Alguém te enviou um convite do Ghostly. Abra onde você usa o Ghostly.",
  browser: "Abrir no navegador",
  desktop: "Abrir no app para desktop",
  desktopCopied: "Convite copiado. No Ghostly, escolha Entrar e depois Colar.",
  desktopCopyFailed: "Não deu para copiar. Copie este convite e escolha Entrar no Ghostly:",
  download: "Baixar o Ghostly",
  private: "O convite fica neste navegador. Ele nunca foi enviado ao ghostly.tools.",
  close: "Fechar",
  refusedTitle: "Não dá para abrir este convite",
  refused: {
    typo: "Este código tem um erro de digitação. Confira ou peça o código de novo.",
    update: "Este convite foi criado por um Ghostly mais novo. Atualize para entrar.",
    "not-ghostly": "Isto não é um convite do Ghostly.",
    damaged: "Este convite está danificado. Peça um novo.",
  },
};

export const join: Localized<JoinCopy> = { en, "pt-br": ptBr };
