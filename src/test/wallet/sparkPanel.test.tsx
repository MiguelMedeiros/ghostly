import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SPARK_PROVIDER } from "@ghostly/core";
import { SparkWalletPanel } from "../../components/SparkWalletPanel";
import { servicesPlatform, type WalletState } from "../../lib/platform";
import { walletView } from "../fakeEngine";
import { renderApp } from "../render";

// covers: wallet.spark.mainnet-key, wallet.spark.send, wallet.spark.lightning

/** Made by the Breez SDK on Breez's regtest: a wallet's address, and an invoice of 1234 sats ("probe") from it. */
const ADDRESS = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkwf2mtr";
const INVOICE = "sparkrt1pgss87y4e569hncpt9649q5s6x7c3vv9lqwrjlucxfl3a3kk355a3pfkzg5qsqgjzqq6p4sscrm8avymnelqhzrus7wz5ptswfhkyef6qcydm9xh65rzyqcg6gy35sxa3w5e20exjmr8xhyl96u3cxqk9ttgwes2xkfepzpp5nmw3zu5aczluq5t2fly3venjcv3cn9fvmtjgwcaae4fw2rqw4fy0nwd082rg0zclp2";
const wallet = servicesPlatform!.wallet;
const ready = (patch: Partial<NonNullable<WalletState["spark"]>> = {}, state: Partial<WalletState> = {}) =>
  walletView({ mode: "testnet", spark: { configured: true, locked: false, network: "regtest", address: ADDRESS, balance: 5_000, history: [], ...patch }, ...state }) as WalletState;
const review = (amount: number, address: string) => ({ id: "rv-1", method: "spark", network: "regtest", provider: SPARK_PROVIDER, asset: "BTC", unit: "sat", address, expiresAt: Date.now() + 60_000,
  payee: address, amount, fee: 0, feeCap: 100, createdAt: Date.now(), state: "pending" });

describe("the Spark panel", () => {
  it("Mainnet asks for a Breez API key, labelled real bitcoin, and opens the wallet with it", async () => {
    const state = walletView({ spark: { configured: false, locked: true, balance: 0, network: "bitcoin", needsKey: true, unavailable: "key" } }) as WalletState;
    const { user, engine } = renderApp(<SparkWalletPanel wallet={wallet} state={state} />);
    engine.on("sparkCreate", () => undefined);
    expect(screen.getByTestId("spark-needs-key")).toHaveTextContent("Mainnet moves real bitcoin");
    expect(screen.getByTestId("spark-mainnet-create")).toBeDisabled();
    await user.type(screen.getByLabelText("Breez API key"), "breez-key");
    await user.click(screen.getByTestId("spark-mainnet-create"));
    expect(engine.callsTo("sparkCreate")).toEqual([{ network: "bitcoin", apiKey: "breez-key" }]);
  });

  it("a Mainnet wallet says it holds real bitcoin", () => {
    renderApp(<SparkWalletPanel wallet={wallet} state={ready({ network: "bitcoin" }, { mode: "mainnet" })} />);
    expect(screen.getByTestId("spark-mainnet-label")).toHaveTextContent("real bitcoin");
  });

  it("shows the balance and the wallet's own address to receive on", () => {
    renderApp(<SparkWalletPanel wallet={wallet} state={ready()} />);
    expect(screen.getByTestId("spark-balance")).toHaveTextContent("5,000");
    expect(screen.getByTestId("spark-address")).toHaveTextContent(ADDRESS);
    expect(screen.getByTestId("spark-address-copy")).toBeInTheDocument();
    expect(screen.queryByTestId("spark-address-link"), "no scheme a wallet agrees on: no broken link").toBeNull();
  });

  it("sends to a Spark address for the amount typed, through a review", async () => {
    const { user, engine } = renderApp(<SparkWalletPanel wallet={wallet} state={ready()} />);
    engine.on("preparePayment", ({ amount, target }) => review(amount, target.address) as never);
    await user.click(screen.getByTestId("wallet-send"));
    await user.type(screen.getByLabelText("Spark address or invoice"), ADDRESS);
    await user.type(screen.getByTestId("spark-amount"), "700");
    await user.click(screen.getByTestId("spark-review"));
    expect(engine.callsTo("preparePayment")).toEqual([expect.objectContaining({ amount: 700, target: expect.objectContaining({ method: "spark", network: "regtest", provider: SPARK_PROVIDER, address: ADDRESS }) })]);
    expect(await screen.findByRole("button", { name: "Approve payment" })).toBeInTheDocument();
  });

  it("an invoice names its amount and memo: nothing to type", async () => {
    const { user, engine } = renderApp(<SparkWalletPanel wallet={wallet} state={ready()} />);
    engine.on("preparePayment", ({ amount, target }) => review(amount, target.address) as never);
    await user.click(screen.getByTestId("wallet-send"));
    await user.click(screen.getByLabelText("Spark address or invoice"));
    await user.paste(INVOICE);
    expect(screen.getByTestId("spark-invoice-summary")).toHaveTextContent("Invoice for 1,234 sats · probe");
    expect(screen.queryByTestId("spark-amount")).toBeNull();
    await user.click(screen.getByTestId("spark-review"));
    expect(engine.callsTo("preparePayment")[0]).toMatchObject({ amount: 1_234, target: { address: INVOICE } });
  });

  it("refuses what is not a Spark string of its network before any review", async () => {
    const { user } = renderApp(<SparkWalletPanel wallet={wallet} state={ready()} />);
    await user.click(screen.getByTestId("wallet-send"));
    await user.type(screen.getByLabelText("Spark address or invoice"), "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080");
    expect(screen.getByTestId("spark-address-invalid")).toHaveTextContent("not a Spark regtest address or invoice");
    expect(screen.getByTestId("spark-review")).toBeDisabled();
  });

  it("offers the same wallet as the Lightning source, and says so once it is", async () => {
    const { user, engine } = renderApp(<SparkWalletPanel wallet={wallet} state={ready()} />);
    engine.on("sparkUseForLightning", () => undefined);
    await user.click(screen.getByTestId("spark-use-lightning"));
    expect(engine.callsTo("sparkUseForLightning")).toHaveLength(1);
  });

  it("with Breez as the Lightning source, it is in use; and the history lists what moved", () => {
    const history = [{ id: "t1", direction: "in" as const, amount: 1_200, fee: 0, at: Date.UTC(2026, 8, 24), status: "completed" as const, via: "spark" as const, memo: "lunch" },
      { id: "t2", direction: "out" as const, amount: 300, fee: 0, at: Date.UTC(2026, 8, 24), status: "pending" as const, via: "lightning" as const }];
    renderApp(<SparkWalletPanel wallet={wallet} state={ready({ history }, { lightning: { providerId: "breez", status: "ready" } as WalletState["lightning"] })} />);
    expect(screen.getByTestId("spark-lightning-on")).toHaveTextContent("In use");
    const rows = screen.getAllByTestId("spark-history-row");
    expect(rows[0]).toHaveTextContent("+1,200Spark · lunch");
    expect(rows[1]).toHaveTextContent("−300Lightning · pending");
  });
});
