# Cloak and Dagger — cloakdag.com

One-page site for Cloak and Dagger, a PR / comms / marketing agency for financial services and luxury lifestyle brands.
Styled after the C&D proposal decks (paper cover, Special Elite typewriter, heavy condensed caps, charcoal panels).

- `public/` — the whole site: `index.html`, `styles.css`, `img/`
- `server.js` — zero-dependency Node static server (reads `$PORT`)

```sh
npm start   # http://localhost:3000
```

## Deploy (Railway)

New Project → Deploy from GitHub repo → `CK42BB/cloakdag`. Railway detects Node and runs `npm start`.
Then Settings → Networking → Custom Domain → `cloakdag.com` and add the CNAME it gives you at your DNS provider.

## Editing

- Contact email: search `jb@cloakdag.com` in `public/index.html`.
- Client logos: `public/img/clients/` (white-on-transparent, shown on the dark band).
- Team photos: `public/img/team/`.
