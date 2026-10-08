import { shell } from "@/content/shell";
import { Nav } from "./Nav";
import { SiteFooter } from "./Footer";
import { GhostPet } from "./GhostPet";
import { BooTransition } from "./Boo";
import { IdleLoops } from "./IdleLoops";
import { JoinLanding } from "./JoinLanding";
import { appsReleased } from "@/lib/appsGate";

/** `apps`: the Apps link shows only once the released Ghostly has Apps (lib/appsGate.ts). */
export async function Shell({ children }: { children: React.ReactNode }) {
  const t = shell;
  const apps = await appsReleased();
  return (
    <div>
      <a className="skip-link" href="#content">
        {t.skip}
      </a>
      <Nav apps={apps} />
      <main id="content">{children}</main>
      <SiteFooter apps={apps} />
      <GhostPet label={t.pet} />
      <BooTransition />
      <IdleLoops />
      <JoinLanding />
    </div>
  );
}
