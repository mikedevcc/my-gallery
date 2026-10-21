# My Gallery

Before using media storage, follow [Debian storage provisioning and validation](docs/storage-configuration.md).
`MEDIA_STORAGE_ROOT`, `MEDIA_STORAGE_UUID`, and `MEDIA_STORAGE_ID` are required;
the application does not create the storage root or installation marker.

A responsive, frontend-only personal photo library prototype built with Next.js App Router, React, TypeScript, and Tailwind CSS.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3000. Use `npm run lint` and `npm run build` to check the project.

## Structure

- `app/` contains the main routes: Photos, Trips and trip details, Albums, Favorites, Search, and library sections. `app/photo/[id]` is the immersive viewer route.
- `components/shell.tsx` provides desktop navigation, mobile navigation, top search, storage status, and the upload preview action.
- `components/gallery.tsx` provides the reusable photo grid and keyboard accessible viewer with filmstrip and information panel.
- `components/cards.tsx`, `components/pages.tsx`, and `components/trip-detail.tsx` provide collection cards and page content.
- `components/icons.tsx` contains small local SVG icons.
- `lib/types.ts` defines Photo, Trip, and Album. `lib/mock-data.ts` supplies the demonstration records.

## Connecting a real library

Replace the exported arrays in `lib/mock-data.ts` with server-side data fetching at the route level, keeping the types in `lib/types.ts` as the UI contract. Add upload, favorite, tagging, and description API calls behind the existing controls. For large libraries, paginate timeline results and virtualize or incrementally load gallery sections.

`Photo.thumbnailSrc` is used by grids and the filmstrip; `Photo.src` is used by the viewer. Point both to your NAS media endpoint, with separately generated thumbnail and display-size URLs. Add its host to `images.remotePatterns` in `next.config.ts`. Keep originals behind authenticated download endpoints when connecting a private library.

The current images are Unsplash development URLs. They need a network connection to display. Upload and collection creation are preview actions. Icons are local SVGs because the package registry was unavailable in the build environment.
