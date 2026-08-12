# frontend

The self-service portal. Three files, no framework, no build step, no
dependencies — open it and it runs.

```
index.html   markup: the login screen, the list, the result dialog
app.js       everything it does: sign in, add, remove, save
styles.css   everything it looks like, light and dark
```

## Running it

```sh
make frontend        # http://localhost:5173, from the repo root
```

It expects the API on port 3000 of whatever host serves the page — `localhost`
and `127.0.0.1` both work. To point somewhere else, set it once in the browser
console — no rebuild, no config file:

```js
localStorage.setItem('apiBase', 'https://api.example');
```

The API must list the page's origin in `CORS_ORIGINS`, which by default it does
for both `http://localhost:5173` and `http://127.0.0.1:5173`. Open the page over
`make frontend`, not by double-clicking `index.html` — a `file://` page has the
origin `null` and every request is blocked. When an origin is missing the
browser rejects the request before it reaches the server, and the portal shows
"Cannot reach the API" with no matching entry in the API log — the request never
got there. Add the origin to `CORS_ORIGINS`; `npm run dev` watches `.env` and
restarts itself, but `npm start` does not, so restart that one by hand.

## What it does

1. **Sign in.** `GET /auth/users` fills the dropdown, `POST /auth/login` returns
   a token. No password — the backend's mock IdP stands in for the real one.
2. **Show the list.** `GET /v1/allowlist`.
3. **Edit.** Add and remove are local only. Nothing leaves the browser until
   Save, and Save is disabled while nothing has changed.
4. **Save.** `PUT /v1/allowlist` with `If-Match` set to the version last read.
   A spinner holds the screen — the request waits for the edge to confirm — then
   a dialog shows the stored list and whether it is live yet.

## Things worth knowing

- **The token is a variable.** No `localStorage`, no cookie. Reloading signs you
  out, and nothing on disk holds a credential.
- **The API is the authority.** The add box checks the shape of an address so an
  obvious typo costs no round trip. Whether a range is routable, wide enough, or
  yours is decided by the backend, and its reasons are shown verbatim.
- **Conflicts are handled, not hidden.** A 409 means someone changed the list
  since it was read; the page reloads it and says so rather than overwriting.
