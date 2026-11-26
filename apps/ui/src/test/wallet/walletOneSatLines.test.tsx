import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ArkWalletPanel } from "../../components/ArkWalletPanel";
import { BarkWalletPanel } from "../../components/BarkWalletPanel";
import { FedimintWalletPanel } from "../../components/FedimintWalletPanel";
import { TestCoins } from "../../components/wallet/TestCoins";
import { networkState } from "../../components/walletCardData";
import type { WalletPlatform, WalletState } from "../../lib/platform";
import type { Language } from "../../lib/settings";
import { walletView } from "../fakeEngine";
import { arkReady, barkReady, mint, TEST_MINT } from "../payments/fixtures";
import { renderApp } from "../render";

// covers: wallet.ark.recover, wallet.bark.send, wallet.fedimint.notes, wallet.test-coins

/**
 * One sat expired, pending, on-chain, redeemed or on its way from the faucet: the words around the unit take its
 * number too ("1 sat de teste expirou … recupere-o", not "expiraram … recupere-os"), as the unit itself does. Arabic's
 * dual is the unit's own form (`wallet.sats`): read at one only here. Chinese
 * says "它", not "它们", for one; Japanese says every count alike.
 */
type Lines = { expired: string; small: string; sweeping: string; onchain: string; pending: string; redeemed: string; gotPending: string };
const SAID: Partial<Record<Language, Partial<Record<1 | 2, Lines>>>> = {
  en: {
    1: {
      expired: "1 test sat expired before it was renewed. It is still yours: recover it to use it again.",
      small: "1 test sat expired, too little to recover on its own. It is recovered with the next coins that expire.",
      sweeping: "1 test sat expired. You can recover it once the Ark server has swept its batch.",
      onchain: "1 test sat on-chain, not in Ark yet. Moving it is an on-chain transaction: its fee comes off.",
      pending: "1 test sat pending (a round, a board or a Lightning payment): yours, not spendable yet",
      redeemed: "Redeemed 1 test sat.",
      gotPending: "+1 test sat on the way: it shows up here in a few seconds",
    },
    2: {
      expired: "2 test sats expired before they were renewed. They are still yours: recover them to use them again.",
      small: "2 test sats expired, too few to recover on their own. They are recovered with the next coins that expire.",
      sweeping: "2 test sats expired. You can recover them once the Ark server has swept their batch.",
      onchain: "2 test sats on-chain, not in Ark yet. Moving them is an on-chain transaction: its fee comes off.",
      pending: "2 test sats pending (a round, a board or a Lightning payment): yours, not spendable yet",
      redeemed: "Redeemed 2 test sats.",
      gotPending: "+2 test sats on the way: it shows up here in a few seconds",
    },
  },
  pt: {
    1: {
      expired: "1 sat de teste expirou antes de ser renovado. Continua sendo seu: recupere-o para usá-lo de novo.",
      small: "1 sat de teste expirou, pouco demais para recuperar sozinho. Ele será recuperado com as próximas moedas que expirarem.",
      sweeping: "1 sat de teste expirou. Você poderá recuperá-lo quando o servidor Ark tiver varrido o lote dele.",
      onchain: "1 sat de teste on-chain, ainda fora do Ark. Movê-lo é uma transação on-chain: a taxa é descontada.",
      pending: "1 sat de teste pendente (uma rodada, um embarque ou um pagamento Lightning): seu, mas ainda não gastável",
      redeemed: "1 sat de teste resgatado.",
      gotPending: "+1 sat de teste a caminho: aparece aqui em alguns segundos",
    },
    2: {
      expired: "2 sats de teste expiraram antes de serem renovados. Continuam sendo seus: recupere-os para usá-los de novo.",
      small: "2 sats de teste expiraram, poucos demais para recuperar sozinhos. Eles serão recuperados com as próximas moedas que expirarem.",
      sweeping: "2 sats de teste expiraram. Você poderá recuperá-los quando o servidor Ark tiver varrido o lote deles.",
      onchain: "2 sats de teste on-chain, ainda fora do Ark. Movê-los é uma transação on-chain: a taxa é descontada.",
      pending: "2 sats de teste pendentes (uma rodada, um embarque ou um pagamento Lightning): seus, mas ainda não gastáveis",
      redeemed: "2 sats de teste resgatados.",
      gotPending: "+2 sats de teste a caminho: aparece aqui em alguns segundos",
    },
  },
  es: {
    1: {
      expired: "1 sat de prueba caducó antes de renovarse. Sigue siendo tuyo: recupéralo para volver a usarlo.",
      small: "1 sat de prueba caducó, demasiado poco para recuperarlo solo. Se recupera con las próximas monedas que caduquen.",
      sweeping: "1 sat de prueba caducó. Podrás recuperarlo cuando el servidor Ark haya barrido su lote.",
      onchain: "1 sat de prueba on-chain, aún no en Ark. Moverlo es una transacción on-chain: se descuenta su comisión.",
      pending: "1 sat de prueba pendiente (una ronda, un embarque o un pago Lightning): tuyo, pero aún no gastable",
      redeemed: "Canjeado 1 sat de prueba.",
      gotPending: "+1 sat de prueba en camino: aparece aquí en unos segundos",
    },
  },
  fr: {
    1: {
      expired: "1 sat de test a expiré avant d'être renouvelé. Il est toujours à vous : récupérez-le pour l'utiliser à nouveau.",
      small: "1 sat de test a expiré, trop peu pour être récupéré seul. Il est récupéré avec les prochaines pièces qui expirent.",
      sweeping: "1 sat de test a expiré. Vous pourrez le récupérer une fois que le serveur Ark aura balayé son lot.",
      onchain: "1 sat de test on-chain, pas encore dans Ark. Le transférer est une transaction on-chain : ses frais sont déduits.",
      pending: "1 sat de test en attente (un round, un embarquement ou un paiement Lightning) : à vous, mais pas encore dépensable",
      redeemed: "1 sat de test encaissé.",
      gotPending: "+1 sat de test en route : il arrive ici dans quelques secondes",
    },
  },
  it: {
    1: {
      expired: "1 sat di prova è scaduto prima di essere rinnovato. È ancora tuo: recuperalo per usarlo di nuovo.",
      small: "1 sat di prova è scaduto, troppo poco per recuperarlo da solo. Viene recuperato con le prossime monete che scadono.",
      sweeping: "1 sat di prova è scaduto. Potrai recuperarlo quando il server Ark avrà spazzato il suo lotto.",
      onchain: "1 sat di prova on-chain, non ancora in Ark. Spostarlo è una transazione on-chain: la commissione viene detratta.",
      pending: "1 sat di prova in sospeso (un round, un imbarco o un pagamento Lightning): tuo, ma non ancora spendibile",
      redeemed: "Riscattato 1 sat di prova.",
      gotPending: "+1 sat di prova in arrivo: compare qui tra pochi secondi",
    },
  },
  ar: {
    1: {
      expired: "انتهت صلاحية 1 sat تجريبي قبل تجديده. لا يزال ملكك: استردّه لتستخدمه مجددًا.",
      small: "انتهت صلاحية 1 sat تجريبي، وهو أقل من أن يُسترد وحده. سيُسترد مع العملات التالية التي تنتهي صلاحيتها.",
      sweeping: "انتهت صلاحية 1 sat تجريبي. يمكنك استرداده بعد أن يكنس خادم Ark دفعته.",
      onchain: "1 sat تجريبي على السلسلة، ليس في Ark بعد. نقله معاملة على السلسلة: تُخصم رسومها.",
      pending: "1 sat تجريبي معلّق (جولة أو صعود أو دفعة Lightning): ملكك، لكنه غير قابل للإنفاق بعد",
      redeemed: "استُردّ 1 sat تجريبي.",
      gotPending: "+1 sat تجريبي في الطريق: يظهر هنا خلال ثوانٍ",
    },
  },
  zh: {
    1: {
      expired: "1 测试 sat 在续期前已过期。它仍然属于你：取回后即可再次使用。",
      small: "1 测试 sat 已过期，数额太小，无法单独取回。它会与下一批过期的币一起取回。",
      sweeping: "1 测试 sat 已过期。Ark 服务器清扫其批次后即可取回。",
      onchain: "1 测试 sat 在链上，尚未转入 Ark。转移是一笔链上交易：会扣除其手续费。",
      pending: "1 测试 sat 待处理（一轮、一次登船或一笔 Lightning 付款）：属于你，但暂不可用",
      redeemed: "已兑换 1 测试 sat。",
      gotPending: "+1 测试 sat 正在到账：几秒后显示在这里",
    },
  },
};

