# Supabase Setup

This app switches from the local filesystem demo store to Supabase when all three env vars are present:

```bash
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
```

`NEXT_PUBLIC_SUPABASE_ANON_KEY` is also accepted as a fallback for older projects, but new projects should use the publishable key.

## What To Create

1. Create a Supabase project.
2. In the SQL editor, run [`schema.sql`](./schema.sql).
3. In Authentication:
   - enable Email OTP / passwordless email
   - enable Google
4. In Authentication URL config, add:
   - local: `http://127.0.0.1:3000/auth/callback`
   - production: `https://your-render-domain/auth/callback`
5. In Google OAuth, use the same callback URL from step 4.
6. Add the three env vars above to local `.env.local` and Render.

## Optional Env

```bash
SUPABASE_STORAGE_BUCKET=session-assets
```

The SQL schema creates `session-assets` by default. If you change the bucket name, update both the env var and the storage policies in `schema.sql`.

## App Behavior

- No Supabase envs: the app keeps using the local filesystem demo mode.
- Supabase envs present: auth and per-user persistence turn on.
- Homepage stays public, but starting a new sketch requires sign-in.
- Session pages, dashboard data, and API routes are limited to the signed-in owner.

## Notes

- The app currently uses the service role key on the server for persistence and background generation jobs.
- Do not expose `SUPABASE_SERVICE_ROLE_KEY` to the browser.
- The schema uses RLS so browser-side reads can still be scoped to the signed-in user.
