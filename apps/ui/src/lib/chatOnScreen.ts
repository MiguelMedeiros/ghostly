import { createContext } from "react";

/**
 * Whether the chat this is drawn in is the one on screen. A chat on a call, ringing or with an app running stays loaded
 * when another is opened (App's `loaded`), only hidden: what it opened over the page (a message's details, a portal on
 * `document.body`) closes as it goes off screen, or it stayed over the other chat with Tab caught in it (agents#1704).
 * Outside a chat (a group's page, a test), on screen.
 */
export const ChatOnScreen = createContext(true);
