# Hello World — In-Client JavaScript API

The simplest possible example of the [Nx Witness Desktop Client In-Client JavaScript API](https://support.networkoptix.com/hc/en-us/articles/32919459274519-The-In-Client-JavaScript-API): a single static HTML page that detects whether it's running as an Integration inside the Desktop Client, and if so, greets you with the name of the tab it's loaded in.

No build step, no dependencies — just static HTML/CSS you can open directly.

## What it shows

- `window.isVmsApiEnabled` — how a page can detect whether the API is available at all.
- `window.vmsApiInit` — the callback the Desktop Client calls once the JS API is ready to use.
- `window.vms.tab.name` — reading a basic property from the API.

While the API isn't initialized, the page shows setup instructions.
Once `vmsApiInit` fires, it swaps to a "Congratulations!" view naming the tab running the integration.

## Running it

1. Change the directory to the `src` folder in `hello_world`
```bash
cd hello_world/src
```
2. Server the `index.html` via a HTTP server. (Ex: via python http server)
```python
python3 -m http.server 1234
```
3. Open the Desktop Client.
4. Go to **Main Menu → Add → Integrations…**
4. Add a new **Integration**, pointing it at the local URL from Step 2, eg:
`http://127.0.0.1:1234`
5. Open the integration's tab in the client, then drag the Integration to the viewing area.
6. Congratulations!  You can now see the page and a greeting naming the tab running the integration.

## Files

| File | Purpose |
|---|---|
| `src/index.html` | The page markup and the API usage (`vmsApiInit`, `window.vms.tab.name`). |
| `src/css/style.css` | Styling only — not part of the API demo. |
| `src/img/integration_inclient_js_api.png` | Screenshot used in the setup instructions. |
