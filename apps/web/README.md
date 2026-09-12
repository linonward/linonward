# linonward notes

`apps/web` powers the public content site at `notes.linonward.com` and its single-administrator
publishing interface under `/admin`.

## Local setup

Copy `.env.example` to `.env.local`, configure PostgreSQL, GitHub OAuth, Cloudflare R2, and the
WeChat Official Account credentials, then run from the repository root:

```sh
pnpm --filter @linonward/web db:migrate
pnpm turbo run dev --filter=@linonward/web
```

The GitHub OAuth callback URL is `/api/auth/callback/github`. `ADMIN_GITHUB_ID` must be the numeric
GitHub user ID of the only allowed administrator.

## Publishing

Articles are autosaved to PostgreSQL. “发布网站” creates an immutable revision and exposes the
article on the public site. “同步微信草稿” uploads article images and the first image as the cover,
then creates a WeChat draft. It never submits or publishes the draft.

R2 must allow `PUT` requests from the application origin and expose the uploaded objects through
the HTTPS origin configured in `R2_PUBLIC_BASE_URL`.
