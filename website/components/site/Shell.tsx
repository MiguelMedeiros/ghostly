import { shell } from "@/content/shell";
import { Nav } from "./Nav";
import { SiteFooter } from "./Footer";
import { GhostPet } from "./GhostPet";
import { GhostSwarm } from "./GhostSwarm";
import { IdleLoops } from "./IdleLoops";
import { JoinLanding } from "./JoinLanding";

export function Shell({ children }: { children: React.ReactNode }) {
  const t = shell;
  return (
    <div>
      <a className="skip-link" href="#content">
        {t.skip}
      </a>
      <Nav />
      <main id="content">{children}</main>
      <SiteFooter />
      <GhostPet label={t.pet} />
      <GhostSwarm />
      <IdleLoops />
      <JoinLanding />
    </div>
  );
}
