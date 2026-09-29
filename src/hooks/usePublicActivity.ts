import { useCallback, useEffect, useRef, useState } from "react";
import { engine } from "@ghostly/browser/platform/engine";
import type { PublicGraphView, PublicPostsView } from "@ghostly/browser/shared/types";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface PublicActivityState {
  posts?: PublicPostsView | null;
  graph?: PublicGraphView | null;
  /** "posts" while the first page loads, "more" while the next one does. */
  loading?: "posts" | "more";
  error?: string;
  graphError?: string;
  more(): void;
  retry(): void;
}

/**
 * A verified identity's posts and follows (`loadPublicPosts`, `loadPublicGraph`), asked once when the component that
 * uses this mounts with `on` (the chosen card of an open panel) and never in the background; `more` asks for the next
 * page. An identity that changes starts over; an answer for the one before is dropped.
 */
export function usePublicActivity(provider: string, subject: string, on: boolean): PublicActivityState {
  const [posts, setPosts] = useState<PublicPostsView | null>();
  const [graph, setGraph] = useState<PublicGraphView | null>();
  const [loading, setLoading] = useState<"posts" | "more">();
  const [error, setError] = useState<string>();
  const [graphError, setGraphError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const current = useRef("");
  const key = `${provider}\n${subject}`;

  useEffect(() => {
    current.current = key;
    setPosts(undefined); setGraph(undefined); setError(undefined); setGraphError(undefined);
    if (!on) { setLoading(undefined); return; }
    setLoading("posts");
    const force = attempt > 0;
    void engine.call("loadPublicPosts", { provider, subject, force })
      .then(v => { if (current.current === key) setPosts(v); }, e => { if (current.current === key) setError(message(e)); })
      .finally(() => { if (current.current === key) setLoading(undefined); });
    void engine.call("loadPublicGraph", { provider, subject, force })
      .then(v => { if (current.current === key) setGraph(v); }, e => { if (current.current === key) setGraphError(message(e)); });
  }, [key, provider, subject, on, attempt]);

  const more = useCallback(() => {
    if (!on || loading) return;
    setLoading("more"); setError(undefined);
    void engine.call("loadPublicPosts", { provider, subject, more: true })
      .then(v => { if (current.current === key) setPosts(v); }, e => { if (current.current === key) setError(message(e)); })
      .finally(() => { if (current.current === key) setLoading(undefined); });
  }, [key, provider, subject, on, loading]);
  const retry = useCallback(() => setAttempt(n => n + 1), []);

  return { posts, graph, loading, error, graphError, more, retry };
}
