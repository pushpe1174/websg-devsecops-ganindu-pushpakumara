const API = localStorage.getItem('apiBase') ?? 'http://localhost:3000';

const el = (id) => document.getElementById(id);
const screens = { login: el('login'), app: el('app') };

const state = {
  token: null,
  user: null,
  tenant: null,
  version: 0,
  saved: [],
  draft: [],
};

function show(name) {
  for (const [key, node] of Object.entries(screens)) node.hidden = key !== name;
}

function busy(on, text = 'Saving…') {
  el('loading-text').textContent = text;
  el('loading').hidden = !on;
}

function fail(node, message) {
  node.textContent = message;
  node.hidden = !message;
}

start();

async function start() {
  show('login');
  try {
    const { users } = await call('GET', '/auth/users');
    el('user').replaceChildren(
      ...users.map(({ userId, tenantId }) => new Option(`${userId} — ${tenantId}`, userId)),
    );
  } catch (err) {
    fail(el('login-error'), describe(err));
  }
}

el('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  fail(el('login-error'), '');
  busy(true, 'Signing in…');

  try {
    const session = await call('POST', '/auth/login', { userId: el('user').value });
    state.token = session.token;
    state.user = session.userId;
    state.tenant = session.tenantId;

    el('who').textContent = session.userId;
    el('tenant').textContent = session.tenantId;

    await load();
    show('app');
  } catch (err) {
    fail(el('login-error'), describe(err));
  } finally {
    busy(false);
  }
});

el('signout').addEventListener('click', () => {
  Object.assign(state, { token: null, user: null, tenant: null, version: 0, saved: [], draft: [] });
  fail(el('error'), '');
  show('login');
});

async function load() {
  busy(true, 'Loading…');
  try {
    const record = await call('GET', '/v1/allowlist');
    state.version = record.version;
    state.saved = [...record.cidrs];
    state.draft = [...record.cidrs];
    el('meta').textContent = describeRecord(record);
    render();
  } finally {
    busy(false);
  }
}

function render() {
  const list = el('list');
  list.replaceChildren(
    ...state.draft.map((cidr) => {
      const item = document.createElement('li');
      if (!state.saved.includes(cidr)) item.classList.add('added');

      const label = document.createElement('span');
      label.textContent = cidr;

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'link';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        state.draft = state.draft.filter((entry) => entry !== cidr);
        render();
      });

      item.append(label, remove);
      return item;
    }),
  );

  el('empty').hidden = state.draft.length > 0;

  const dirty =
    state.draft.length !== state.saved.length ||
    state.draft.some((cidr, i) => cidr !== state.saved[i]);
  el('save').disabled = !dirty;
  el('reset').disabled = !dirty;
}

el('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = el('cidr');
  const cidr = input.value.trim();
  fail(el('error'), '');

  if (!/^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(cidr)) {
    return fail(el('error'), 'Enter an IPv4 address or CIDR, for example 203.0.113.0/24.');
  }
  if (state.draft.includes(cidr)) return fail(el('error'), `${cidr} is already on the list.`);

  state.draft.push(cidr);
  input.value = '';
  render();
});

el('reset').addEventListener('click', () => {
  state.draft = [...state.saved];
  fail(el('error'), '');
  render();
});

el('save').addEventListener('click', async () => {
  fail(el('error'), '');
  busy(true, 'Saving…');

  try {
    const record = await call('PUT', '/v1/allowlist', { cidrs: state.draft }, state.version);

    state.version = record.version;
    state.saved = [...record.cidrs];
    state.draft = [...record.cidrs];
    el('meta').textContent = describeRecord(record);
    render();
    popup(record);
  } catch (err) {
    fail(el('error'), describe(err));
    if (err.status === 409 || err.status === 428) await load();
  } finally {
    busy(false);
  }
});

function popup(record) {
  const applied = record.syncStatus === 'APPLIED';
  el('result-title').textContent = applied ? 'Allowlist updated' : 'Saved, still applying';
  el('result-note').textContent = applied
    ? `Version ${record.version} is live at the edge.`
    : `Version ${record.version} is stored and is being pushed to the edge. Reload in a moment to confirm.`;

  el('result-list').replaceChildren(
    ...(record.cidrs.length > 0
      ? record.cidrs.map((cidr) => {
          const item = document.createElement('li');
          item.textContent = cidr;
          return item;
        })
      : [Object.assign(document.createElement('li'), { textContent: 'No addresses' })]),
  );

  el('result').showModal();
}

const describeRecord = (record) =>
  `version ${record.version} · ${record.syncStatus === 'APPLIED' ? 'applied' : 'applying'}`;

async function call(method, path, body, ifMatch) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ifMatch !== undefined) headers['if-match'] = String(ifMatch);

  let response;
  try {
    response = await fetch(API + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      mode: 'cors',
    });
  } catch {
    throw Object.assign(new Error(`Cannot reach the API at ${API}.`), { status: 0 });
  }

  const payload = await response.json().catch(() => ({}));
  if (response.ok) return payload;

  throw Object.assign(new Error(payload.error ?? response.statusText), {
    status: response.status,
    reasons: payload.reasons,
  });
}

function describe(err) {
  if (err.status === 401) return 'Your session has expired. Sign in again.';
  if (err.status === 409) return 'The list changed elsewhere. It has been reloaded — try again.';
  const reasons = err.reasons?.length ? `\n${err.reasons.join('\n')}` : '';
  return `${err.message}${reasons}`;
}
