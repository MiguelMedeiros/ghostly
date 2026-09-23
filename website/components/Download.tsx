import { DOWNLOADS, RELEASE_URL, VERSION } from "@/lib/release";
import { Icon } from "./icons";

const desktopDownloads = [
  {
    os: "macOS",
    links: [
      { label: "Apple Silicon", href: DOWNLOADS.macArm },
      { label: "Intel", href: DOWNLOADS.macIntel },
    ],
  },
  {
    os: "Windows",
    links: [
      { label: ".exe", href: DOWNLOADS.windowsExe },
      { label: ".msi", href: DOWNLOADS.windowsMsi },
    ],
  },
  {
    os: "Linux",
    links: [
      { label: ".deb", href: DOWNLOADS.linuxDeb },
      { label: ".AppImage", href: DOWNLOADS.linuxAppImage },
    ],
  },
];

export function Download() {
  return (
    <section
      id="download"
      className="landing-section download-section"
      aria-labelledby="download-heading"
    >
      <div className="landing-wrap">
        <div className="section-heading horizontal-heading">
          <div>
            <p className="eyebrow">Same Ghostly. Your choice of home.</p>
            <h2 id="download-heading">
              Start in a tab.
              <br />
              Stay where you like.
            </h2>
          </div>
          <p>
            One protocol across web, desktop and extension.
            <br />
            <a
              className="quiet-link"
              href={RELEASE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Release v{VERSION} <span aria-hidden="true">↗</span>
            </a>
          </p>
        </div>
        <div className="client-options" id="clients">
          <article className="client-option recommended">
            <div className="client-top">
              <Icon name="globe" />
              <span>THE EASIEST WAY TO TRY</span>
            </div>
            <h3>Web app</h3>
            <p>
              Open a tab on your computer or phone. Start connecting without
              installing anything.
            </p>
            <ul>
              <li>
                <Icon name="check" />
                Chat, calls, files & sats
              </li>
              <li>
                <Icon name="check" />
                Add to your phone’s home screen
              </li>
            </ul>
            <a
              className="landing-button primary"
              href="https://app.ghostly.tools"
              target="_blank"
              rel="noopener noreferrer"
            >
              Open Ghostly <span aria-hidden="true">↗</span>
            </a>
            <p className="client-note">
              Keep the tab open to stay online. Local apps need desktop or the
              extension. Screen sharing needs a computer.
            </p>
          </article>
          <article className="client-option">
            <div className="client-top">
              <Icon name="desktop" />
              <span>MACOS · WINDOWS · LINUX</span>
            </div>
            <h3>Desktop app</h3>
            <p>
              A dedicated home for Ghostly, with local app sharing and direct
              access to the DHT.
            </p>
            <ul>
              <li>
                <Icon name="check" />
                Chat, calls, files & sats
              </li>
              <li>
                <Icon name="check" />
                Share and open local apps
              </li>
            </ul>
            <div className="desktop-downloads">
              {desktopDownloads.map((platform) => (
                <div key={platform.os}>
                  <span>{platform.os}</span>
                  <div>
                    {platform.links.map((link) => (
                      <a
                        key={link.label}
                        href={link.href}
                        aria-label={`Download Ghostly for ${platform.os}: ${link.label}`}
                      >
                        {link.label} <span aria-hidden="true">↓</span>
                      </a>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <p className="client-note">
              WebRTC support depends on your platform’s WebView. See the{" "}
              <a
                href="https://github.com/MiguelMedeiros/ghostly/blob/main/docs/INSTALLATION.md"
                target="_blank"
                rel="noopener noreferrer"
              >
                installation guide
              </a>
              .
            </p>
          </article>
          <article className="client-option" id="extension">
            <div className="client-top">
              <Icon name="puzzle" />
              <span>CHROME · BRAVE · EDGE</span>
            </div>
            <h3>Browser extension</h3>
            <p>
              Keep your peer running while the browser is open, and bring your
              local apps along.
            </p>
            <ul>
              <li>
                <Icon name="check" />
                Chat, calls, files & sats
              </li>
              <li>
                <Icon name="check" />
                Share and open local apps
              </li>
            </ul>
            <a
              className="landing-button secondary"
              href={DOWNLOADS.extensionZip}
            >
              Download extension <span aria-hidden="true">↓</span>
            </a>
            <details className="install-details">
              <summary>How to install the ZIP</summary>
              <ol>
                <li>Unzip into a folder you’ll keep.</li>
                <li>
                  Open <code>chrome://extensions</code> and enable Developer
                  mode.
                </li>
                <li>
                  Choose <strong>Load unpacked</strong> and select that folder.
                </li>
              </ol>
              <p>
                Opening a contact’s app uses Chrome’s debugger permission on its
                viewer tab.
              </p>
            </details>
          </article>
        </div>
        <div className="cli-download" id="cli">
          <Icon name="terminal" />
          <div>
            <h3>Prefer a terminal?</h3>
            <p>Text messaging for scripts, bots and agents.</p>
          </div>
          <code>cargo install ghostly-cli</code>
          <a className="text-link" href="/cli">
            CLI guide <span aria-hidden="true">↗</span>
          </a>
        </div>
      </div>
    </section>
  );
}
