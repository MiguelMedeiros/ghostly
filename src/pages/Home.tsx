export function Home() {
  return (
    <div className="flex-1 flex items-center justify-center bg-chat-bg">
      <div className="text-center space-y-4 animate-fade-in max-w-md px-6">
        <div className="text-accent text-6xl mb-2">&#9670;</div>
        <h2 className="text-text-primary text-2xl font-light">
          Dead Drop
        </h2>
        <p className="text-text-muted text-sm leading-relaxed">
          Ephemeral encrypted messaging over the DHT.
          <br />
          No server. No accounts. No trace.
        </p>
        <div className="border-t border-border pt-4 mt-6">
          <p className="text-text-muted text-xs leading-relaxed">
            Messages are encrypted and published as DNS records to the Mainline
            DHT via Pkarr. Your private keys never leave this device. Messages
            expire when you stop republishing.
          </p>
        </div>
        <p className="text-text-muted text-xs">
          Create a new drop or join with an invite link from the sidebar.
        </p>
      </div>
    </div>
  );
}
