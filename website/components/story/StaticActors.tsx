"use client";

import { motion, useTransform } from "motion/react";
import { Ghost } from "@/components/ghost/Ghost";
import { orientationOf, VIEW_BOX_ORIGIN } from "@/components/home/stage";
import { useScene } from "./SceneFrame";
import { BLOCKING, poseAt, type Chapter } from "./poses";

/**
 * The two actors drawn inside a scene's own stage, at the pose the blocking
 * table gives for the current progress. In the story the act backdrop draws
 * them instead and CSS hides these; they carry the still frames (reduced
 * motion, no scripts) and the static article.
 */
export function StaticActors({ chapter }: { chapter: Chapter }) {
  const { p, step, portrait } = useScene();
  const b = BLOCKING[orientationOf(portrait)][chapter];
  const boo = {
    x: useTransform(p, (v) => poseAt(b.boo, v).x),
    y: useTransform(p, (v) => poseAt(b.boo, v).y),
    s: useTransform(p, (v) => poseAt(b.boo, v).s / 100),
    a: useTransform(p, (v) => poseAt(b.boo, v).a),
  };
  const casper = {
    x: useTransform(p, (v) => poseAt(b.casper, v).x),
    y: useTransform(p, (v) => poseAt(b.casper, v).y),
    s: useTransform(p, (v) => poseAt(b.casper, v).s / 100),
    a: useTransform(p, (v) => poseAt(b.casper, v).a),
  };
  const mood = (who: "boo" | "casper") => b.moods[who][Math.min(step, b.moods[who].length - 1)];
  return (
    <g className="scene-actors-static">
      <motion.g style={{ x: casper.x, y: casper.y, scale: casper.s, opacity: casper.a, ...VIEW_BOX_ORIGIN }}>
        <Ghost who="casper" size={100} mood={mood("casper")} look={{ x: -0.6, y: 0.2 }} float={false} halo phase={1} />
      </motion.g>
      <motion.g style={{ x: boo.x, y: boo.y, scale: boo.s, opacity: boo.a, ...VIEW_BOX_ORIGIN }}>
        <Ghost who="boo" size={100} mood={mood("boo")} look={{ x: 0.6, y: 0.2 }} float={false} halo />
      </motion.g>
    </g>
  );
}
