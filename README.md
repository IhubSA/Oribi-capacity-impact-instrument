# Capacity & Impact Instrument — REACH CSO Programme

A combined organisational-capacity diagnostic (8 domains, Lead / Second / Self-assessment
tracks) and M&E KPI tracker (Impact / Outcome / Output / Internal indicators) for the EU REACH
CSO capacity-building programme. Static site, no build step, backed by Supabase.

## Stack

- **Frontend**: plain HTML/CSS/JS, no framework, no bundler. Deployable as a static site.
- **Backend**: [Supabase](https://supabase.com) — Postgres + auto-generated REST API, accessed
  from the browser with the `@supabase/supabase-js` client (loaded from a CDN in `index.html`).
- **Hosting**: [Vercel](https://vercel.com), deployed from this GitHub repo.

## Project structure

```
index.html              entry point — loads Supabase JS, then the app files below
css/styles.css           all styling
js/supabase-client.js    Supabase project URL + public key, creates the `sb` client
js/data.js               the 8 capacity domains + 36 M&E indicators, as static JSON
js/app.js                all application logic (routing, rendering, scoring, storage)
supabase/migration.sql   the SQL that set up the database (see below)
```

## Data model

Everything for one CSO — basic info, all capacity-domain scores/comments, all M&E monthly
entries — is stored as a single JSON blob in one row of `public.cso_organisations`:

| column       | type        | notes                                   |
|--------------|-------------|------------------------------------------|
| `id`         | text (PK)   | generated client-side                    |
| `name`       | text        | CSO name, kept in sync with `data.name`  |
| `data`       | jsonb       | the full assessment state                |
| `created_at` | timestamptz | set once, server-side                    |
| `updated_at` | timestamptz | refreshed on every write via trigger     |

A second table, `public.cso_admin_config`, holds a single admin password used to gate the admin
dashboard. It is **not** readable via the API — the client calls the
`cso_verify_admin_password(pw)` Postgres function (RPC) instead, so the password itself never
reaches the browser.

Full schema, including Row Level Security policies, is in `supabase/migration.sql`.

## Access model — read this before using it for anything sensitive

This app uses one shared **public** API key (the Supabase "anon"/"publishable" key) for every
visitor. There is currently no per-user login — Row Level Security policies allow anyone holding
that public key to read and write every CSO's data. The admin password only gates the *admin
dashboard screen*; it does not restrict the underlying data, which is equally readable by a
regular visitor who never logs in as admin.

This mirrors how the tool worked before (shared storage, no real accounts) — it's simple to run,
but it is **not** appropriate for confidential CSO data without a follow-up pass to add real
authentication. Two reasonable next steps if/when that's needed:

1. **Supabase Auth** — require sign-in (email/password or magic link) and rewrite the RLS
   policies to check `auth.uid()` — e.g. a CSO only sees rows it created, admins (flagged in a
   `profiles` table) see everything.
2. **Row-level ownership** — add a `created_by` column tied to `auth.users`, and scope the
   `select`/`update`/`delete` policies to `created_by = auth.uid()` for normal users, with a
   separate admin policy checking a roles table.

## Running locally

No build step. Any static file server works:

```bash
npx serve .
# or
python3 -m http.server 8000
```

Then open the printed URL. The app talks to the live Supabase project directly — there's no
separate local database.

## Deploying (Vercel)

1. Push this repo to GitHub (see below).
2. In Vercel: **Add New… → Project → Import** your GitHub repo.
3. Framework preset: **Other** (it's a static site — no build command, no output directory
   overrides needed; Vercel serves `index.html` and the `css/`/`js/` folders as-is).
4. Deploy. No environment variables are required — the Supabase URL and public key are already
   in `js/supabase-client.js` (safe to be public; see Access model above).

## Changing the admin password

Run this in the Supabase SQL editor for project `ziladpnlfajtiboavwvn`:

```sql
update public.cso_admin_config set password = 'your-new-password' where id = 1;
```

## Updating the question bank / M&E indicators

Edit `js/data.js` directly (it's a plain JSON object assigned to `window.__DATA__`), or
regenerate it from the original source spreadsheets if you have them — the shape is:

```js
window.__DATA__ = {
  domains: [ { key, num, title, desc, questions: [ { id, sub, q, levels: [l1,l2,l3,l4] } ] } ],
  indicators: [ { idx, section, name, definition, data_source, responsible, frequency,
                   collection_method, baseline, target_y1, target_project, unit } ]
};
```
