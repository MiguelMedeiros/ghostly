"use client";

import dynamic from "next/dynamic";

/**
 * The 404 scene, loaded only when a page is not found. The root not-found page is part of every page's tree (Next keeps
 * it ready for a `notFound()`), so a scene imported straight from it loaded its script on every page of the site.
 */
export const NotFoundLazy = dynamic(() => import("./NotFoundScene").then((m) => m.NotFoundScene));
