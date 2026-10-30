import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signOut, GoogleAuthProvider, signInWithPopup,
  signInWithRedirect, getRedirectResult, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, onSnapshot, writeBatch, Timestamp, connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/11.0.2/firebase-firestore.js";
import { firebaseConfig, allowedEmails } from "./firebase-config.js";

// ---- 定数 ----
const AGES = ["小学生以下", "中学生", "高校生", "大学生", "大人"];
const GENDERS = ["男", "女", "混合"];
const DEPOSITS = [500, 1000, 2000, 5000, 10000];
const TICKET_MAX = 20;
const DEFAULT_SETTINGS = { price: 400, totalCost: 55852 };

// ---- Firebase ----
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// 端末内にもデータを持つ。ネットが切れても書き込みは端末にたまり、つながったら送られる
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
// 手元の PC で試すときだけエミュレーターにつなぐ
if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}
const ordersCol = collection(db, "orders");
const settingsRef = doc(db, "settings", "main");

// ---- 状態 ----
const state = {
  orders: [],          // {id, ...data, createdAt: Date, handedAt: Date|null, pending: bool}
  settings: { ...DEFAULT_SETTINGS },
  form: { cups: 1, age: null, gender: null, withChild: false, deposit: null },
  unsubs: [],
  fromCache: true,
  loaded: false,       // 最初のデータが届くまで会計を止める(番号の重複防止)
};

