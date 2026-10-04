# VectorForge

VectorForge turns local raster images into editable SVG artwork and provides a responsive workspace for drawing and refining vectors.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/vectorforge/` — the VectorForge web app.
- `artifacts/api-server/` — shared API server scaffold; VectorForge does not currently depend on it.

## Architecture decisions

- The initial VectorForge workflow runs locally in the browser; it does not require accounts, a database, or cloud image uploads.
- Raster editing uses Canvas; generated and hand-drawn artwork remains editable SVG.

## Product

- Upload PNG, JPG, and WEBP artwork, vectorize, edit SVG shapes, draw, and export SVG or PNG.
- Prioritize a compact, touch-friendly mobile workspace as well as desktop editing.

## User preferences

- Keep the editor mobile-first and responsive to small screens.

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
