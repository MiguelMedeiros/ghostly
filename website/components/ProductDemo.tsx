"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { GhostGlyph, Icon } from "./icons";
import type { FeatureId } from "./Features";
import { useHaunting } from "./HauntedPage";

function DemoHeader({ label = "Casper" }: { label?: string }) {
  return (
    <div className="demo-header">
      <span className="demo-avatar">
        <GhostGlyph />
      </span>
      <div>
        <strong>{label}</strong>
        <small>
          <span className="status-dot" /> Encrypted connection
        </small>
      </div>
      <Icon name="video" />
    </div>
  );
}

function LocalAppDemo() {
  const [sharing, setSharing] = useState(true);
  const { enabled } = useHaunting();
  return (
    <div className="local-app-demo">
      <div className="local-source">
        <span className="source-icon">
          <Icon name="desktop" />
        </span>
        <div>
          <small>ON YOUR COMPUTER</small>
          <strong>Boo’s little lab</strong>
          <code>localhost:3000</code>
        </div>
        <button
          className="demo-switch"
          type="button"
          role="switch"
          aria-checked={sharing}
          aria-label="Share demo app"
          onClick={() => setSharing(!sharing)}
        >
          <span />
        </button>
      </div>
      <div className={`local-connection ${sharing ? "is-sharing" : ""}`}>
        <span />
        <p>{sharing ? "Shared with your linked contacts" : "Sharing is off"}</p>
        <span />
      </div>
      <div className="remote-app" aria-live="polite">
        <div className="remote-toolbar">
          <span className="window-dots" aria-hidden="true">
            ● ● ●
          </span>
          <span>Your contact’s view</span>
          <Icon name="key" />
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={sharing ? "shared" : "offline"}
            initial={
              enabled
                ? { opacity: 0, y: 15, scale: 0.95, filter: "blur(6px)" }
                : false
            }
            animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
            exit={
              enabled
                ? { opacity: 0, y: -16, scale: 0.95, filter: "blur(6px)" }
                : { opacity: 0 }
            }
            transition={{ duration: enabled ? 0.3 : 0 }}
          >
            {sharing ? (
              <div className="mini-board">
                <div className="mini-board-heading">
                  <span>
                    <GhostGlyph /> BOO’S LAB
                  </span>
                  <small>LIVE FROM YOUR COMPUTER</small>
                </div>
                <h4>
                  It’s alive.
                  <br />
                  On my localhost.
                </h4>
                <div className="mini-board-cards">
                  <div>
                    <span>01 / EXPERIMENT</span>
                    <strong>
                      A little
                      <br />
                      ghost magic.
                    </strong>
                    <div className="mini-lab-ghost">
                      <GhostGlyph />
                    </div>
                  </div>
                  <div>
                    <span>02 / AFTER HOURS</span>
                    <strong>
                      Made after
                      <br />
                      midnight.
                    </strong>
                    <div className="mini-shapes">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="app-offline">
                <GhostGlyph />
                <strong>Poof. The door is closed.</strong>
                <p>
                  Your local app stays on your computer.
                  <br />
                  Turn sharing on to let contacts open it again.
                </p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      <p className="demo-bottom-note">
        {sharing
          ? "Served from your machine over WebRTC. No deployment needed."
          : "You control when your app is reachable through Ghostly."}
      </p>
    </div>
  );
}

export function ProductDemo({ feature }: { feature: FeatureId }) {
  if (feature === "apps") return <LocalAppDemo />;
  if (feature === "automate")
    return (
      <div className="terminal-demo">
        <div className="remote-toolbar">
          <span className="window-dots" aria-hidden="true">
            ● ● ●
          </span>
          <span>your terminal</span>
        </div>
        <div className="terminal-content">
          <p className="terminal-comment"># Install once</p>
          <pre>
            <span>$</span> cargo install ghostly-cli
          </pre>
          <p className="terminal-comment"># Listen to your connected peer</p>
          <pre>
            {
              'ghostly-cli watch \\\n  --seed "$SEED" \\\n  --peer "$PEER" \\\n  --key "$KEY"'
            }
          </pre>
          <div className="terminal-response">
            <span className="status-dot" /> Incoming messages → your script
          </div>
          <p className="terminal-comment">
            Use your link’s keys. Keep them private.
          </p>
        </div>
        <div className="terminal-usecases">
          <span>Deploy notifications</span>
          <span>Personal bots</span>
          <span>AI agents</span>
        </div>
      </div>
    );
  return (
    <div className="conversation-demo">
      <DemoHeader />
      <div className="demo-conversation">
        {feature === "chat" && (
          <>
            <p className="demo-time">TODAY · YOUR OWN LITTLE CORNER</p>
            <div className="bubble incoming">Got a minute for a wild idea?</div>
            <div className="bubble outgoing">
              Always. What are you thinking?{" "}
              <small>
                12:04 <span>✓✓</span>
              </small>
            </div>
            <div className="bubble incoming">
              Something we can build together. 👻
            </div>
            <div className="chat-encryption">
              <Icon name="key" />
              <span>
                Only the holders of this invite
                <br />
                can decrypt the conversation.
              </span>
            </div>
          </>
        )}
        {feature === "calls" && (
          <>
            <div className="call-stage">
              <span className="call-status">
                <span className="status-dot" /> Voice connected
              </span>
              <div className="call-ghosts">
                <GhostGlyph />
                <GhostGlyph />
              </div>
              <strong>A little closer, wherever you are.</strong>
              <div className="waveform" aria-hidden="true">
                {[
                  12, 24, 38, 21, 46, 32, 18, 40, 26, 48, 24, 14, 32, 20, 10,
                ].map((height, i) => (
                  <span
                    key={i}
                    style={{ height, animationDelay: `${i * -0.13}s` }}
                  />
                ))}
              </div>
              <div className="call-options">
                <span>
                  <Icon name="mic" />
                  Voice
                </span>
                <span>
                  <Icon name="video" />
                  Camera
                </span>
                <span>
                  <Icon name="desktop" />
                  Screen
                </span>
              </div>
            </div>
            <div className="bubble incoming">
              Let me show you what I’m working on.
            </div>
          </>
        )}
        {feature === "files" && (
          <>
            <div className="bubble incoming">
              Here’s everything for the project.
            </div>
            <div className="file-demo-card">
              <span className="file-demo-icon">
                <Icon name="file" />
              </span>
              <div>
                <strong>weekend-project.zip</strong>
                <small>24 MiB · sent peer to peer</small>
              </div>
              <Icon name="check" />
            </div>
            <div className="file-progress">
              <span />
            </div>
            <p className="transfer-complete">
              <Icon name="check" /> Transfer complete
            </p>
            <div className="bubble outgoing">
              Got it. Let’s make something. <small>✓✓</small>
            </div>
            <p className="demo-bottom-note">
              Photos, documents, archives. Up to 100 MiB each.
            </p>
          </>
        )}
        {feature === "sats" && (
          <>
            <div className="bubble incoming">Coffee’s on me today.</div>
            <div className="payment-demo-card">
              <span className="payment-label">
                <Icon name="bolt" /> SATS RECEIVED
              </span>
              <strong>
                2,100 <span>sats</span>
              </strong>
              <p>For the coffee ☕</p>
              <div>
                <Icon name="check" /> Redeemed into your Cashu wallet
              </div>
            </div>
            <div className="payment-options">
              <span>Send sats</span>
              <span>Request sats</span>
              <span>Pay invoice</span>
            </div>
            <p className="demo-bottom-note">
              An example payment. No money moves in this preview.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