// ---- 便利関数 ----
const $ = (id) => document.getElementById(id);
const yen = (n) => (n < 0 ? "−¥" : "¥") + Math.abs(Math.round(n)).toLocaleString("ja-JP");
const pad = (n) => String(n).padStart(2, "0");
const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fullTime = (d) => `${dateKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const toDate = (v) => (v instanceof Timestamp ? v.toDate() : v instanceof Date ? v : null);
const active = () => state.orders.filter((o) => !o.canceled);
const waiting = () => active().filter((o) => !o.handedAt);
const todayKey = () => dateKey(new Date());

function usedTickets(exceptId = null) {
  const s = new Set();
  for (const o of waiting()) if (o.ticket != null && o.id !== exceptId) s.add(o.ticket);
  return s;
}
function nextTicket() {
  const used = usedTickets();
  for (let i = 1; i <= TICKET_MAX; i++) if (!used.has(i)) return i;
  return null;
}

function write(promise) {
  // オフライン時は Promise が送信完了まで解決しないので待たない。失敗だけ知らせる
  promise.catch((e) => { console.error(e); toast("保存に失敗しました: " + e.code); });
}

let toastTimer = null;
function toast(msg, action = null) {
  const t = $("toast");
  t.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => { t.hidden = true; action.fn(); };
    t.appendChild(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, action ? 6000 : 3000);
}

function openModal(build) {
  const box = $("modal-content");
  box.innerHTML = "";
  build(box);
  $("modal").hidden = false;
}
function closeModal() { $("modal").hidden = true; }
$("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "text") e.textContent = v;
    else if (k === "onclick") e.onclick = v;
    else if (k === "class") e.className = v;
    else e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) if (c) e.appendChild(c);
  return e;
}

// ---- ログイン ----
const LOGIN_ERRORS = {
  "auth/network-request-failed": "ネットにつながっていません。つながる場所でログインしてください",
  "auth/popup-closed-by-user": "ログインが途中で閉じられました。もう一度押してください",
  "auth/cancelled-popup-request": "",
  "auth/unauthorized-domain": "このアドレスからはログインできない設定です",
};
function showLoginError(err) {
  console.error(err);
  const msg = LOGIN_ERRORS[err.code];
  $("login-error").textContent = msg ?? "ログインできませんでした (" + err.code + ")";
}
$("google-login").addEventListener("click", async () => {
  $("login-error").textContent = "";
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    // ポップアップが開けない環境(ホーム画面から起動した場合など)はページ遷移でログインする
    if (err.code === "auth/popup-blocked" || err.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider).catch(showLoginError);
    } else showLoginError(err);
  }
});
getRedirectResult(auth).catch(showLoginError);

onAuthStateChanged(auth, (user) => {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
  if (!user) {
    $("login-view").hidden = false;
    $("main-view").hidden = true;
    return;
  }
  const email = (user.email || "").toLowerCase();
  if (!allowedEmails.includes(email)) {
    $("login-error").textContent = `${user.email} は登録されていないので使えません。HAC のアカウントでログインしてください。`;
    signOut(auth);
    return;
  }
  $("login-view").hidden = true;
  $("main-view").hidden = false;
  $("account-info").textContent = "ログイン中: " + user.email;
  subscribe();
});

function subscribe() {
  state.unsubs.push(onSnapshot(ordersCol, { includeMetadataChanges: true }, (snap) => {
    state.fromCache = snap.metadata.fromCache;
    state.loaded = true;
    state.orders = snap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id, ...x,
        createdAt: toDate(x.createdAt) || new Date(0),
        handedAt: toDate(x.handedAt),
        pending: d.metadata.hasPendingWrites,
      };
    }).sort((a, b) => a.createdAt - b.createdAt);
    renderAll();
  }, (err) => { console.error(err); toast("読み込みエラー: " + err.code); }));

  state.unsubs.push(onSnapshot(settingsRef, (snap) => {
    state.settings = { ...DEFAULT_SETTINGS, ...(snap.exists() ? snap.data() : {}) };
    $("set-price").value = state.settings.price;
    $("set-cost").value = state.settings.totalCost;
    renderAll();
  }));
}

// ---- タブ ----
document.querySelectorAll(".tabbar button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabbar button").forEach((x) => x.classList.toggle("active", x === b));
    document.querySelectorAll(".tab").forEach((t) => { t.hidden = t.id !== "tab-" + b.dataset.tab; });
    window.scrollTo(0, 0);
  });
});

// ---- 会計フォーム ----
function buildChoices(containerId, values, key, label = (v) => v) {
  const c = $(containerId);
  c.innerHTML = "";
  for (const v of values) {
    const b = el("button", { type: "button", "aria-pressed": "false", text: label(v) });
    b.dataset.value = v;
    b.onclick = () => {
      state.form[key] = state.form[key] === v ? null : v;
      renderForm();
    };
    c.appendChild(b);
  }
}
buildChoices("age-choices", AGES, "age");
buildChoices("gender-choices", GENDERS, "gender");
buildChoices("deposit-choices", DEPOSITS, "deposit", (v) => v.toLocaleString("ja-JP") + "円");

$("cups-minus").onclick = () => { state.form.cups = Math.max(1, state.form.cups - 1); renderForm(); };
$("cups-plus").onclick = () => { state.form.cups = Math.min(99, state.form.cups + 1); renderForm(); };
$("child-toggle").onclick = () => { state.form.withChild = !state.form.withChild; renderForm(); };

function renderForm() {
  const f = state.form;
  $("cups-value").textContent = f.cups;
  for (const [cid, key] of [["age-choices", "age"], ["gender-choices", "gender"], ["deposit-choices", "deposit"]]) {
    $(cid).querySelectorAll("button").forEach((b) => {
      b.setAttribute("aria-pressed", String(String(f[key]) === b.dataset.value));
    });
  }
  $("child-toggle").setAttribute("aria-pressed", String(f.withChild));
  $("child-toggle").textContent = "子連れ: " + (f.withChild ? "はい" : "いいえ");
  const amount = state.settings.price * f.cups;
  $("total-amount").textContent = yen(amount);
  if (f.deposit == null) $("change-amount").textContent = "—";
  else if (f.deposit < amount) $("change-amount").textContent = "不足 " + yen(amount - f.deposit);
  else $("change-amount").textContent = yen(f.deposit - amount);
  const ok = f.age && f.gender;
  $("confirm-btn").disabled = !ok || !state.loaded;
  $("confirm-btn").textContent = !state.loaded ? "記録を読み込み中…" : ok ? `会計を確定(${yen(amount)})` : "年代と性別を選んでください";
}

$("confirm-btn").onclick = () => {
  const f = state.form;
  if (!f.age || !f.gender || !state.loaded) return;
  const ticket = nextTicket();
  const now = new Date();
  const ref = doc(ordersCol);
  const data = {
    createdAt: Timestamp.fromDate(now),
    date: dateKey(now),
    cups: f.cups,
    unitPrice: state.settings.price,
    amount: state.settings.price * f.cups,
    age: f.age,
    gender: f.gender,
    withChild: f.withChild,
    ticket,
    handedAt: null,
    canceled: false,
    updatedAt: Timestamp.fromDate(now),
  };
  write(setDoc(ref, data));
  state.form = { cups: 1, age: null, gender: null, withChild: false, deposit: null };
  renderForm();

  openModal((box) => {
    box.appendChild(el("h2", { text: "会計を記録しました" }));
    if (ticket != null) {
      box.appendChild(el("p", { class: "muted", text: "この番号の整理券を渡してください" }));
      box.appendChild(el("div", { class: "ticket-big", text: String(ticket) }));
    } else {
      box.appendChild(el("div", { class: "warn", text: `整理券が${TICKET_MAX}枚すべて使用中です。会計は記録しました。番号は履歴から後で付けられます。` }));
    }
    box.appendChild(el("p", { class: "center", text: `${data.cups}杯 ${yen(data.amount)} / ${data.age}・${data.gender}${data.withChild ? "・子連れ" : ""}` }));
    box.appendChild(el("button", { type: "button", class: "primary big", text: "OK", onclick: closeModal }));
  });
};

// ---- 整理券 ----
function renderTickets() {
  const list = waiting();
  const grid = $("ticket-grid");
  grid.innerHTML = "";
  for (const o of list) {
    const mins = Math.floor((Date.now() - o.createdAt) / 60000);
    const card = el("button", { type: "button", class: "ticket" + (o.ticket == null ? " noticket" : "") }, [
      el("div", { class: "num", text: o.ticket == null ? "番号なし" : String(o.ticket) }),
      el("div", { class: "sub", text: `${o.cups}杯・${mins}分待ち` }),
    ]);
    card.onclick = () => markHanded(o);
    grid.appendChild(card);
  }
  $("ticket-empty").hidden = list.length > 0;
  const used = usedTickets();
  const free = $("free-tickets");
  free.innerHTML = "";
  for (let i = 1; i <= TICKET_MAX; i++) if (!used.has(i)) free.appendChild(el("span", { text: String(i) }));
  const n = list.length;
  $("reg-waiting").textContent = n;
  $("tab-waiting").hidden = n === 0;
  $("tab-waiting").textContent = n;
}

// 待ちに戻すとき、元の番号が他で使われていたら空き番号に振り直す
function backToWaiting(o, extra = {}) {
  const patch = { ...extra, handedAt: null, updatedAt: Timestamp.fromDate(new Date()) };
  if (o.ticket != null && usedTickets(o.id).has(o.ticket)) {
    const t = nextTicket();
    patch.ticket = t;
    toast(`${o.ticket} 番は使用中なので ${t ?? "番号なし"} に変更しました。整理券を確認してください`);
  }
  write(updateDoc(doc(ordersCol, o.id), patch));
}

function markHanded(o) {
  const now = new Date();
  write(updateDoc(doc(ordersCol, o.id), { handedAt: Timestamp.fromDate(now), updatedAt: Timestamp.fromDate(now) }));
  toast(`${o.ticket ?? "番号なし"} 番を受け渡し済みにしました`, {
    label: "元に戻す",
    fn: () => backToWaiting(o),
  });
}

// ---- 履歴 ----
function renderHistory() {
  const list = $("history-list");
  list.innerHTML = "";
  let lastDay = null;
  for (const o of [...state.orders].reverse()) {
    const day = dateKey(o.createdAt);
    if (day !== lastDay) { list.appendChild(el("div", { class: "day-head", text: day })); lastDay = day; }
    const status = o.canceled ? "取消" : o.handedAt ? "渡済" : "待ち";
    const row = el("button", { type: "button", class: "row" + (o.canceled ? " canceled" : "") }, [
      el("span", { class: "time", text: hm(o.createdAt) }),
      el("span", { class: "tk", text: o.ticket == null ? "—" : "#" + o.ticket }),
      el("span", {}, [
        el("div", { text: `${o.cups}杯 ${yen(o.amount)}${o.pending ? " ・未送信" : ""}` }),
        el("div", { class: "attrs", text: `${o.age}・${o.gender}${o.withChild ? "・子連れ" : ""}` }),
      ]),
      el("span", { class: "st", text: status }),
    ]);
    row.onclick = () => openEdit(o);
    list.appendChild(row);
  }
  if (!state.orders.length) list.appendChild(el("p", { class: "muted center", text: "まだ会計はありません" }));
}

function openEdit(o) {
  const draft = { cups: o.cups, age: o.age, gender: o.gender, withChild: !!o.withChild, ticket: o.ticket };
  openModal((box) => {
    box.appendChild(el("h2", { text: `${dateKey(o.createdAt)} ${hm(o.createdAt)} の会計` }));
    box.appendChild(el("p", { class: "muted", text: `単価 ${yen(o.unitPrice)}` + (o.handedAt ? ` / 受け渡し ${hm(o.handedAt)}` : "") }));

    const cupsOut = el("output", { text: String(draft.cups) });
    const stepper = el("div", { class: "stepper" }, [
      el("button", { type: "button", text: "−", onclick: () => { draft.cups = Math.max(1, draft.cups - 1); cupsOut.textContent = draft.cups; } }),
      cupsOut,
      el("button", { type: "button", text: "＋", onclick: () => { draft.cups = Math.min(99, draft.cups + 1); cupsOut.textContent = draft.cups; } }),
    ]);
    box.appendChild(el("div", { class: "field" }, [el("div", { class: "field-label", text: "杯数" }), stepper]));

    const mkChoices = (values, key, cls) => {
      const c = el("div", { class: "choices " + cls });
      const sync = () => c.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(draft[key] === b.dataset.value)));
      for (const v of values) {
        const b = el("button", { type: "button", text: v, onclick: () => { draft[key] = v; sync(); } });
        b.dataset.value = v;
        c.appendChild(b);
      }
      sync();
      return c;
    };
    box.appendChild(el("div", { class: "field" }, [el("div", { class: "field-label", text: "年代" }), mkChoices(AGES, "age", "five")]));
    box.appendChild(el("div", { class: "field" }, [el("div", { class: "field-label", text: "性別" }), mkChoices(GENDERS, "gender", "three")]));

    const child = el("button", { type: "button", class: "toggle" });
    const syncChild = () => { child.setAttribute("aria-pressed", String(draft.withChild)); child.textContent = "子連れ: " + (draft.withChild ? "はい" : "いいえ"); };
    child.onclick = () => { draft.withChild = !draft.withChild; syncChild(); };
    syncChild();
    box.appendChild(el("div", { class: "field" }, [child]));

    const sel = el("select", { "aria-label": "整理券番号" });
    sel.appendChild(el("option", { value: "", text: "番号なし" }));
    for (let i = 1; i <= TICKET_MAX; i++) sel.appendChild(el("option", { value: String(i), text: i + " 番" }));
    sel.value = draft.ticket == null ? "" : String(draft.ticket);
    const warn = el("div", { class: "warn", hidden: "" });
    sel.onchange = () => {
      draft.ticket = sel.value === "" ? null : Number(sel.value);
      const clash = draft.ticket != null && !o.handedAt && usedTickets(o.id).has(draft.ticket);
      warn.hidden = !clash;
      warn.textContent = clash ? `${draft.ticket} 番は別の待ちの会計で使用中です。保存すると番号が重なります。` : "";
    };
    box.appendChild(el("div", { class: "field" }, [el("div", { class: "field-label", text: "整理券番号" }), sel, warn]));

    const actions = el("div", { class: "modal-actions" });
    actions.appendChild(el("button", { type: "button", text: "閉じる", onclick: closeModal }));
    actions.appendChild(el("button", {
      type: "button", class: "primary", text: "保存", onclick: () => {
        write(updateDoc(doc(ordersCol, o.id), {
          ...draft, amount: o.unitPrice * draft.cups, updatedAt: Timestamp.fromDate(new Date()),
        }));
        closeModal();
        toast("修正しました");
      },
    }));
    box.appendChild(actions);

    const extra = el("div", { class: "modal-actions" });
    if (o.handedAt && !o.canceled) {
      extra.appendChild(el("button", { type: "button", text: "待ちに戻す", onclick: () => {
        closeModal();
        backToWaiting(o);
      } }));
    } else extra.appendChild(el("span"));
    extra.appendChild(el("button", {
      type: "button", class: "danger", text: o.canceled ? "取り消しを元に戻す" : "この会計を取り消す",
      onclick: () => {
        closeModal();
        if (o.canceled && !o.handedAt) {
          toast("取り消しを元に戻しました");
          backToWaiting(o, { canceled: false });
        } else {
          write(updateDoc(doc(ordersCol, o.id), { canceled: !o.canceled, updatedAt: Timestamp.fromDate(new Date()) }));
          toast(o.canceled ? "取り消しを元に戻しました" : "会計を取り消しました");
        }
      },
    }));
    box.appendChild(extra);
  });
}

// ---- 集計 ----
function agg(list) {
  return { n: list.length, cups: list.reduce((s, o) => s + o.cups, 0), sales: list.reduce((s, o) => s + o.amount, 0) };
}
function renderSummary() {
  const all = active();
  const today = all.filter((o) => o.date === todayKey());
  const t = agg(today), a = agg(all);
  $("sum-today-cups").textContent = t.cups;
  $("sum-today-sales").textContent = yen(t.sales);
  $("sum-total-cups").textContent = a.cups;
  $("sum-total-sales").textContent = yen(a.sales);
  $("sum-profit").textContent = yen(a.sales - state.settings.totalCost);
  $("reg-today-cups").textContent = t.cups;
  $("reg-price").textContent = state.settings.price;

  const fill = (tbodyId, rows) => {
    const tb = $(tbodyId);
    tb.innerHTML = "";
    for (const [label, s] of rows) tb.appendChild(el("tr", {}, [el("td", { text: label }), el("td", { text: String(s.n) }), el("td", { text: String(s.cups) })]));
  };
  const hours = [...new Set(today.map((o) => o.createdAt.getHours()))].sort((x, y) => x - y);
  fill("sum-hourly", hours.map((h) => [`${pad(h)}時台`, agg(today.filter((o) => o.createdAt.getHours() === h))]));
  fill("sum-age", AGES.map((g) => [g, agg(all.filter((o) => o.age === g))]));
  fill("sum-gender", [
    ...GENDERS.map((g) => [g, agg(all.filter((o) => o.gender === g))]),
    ["子連れ", agg(all.filter((o) => o.withChild))],
  ]);
  const handed = all.filter((o) => o.handedAt);
  if (handed.length) {
    const avg = handed.reduce((s, o) => s + (o.handedAt - o.createdAt), 0) / handed.length / 60000;
    $("sum-wait").textContent = `平均待ち時間 ${avg.toFixed(1)} 分(受け渡し済み ${handed.length} 件)`;
  } else $("sum-wait").textContent = "";
}

// ---- 同期状態 ----
function renderSync() {
  const b = $("sync-badge");
  const pending = state.orders.filter((o) => o.pending).length;
  b.classList.remove("ok", "pending");
  if (pending) { b.textContent = `未送信 ${pending} 件`; b.classList.add("pending"); }
  else if (!navigator.onLine || state.fromCache) { b.textContent = "オフライン(端末に保存)"; b.classList.add("pending"); }
  else { b.textContent = "クラウドに保存済み"; b.classList.add("ok"); }
}
window.addEventListener("online", renderSync);
window.addEventListener("offline", renderSync);

function renderAll() {
  renderForm();
  renderTickets();
  renderHistory();
  renderSummary();
  renderSync();
}
setInterval(() => { if (!$("main-view").hidden) renderTickets(); }, 30000);

// ---- 設定 ----
$("save-price").onclick = () => {
  const v = Number($("set-price").value);
  if (!Number.isFinite(v) || v < 0) return toast("価格を正しく入れてください");
  write(setDoc(settingsRef, { price: Math.round(v) }, { merge: true }));
  toast(`価格を ${v} 円にしました`);
};
$("save-cost").onclick = () => {
  const v = Number($("set-cost").value);
  if (!Number.isFinite(v) || v < 0) return toast("金額を正しく入れてください");
  write(setDoc(settingsRef, { totalCost: Math.round(v) }, { merge: true }));
  toast("合計費用を保存しました");
};
$("logout-btn").onclick = () => {
  openModal((box) => {
    box.appendChild(el("h2", { text: "ログアウトしますか" }));
    box.appendChild(el("p", { class: "muted", text: "会場で電波が悪いと、再ログインできないことがあります。" }));
    box.appendChild(el("div", { class: "modal-actions" }, [
      el("button", { type: "button", text: "やめる", onclick: closeModal }),
      el("button", { type: "button", class: "danger", text: "ログアウト", onclick: () => { closeModal(); signOut(auth); } }),
    ]));
  });
};

// CSV
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
$("export-csv").onclick = async () => {
  const header = ["会計ID", "日付", "会計時刻", "杯数", "単価", "金額", "年代", "性別", "子連れ", "整理券番号", "受け渡し時刻", "待ち時間(分)"];
  const rows = active().map((o) => [
    o.id, o.date, fullTime(o.createdAt), o.cups, o.unitPrice, o.amount, o.age, o.gender,
    o.withChild ? "はい" : "いいえ", o.ticket ?? "", o.handedAt ? fullTime(o.handedAt) : "",
    o.handedAt ? ((o.handedAt - o.createdAt) / 60000).toFixed(1) : "",
  ]);
  const text = "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  const now = new Date();
  const name = `会計記録_${dateKey(now).replace(/-/g, "")}_${pad(now.getHours())}${pad(now.getMinutes())}.csv`;
  const file = new File([text], name, { type: "text/csv" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === "AbortError") return; }
  }
  const a = el("a", { href: URL.createObjectURL(file), download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
};

// 全消去
$("wipe-btn").onclick = () => {
  openModal((box) => {
    box.appendChild(el("h2", { text: "全記録を消去" }));
    box.appendChild(el("p", { text: `会計 ${state.orders.length} 件をすべて消します。元に戻せません。消す場合は下に「削除」と入力してください。` }));
    const input = el("input", { type: "text", "aria-label": "確認入力" });
    box.appendChild(input);
    box.appendChild(el("div", { class: "modal-actions" }, [
      el("button", { type: "button", text: "やめる", onclick: closeModal }),
      el("button", {
        type: "button", class: "danger", text: "消去する", onclick: () => {
          if (input.value.trim() !== "削除") return toast("「削除」と入力してください");
          const ids = state.orders.map((o) => o.id);
          for (let i = 0; i < ids.length; i += 400) {
            const batch = writeBatch(db);
            ids.slice(i, i + 400).forEach((id) => batch.delete(doc(ordersCol, id)));
            write(batch.commit());
          }
          closeModal();
          toast(`${ids.length} 件を消去しました`);
        },
      }),
    ]));
  });
};

renderForm();
