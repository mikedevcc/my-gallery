# My Gallery — AI Agent Instructions

## Project overview

My Gallery is a self-hosted photo and video management application focused on privacy, safe media storage, and personal media organization.

### Technology stack

- **Frontend and backend:** Next.js 16 App Router, React 19, TypeScript
- **Styling:** Tailwind CSS
- **Database:** PostgreSQL 17 using `pg` and versioned SQL migrations
- **Media processing:** ExifTool, FFmpeg, Sharp
- **Deployment:** Docker Compose on Debian 13
- **Storage:** Locally mounted ext4/XFS filesystem with strict identity verification
- **Access:** Private networking through SSH tunneling or Tailscale Serve

The application does not currently implement built-in user authentication.

## Development principles

1. Prefer small, focused changes that preserve existing functionality.
2. Understand existing implementations before modifying them.
3. Follow established TypeScript, React, Next.js, and SQL patterns.
4. Avoid introducing dependencies without a clear technical justification.
5. Add or update tests when changing application behavior.
6. Never weaken storage safety, database integrity, or recovery protections to make tests pass.
7. Keep documentation synchronized with architectural and deployment changes.

## Next.js conventions

This project uses Next.js 16. Do not assume older Next.js APIs or conventions are compatible.

Before modifying framework-specific functionality, consult the installed documentation under `node_modules/next/dist/docs/`.

Use server-side operations for database access, filesystem operations, and sensitive application configuration.

Never expose server-side credentials through client components or `NEXT_PUBLIC_*` variables.

## Database rules

PostgreSQL is the source of truth for media metadata and application relationships.

- Use `pg` and parameterized SQL queries.
- Do not introduce Prisma into active application code.
- Versioned SQL files under `db/migrations/` are authoritative.
- Never edit previously applied migrations.
- Introduce new schema changes through new, reviewed migrations.
- Do not automatically execute migrations during application startup.
- Keep migration credentials separate from application credentials.
- The application database role must not modify `schema_migrations`.

See `db/migrations/README.md` for migration procedures.

## Media storage safety

**Media integrity is a critical project requirement.**

- Never create, format, initialize, or replace a storage filesystem automatically.
- Never bypass storage identity or installation marker checks.
- Never write media to an unverified fallback directory.
- Preserve existing path validation and symlink protections.
- Preserve storage identity verification throughout long-running operations.
- Do not silently delete originals, backups, recovery journals, or destination locks.
- Investigate storage failures rather than automatically resetting state.

Docker deployments use host-side storage preflight verification and a protected, read-only identity assertion.

See `docs/storage-configuration.md`, `docs/media-path-security.md`, and `docs/replacement-recovery.md`.

## Media operations

Media imports, replacements, and deletions may affect both PostgreSQL metadata and physical files.

- Preserve transaction boundaries and recovery behavior.
- Avoid destructive operations without explicitly verified targets.
- Preserve media identifiers and metadata relationships where required.
- Maintain receipt and recovery-journal consistency.
- Validate inputs and enforce existing processing limits.
- Respect capture-date and timezone semantics.

Do not assume filesystem operations and database transactions are atomic together.

## Security

- Never commit `.env` files, credentials, private SSH keys, or real deployment secrets.
- Do not expose internal error details or credentials through API responses.
- Maintain existing request-size, processing, and concurrency limits.
- Do not expose the application publicly without appropriate authentication and authorization.
- Keep the production container unprivileged.
- Do not mount Docker sockets or raw storage devices into the application container.

## Testing and verification

Before committing significant changes, run:

```bash
npm run lint
npx tsc --noEmit
npm run build
npx vitest run
npm run db:migrate:test
npm audit --omit=dev
```

Run relevant specialized tests when modifying storage, recovery, or database operations.

Tests must not accidentally connect to production databases or modify real media.

## Deployment conventions

- Development takes place on the laptop.
- The NAS hosts the production Docker containers and media filesystem.
- Deployment configuration must be documented and reviewed.
- PostgreSQL migrations are separate maintenance operations.
- Application startup requires successful host-side storage verification.
- Docker must not independently restart the Gallery container without preflight.
- Preserve the existing private network boundary.

See `docs/deployment.md` and `docs/docker-deployment.md`.

## Documentation

Update the relevant documentation whenever changing:

- Database schema or migration procedures
- Storage requirements and safety checks
- Media import, replacement, or deletion behavior
- API contracts
- Server dependencies
- Docker or systemd deployment
- Recovery procedures

Keep `README.md` consistent with implemented features. Do not describe planned features as completed.

---

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->