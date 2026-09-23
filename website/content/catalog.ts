import type { Localized } from "@/lib/i18n";

const en = {
  meta: {
    title: "WISP catalog",
    description: "Every Ghostly WISP draft: searchable, grouped by family, with specification status kept apart from what actually runs.",
  },
  eyebrow: "WISP catalog",
  title: "Every contract, in one place.",
  lead: "Each WISP is an open contract that any app can implement. Here are all of them, by family. Tap one to read it.",
  axes: "Two separate questions: every document is a Draft specification; the badge says whether what it describes runs in the app.",
  search: "Search by number, name or what it does",
  searchLabel: "Search the catalog",
  family: "Family",
  kind: "Kind",
  level: "Availability",
  all: "All",
  kinds: { Contract: "Contract", Adapter: "Adapter", Profile: "Profile", Process: "Process" } as Record<string, string>,
  process: "Process document",
  results: "{n} of {t} drafts",
  none: "Nothing matches. Try a number like 401 or a word like “files”.",
  clear: "Clear filters",
  unassigned: "number to be defined",
  unassignedHelp: "A planned draft whose public number isn't assigned yet; the old file name stays for links.",
  implements: "implements {n}",
  notClassified: "Not yet reviewed for the site",
  read: "Read",
  inventory: {
    title: "Adapter inventory",
    lead: "Candidates from the adapter roadmap. Listed here so links keep working; the roadmap explains order and dependencies. A candidate is not a commitment.",
    cta: "See the roadmap",
  },
  sources: "Catalog sources",
  map: {
    drafts: "drafts",
    contract: "Big tile: the contract, the shared rule of a family",
    adapter: "Small tile: an adapter or profile, one concrete way to follow it",
    color: "Color: whether it already works in the app",
  },
  listTitle: "Search and full list",
};

export type CatalogCopy = typeof en;

const ptBr: CatalogCopy = {
  meta: {
    title: "Catálogo de WISPs",
    description: "Todos os rascunhos WISP do Ghostly: com busca, agrupados por família, com o status da especificação separado do que realmente roda.",
  },
  eyebrow: "Catálogo de WISPs",
  title: "Todos os contratos, num só lugar.",
  lead: "Cada WISP é um contrato aberto que qualquer app pode implementar. Aqui estão todos, por família. Toque num para ler.",
  axes: "Duas perguntas separadas: todo documento é uma especificação em Draft; o selo diz se o que ele descreve roda no app.",
  search: "Busque por número, nome ou função",
  searchLabel: "Buscar no catálogo",
  family: "Família",
  kind: "Tipo",
  level: "Disponibilidade",
  all: "Todos",
  kinds: { Contract: "Contrato", Adapter: "Adapter", Profile: "Perfil", Process: "Processo" },
  process: "Documento de processo",
  results: "{n} de {t} rascunhos",
  none: "Nada encontrado. Tente um número como 401 ou uma palavra como “arquivos”.",
  clear: "Limpar filtros",
  unassigned: "número a definir",
  unassignedHelp: "Um rascunho planejado cujo número público ainda não foi atribuído; o nome antigo do arquivo continua para os links.",
  implements: "implementa {n}",
  notClassified: "Ainda não revisado para o site",
  read: "Ler",
  inventory: {
    title: "Inventário de adapters",
    lead: "Candidatos do roadmap de adapters. Listados aqui para os links continuarem funcionando; o roadmap explica ordem e dependências. Candidato não é compromisso.",
    cta: "Ver o roadmap",
  },
  sources: "Fontes do catálogo",
  map: {
    drafts: "rascunhos",
    contract: "Bloco grande: o contrato, a regra comum da família",
    adapter: "Bloco pequeno: um adapter ou perfil, uma forma concreta de cumprir",
    color: "Cor: se já funciona no app",
  },
  listTitle: "Busca e lista completa",
};

export const catalog: Localized<CatalogCopy> = { en, "pt-br": ptBr };
