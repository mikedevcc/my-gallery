# Production interface scope (M9)

Production desktop and mobile navigation expose Photos, Trips, Albums and
Favorites. The import control, collection management, real media Viewer,
favorites, downloads, information panel and Trip filmstrip remain available.
Videos can still be imported and viewed in the real library/collections; only
the unfinished separate Videos page is retired.

Search (including the header input and keyboard shortcut), Recently Added,
Videos, Screenshots and Trash are hidden. Their old direct routes return Next.js
404 responses instead of mock content or misleading empty placeholders. Recently
Added has not been replaced with a new API/view. No trash/recycle-bin feature is
implied; existing deletion semantics are unchanged.

The fabricated 3.2/8 TB storage indicator and mock profile/avatar action were
removed. No replacement storage, account or dashboard feature was added.
Viewer description editing was removed because it never persisted changes.
Native sharing is offered only after browser capability detection; cancellation
is harmless and other failures show a static message with a download alternative.
The first client render matches server rendering before capability detection.

`lib/mock-data.ts` and its types remain available for development/test fixtures.
Production routes/components no longer import those fixtures. The unused demo
PhotoGrid and mock-backed page components were removed after checking references.
The Viewer route accepts only canonical positive PostgreSQL integer IDs, rejecting
legacy mock photo slugs before rendering a Viewer or issuing an API request.
Numeric IDs in real API responses remain valid; production no longer supplies
mock Trip/Album IDs to the live collection cards.

The existing responsive shell, four-item mobile navigation and active collection
highlighting remain. Upload stays aligned to the right without the search field.
Mobile Viewer controls no longer depend on child position, which would hide the
wrong control when unsupported native sharing is absent.

## Verification and deferred work

`node --import tsx --test scripts/production-interface.test.ts` uses static React
rendering, mocked Next navigation and seeded Viewer state. It verifies desktop
and mobile navigation markup, active detail links, retirement of direct routes,
legacy mock ID rejection, real media links, retained Viewer controls and absence
of production mock imports. CSS-module loading is stubbed only in the Node test
renderer; Next handles actual CSS in application builds. No database, media,
network or browser interaction is required by this test.

Browser layout, keyboard/pointer interactions and actual native-share capability
still need normal deployment smoke checks at desktop/mobile widths. Tests do not
claim end-to-end browser coverage. Search, Recently Added, dedicated media-category
pages, Trash, storage reporting, accounts and persisted descriptions remain
future work; none is presented as implemented in production navigation.
