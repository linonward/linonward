# linonward notes

`apps/web` powers the public content site at `notes.linonward.com` and its single-administrator
publishing interface under `/admin`.

## Architecture

The site remains one deployable Next.js application, while server responsibilities are separated
into workspace packages:

- `@linonward/database` owns the PostgreSQL connection, schema, and migrations.
- `@linonward/content` owns the article draft, revision, and publishing lifecycle.
- `@linonward/publishing` owns external publishing integrations such as WeChat drafts.
- `@linonward/web` owns pages, authentication, and thin HTTP adapters.

Server Components call the domain packages directly. Route Handlers should only handle HTTP and
authentication concerns before delegating to those packages. This keeps the domain boundaries ready
for a future worker or standalone API deployment without adding a network hop today.

## Local setup

Copy `.env.example` to `.env.local`, configure PostgreSQL, GitHub OAuth, Cloudflare R2, and the
WeChat Official Account credentials, then run from the repository root:

```sh
pnpm --filter @linonward/database db:migrate
pnpm turbo run dev --filter=@linonward/web
```

The GitHub OAuth callback URL is `/api/auth/callback/github`. `ADMIN_GITHUB_ID` must be the numeric
GitHub user ID of the only allowed administrator.

## Publishing

Articles are autosaved to PostgreSQL without changing the public version. “发布网站” creates an
immutable revision and advances the version exposed on the public site. “同步微信草稿” uses that
same published revision, uploads its images and the first image as the cover, then creates a WeChat
draft. It never submits or publishes the draft.

R2 must allow `PUT` requests from the application origin and expose the uploaded objects through
the HTTPS origin configured in `R2_PUBLIC_BASE_URL`.