const onTestnet = (patch: Parameters<typeof walletView>[0]) => networkState(walletView(patch) as WalletState, "testnet");
const federation = { id: "a".repeat(64), name: "Alpha", balance: 5_000, status: "ready" as const, lightning: false, invite: "fed1a",
  guardians: [{ id: 0, name: "g0" }], consensusVersion: "2.1", network: "regtest", modules: ["mint"] };

describe("one sat on the Ark, Bark and Fedimint cards and from the test faucet", () => {
  for (const [language, counts] of Object.entries(SAID) as [Language, Partial<Record<1 | 2, Lines>>][]) {
    for (const [n, lines] of Object.entries(counts) as [string, Lines][]) {
      const amount = Number(n);

      it(`${language}: ${amount} sat expired on the Ark card reads in its number`, () => {
        const wallet = {} as WalletPlatform;
        const sweeping = renderApp(<ArkWalletPanel wallet={wallet} state={onTestnet({ ark: arkReady({ network: "regtest", sweeping: amount, small: amount }) })} />, { language });
        expect(screen.getByTestId("ark-sweeping")).toHaveTextContent(lines.sweeping);
        expect(screen.getByTestId("ark-small")).toHaveTextContent(lines.small);
        sweeping.unmount();
        renderApp(<ArkWalletPanel wallet={wallet} state={onTestnet({ ark: arkReady({ network: "regtest", recoverable: amount }) })} />, { language });
        expect(screen.getByTestId("ark-recoverable")).toHaveTextContent(lines.expired);
      });

      it(`${language}: ${amount} sat pending and on-chain on the Bark card reads in its number`, () => {
        renderApp(<BarkWalletPanel wallet={{} as WalletPlatform} state={onTestnet({ bark: barkReady({ pending: amount, onchain: amount }) })} />, { language });
        expect(screen.getByTestId("bark-pending")).toHaveTextContent(lines.pending);
        expect(screen.getByTestId("bark-onchain")).toHaveTextContent(lines.onchain);
      });

      it(`${language}: ${amount} sat redeemed on the Fedimint card reads in its number`, async () => {
        const wallet = { fedimintReceiveNotes: async () => ({ amount }) } as unknown as WalletPlatform;
        const state = walletView({ mode: "testnet", fedimint: { federations: [federation], balance: 5_000, history: [] } as never }) as WalletState;
        const { user } = renderApp(<FedimintWalletPanel wallet={wallet} state={state} />, { language });
        await user.type(screen.getByTestId("fedimint-notes-in"), "notes-in-1");
        await user.click(screen.getByTestId("fedimint-redeem"));
        expect(await screen.findByTestId("fedimint-redeemed")).toHaveTextContent(lines.redeemed);
      });

      it(`${language}: ${amount} test sat on its way from the faucet reads in its number`, async () => {
        const wallet = { testCoins: async () => ({ amount, unit: "test sats", pending: true }) } as unknown as WalletPlatform;
        const { user } = renderApp(<TestCoins rail="cashu" network="testnet" wallet={wallet} state={onTestnet({ mints: [mint(TEST_MINT, 0)] })} />, { language });
        await user.click(screen.getByTestId("test-coins-get"));
        expect(await screen.findByTestId("test-coins-result")).toHaveTextContent(lines.gotPending);
      });
    }
  }
});
