//#region ../browser/src/engine/paymentAdapters/providers/bitcoindProvider.ts
/**
* Bitcoin Core as the source picker lists it, and its settings. The client (`./bitcoind`) and btc-signer's
* transaction code load when a wallet connects, not with the app.
*/
var WALLET_NAME = /^[A-Za-z0-9._-]{0,64}$/;
/** `user:password` in the password field (the .cookie file's contents) when no user is given. */
function credentials({ config, secrets }) {
	const password = secrets.password ?? "";
	const user = config.user?.trim() ?? "";
	if (!user && password.includes(":")) {
		const at = password.indexOf(":");
		return {
			user: password.slice(0, at),
			password: password.slice(at + 1)
		};
	}
	return {
		user,
		password
	};
}
var bitcoindRpc = {
	id: "bitcoind",
	label: "Bitcoin Core",
	kind: "onchain",
	description: "A wallet on your own Bitcoin Core node, over its RPC. Your node holds the keys and signs. Needs the desktop app.",
	networks: [
		"bitcoin",
		"testnet",
		"signet",
		"regtest"
	],
	platforms: ["desktop"],
	experimental: true,
	fields: [
		{
			name: "url",
			label: "RPC address",
			kind: "url",
			placeholder: "http://127.0.0.1:8332",
			defaults: {
				mainnet: "http://127.0.0.1:8332",
				testnet: "http://127.0.0.1:38332"
			},
			help: "Your node's rpcbind and rpcport: 8332 mainnet, 38332 signet, 48332 testnet4, 18443 regtest."
		},
		{
			name: "wallet",
			label: "Wallet name",
			kind: "text",
			optional: true,
			placeholder: "ghostly",
			help: "A wallet loaded in the node (bitcoin-cli listwallets). Empty: its default wallet."
		},
		{
			name: "user",
			label: "RPC user",
			kind: "text",
			optional: true,
			help: "Leave empty to paste the .cookie file below."
		},
		{
			name: "password",
			label: "RPC password or cookie",
			kind: "secret",
			help: "rpcpassword, or the contents of the node's .cookie file (it changes when bitcoind restarts)."
		}
	],
	validate(settings) {
		const url = (() => {
			try {
				return new URL(settings.config.url?.trim() ?? "");
			} catch {
				return;
			}
		})();
		if (!url || !["http:", "https:"].includes(url.protocol)) throw new Error("Enter the node's RPC address, like http://127.0.0.1:8332");
		if (url.username || url.password) throw new Error("Put the RPC user and password in their own fields, not in the address");
		if (url.search || url.hash) throw new Error("The RPC address cannot have a query or fragment");
		if (!WALLET_NAME.test(settings.config.wallet?.trim() ?? "") || [".", ".."].includes(settings.config.wallet?.trim() ?? "")) throw new Error("A wallet name has only letters, digits, '-', '_' and '.'");
		const { user, password } = credentials(settings);
		if (!user || !password) throw new Error("Enter the RPC user and password, or paste the .cookie file");
	},
	async create(settings, host) {
		const { BitcoindOnchain, tauriTransport } = await import("./bitcoind-CZchoh43.js");
		return BitcoindOnchain.connect({
			url: settings.config.url.trim(),
			wallet: settings.config.wallet?.trim() ?? "",
			...credentials(settings)
		}, host.mode, tauriTransport(host.invoke), host.signal);
	}
};
//#endregion
export { credentials as n, bitcoindRpc as t };

//# sourceMappingURL=bitcoindProvider-DGw3xBSa.js.map