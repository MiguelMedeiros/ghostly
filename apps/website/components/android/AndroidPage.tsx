import Link from "next/link";
import { Shell } from "@/components/site/Shell";
import { Icon } from "@/components/site/icons";
import { QrCode } from "@/components/site/QrCode";
import { CopyButton } from "@/components/cli/CopyButton";
import { android } from "@/content/android";
import { APP_URL } from "@/content/shell";
import { ANDROID_CERT_SHA256, ANDROID_MIN, ANDROID_PAGE_URL, assetNames, downloads, releaseUrl } from "@/lib/release";
import "@/app/cli.css";
import "@/app/android.css";

/**
 * /android: the APK of `version` (lib/latestRelease.ts), the three steps to
 * install it, how it updates, and the signing certificate's fingerprint to
 * check it. On a computer, a QR code opens this page on the phone; on a phone,
 * CSS hides it.
 */
export function AndroidPage({ version }: { version: string }) {
  const t = android;
  const apk = downloads(version).androidApk;
  const verify = `apksigner verify --print-certs ${assetNames(version).androidApk}`;
  return (
    <Shell>
      <section className="an-hero">
        <div className="wrap an-hero-grid">
          <div className="an-hero-copy">
            <span className="eyebrow">{t.hero.eyebrow}</span>
            <h1 className="h-display an-title">{t.hero.title}</h1>
            <p className="lead">{t.hero.lead}</p>
            <div className="an-actions">
              <a className="btn btn--primary btn--lg" href={apk}>
                <Icon name="android" /> {t.hero.download} <span className="an-version">v{version}</span>
              </a>
              <a className="btn" href={APP_URL}>
                {t.hero.open} <span aria-hidden="true">↗</span>
              </a>
            </div>
            <p className="caption an-needs">{t.hero.needs(ANDROID_MIN)}</p>
          </div>
          <figure className="an-qr">
            <QrCode text={ANDROID_PAGE_URL} label={t.hero.qr} className="an-qr-code" />
            <figcaption className="note">{t.hero.scan}</figcaption>
          </figure>
        </div>
      </section>

      <section className="wrap cl-block" id="install" aria-labelledby="an-install">
        <h2 id="an-install" className="h-card">
          {t.install.title}
        </h2>
        <ol className="an-steps">
          {t.install.steps.map((s, i) => (
            <li key={s.title} className="an-step">
              <span className="an-step-n" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{s.title}</h3>
              <p className="muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="wrap cl-block" aria-labelledby="an-updates">
        <h2 id="an-updates" className="h-card">
          {t.updates.title}
        </h2>
        <p className="muted an-prose">{t.updates.body}</p>
      </section>

      <section className="wrap cl-block" id="verify" aria-labelledby="an-verify">
        <h2 id="an-verify" className="h-card">
          {t.verify.title}
        </h2>
        <p className="muted an-prose">{t.verify.lead}</p>
        <div className="cl-line">
          <pre tabIndex={0} role="region" aria-label="SHA-256">
            <code>{ANDROID_CERT_SHA256}</code>
          </pre>
          <CopyButton text={ANDROID_CERT_SHA256} label={t.verify.copy} done={t.verify.copied} />
        </div>
        <p className="muted an-prose">{t.verify.command}</p>
        <div className="cl-line">
          <pre tabIndex={0}>
            <code>{verify}</code>
          </pre>
          <CopyButton text={verify} label={t.verify.copy} done={t.verify.copied} />
        </div>
        <p className="note">
          {t.verify.sums}{" "}
          <a className="link-arrow" href={releaseUrl(version)}>
            {t.verify.all} ↗
          </a>
        </p>
      </section>

      <section className="wrap cl-block" aria-labelledby="an-other">
        <h2 id="an-other" className="h-card">
          {t.other.title}
        </h2>
        <p className="muted an-prose">{t.other.body}</p>
        <p className="cl-more">
          <a className="link-arrow" href={APP_URL}>
            {t.other.cta} ↗
          </a>
          <Link className="link-arrow" href="/#download">
            {t.other.desktop} →
          </Link>
        </p>
      </section>
    </Shell>
  );
}
