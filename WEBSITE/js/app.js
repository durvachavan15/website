const STORAGE = { draft: "horizon_draft" };
let currentUser = null;

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: "same-origin",
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) }
    });
  } catch {
    throw new Error("Account service is unavailable. Start the backend with `python server.py` and open http://127.0.0.1:8000.");
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The account API returned an invalid response. On Netlify, check that Functions deployed; locally, run `python server.py` and open http://127.0.0.1:8000.");
  }
  if (!response.ok) throw new Error(result.error || "Request failed.");
  return result;
}

function setCurrentUser(user) {
  currentUser = user;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function getDraft() {
  return JSON.parse(localStorage.getItem(STORAGE.draft) || "null");
}

function setDraft(draft) {
  localStorage.setItem(STORAGE.draft, JSON.stringify(draft));
}

function money(n) {
  return "₹" + Number(n).toLocaleString("en-IN");
}

function daysBetween(start, end) {
  const a = new Date(start);
  const b = new Date(end);
  const days = Math.ceil((b - a) / 86400000);
  return Math.max(1, days);
}

function vehicleCard(v, withButton = true) {
  return `
    <article class="card vehicle-card">
      <img src="${v.img}" alt="${v.name}">
      <div class="vehicle-body">
        <div class="badge-row">
          <span class="badge">${v.tag}</span>
          <span class="muted">${v.city}</span>
        </div>
        <h3 style="margin:10px 0 6px">${v.name}</h3>
        <p class="muted">${v.seats} seats · ${v.trans} · ${v.fuel}</p>
        <div class="price-row" style="margin-top:14px">
          <div class="price">${money(v.price)}<span class="muted" style="font-size:.8rem;font-weight:600"> /day</span></div>
          ${withButton ? `<a class="btn btn-navy" href="confirm.html?id=${v.id}">Select</a>` : ""}
        </div>
      </div>
    </article>
  `;
}

async function renderNavAuth() {
  const slot = document.querySelector("[data-auth-slot]");
  if (!slot) return;
  let user = null;
  try {
    user = (await apiRequest("/api/me")).user;
  } catch {
    user = null;
  }
  setCurrentUser(user);
  if (user) {
    slot.innerHTML = `<a class="btn btn-outline" href="account.html">${escapeHTML(user.name.split(" ")[0])}</a>`;
  } else {
    slot.innerHTML = `<a class="btn btn-navy" href="account.html">Sign in</a>`;
  }
}

function todayISO(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

document.addEventListener("DOMContentLoaded", () => { renderNavAuth(); });
