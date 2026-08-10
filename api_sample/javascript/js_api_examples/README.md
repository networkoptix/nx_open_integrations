# JS API Examples — Integrations in Nx Witness Desktop Client embedded browser

The Nx Witness JavaScript API lets developers integrate web apps through the built-in **Integrations** resource. 
Developers can build a web-based application as an Integration and use the API to trigger actions on the 
Desktop Client, creating an integrated experience for users inside the Desktop Client.

Reference: [The In-Client JavaScript API](https://support.networkoptix.com/hc/en-us/articles/32919459274519-The-In-Client-JavaScript-API)

## Folders

| Folder | What it shows |
|---|---|
| [`hello_world`](hello_world) | The smallest possible example: static HTML/CSS, no build step, just `vmsApiInit` and reading the current tab name. Start here. |
| [`first_integration`](first_integration) | The first integration extended from hello-world sample. Demonstrate the resource interaction features. |
| [`dashboard`](dashboard) | A dashboard-style page built against the Desktop Client JS API. |
| [`resources`](resources) | A general-purpose test/reference page for the same API, with a prebuilt `compiled_client_api_test_page.html`. |

## Samples

1. `hello_world` has no build step at all — serve its `src/index.html` directly with any HTTP server, then open it as an Integration in the Desktop Client. 
It's a warm-up sample that introduces API object initialization.

2. `first_integration`, `dashboard` and `resources` are [Parcel](https://parceljs.org/)-based TypeScript/HTML/CSS projects. 
See the `readme.md` in each folder for details, including the `npm install` / `npm start` / `npm run build` steps.