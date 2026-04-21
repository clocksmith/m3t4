# Content

Copy and fiction only.

This directory owns:

- goal labels and target names
- HUD text packs
- fighter display names, labels, archetypes, and voice lines
- weapon names and non-mechanical descriptions
- economy/reward copy that does not affect gameplay power

Visual paths and generation prompts belong in `theming/`. Runtime selection
belongs in `config/`. Balance output belongs in `data/`.

Edit source files here, not the mirrored files under `client/content/`.
`npm run build` and Firebase Hosting deploys run `npm run sync:content`,
which copies the browser-shipped content into `client/content/`.
