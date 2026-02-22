export function Footer() {
  return (
    <footer className="border-t border-border/30 py-12 px-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#0f172a] flex items-center justify-center">
              <span className="font-mono text-xs font-bold text-cyan">DD</span>
            </div>
            <span className="text-sm text-gray-500">
              Built with{" "}
              <a
                href="https://pkarr.org"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-cyan transition-colors"
              >
                Pkarr
              </a>
            </span>
          </div>

          <div className="flex items-center gap-6 text-sm text-gray-500">
            <a
              href="https://github.com/miguelmedeiros/pkarr-chat"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-cyan transition-colors"
            >
              GitHub
            </a>
            <a
              href="https://pkarr.org"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-cyan transition-colors"
            >
              Pkarr
            </a>
            <a
              href="https://www.bittorrent.org/beps/bep_0044.html"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-cyan transition-colors"
            >
              BEP44
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}
