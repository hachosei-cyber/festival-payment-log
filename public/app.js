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
const AGES = ["中学生以下", "高校生", "大学生", "大人"];
// 2026-10-31 に「小学生以下」「中学生」を「中学生以下」にまとめた。古い記録も読み込み時に合わせる
const AGE_ALIAS = { "小学生以下": "中学生以下", "中学生": "中学生以下" };
const GENDERS = ["男", "女", "混合"];
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
  form: { cups: 1, age: null, gender: null, withChild: false },
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
        age: AGE_ALIAS[x.age] ?? x.age,
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
    if (b.dataset.tab === "summary") openSummary();
    else summaryUI.visible = false;
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

$("cups-minus").onclick = () => { state.form.cups = Math.max(1, state.form.cups - 1); renderForm(); };
$("cups-plus").onclick = () => { state.form.cups = Math.min(99, state.form.cups + 1); renderForm(); };
$("child-toggle").onclick = () => { state.form.withChild = !state.form.withChild; renderForm(); };

function renderForm() {
  const f = state.form;
  $("cups-value").textContent = f.cups;
  for (const [cid, key] of [["age-choices", "age"], ["gender-choices", "gender"]]) {
    $(cid).querySelectorAll("button").forEach((b) => {
      b.setAttribute("aria-pressed", String(String(f[key]) === b.dataset.value));
    });
  }
  $("child-toggle").setAttribute("aria-pressed", String(f.withChild));
  $("child-toggle").textContent = "子連れ: " + (f.withChild ? "はい" : "いいえ");
  const amount = state.settings.price * f.cups;
  $("total-amount").textContent = yen(amount);
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
  state.form = { cups: 1, age: null, gender: null, withChild: false };
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
    box.appendChild(el("div", { class: "field" }, [el("div", { class: "field-label", text: "年代" }), mkChoices(AGES, "age", "four")]));
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
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const SVGNS = "http://www.w3.org/2000/svg";
const BIN = 15 * 60000;
const summaryUI = { visible: false, day: null, shown: {}, intro: false };

function agg(list) {
  return { n: list.length, cups: list.reduce((s, o) => s + o.cups, 0), sales: list.reduce((s, o) => s + o.amount, 0) };
}
// 数字を前の値から新しい値までカウントアップする
function countUp(id, to, fmt) {
  const node = $(id);
  const from = summaryUI.shown[id] ?? 0;
  summaryUI.shown[id] = to;
  if (reduceMotion || !summaryUI.visible || from === to) { node.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 800;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    node.textContent = fmt(from + (to - from) * e);
    if (k < 1 && summaryUI.shown[id] === to) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
const man = (v) => {
  // グラフの軸用: 1万円単位
  const a = Math.abs(v) / 10000;
  const s = a >= 10 || Number.isInteger(a) ? a.toFixed(0) : a.toFixed(1);
  return (v < 0 ? "−" : "") + s + "万";
};
const md = (key) => { const [, m, d] = key.split("-"); return `${Number(m)}/${Number(d)}`; };

function openSummary() {
  summaryUI.visible = true;
  summaryUI.shown = {};
  summaryUI.intro = true;
  document.querySelectorAll("#tab-summary .anim").forEach((n, i) => {
    n.style.setProperty("--i", i);
    n.classList.remove("play");
    void n.offsetWidth;
    n.classList.add("play");
  });
  renderSummary();
  summaryUI.intro = false;
}

function renderSummary() {
  const all = active();
  const today = all.filter((o) => o.date === todayKey());
  const t = agg(today), a = agg(all);
  const cost = state.settings.totalCost;
  const profit = a.sales - cost;
  countUp("sum-today-cups", t.cups, (v) => String(Math.round(v)));
  countUp("sum-today-sales", t.sales, yen);
  countUp("sum-total-cups", a.cups, (v) => String(Math.round(v)));
  countUp("sum-total-sales", a.sales, yen);
  countUp("sum-profit", profit, yen);
  $("sum-profit").classList.toggle("plus", profit >= 0);
  $("reg-today-cups").textContent = t.cups;
  $("reg-price").textContent = state.settings.price;

  const ratio = cost > 0 ? Math.min(1, a.sales / cost) : 1;
  const bar = $("be-fill");
  if (summaryUI.intro && !reduceMotion) {
    // いったん 0 に戻してから伸ばす
    bar.style.transition = "none";
    bar.style.width = "0";
    void bar.offsetWidth;
    bar.style.transition = "";
    requestAnimationFrame(() => { bar.style.width = ratio * 100 + "%"; });
  } else bar.style.width = ratio * 100 + "%";
  $("be-fill").classList.toggle("done", profit >= 0);
  if (profit < 0) {
    const cups = Math.ceil(-profit / Math.max(1, state.settings.price));
    $("sum-breakeven").textContent = `損益分岐まで あと ${yen(-profit)}(今の価格で約 ${cups} 杯)`;
  } else {
    $("sum-breakeven").textContent = `損益分岐を超えました(+${yen(profit)})`;
  }

  const fill = (tbodyId, rows) => {
    const tb = $(tbodyId);
    tb.innerHTML = "";
    for (const [label, s] of rows) tb.appendChild(el("tr", {}, [el("td", { text: label }), el("td", { text: String(s.n) }), el("td", { text: String(s.cups) })]));
  };
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

  renderChart(all, cost);
}

// 選んだ日の15分ごとの累積利益。前の日までの売上も引き継ぐ
function profitSeries(all, day, cost) {
  const dayOrders = all.filter((o) => o.date === day).sort((x, y) => x.createdAt - y.createdAt);
  const base = all.filter((o) => o.date < day).reduce((s, o) => s + o.amount, 0);
  if (!dayOrders.length) return null;
  const floor = (ms) => Math.floor(ms / BIN) * BIN;
  const start = floor(dayOrders[0].createdAt.getTime());
  let last = dayOrders[dayOrders.length - 1].createdAt.getTime();
  if (day === todayKey()) last = Math.max(last, Date.now());
  const end = floor(last) + BIN;
  const pts = [{ t: start, profit: base - cost, n: 0, cups: 0 }];
  let cum = base, i = 0;
  for (let b = start; b < end; b += BIN) {
    let n = 0, cups = 0;
    while (i < dayOrders.length && dayOrders[i].createdAt.getTime() < b + BIN) {
      cum += dayOrders[i].amount; cups += dayOrders[i].cups; n++; i++;
    }
    pts.push({ t: b + BIN, from: b, profit: cum - cost, n, cups });
  }
  return pts;
}

function svg(tag, attrs = {}, text) {
  const n = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}

function renderChart(all, cost) {
  const days = [...new Set(all.map((o) => o.date))].sort();
  if (!days.includes(summaryUI.day)) summaryUI.day = days.includes(todayKey()) ? todayKey() : days[days.length - 1] ?? null;

  const seg = $("chart-days");
  seg.innerHTML = "";
  days.forEach((d, idx) => {
    const b = el("button", { type: "button", role: "tab", "aria-selected": String(d === summaryUI.day), text: `${md(d)}(${idx + 1}日目)` });
    b.onclick = () => { summaryUI.day = d; summaryUI.intro = true; renderChart(active(), state.settings.totalCost); summaryUI.intro = false; };
    seg.appendChild(b);
  });

  const chart = $("profit-chart");
  chart.innerHTML = "";
  $("chart-tip").hidden = true;
  const tbody = $("sum-bins");
  tbody.innerHTML = "";
  const pts = summaryUI.day ? profitSeries(all, summaryUI.day, cost) : null;
  if (!pts) {
    $("chart-desc").textContent = "会計が入るとグラフが表示されます。";
    chart.setAttribute("viewBox", "0 0 10 1");
    return;
  }

  const W = Math.max(300, $("chart-wrap").clientWidth || 340), H = 240;
  const m = { l: 44, r: 14, t: 18, b: 28 };
  chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
  chart.setAttribute("width", W);
  chart.setAttribute("height", H);
  const ys = pts.map((p) => p.profit);
  let lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  const pad = Math.max(2000, (hi - lo) * 0.1);
  lo -= pad; hi += pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const x = (t) => m.l + (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * (W - m.l - m.r));
  const y = (v) => m.t + ((hi - v) / (hi - lo)) * (H - m.t - m.b);

  // 目盛り(1万円単位のきりのよい値)
  const span = hi - lo;
  const stepY = [5000, 10000, 20000, 50000, 100000].find((s) => span / s <= 5) || 200000;
  const grid = svg("g", { class: "grid" });
  for (let v = Math.ceil(lo / stepY) * stepY; v <= hi; v += stepY) {
    if (v === 0) continue;
    grid.appendChild(svg("line", { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    grid.appendChild(svg("text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }, man(v)));
  }
  const hourMs = 3600000;
  const stepX = t1 - t0 > 6 * hourMs ? 2 * hourMs : hourMs;
  let tick = Math.ceil(t0 / hourMs) * hourMs;
  while (new Date(tick).getHours() % (stepX / hourMs) !== 0) tick += hourMs;
  for (let tt = tick; tt <= t1; tt += stepX) {
    grid.appendChild(svg("text", { x: x(tt), y: H - 8, "text-anchor": "middle" }, hm(new Date(tt))));
  }
  if (t1 - t0 < hourMs) {
    grid.appendChild(svg("text", { x: x(t0), y: H - 8, "text-anchor": "start" }, hm(new Date(t0))));
    grid.appendChild(svg("text", { x: x(t1), y: H - 8, "text-anchor": "end" }, hm(new Date(t1))));
  }
  chart.appendChild(grid);

  // 損益分岐線(利益 0 円)
  const be = svg("g", { class: "breakeven" });
  be.appendChild(svg("line", { x1: m.l, x2: W - m.r, y1: y(0), y2: y(0) }));
  const leftGap = Math.abs(y(pts[0].profit) - y(0)), rightGap = Math.abs(y(pts[pts.length - 1].profit) - y(0));
  const onLeft = leftGap > rightGap;
  const sideVal = onLeft ? pts[0].profit : pts[pts.length - 1].profit;
  be.appendChild(svg("text", {
    x: onLeft ? m.l + 4 : W - m.r, y: sideVal > 0 ? y(0) + 15 : y(0) - 6, "text-anchor": onLeft ? "start" : "end",
  }, "損益分岐 ¥0"));
  chart.appendChild(be);

  // 利益の線と面
  const d = pts.map((p, k) => `${k ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.profit).toFixed(1)}`).join(" ");
  const area = svg("path", { class: "area", d: `${d} L${x(t1).toFixed(1)},${y(lo)} L${x(t0).toFixed(1)},${y(lo)} Z` });
  const line = svg("path", { class: "line", d });
  chart.appendChild(area);
  chart.appendChild(line);
  const lastP = pts[pts.length - 1];
  const endDot = svg("circle", { class: "end-dot", cx: x(lastP.t), cy: y(lastP.profit), r: 5 });
  chart.appendChild(endDot);
  const endLabel = svg("text", { class: "end-label", x: x(lastP.t) - 8, y: y(lastP.profit) + (lastP.profit < 0 ? 18 : -10), "text-anchor": "end" }, yen(lastP.profit));
  chart.appendChild(endLabel);

  if (summaryUI.intro && !reduceMotion) {
    const len = line.getTotalLength();
    line.style.strokeDasharray = `${len}`;
    line.style.strokeDashoffset = `${len}`;
    area.style.opacity = "0";
    endDot.style.opacity = "0";
    endLabel.style.opacity = "0";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      line.style.transition = "stroke-dashoffset 1.1s cubic-bezier(.2,.7,.2,1)";
      line.style.strokeDashoffset = "0";
      area.style.transition = "opacity .6s ease .5s";
      area.style.opacity = "";
      for (const n of [endDot, endLabel]) { n.style.transition = "opacity .3s ease 1s"; n.style.opacity = ""; }
    }));
  }

  // タップ・ホバーで値を出す
  const cross = svg("line", { class: "cross", y1: m.t, y2: H - m.b, visibility: "hidden" });
  const hoverDot = svg("circle", { class: "hover-dot", r: 5, visibility: "hidden" });
  chart.appendChild(cross);
  chart.appendChild(hoverDot);
  const hit = svg("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: H, fill: "transparent" });
  chart.appendChild(hit);
  const tip = $("chart-tip");
  const show = (ev) => {
    const r = chart.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    const cx = x(best.t), cy = y(best.profit);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
    hoverDot.setAttribute("cx", cx); hoverDot.setAttribute("cy", cy); hoverDot.setAttribute("visibility", "visible");
    tip.innerHTML = "";
    tip.appendChild(el("div", { class: "tip-time", text: best.from != null ? `${hm(new Date(best.from))}〜${hm(new Date(best.t))}` : `${hm(new Date(best.t))} 開始時点` }));
    tip.appendChild(el("div", { class: "tip-val", text: `累積利益 ${yen(best.profit)}` }));
    if (best.from != null) tip.appendChild(el("div", { text: `この15分: ${best.n}件・${best.cups}杯` }));
    tip.hidden = false;
    const left = (cx / W) * r.width;
    tip.style.left = Math.min(Math.max(left, 70), r.width - 70) + "px";
    tip.style.top = Math.max(0, (cy / H) * r.height - 64) + "px";
  };
  const hide = () => { cross.setAttribute("visibility", "hidden"); hoverDot.setAttribute("visibility", "hidden"); tip.hidden = true; };
  hit.addEventListener("pointermove", show);
  hit.addEventListener("pointerdown", show);
  hit.addEventListener("pointerleave", (ev) => { if (ev.pointerType === "mouse") hide(); });
  chartOutsideHide = (ev) => { if (!$("chart-wrap").contains(ev.target)) hide(); };

  const first = pts[0], fin = lastP;
  const crossing = pts.find((p, k) => k > 0 && pts[k - 1].profit < 0 && p.profit >= 0);
  $("chart-desc").textContent =
    `${md(summaryUI.day)} ${hm(new Date(t0))}〜${hm(new Date(t1))}。累積利益は ${yen(first.profit)} から ${yen(fin.profit)}。` +
    (crossing ? `${hm(new Date(crossing.from))}〜${hm(new Date(crossing.t))} の間に損益分岐を超えました。` : fin.profit < 0 ? "まだ損益分岐の手前です。" : "");

  for (const p of pts.slice(1)) {
    tbody.appendChild(el("tr", {}, [
      el("td", { text: `${hm(new Date(p.from))}〜` }),
      el("td", { text: String(p.n) }),
      el("td", { text: String(p.cups) }),
      el("td", { text: yen(p.profit) }),
    ]));
  }
}
let chartOutsideHide = null;
document.addEventListener("pointerdown", (ev) => { if (chartOutsideHide) chartOutsideHide(ev); });
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (summaryUI.visible) renderChart(active(), state.settings.totalCost); }, 150);
});

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
