import assert from "node:assert/strict";
import { test, mock } from "node:test";
import React, { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext, SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { Viewer, LibraryMediaGrid } from "../components/gallery";
import PhotoPage from "../app/photo/[id]/page";
import SearchPage from "../app/search/page";
import RecentPage from "../app/recent/page";
import VideosPage from "../app/videos/page";
import ScreenshotsPage from "../app/screenshots/page";
import TrashPage from "../app/trash/page";
import { photos } from "../lib/mock-data";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

// Node's fixture renderer does not load CSS; Next handles these imports in builds.
const fixtureRequire = createRequire(path.resolve("scripts/production-interface.test.ts"));
const css = fixtureRequire.extensions[".css"];
fixtureRequire.extensions[".css"] = module => { module.exports = {}; };
const { Shell } = fixtureRequire("../components/shell") as typeof import("../components/shell");
if (css) fixtureRequire.extensions[".css"] = css;
else delete fixtureRequire.extensions[".css"];

const router = { bfcacheId: "fixture", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch() {}, };
const shellProps: React.ComponentProps<typeof Shell> = { appVersion: "0.1.0", children: null };
function render(node: ReactNode, pathname = "/") {
    return renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: router },
        createElement(PathnameContext.Provider, { value: pathname },
            createElement(SearchParamsContext.Provider, { value: new URLSearchParams() }, node))));
}

test("desktop and mobile navigation expose the same four real views and working upload control", () => {
    const html = render(createElement(Shell, shellProps, "fixture content"));
    const navs = [...html.matchAll(/<nav\b[^>]*>([\s\S]*?)<\/nav>/g)].map(match => match[1]);
    assert.equal(navs.length, 2);
    for (const nav of navs) {
        assert.deepEqual([...nav.matchAll(/href="([^"]+)"/g)].map(match => match[1]), ["/", "/trips", "/albums", "/favorites"]);
        for (const label of ["Photos", "Trips", "Albums", "Favorites"]) assert.ok(nav.includes(label));
    }
    assert.match(html, /type="file"/);
    assert.match(html, /fixture content/);
    for (const text of ["Recently Added", "Screenshots", "Trash", "global-search", "top-search", "Profile", "Personal library preview", "storage-bar", "3.2 TB", "8 TB", ">MF<"]) {
        assert.equal(html.includes(text), false, text);
    }
});

test("collection detail routes keep their parent navigation active", () => {
    for (const [pathname, active] of [["/trips/12", "/trips"], ["/albums/34", "/albums"], ["/favorites", "/favorites"]]) {
        const html = render(createElement(Shell, shellProps), pathname);
        const current = [...html.matchAll(/<a\b([^>]*aria-current="page"[^>]*)>/g)].map(match => /href="([^"]+)"/.exec(match[1])![1]);
        assert.deepEqual(current, [active, active]);
    }
});

const notFound = (error: unknown) => (error as { digest?: string }).digest === "NEXT_HTTP_ERROR_FALLBACK;404";
test("retired routes return 404 even when accessed directly", () => {
    for (const page of [SearchPage, RecentPage, VideosPage, ScreenshotsPage, TrashPage]) assert.throws(page, notFound);
});

test("legacy mock photo slugs and invalid IDs cannot instantiate a real Viewer or issue requests", async () => {
    const fetch = mock.method(globalThis, "fetch", () => { throw new Error("Unexpected request"); });
    try {
        for (const id of [...photos.map(photo => photo.id), "0", "-1", "01", "1demo", "1.0", "1e0", "2147483648", "1/../../media", ""]) {
            await assert.rejects(PhotoPage({ params: Promise.resolve({ id }) }), notFound);
        }
        for (const id of ["1", "2147483647"]) {
            const result = await PhotoPage({ params: Promise.resolve({ id }) });
            assert.equal(result.type, Viewer); assert.equal(result.props.id, id);
        }
        assert.equal(fetch.mock.callCount(), 0);
    } finally { fetch.mock.restore(); }
});

test("real library grids retain numeric Viewer links", () => {
    const html = render(createElement(LibraryMediaGrid, { onToggleFavorite() {}, items: [{ media_id: 42, file_name: "fixture.jpg", file_type: "IMAGE", date_taken: null,
        date_imported: "2026-01-01T00:00:00Z", width: 8, height: 8, favorite: false, city_name: null, country_name: null }] }));
    assert.deepEqual([...html.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(match => match[1]), ["/photo/42?scope=all"]);
    assert.match(html, /\/api\/media\/42\/thumbnail/);
});

function renderLoadedViewer(canShare = false) {
    // Seed the Viewer through React's state initializer; effects/network never run
    // during this server-render fixture. Leave child components' state untouched.
    const actual = React.useState;
    const media = { media_id: 42, file_name: "fixture.jpg", file_type: "IMAGE", file_size: 64,
        date_taken: null, width: 8, height: 8, favorite: false };
    // Keep the complete Viewer state fixture explicit; child hooks use their
    // real initializers once these Viewer-only values have been consumed.
    const initial = [
        42,     // selectedId
        media,
        [],     // collectionMedia
        false,  // loading
        null,   // error
        true,   // info
        false,  // favorite
        [],     // pendingFavoriteIds
        "",     // favoriteError
        "",     // shareError
        null,   // deleteTarget
        false,  // isImmersive
    ];
    let index = 0;
    const state = mock.method(React, "useState", ((value: unknown) => actual(index < initial.length ? initial[index++] : value)) as typeof React.useState);
    const capability = mock.method(React, "useSyncExternalStore", () => canShare);
    try { return render(createElement(Viewer, { id: "42" })); }
    finally { state.mock.restore(); capability.mock.restore(); }
}
test("loaded Viewer has functional controls without a nonpersistent description editor", () => {
    const html = renderLoadedViewer();
    for (const label of ["Toggle favorite", "Download media", "Hide information", "Close viewer"]) assert.ok(html.includes(label), label);
    assert.match(html, /aria-label="Hide information" aria-pressed="true"/);
    assert.match(html, /href="\/api\/media\/42\/file"/);
    for (const text of ["textarea", "photo-description", "Add a description", "Share media"]) assert.equal(html.includes(text), false, text);
    assert.ok(renderLoadedViewer(true).includes('aria-label="Share media"'));
});

test("production routes and components have no dependency on mock data", async () => {
    async function check(directory: string) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await check(file);
            else if (/\.tsx?$/.test(entry.name)) assert.doesNotMatch(await fs.readFile(file, "utf8"), /(?:from\s*|import\s*\()\s*['"][^'"]*mock-data/, file);
        }
    }
    await check("app"); await check("components");
    assert.ok(photos.length > 0, "Development fixtures are retained");
});
