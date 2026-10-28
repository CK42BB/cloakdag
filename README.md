# Cloak and Dagger — cloakdag.com

One-page site for Cloak and Dagger, a PR / comms / marketing agency for financial services and luxury lifestyle brands.
Styled after the C&D proposal decks (paper cover, Special Elite typewriter, heavy condensed caps, charcoal panels).

- `public/` — the whole site: `index.html`, `styles.css`, `img/`
- `server.js` — zero-dependency Node server (reads `$PORT`): static files plus the `/admin` editor API
- `admin/` — the editor (login page, `editor.js`, `editor.css`)

```sh
npm start   # http://localhost:3000
```

## Deploy (Railway)

New Project → Deploy from GitHub repo → `CK42BB/cloakdag`. Railway detects Node and runs `npm start`.
Then Settings → Networking → Custom Domain → `cloakdag.com` and add the CNAME it gives you at your DNS provider.

## Site editor (/admin)

Non-technical editing at **cloakdag.com/admin**: sign in with email + shared password (or an emailed one-time link), click any text to edit it,
replace images, reorder/hide/copy/add sections, change backgrounds/spacing/columns, then **Publish**.

- Publishing commits `public/index.html` to GitHub (author = the editor's email) and updates the live file immediately;
  Railway then redeploys the same content. Every publish is restorable from the editor's History tab.
- Only the region between `<!-- cms:start -->` and `<!-- cms:end -->` (nav, main, footer) plus the title/description
  is editable. `<head>`, styles and scripts stay code-only. Keep those markers when editing the HTML by hand.
- Uploaded images are resized/converted to WebP in the browser and committed to `public/img/uploads/`.
- Hand-editing and editor publishing can coexist: the editor refuses to overwrite a change it hasn't seen
  (it offers to replace or cancel).

### Railway variables

| Variable | Value |
| --- | --- |
| `ADMIN_EMAILS` | `jb@cloakdag.com,…` (comma-separated; remove someone to revoke access) |
| `ADMIN_PASSWORD_HASH` | shared password, hashed: `printf '%s' 'the-password' \| node server.js hash-password`. While set, /admin asks for email + password instead of emailing a link; unset it to switch to email links |
| `SESSION_SECRET` | long random string (`openssl rand -hex 32`) |
| `SITE_URL` | `https://cloakdag.com` |
| `GITHUB_TOKEN` | fine-grained token, repo `CK42BB/cloakdag` only, **Contents: Read and write** |
| `RESEND_API_KEY` | from resend.com, with `cloakdag.com` verified as a sending domain |
| `MAIL_FROM` | optional, default `Cloak and Dagger <admin@cloakdag.com>` |

Locally, without `RESEND_API_KEY` the sign-in link is printed to the console, and without `GITHUB_TOKEN` publishes
only write the local file:

```sh
ADMIN_EMAILS=you@example.com npm start   # then open http://localhost:3000/admin
```

## Editing by hand

- Contact email: search `jb@cloakdag.com` in `public/index.html`.
- Client logos: `public/img/clients/` (white-on-transparent, shown on the dark band).
- Team photos: `public/img/team/`.
