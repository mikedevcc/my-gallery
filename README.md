# My Gallery

For runtime configuration, required services and release procedures, see
[production deployment](docs/deployment.md) and [.env.example](.env.example).

Before using media storage, follow [Debian storage provisioning and validation](docs/storage-configuration.md).
`MEDIA_STORAGE_ROOT`, `MEDIA_STORAGE_UUID`, and `MEDIA_STORAGE_ID` are required;
the application does not create the storage root or installation marker.

A self-hosted personal photo library built with Next.js App Router, React, TypeScript, PostgreSQL, and Tailwind CSS. Production navigation exposes only implemented, live-data views.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3000. Use `npm run lint` and `npm run build` to check the project.

## Structure

- `app/` contains the main routes: Photos, Trips and trip details, Albums and album details, and Favorites. `app/photo/[id]` is the immersive viewer route.
- `components/shell.tsx` provides desktop/mobile navigation and the working import control.
- `components/gallery.tsx` provides the reusable photo grid and keyboard accessible viewer with filmstrip and information panel.
- `components/cards.tsx`, `components/pages.tsx`, and `components/trip-detail.tsx` provide collection cards and page content.
- `components/icons.tsx` contains small local SVG icons.
- `lib/types.ts` contains UI types. `lib/mock-data.ts` is a retained development fixture and is not imported by production components.

## Production interface

Photos, Trips, Albums, Favorites, imports and Viewer use the existing real APIs.
Search, Recently Added, Videos, Screenshots and Trash are deferred and their old
routes return 404. Videos remain available within the working library and collections.
Fabricated storage totals, the demo profile action and nonpersistent description
editing are removed. Native sharing appears only on browsers that support it.
See [production interface scope](docs/production-interface.md) for deferred features
and verification limitations.
