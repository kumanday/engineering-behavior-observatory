# Project site

Source of the project site at <https://ebo.kumanday.ai/>: the landing page and the
`docs/` tree rendered as browsable pages. It is a [Hugo](https://gohugo.io/) site
(Hugo 0.160.1, no theme) deployed to GitHub Pages by `.github/workflows/pages.yml`
on every push to `main` that touches `site/` or `docs/`.

- `layouts/home.html` is the landing page; `layouts/baseof.html` and `layouts/_partials/`
  hold the shared head, masthead and colophon.
- `docs/` is mounted as content (see `hugo.toml`), so the Markdown stays where it is
  and reads the same on GitHub. Each `README.md` becomes its section's page, a page's
  title is its first-level heading, and relative `.md` links resolve to site pages
  (`layouts/_markup/render-link.html`). Links to other repository files go to GitHub.
  A link to a missing docs page fails the CI build (`--panicOnWarning`).
- Sidebar order is set in `hugo.toml` under `params.docs`; a section's pages not
  listed there follow by title. A new top-level folder under `docs/` needs a
  `README.md` and an entry in `params.docs.sections` (and a mount for its README).
- `static/` holds `style.css`, `site.js`, `docs.css`, `docs.js` and the generated
  `tokens.css`. `docs/assets/` media used by the landing page is mounted at `assets/`.
- Search is [Pagefind](https://pagefind.app/) 1.6.0, indexed in CI after the Hugo build.
- The workflow stamps the package version and commit into the colophon through
  `HUGO_PARAMS_BUILD`.

`PRODUCT.md` is the brief (audience, voice, anti-references) and `DESIGN.md` the
visual system ([design.md format](https://github.com/google-labs-code/design.md)).
`static/tokens.css` is generated from `DESIGN.md`; regenerate it after token changes:

```sh
node viewer/design/build-tokens.mjs site/DESIGN.md site/static/tokens.css
```

Preview locally (search needs the Pagefind index, which only the CI build creates):

```sh
hugo server --source site
```

Build as CI does:

```sh
hugo --source site --destination /tmp/ebo-site --baseURL http://localhost:8090/ --panicOnWarning
npx pagefind@1.6.0 --site /tmp/ebo-site
python3 -m http.server 8090 --directory /tmp/ebo-site
```
