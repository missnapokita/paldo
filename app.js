import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup,
  signInWithRedirect, getRedirectResult, signOut
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getDatabase, ref, get, onValue, update, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const DAY = 24 * 60 * 60 * 1000;
const VIP_PLANS = { 7: "1_week", 30: "1_month", 90: "3_months", 365: "1_year" };

const state = {
  auth: null,
  db: null,
  admin: null,
  users: [],
  selectedUid: null,
  unsubscribe: null,
  clock: null
};

const elements = {
  loginView: $("#loginView"), dashboard: $("#dashboardView"), login: $("#loginButton"),
  loginMessage: $("#loginMessage"), logout: $("#logoutButton"), sync: $("#syncState"),
  body: $("#usersBody"), empty: $("#emptyState"), search: $("#searchInput"),
  filter: $("#statusFilter"), modal: $("#userModal"), toast: $("#toast")
};

function setupError(message) {
  elements.login.disabled = true;
  elements.loginMessage.textContent = message;
  elements.loginMessage.classList.add("error");
}

if (!firebaseConfig.appId || firebaseConfig.appId.includes("PASTE_")) {
  setupError("Setup needed: paste the Firebase Web appId in firebase-config.js.");
} else {
  const app = initializeApp(firebaseConfig);
  state.auth = getAuth(app);
  state.db = getDatabase(app);
  startAuth();
}

async function startAuth() {
  try { await getRedirectResult(state.auth); } catch (error) { showAuthError(error); }
  onAuthStateChanged(state.auth, async (user) => {
    stopUsers();
    if (!user) { showLogin(); return; }
    elements.loginMessage.textContent = "Checking administrator access…";
    elements.login.disabled = true;
    try {
      const adminSnapshot = await get(ref(state.db, `admins/${user.uid}`));
      if (adminSnapshot.val() !== true) {
        await signOut(state.auth);
        setupError("Access denied. Add this account UID to /admins in Firebase first.");
        return;
      }
      state.admin = user;
      showDashboard(user);
      watchUsers();
    } catch (error) {
      await signOut(state.auth).catch(() => {});
      showAuthError(error);
    }
  });
}

elements.login.addEventListener("click", async () => {
  elements.login.disabled = true;
  elements.loginMessage.classList.remove("error");
  elements.loginMessage.textContent = "Opening Google sign-in…";
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(state.auth, provider);
  } catch (error) {
    if (["auth/popup-blocked", "auth/cancelled-popup-request", "auth/operation-not-supported-in-this-environment"].includes(error.code)) {
      await signInWithRedirect(state.auth, provider);
      return;
    }
    showAuthError(error);
  }
});

elements.logout.addEventListener("click", () => signOut(state.auth));
elements.search.addEventListener("input", renderUsers);
elements.filter.addEventListener("change", renderUsers);
$$('[data-close-modal]').forEach((button) => button.addEventListener("click", closeModal));
$("#copyUid").addEventListener("click", copySelectedUid);
$("#blockButton").addEventListener("click", toggleBlock);
$("#removeVipButton").addEventListener("click", removeVip);
$$('[data-vip-days]').forEach((button) => button.addEventListener("click", () => grantVip(Number(button.dataset.vipDays))));
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

function showLogin() {
  state.admin = null;
  elements.dashboard.classList.add("hidden");
  elements.loginView.classList.remove("hidden");
  elements.login.disabled = false;
  elements.loginMessage.classList.remove("error");
  elements.loginMessage.textContent = "Only approved administrator accounts can enter.";
}

function showDashboard(user) {
  elements.loginView.classList.add("hidden");
  elements.dashboard.classList.remove("hidden");
  $("#adminName").textContent = user.displayName || "Administrator";
  $("#adminEmail").textContent = user.email || user.uid;
  setImage($("#adminPhoto"), user.photoURL, user.displayName || "A");
}

function watchUsers() {
  setSync("Connecting", "");
  state.unsubscribe = onValue(ref(state.db, "users"), (snapshot) => {
    const value = snapshot.val() || {};
    state.users = Object.entries(value).map(([uid, user]) => normalizeUser(uid, user || {}));
    state.users.sort((a, b) => b.lastLoginAt - a.lastLoginAt);
    renderUsers();
    setSync("Live", "live");
  }, (error) => {
    console.error(error);
    setSync("Permission error", "error");
    toast("Unable to read users. Check Firebase rules.");
  });
  state.clock = window.setInterval(() => {
    updateCountdowns();
    updateStats();
    if (state.selectedUid) updateModal(findUser(state.selectedUid));
  }, 1000);
}

