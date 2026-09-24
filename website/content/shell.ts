import type { Localized } from "@/lib/i18n";
import type { Level } from "@/lib/status";

export const APP_URL = "https://app.ghostly.tools";
export const REPO_URL = "https://github.com/MiguelMedeiros/ghostly";

const en = {
    skip: "Skip to content",
    nav: {
      story: "How it works",
      developers: "Developers",
      wisps: "WISPs",
      roadmap: "Roadmap",
      cli: "CLI",
      open: "Open app",
      menu: "Menu",
      language: "Language",
    },
    footer: {
      tagline: "Find each other through Ghost. Then choose how to talk, what to share and how to trade value.",
      product: "Product",
      developers: "Developers",
      project: "Project",
      links: {
        open: "Open in your browser",
        download: "Download",
        privacy: "Privacy",
        overview: "Build with Ghostly",
        catalog: "WISP catalog",
        protocol: "Protocol docs",
        cli: "CLI",
        roadmap: "Roadmap",
        github: "GitHub",
        releases: "Releases",
        security: "Security",
        contributing: "Contributing",
      },
      haunt: "Haunting the internet with",
      made: "Made by",
      sleeping: "A ghost is sleeping here",
    },
    pet: "Hide the ghost",
    levels: {
      released: "Available",
      development: "In development",
      building: "Being built",
      planned: "Planned",
      research: "Research",
    } satisfies Record<Level, string>,
    levelHelp: {
      released: "In the public release, v{v}.",
      development: "Merged for the next release, {n}. Not in public downloads yet.",
      building: "Being built right now. Not merged.",
      planned: "Designed or proposed. No working version yet.",
      research: "An open question we are investigating.",
    } satisfies Record<Level, string>,
    draft: "Draft",
    englishOnly: "This page is in English.",
};

export type ShellCopy = typeof en;

const ptBr: ShellCopy = {
    skip: "Pular para o conteúdo",
    nav: {
      story: "Como funciona",
      developers: "Desenvolvedores",
      wisps: "WISPs",
      roadmap: "Roadmap",
      cli: "CLI",
      open: "Abrir app",
      menu: "Menu",
      language: "Idioma",
    },
    footer: {
      tagline: "As pessoas se encontram pelo Ghost. Depois escolhem como conversar, o que compartilhar e como trocar valor.",
      product: "Produto",
      developers: "Desenvolvedores",
      project: "Projeto",
      links: {
        open: "Abrir no navegador",
        download: "Baixar",
        privacy: "Privacidade (em inglês)",
        overview: "Construa com o Ghostly",
        catalog: "Catálogo de WISPs",
        protocol: "Docs do protocolo (em inglês)",
        cli: "CLI (em inglês)",
        roadmap: "Roadmap",
        github: "GitHub",
        releases: "Versões",
        security: "Segurança",
        contributing: "Como contribuir",
      },
      haunt: "Assombrando a internet com",
      made: "Feito por",
      sleeping: "Um fantasma dorme aqui",
    },
    pet: "Esconder o fantasma",
    levels: {
      released: "Disponível",
      development: "Em desenvolvimento",
      building: "Sendo construído",
      planned: "Planejado",
      research: "Pesquisa",
    },
    levelHelp: {
      released: "Na versão pública, v{v}.",
      development: "Integrado para a próxima versão, {n}. Ainda não está nos downloads.",
      building: "Em construção agora. Ainda não integrado.",
      planned: "Desenhado ou proposto. Ainda sem versão funcionando.",
      research: "Uma pergunta em aberto que estamos investigando.",
    },
    draft: "Draft",
    englishOnly: "Esta página está em inglês.",
};

export const shell: Localized<ShellCopy> = { en, "pt-br": ptBr };
