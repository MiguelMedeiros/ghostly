export function Footer() {
  return (
    <footer className="border-t border-border/30 py-12 px-6">
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-3">
            <svg className="w-7 h-7 text-cyan" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C7.582 2 4 5.582 4 10v8c0 .75.6 1 1 .6l2-1.6 2 1.6c.4.3.8.3 1.2 0L12 17l1.8 1.6c.4.3.8.3 1.2 0l2-1.6 2 1.6c.4.4 1 .15 1-.6v-8c0-4.418-3.582-8-8-8z"/>
              <circle cx="9" cy="9" r="1.5" className="fill-background"/>
              <circle cx="15" cy="9" r="1.5" className="fill-background"/>
            </svg>
            <span className="text-sm text-gray-500">
              Haunting the internet with{" "}
              <a
                href="https://github.com/pubky/pkarr"
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
              href="https://github.com/MiguelMedeiros/ghostly"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-cyan transition-colors"
            >
              GitHub
            </a>
            <a
              href="https://github.com/pubky/pkarr"
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
            <span className="text-gray-600">•</span>
            <span>
              Made by{" "}
              <a
                href="https://miguelmedeiros.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-cyan transition-colors"
              >
                Miguel Medeiros
              </a>
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