function stopUsers() {
  if (state.unsubscribe) state.unsubscribe();
  if (state.clock) window.clearInterval(state.clock);
  state.unsubscribe = null;
  state.clock = null;
  state.users = [];
}

function normalizeUser(uid, data) {
  return {
    uid,
    displayName: stringValue(data.displayName) || "Bida Reels User",
    email: stringValue(data.email),
    photoUrl: safeImageUrl(data.photoUrl),
    blocked: data.blocked === true,
    blockReason: stringValue(data.blockReason),
    createdAt: numberValue(data.createdAt),
    lastLoginAt: numberValue(data.lastLoginAt),
    vipUntil: Math.max(numberValue(data.vipUntil), numberValue(data.adsDisabledUntil)),
    vipPlan: stringValue(data.vipPlan)
  };
}

function visibleUsers() {
  const needle = elements.search.value.trim().toLowerCase();
  const filter = elements.filter.value;
  const now = Date.now();
  return state.users.filter((user) => {
    const vip = user.vipUntil > now;
    const matchesText = !needle || `${user.displayName} ${user.email} ${user.uid}`.toLowerCase().includes(needle);
    const matchesFilter = filter === "all" || (filter === "vip" && vip) ||
      (filter === "blocked" && user.blocked) || (filter === "regular" && !vip && !user.blocked);
    return matchesText && matchesFilter;
  });
}

function renderUsers() {
  const users = visibleUsers();
  elements.body.innerHTML = users.map(userRow).join("");
  elements.empty.classList.toggle("hidden", users.length !== 0);
  elements.body.querySelectorAll("[data-manage]").forEach((button) => {
    button.addEventListener("click", () => openModal(button.dataset.manage));
  });
  updateStats();
  updateCountdowns();
}

function userRow(user) {
  const avatar = user.photoUrl
    ? `<img class="avatar" src="${escapeHtml(user.photoUrl)}" alt="">`
    : `<span class="avatar">${escapeHtml(initials(user.displayName))}</span>`;
  const badges = [
    user.vipUntil > Date.now() ? '<span class="badge vip">VIP</span>' : '<span class="badge">REGULAR</span>',
    user.blocked ? '<span class="badge blocked">BLOCKED</span>' : ""
  ].join("");
  return `<tr>
    <td><div class="user-cell">${avatar}<div><strong>${escapeHtml(user.displayName)}</strong><span>${escapeHtml(user.email || user.uid)}</span></div></div></td>
    <td><div class="badges">${badges}</div></td>
    <td><span class="countdown" data-countdown="${user.uid}">${vipText(user.vipUntil)}</span></td>
    <td>${escapeHtml(formatDate(user.lastLoginAt))}</td>
    <td><button class="manage-button" type="button" data-manage="${user.uid}">Manage</button></td>
  </tr>`;
}

function updateStats() {
  const now = Date.now();
  $("#totalUsers").textContent = state.users.length;
  $("#activeVip").textContent = state.users.filter((user) => user.vipUntil > now).length;
  $("#blockedUsers").textContent = state.users.filter((user) => user.blocked).length;
  $("#recentUsers").textContent = state.users.filter((user) => user.lastLoginAt > now - 7 * DAY).length;
}

function updateCountdowns() {
  document.querySelectorAll("[data-countdown]").forEach((node) => {
    const user = findUser(node.dataset.countdown);
    if (user) node.textContent = vipText(user.vipUntil);
  });
}

function openModal(uid) {
  const user = findUser(uid);
  if (!user) return;
  state.selectedUid = uid;
  updateModal(user);
  elements.modal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  state.selectedUid = null;
  elements.modal.classList.add("hidden");
  document.body.style.overflow = "";
}

function updateModal(user) {
  if (!user) return;
  setImage($("#modalPhoto"), user.photoUrl, user.displayName);
  $("#modalTitle").textContent = user.displayName;
  $("#modalEmail").textContent = user.email || "No email saved";
  $("#modalUid").textContent = user.uid;
  $("#modalStatus").textContent = user.blocked ? "Blocked" : (user.vipUntil > Date.now() ? "Active VIP" : "Active user");
  $("#modalCountdown").textContent = vipText(user.vipUntil);
  $("#modalCreated").textContent = formatDate(user.createdAt);
  $("#modalLastLogin").textContent = formatDate(user.lastLoginAt);
  $("#blockReason").value = user.blockReason;
  const block = $("#blockButton");
  block.textContent = user.blocked ? "Unblock this user" : "Block this user";
  block.classList.toggle("unblock", user.blocked);
  $("#removeVipButton").disabled = user.vipUntil <= Date.now();
}

