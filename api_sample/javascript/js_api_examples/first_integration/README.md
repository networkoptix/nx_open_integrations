# The First Integration — In-Client JavaScript API

This would be your first integration with Nx Witness JavaScript API.
The integration is the extension of continuing directly from the hello-world sample, and it is built with TypeScript and bundled with [Parcel](https://parceljs.org/): `npm install`, `npm start`, and you're iterating in seconds. No manual bundler config required.

## What it shows

- `window.isVmsApiEnabled` — how a page can detect whether the API is available at all.
- `window.vmsApiInit` — the callback the Desktop Client calls once the JS API is ready to use.
- `window.vms.tab.name` — reading a basic property from the API.
- `window.vms.resources.resources()` — fetching the full list of resources visible to the current session.
- `window.vms.resources.added` / `window.vms.resources.removed` — subscribing to live resource lifecycle events, so the list stays in sync (add, update-in-place by id, and remove) while the tab stays open.
- `window.vms.resources.hasMediaStream()` — filtering that list down to resources that actually have video, since `resources()` can return non-camera resources too.
- `window.vms.tab.addItem()` — clicking a camera in the list adds it to the current layout as a new item. Clicking the same camera again adds another item (duplicates are allowed, matching how the Desktop Client itself behaves).
- A typed `window.vms` surface (`src/typesFromDesktopClient.d.ts`), so the API is autocompleted and type-checked rather than accessed as `any`.

While the API isn't initialized, the page shows setup instructions. Once `vmsApiInit` fires, it swaps to the live view: a greeting naming the current tab, and a camera list that shows the first 5 entries, with a toggle to reveal the rest. Click any camera to drop it onto the current layout.

> **Note on resource scope:** resources are fetched using the account's current session token, which may grant access across multiple sites if the account has that permission — not just resources scoped to this integration's origin site. This is expected: some cross-site features (e.g. cloud layouts) rely on a single session token reaching resources across sites/tenants.

## Running it

### Quick start (dev server)

1. Navigate to the root of `first_integration`
2. `npm install`
3. `npm start` — Parcel serves the page at `http://localhost:1234` and rebuilds on save.
4. Open the Desktop Client.
5. Go to **Main Menu → Add → Integrations…**
6. Add a new **Integration**, pointing it at `http://localhost:1234`.
7. Open the integration's tab in the client, then drag the Integration to the viewing area.
8. Congratulations! You'll see the greeting for your current tab, and a live camera list.

### Build & serve (closer to a real deployment)

1. `npm run build` — bundles everything into `dist/`.
2. `npm run serve` — serves `dist/` as static files at `http://localhost:3000`.
3. Point the Integration at that URL instead of the dev server (steps 4–8 above are otherwise the same).

## Files

| File | Purpose |
|---|---|
| `src/index.html` | Page markup: setup banner, live app view, and the camera list. |
| `src/index.ts` | Entry point: `vmsApiInit`, banner/app toggling, and the "show all cameras" control. |
| `src/initHandlers.ts` | Wires up `window.vms.resources` — initial population (filtered to resources with a media stream) plus live add/update/remove. |
| `src/helpers.ts` | DOM helpers for the camera list: upserting a row by resource id (with a click handler that adds it to the layout), removing a row, and recomputing which rows are visible vs. hidden behind "show all". |
| `src/typesFromDesktopClient.d.ts` | TypeScript types for the `window.vms` API surface used by this integration. |
| `src/css/styles.css` | Styling configurations. |
| `src/img/integration_inclient_js_api.png` | Screenshot used in the setup instructions. |
