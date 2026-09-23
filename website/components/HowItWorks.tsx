import { Icon, type IconName } from "./icons";

const steps: { icon: IconName; title: string; text: string }[] = [
  {
    icon: "globe",
    title: "Open Ghostly.",
    text: "Start in your browser, or use the desktop app or extension. Your device creates the keys. No sign-up form.",
  },
  {
    icon: "key",
    title: "Invite your person.",
    text: "Create a chat and share its private invite link or QR code with your contact. The invite is the key: keep it between you.",
  },
  {
    icon: "chat",
    title: "Make the connection yours.",
    text: "Start a conversation, jump on a call, send a file or share an app. Keep both devices online for live features.",
  },
];

export function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="landing-section getting-started"
      aria-labelledby="start-heading"
    >
      <div className="landing-wrap">
        <div className="section-heading horizontal-heading">
          <div>
            <p className="eyebrow">Less setup. More connection.</p>
            <h2 id="start-heading">It starts with an invite.</h2>
          </div>
          <a
            className="text-link"
            href="https://app.ghostly.tools"
            target="_blank"
            rel="noopener noreferrer"
          >
            Create your first chat <span aria-hidden="true">↗</span>
          </a>
        </div>
        <ol className="start-steps">
          {steps.map((step, index) => (
            <li key={step.title}>
              <div className="step-top">
                <span>0{index + 1}</span>
                <Icon name={step.icon} />
              </div>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