async function grantVip(days) {
  const user = selectedUser();
  if (!user || !state.admin) return;
  const until = Date.now() + days * DAY;
  await writeUser(user.uid, {
    vipPlan: VIP_PLANS[days],
    vipGrantedAt: serverTimestamp(),
    vipUntil: until,
    adsDisabledUntil: until,
    vipGrantedBy: state.admin.uid,
    updatedAt: serverTimestamp()
  }, `${planLabel(days)} VIP activated`);
}

async function removeVip() {
  const user = selectedUser();
  if (!user || !state.admin) return;
  await writeUser(user.uid, {
    vipPlan: "",
    vipUntil: 0,
    adsDisabledUntil: 0,
    vipRevokedAt: serverTimestamp(),
    vipGrantedBy: state.admin.uid,
    updatedAt: serverTimestamp()
  }, "VIP access removed");
}

async function toggleBlock() {
  const user = selectedUser();
  if (!user || !state.admin) return;
  const blocked = !user.blocked;
  await writeUser(user.uid, {
    blocked,
    blockReason: blocked ? $("#blockReason").value.trim() : "",
    blockedAt: blocked ? serverTimestamp() : 0,
    blockedBy: blocked ? state.admin.uid : "",
    updatedAt: serverTimestamp()
  }, blocked ? "User blocked" : "User unblocked");
}

async function writeUser(uid, values, successMessage) {
  setModalBusy(true);
  try {
    await update(ref(state.db, `users/${uid}`), values);
    toast(successMessage);
  } catch (error) {
    console.error(error);
    toast("Update failed. Check administrator rules.");
  } finally {
    setModalBusy(false);
    const current = selectedUser();
    if (current) updateModal(current);
  }
}

function setModalBusy(busy) {
  elements.modal.querySelectorAll("button,input").forEach((control) => {
    if (!control.hasAttribute("data-close-modal")) control.disabled = busy;
  });
}

function selectedUser() { return findUser(state.selectedUid); }
function findUser(uid) { return state.users.find((user) => user.uid === uid); }
function setSync(text, status) { elements.sync.className = `sync-state ${status}`; elements.sync.querySelector("span").textContent = text; }

function setImage(image, url, label) {
  image.src = safeImageUrl(url) || avatarData(initials(label));
}

function avatarData(text) {
  const safe = escapeHtml(text || "BR");
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><defs><linearGradient id="g"><stop stop-color="#ffc107"/><stop offset="1" stop-color="#ff7200"/></linearGradient></defs><rect width="120" height="120" rx="34" fill="#221a0c"/><text x="60" y="73" text-anchor="middle" font-family="Arial" font-size="40" font-weight="700" fill="url(#g)">${safe}</text></svg>`)}`;
}

function safeImageUrl(value) { const text = stringValue(value); return /^https:\/\//i.test(text) ? text : ""; }
function stringValue(value) { return typeof value === "string" ? value.trim() : ""; }
function numberValue(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function initials(value) { return stringValue(value).split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "BR"; }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>'"]/g, (char) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char])); }
function formatDate(value) { return value > 0 ? new Intl.DateTimeFormat("en-PH", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : "Not available"; }
function planLabel(days) { return ({7:"1-week",30:"1-month",90:"3-month",365:"1-year"})[days] || `${days}-day`; }

function vipText(until) {
  let remaining = until - Date.now();
  if (remaining <= 0) return "Not active";
  const days = Math.floor(remaining / DAY); remaining %= DAY;
  const hours = Math.floor(remaining / 3600000); remaining %= 3600000;
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  return days > 0 ? `${days}d ${hours}h ${minutes}m` : `${hours}h ${minutes}m ${seconds}s`;
}

async function copySelectedUid() {
  const user = selectedUser();
  if (!user) return;
  try { await navigator.clipboard.writeText(user.uid); toast("UID copied"); }
  catch (_) { toast("Unable to copy UID"); }
}

function showAuthError(error) {
  console.error(error);
  elements.login.disabled = false;
  elements.loginMessage.classList.add("error");
  elements.loginMessage.textContent = friendlyError(error);
}

function friendlyError(error) {
  if (error?.code === "auth/unauthorized-domain") return "Add this GitHub Pages domain to Firebase Authentication > Authorized domains.";
  if (error?.code === "auth/popup-closed-by-user") return "Google sign-in was closed before completion.";
  if (error?.code === "PERMISSION_DENIED") return "Permission denied. Apply database.rules.json and add your admin UID.";
  return error?.message || "Unable to sign in. Check the Firebase setup.";
}

let toastTimer;
function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}
