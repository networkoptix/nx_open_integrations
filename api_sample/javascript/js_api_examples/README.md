# JS API Examples — Nx Desktop Client embedded browser

These two demos are **not** part of the REST / Cloud CDB sample catalog in
[`../../README.md`](../../README.md). They cover a different, unrelated API
surface: the **JavaScript API the Nx Witness Desktop Client exposes to pages
loaded in its built-in browser** (client-side scripting inside the desktop
app, not HTTP calls to a server or the cloud).

Reference: [Nx Meta Knowledgebase — Introduction to the JavaScript API](https://meta.nxvms.com/docs/developers/knowledgebase/325-introduction-to-the-javascript-api)

## Folders

| Folder | What it shows |
|---|---|
| [`dashboard`](dashboard) | A dashboard-style page built against the Desktop Client JS API. |
| [`resources`](resources) | A general-purpose test/reference page for the same API, with a prebuilt `compiled_client_api_test_page.html`. |

Each folder is a small [Parcel](https://parceljs.org/)-based TypeScript/HTML/CSS
project — see each folder's own `readme.md` for its `npm install` / `npm start`
/ `npm run build` steps. They're independent of the Node/Python/TypeScript/C#/
web samples elsewhere in this repo (different runtime, different API, no
shared config or `.env`).
