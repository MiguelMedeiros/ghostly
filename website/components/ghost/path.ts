/**
 * The app's ghost (GHOST_PATH in the app's src/components/pairing/PairingScene.tsx, the same 80×100 box): a round
 * head and a hem cut into points like the arcade ghosts' feet, five points (the corners and three between) and four
 * notches. Every ghost on the site draws it: the story's (Ghost.tsx), the swarm, the GhostPet, the 404 and the
 * Developers explainer. A plain module, so server and client components can both import it.
 */
export const GHOST_PATH = "M40 8 C18 8 8 22 8 40 L8 72 L16 64 L24 72 L32 64 L40 72 L48 64 L56 72 L64 64 L72 72 L72 40 C72 22 62 8 40 8Z";
