// ヘルパー申込アプリ（画面）
//  入力した内容・稼働表の控えは、このスマホのブラウザの中（localStorage）にだけ保存する。
//  PDFはこのアプリの中には残さず、作るたびに利用者が保存先を選んで保存する。

import { $, $$, esc, store, todayIso, jpDate, reiwaLabel, shiftYm, pad2, daysInMonth, addDays, WEEKDAYS, half, last, parseIso } from "./util.js";
import * as S from "./schedule.js";
import * as C from "./core.js";
import { makePdf } from "./pdf.js";
import { runSetup } from "./setup.js";
import { startTour } from "./tour.js";
import * as G from "./gcal.js";

export const APP_VERSION = "1.6.0";
const REFRESH_MINUTES = 120;     // 稼働表をこれより古ければ取り込み直す
const HISTORY_MAX = 30;

// ---- 状態 ---------------------------------------------------------------------

export const state = {
  profile: store.get("profile", null),
  schedule: S.loadSchedule(),
  app: store.get("draft", null),
  history: store.get("history", []),
  extraSheets: store.get("extraSheets", []),
  mailTo: store.get("mailTo", ""),     // 組合のメールアドレス（公開場所の sheets.json から読む）
  ui: { tab: "make", viewYm: null, people: 1, detail: null, fetching: false, progress: 0, progressText: "", fetchError: "", showAllErrors: false },
};

function freshApp() {
  const t = todayIso();
  return { applyDate: t, usageMonth: C.nextMonth(+t.slice(5, 7)), usageManual: false, rows: [] };
}
if (!state.app || !Array.isArray(state.app.rows)) state.app = freshApp();

/** 公開場所の sheets.json から、組合のメールアドレスを読む（読めなければ前回の値のまま）。 */
async function loadMailTo() {
  try {
    const r = await fetch("sheets.json", { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    const to = String(j.mailTo || "").trim();
    if (to !== state.mailTo) { state.mailTo = to; store.set("mailTo", to); }
  } catch { /* 電波が無いときは前回の値 */ }
}

export function saveProfile() { store.set("profile", state.profile); renderWho(); }
function saveDraft() { store.set("draft", state.app); }
function saveHistory() { store.set("history", state.history); }

// ---- 小道具 -------------------------------------------------------------------

let toastTimer = null;
export function toast(text, ms = 3200) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

/** はい／いいえ の確認。true / false を返す。 */
export function confirmDialog(title, body, okLabel = "はい", danger = false) {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "dialog-back";
    back.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
      <h3>${esc(title)}</h3><div>${body}</div>
      <div class="btn-row"><button class="btn" data-a="no">やめる</button>
      <button class="btn primary${danger ? " danger" : ""}" data-a="ok">${esc(okLabel)}</button></div></div>`;
    back.addEventListener("click", (e) => {
      const a = e.target.closest("[data-a]")?.dataset.a;
      if (!a && e.target !== back) return;
      back.remove();
      resolve(a === "ok");
    });
    document.body.appendChild(back);
  });
}

function renderWho() {
  const p = state.profile;
  $("#who").textContent = p?.setupDone ? `${p.formName || p.userName}（${C.DISTRICT_NAMES[p.district] || "地区未設定"}）` : "";
}

const isPast = (iso) => iso < todayIso();

// ---- 稼働表の取り込み ------------------------------------------------------------

export async function refreshSchedule({ quiet = false } = {}) {
  if (state.ui.fetching) return state.schedule;
  state.ui.fetching = true;
  state.ui.fetchError = "";
  state.ui.progress = 0;
  renderSync();
  try {
    const data = await S.fetchAll({
      extraUrls: state.extraSheets,
      previous: state.schedule,
      progress: (f, text) => { state.ui.progress = f; state.ui.progressText = text; renderSync(); },
    });
    state.schedule = data;
    if (!S.saveSchedule(data)) state.ui.fetchError = "稼働表をこのスマホに保存できませんでした（空き容量やプライベートブラウズを確かめてください）。";
    if (!quiet) toast("稼働表を最新にしました");
  } catch (e) {
    state.ui.fetchError = e.message || String(e);
    if (!quiet) toast("稼働表を読めませんでした");
  } finally {
    state.ui.fetching = false;
    renderSync();
    if (state.ui.tab === "make") { renderCalendar(); renderCheck(); }
  }
  return state.schedule;
}

function renderSync() {
  const el = $("#sync");
  if (!el) return;
  const age = S.ageMinutes(state.schedule);
  let txt;
  if (state.ui.fetching) {
    txt = `${esc(state.ui.progressText || "稼働表を読んでいます…")}<div class="progress"><div style="width:${Math.round(state.ui.progress * 100)}%"></div></div>`;
  } else if (!state.schedule) {
    txt = "稼働表をまだ読み込んでいません。";
  } else {
    const when = age == null ? "" : age < 1 ? "たった今" : age < 60 ? `${age}分前` : age < 1440 ? `${Math.floor(age / 60)}時間前` : `${Math.floor(age / 1440)}日前`;
    txt = `稼働表: ${when}に取り込み`;
  }
  const err = state.ui.fetchError ? `<div class="hint err">${esc(state.ui.fetchError)}</div>` : "";
  const stale = state.schedule?.problems?.length && !state.ui.fetching
    ? `<div class="hint warn">一部の月を読めなかったため、前回の内容を出しています。</div>` : "";
  el.innerHTML = `<div class="txt">${txt}${err}${stale}</div>
    <button class="btn small" id="refresh-btn" ${state.ui.fetching ? "disabled" : ""}>↻ 最新にする</button>`;
}

// ---- 申込書の行の操作（カレンダーから） ----------------------------------------------

function sortRows() {
  state.app.rows.sort((a, b) => (a.start || "9999").localeCompare(b.start || "9999"));
}

function autoUsageMonth() {
  if (state.app.usageManual) return;
  const first = state.app.rows.map((r) => C.tidyRow(r).start).filter(Boolean).sort()[0];
  if (first) state.app.usageMonth = +first.slice(5, 7);
}

function rowIndexOf(iso) {
  return state.app.rows.findIndex((r) => C.rowDates(r).includes(iso));
}

/** カレンダーで日を押した: 申込書に入れる／外す。 */
function toggleDate(iso) {
  if (isPast(iso)) {
    toast("過ぎた日は選べません");
    return;
  }
  const rows = state.app.rows;
  const i = rowIndexOf(iso);
  const defaults = state.profile || {};
  if (i >= 0) {
    const r = C.tidyRow(rows[i]);
    const dates = C.rowDates(r);
    if (dates.length === 1) {
      rows.splice(i, 1);
    } else if (iso === dates[0]) {
      rows[i] = C.tidyRow({ ...r, start: dates[1] });
    } else if (iso === dates[dates.length - 1]) {
      rows[i] = C.tidyRow({ ...r, end: dates[dates.length - 2] });
    } else {
      if (rows.length >= C.ROW_COUNT) {
        toast(`途中の日を外すと行が${C.ROW_COUNT}行を超えるため、外せません。先にほかの行を減らしてください。`, 4500);
        return afterRowsChanged(false);
      }
      rows[i] = C.tidyRow({ ...r, end: addDays(iso, -1) });
      rows.splice(i + 1, 0, C.tidyRow({ ...r, start: addDays(iso, 1) }));
    }
    toast(`${jpDate(iso)}を申込書から外しました`, 2000);
  } else {
    const people = String(state.ui.people);
    const prev = addDays(iso, -1), next = addDays(iso, 1);
    const sameMonth = (d) => d.slice(0, 7) === iso.slice(0, 7);
    const canJoin = (r) => String(+half(r.people)) === people;
    const sameSettings = (a, b) => (a.meeting || "") === (b.meeting || "") && C.normalizeTime(a.time) === C.normalizeTime(b.time);
    const before = rows.findIndex((r) => canJoin(r) && sameMonth(prev) && last(C.rowDates(r)) === prev);
    const after = rows.findIndex((r) => canJoin(r) && sameMonth(next) && C.rowDates(r)[0] === next);
    // 前後の行がどちらもつながるが、打合せ形態・時刻が違うときは、前の行だけを延ばす（後ろの行の設定を消さない）
    const joinBoth = before >= 0 && after >= 0 && sameSettings(rows[before], rows[after]);
    if (joinBoth) {
      const a = C.tidyRow(rows[before]), b = C.tidyRow(rows[after]);
      rows[before] = C.tidyRow({ ...a, end: last(C.rowDates(b)) });
      rows.splice(after, 1);
    } else if (before >= 0) {
      rows[before] = C.tidyRow({ ...rows[before], end: iso });
    } else if (after >= 0) {
      const b = C.tidyRow(rows[after]);
      rows[after] = C.tidyRow({ ...b, start: iso, end: last(C.rowDates(b)) });
    } else {
      // 「手で足す」で作った日付の空の行があれば、そこに入れる
      const blank = rows.findIndex((r) => !r.start && !r.end);
      if (blank >= 0) {
        rows[blank] = { ...rows[blank], start: iso, end: "", people };
      } else if (rows.length >= C.ROW_COUNT) {
        toast(`希望日は${C.ROW_COUNT}行まで（申込書の行の数）です。続いた日なら1行にまとまります。`, 4500);
        return afterRowsChanged(false);
      } else {
        rows.push(C.newRow(defaults, iso, "", people));
      }
    }
    const info = S.dayInfo(state.schedule, iso);
    if (info && info.avail != null && info.avail < +people) toast(`${jpDate(iso)}は空きが${info.avail}名です。受けてもらえないかもしれません。`, 4000);
    else toast(`${jpDate(iso)}を申込書に入れました（${people}名）`, 2000);
  }
  sortRows();
  autoUsageMonth();
  afterRowsChanged(true);
}

function afterRowsChanged(rowsToo) {
  saveDraft();
  renderCalendar();
  if (rowsToo) renderForm();
  renderCheck();
}

// ---- 画面: 申込書をつくる ----------------------------------------------------------

function monthRange() {
  const thisYm = todayIso().slice(0, 7);
  const months = (state.schedule?.months || []).map((m) => m.ym).filter((x) => x >= thisYm);
  const last = months.length ? months[months.length - 1] : shiftYm(thisYm, 3);
  return [thisYm, last < shiftYm(thisYm, 3) ? shiftYm(thisYm, 3) : last];
}

function initialViewYm() {
  const [lo, hi] = monthRange();
  const first = state.app.rows.map((r) => r.start).filter(Boolean).sort()[0];
  let ym = first ? first.slice(0, 7) : null;
  if (!ym) {
    const t = todayIso();
    const y = +t.slice(0, 4), m = +t.slice(5, 7);
    const um = +state.app.usageMonth;
    ym = `${um >= m ? y : y + 1}-${pad2(um)}`;
  }
  if (ym < lo) ym = lo;
  if (ym > hi) ym = hi;
  return ym;
}

function renderMake() {
  if (!state.ui.viewYm) state.ui.viewYm = initialViewYm();
  $("#view").innerHTML = `
    ${safariBanner()}
    <div class="sync" id="sync"></div>
    <section class="card" id="card-cal">
      <div class="card-head"><span class="step-no">1</span><h2>空いている日を選ぶ</h2></div>
      <p class="lead">カレンダーの日を押すと、下の申込書に入ります。もう一度押すと外れます。</p>
      <div class="field" id="people-field">
        <span class="label">頼みたい人数</span>
        <div class="seg" id="people-seg">
          ${[1, 2, 3].map((n) => `<button data-people="${n}" aria-pressed="${state.ui.people === n}">${n}名</button>`).join("")}
        </div>
      </div>
      <div id="calendar"></div>
    </section>

    <section class="card" id="card-form">
      <div class="card-head"><span class="step-no">2</span><h2>申込書の中身を確かめる</h2></div>
      <div id="form-area"></div>
    </section>

    <section class="card" id="card-pdf">
      <div class="card-head"><span class="step-no">3</span><h2>申込書をつくって送る</h2></div>
      <div id="check"></div>
      <button class="btn primary big" id="make-pdf">📄 申込書をつくる</button>
      <p class="muted small" style="margin-top:8px">つくったPDFはこのアプリの中には残りません。次の画面で、メールで組合へ送ってください（手元に保存もできます）。</p>
      <button class="btn danger block" id="clear-all" style="margin-top:16px">🗑 入力をすべて消す</button>
    </section>`;
  renderSync();
  renderCalendar();
  renderForm();
  renderCheck();
}

function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

/** iPhoneのSafariのタブで使っているときの案内（しばらく使わないとデータが消えることがあるため）。 */
function safariBanner() {
  if (!isIOS() || isStandalone()) return "";
  return `<div class="hint warn" style="margin-bottom:10px">Safariで開いています。iPhoneでは、7日ほど使わないと設定や履歴が消えることがあります。
    <b>「ホーム画面に追加」</b>して、そのアイコンから使うのがおすすめです（アイコンから開いたときは、はじめの設定をもう一度行います）。<br>
    Safariの共有ボタン（□に↑）→「ホーム画面に追加」</div>`;
}

function availClass(avail) {
  if (avail == null) return "unk";
  if (avail >= 3) return "a3";
  if (avail >= 2) return "a2";
  if (avail >= 1) return "a1";
  return "a0";
}

function renderCalendar() {
  const el = $("#calendar");
  if (!el) return;
  const [lo, hi] = monthRange();
  const ym = state.ui.viewYm;
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7);
  const minfo = S.monthInfo(state.schedule, ym);
  const status = minfo?.status;
  const ownName = state.profile?.userName || "";
  const selected = new Set(state.app.rows.flatMap((r) => C.rowDates(r)));
  const people = state.ui.people;
  const first = new Date(y, m - 1, 1).getDay();
  const nDays = daysInMonth(y, m);

  let cells = WEEKDAYS.split("").map((w, i) => `<div class="wd ${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</div>`).join("");
  for (let i = 0; i < first; i++) cells += "<div></div>";
  for (let d = 1; d <= nDays; d++) {
    const iso = `${ym}-${pad2(d)}`;
    const info = minfo ? minfo.days[d - 1] : null;
    const avail = info ? info.avail : null;
    const cls = ["d", availClass(avail)];
    if (avail != null && avail < people) cls.push("short");
    if (isPast(iso)) cls.push("past");
    if (selected.has(iso)) cls.push("sel");
    if (info?.bookings?.some((b) => S.isOwn(b, ownName))) cls.push("own");
    const n = avail == null ? "—" : avail === 0 ? "×" : `空${avail}`;
    const label = `${m}月${d}日 ${avail == null ? "空き不明" : `空き${avail}名`}${selected.has(iso) ? " 選択中" : ""}`;
    cells += `<button class="${cls.join(" ")}" data-date="${iso}" aria-label="${label}">${d}<span class="n">${n}</span></button>`;
  }

  const chip = status ? `<span class="status-chip ${status}">${S.STATUS_NAMES[status]}</span>` : `<span class="status-chip">稼働表なし</span>`;
  const note = status ? S.STATUS_NOTES[status] : (state.schedule ? "この月の稼働表はまだ公開されていません。" : "稼働表を読み込むと、空きが色で出ます。");
  const stale = minfo?.stale ? "（前回取り込んだ内容です）" : "";
  const nSel = state.app.rows.filter((r) => C.rowDates(r).length).length;
  el.innerHTML = `
    <div class="cal-tools">
      <span class="muted small">${nSel ? `選んだ日: ${selected.size}日（${nSel}行）` : "まだ日を選んでいません"}</span>
      <button class="btn small danger" id="clear-checks" ${nSel ? "" : "disabled"}>✕ チェックをすべて消す</button>
    </div>
    <div class="month-nav">
      <button id="prev-m" aria-label="前の月" ${ym <= lo ? "disabled" : ""}>‹</button>
      <div class="m">${y}年${m}月${chip}</div>
      <button id="next-m" aria-label="次の月" ${ym >= hi ? "disabled" : ""}>›</button>
    </div>
    <div class="status-note">${esc(note)}${stale}</div>
    <div class="cal" id="cal-grid">${cells}</div>
    <div class="legend">
      <span><i style="background:var(--av3)"></i>3名以上</span><span><i style="background:var(--av2)"></i>2名</span>
      <span><i style="background:var(--av1)"></i>1名</span><span><i style="background:var(--av0)"></i>空きなし(×)</span>
      <span><i style="border:2px dashed #bdbdbd"></i>不明(—)</span><span><i style="outline:3px solid var(--sel)"></i>選んだ日</span>
      <span><span class="own-mark"></span>あなたの利用</span>
    </div>
    ${people > 1 ? `<p class="muted small" style="margin-top:4px">薄い日は、${people}名分の空きがない日です。</p>` : ""}
    ${renderAvailList()}`;
}

function renderAvailList() {
  if (!state.schedule) return "";
  const people = state.ui.people;
  const now = new Date();
  const thisYm = todayIso().slice(0, 7);
  const dl = C.blankDeadline(now.getFullYear(), now.getMonth() + 1);
  const thisMonthOpen = now <= new Date(dl.getFullYear(), dl.getMonth(), dl.getDate(), 12);
  const selected = new Set(state.app.rows.flatMap((r) => C.rowDates(r)));
  const items = [];
  for (const m of state.schedule.months) {
    if (m.status === "blank" || m.ym < thisYm || (m.ym === thisYm && !thisMonthOpen)) continue;
    for (const d of m.days) {
      const iso = `${m.ym}-${pad2(d.day)}`;
      if (isPast(iso) || d.avail == null || d.avail < people) continue;
      items.push({ iso, avail: d.avail });
    }
  }
  const sort = state.ui.listSort || "date";
  if (sort === "avail") items.sort((a, b) => b.avail - a.avail || a.iso.localeCompare(b.iso));
  const thisYear = String(now.getFullYear());
  const list = items.slice(0, 120).map((x) =>
    `<button data-date="${x.iso}" class="${selected.has(x.iso) ? "sel" : ""}"><span>${selected.has(x.iso) ? "✓ " : ""}${jpDate(x.iso, x.iso.slice(0, 4) !== thisYear)}</span><span class="badge">空き${x.avail}名</span></button>`).join("");
  return `<details class="avail-list" id="avail-list" ${state.ui.listOpen ? "open" : ""}>
    <summary>${people}名以上頼める日の一覧（${items.length}日）</summary>
    <div class="seg" style="margin-bottom:8px"><button data-sort="date" aria-pressed="${sort === "date"}">日付順</button><button data-sort="avail" aria-pressed="${sort === "avail"}">空きの多い順</button></div>
    <div class="avail-items">${list || '<p class="muted">ありません。</p>'}</div>
    ${!thisMonthOpen ? '<p class="muted small">今月分は空いている日の申込期限（5日の午前中）を過ぎたので出していません。</p>' : ""}
  </details>`;
}

function renderForm() {
  const el = $("#form-area");
  if (!el) return;
  const p = state.profile || {};
  const a = state.app;
  const rows = a.rows.map((r, i) => renderRow(r, i)).join("");
  el.innerHTML = `
    <div class="who-box">申込者: <b>${esc(p.formName || "（未設定）")}</b>　${esc(C.DISTRICT_NAMES[p.district] || "地区未設定")}<br>
      <span class="muted">${esc(p.address || "住所が未設定です")}</span>
      <button class="link" data-go="settings">変える</button></div>
    <div class="two">
      <div class="field" id="f-applyDate">
        <label for="apply-date">申込年月日</label>
        <input type="date" id="apply-date" value="${esc(a.applyDate)}">
        <div class="muted small" id="apply-reiwa">${reiwaLabel(a.applyDate)}</div>
      </div>
      <div class="field" id="f-usageMonth">
        <label for="usage-month">利用希望月分</label>
        <div class="inline"><select id="usage-month">${Array.from({ length: 12 }, (_, i) => `<option value="${i + 1}" ${+a.usageMonth === i + 1 ? "selected" : ""}>${i + 1}</option>`).join("")}</select><span class="unit">月分</span></div>
      </div>
    </div>
    <div class="label" style="font-weight:700;margin-bottom:6px">申込書の紙面（PDFに書く内容）</div>
    <div id="paper"></div>
    <div class="label" style="font-weight:700;margin:14px 0 6px">希望日を直す（${a.rows.length}/${C.ROW_COUNT}行）</div>
    <div id="rows">${rows || `<div class="empty-rows">まだ希望日がありません。<br>上のカレンダーで日を押してください。</div>`}</div>
    <button class="btn block" id="add-row" ${a.rows.length >= C.ROW_COUNT ? "disabled" : ""}>＋ 希望日を手で足す</button>
    ${a.rows.length >= C.ROW_COUNT ? `<p class="muted small">申込書の行は${C.ROW_COUNT}行までです。</p>` : ""}`;
}

function renderRow(r, i) {
  const days = C.rowDays(r);
  const meeting = C.MEETING_OPTIONS.map(([k, n]) =>
    `<button data-meeting="${k}" aria-pressed="${r.meeting === k}">${n.replace("での", "での<br>").replace("打合せ", "<br>打合せ")}</button>`).join("");
  return `<div class="row-card" data-row="${i}">
    <div class="row-head"><span class="no">${i + 1}行目</span><span class="sum">${esc(C.rowLabel(r))}</span>
      <span class="days">${days ? `${days}日間` : ""}</span></div>
    <div class="two">
      <div class="field" data-f="start"><label>開始日</label><input type="date" data-k="start" value="${esc(r.start)}"></div>
      <div class="field" data-f="end"><label>終了日 <span class="opt">1日だけなら空欄</span></label><input type="date" data-k="end" value="${esc(r.end)}" ${r.start ? `min="${esc(r.start)}"` : ""}></div>
    </div>
    <div class="two">
      <div class="field" data-f="people"><span class="label">希望人員</span>
        <div class="stepper"><button data-step="-1" aria-label="減らす">−</button><input type="text" inputmode="numeric" data-k="people" value="${esc(r.people)}" aria-label="希望人員"><button data-step="1" aria-label="増やす">＋</button></div></div>
      <div class="field" data-f="time"><label>希望時刻 <span class="opt">空欄でもよい</span></label>
        <div class="inline"><input type="text" inputmode="decimal" data-k="time" value="${esc(r.time)}" placeholder="例 18"><span class="unit">時頃</span></div></div>
    </div>
    <div class="field" data-f="meeting"><span class="label">打合せ希望形態</span><div class="seg">${meeting}</div></div>
    <div class="row-hints"></div>
    <div style="text-align:right"><button class="btn small danger" data-del="${i}">この行を消す</button></div>
  </div>`;
}

const MEETING_SHORT = { denwa: "電話確認", toujitsu: "当日", zenjitsu: "前日" };

/** 申込書の紙面に近い形の一覧（全行を一度に見る）。行を押すと、その行の入力欄へ移る。 */
function renderPaper(errors = currentCheck().errors) {
  const el = $("#paper");
  if (!el) return;
  const p = state.profile || {};
  const a = state.app;
  const md = (iso) => { const d = parseIso(iso); return d ? `${d.getMonth() + 1}月${d.getDate()}日` : ""; };
  const body = Array.from({ length: C.ROW_COUNT }, (_, i) => {
    const r0 = a.rows[i];
    if (!r0) return `<tr class="blank"><td class="no">${i + 1}</td><td class="period"><span class="d">月　日</span><span class="d">～月　日</span></td><td></td><td></td><td></td><td></td></tr>`;
    const r = C.tidyRow(r0);
    const ok = !!parseIso(r.start);
    const end = ok ? (r.end && parseIso(r.end) ? r.end : r.start) : "";   // 1日だけでも終了日＝開始日を書く
    const bad = errors.some((e) => e.row === i);
    const time = C.normalizeTime(r.time);
    return `<tr class="${bad ? "bad" : ""}" data-goto="${i}">
      <td class="no">${i + 1}</td>
      <td class="period">${ok ? `<span class="d">${md(r.start)}</span><span class="d">～${md(end)}</span>` : `<span class="miss">日付が未入力</span>`}</td>
      <td>${ok ? C.rowDates(r).length : ""}</td>
      <td>${esc(half(r.people || ""))}</td>
      <td class="meet">${r.meeting ? `<span class="circle">${MEETING_SHORT[r.meeting]}</span>` : `<span class="miss">未選択</span>`}</td>
      <td>${time ? `${esc(time)}時頃` : ""}</td></tr>`;
  }).join("");
  el.innerHTML = `<div class="paper">
    <div class="paper-title">酪農ヘルパー利用申込書</div>
    <div class="paper-meta"><span>${esc(reiwaLabel(a.applyDate))}</span><span class="month"><b>${+a.usageMonth}</b>月分</span></div>
    <div class="paper-meta sub"><span>${esc(C.DISTRICT_NAMES[p.district] || "地区未設定")}</span><span>${esc(p.formName || "氏名未設定")}</span></div>
    <table class="paper-table">
      <thead><tr><th></th><th>利用期間</th><th>日数</th><th>人員</th><th>打合せ<br>希望形態</th><th>希望<br>時刻</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </div>
  <p class="muted small" style="margin-top:6px">${a.rows.length ? "行を押すと、下のその行の入力欄に移ります。" : "上のカレンダーで日を押すと、ここに入ります。"}</p>`;
}

function currentCheck() {
  return C.validate(state.app, state.profile, state.schedule);
}

function renderCheck() {
  const el = $("#check");
  if (!el) return;
  const { errors, warnings } = currentCheck();
  // 行ごとのヒント（行の中にも出す）
  $$(".row-card").forEach((card) => {
    const i = +card.dataset.row;
    const errs = errors.filter((e) => e.row === i);
    const warns = warnings.filter((w) => w.row === i);
    const show = state.ui.showAllErrors || card.dataset.touched === "1";
    card.classList.toggle("has-err", show && errs.length > 0);
    $$(".field", card).forEach((f) => f.classList.toggle("bad", show && errs.some((e) => e.field === f.dataset.f)));
    $(".row-hints", card).innerHTML =
      (show ? errs.map((e) => `<div class="hint err">${esc(e.msg)}</div>`).join("") : "") +
      warns.map((w) => `<div class="hint warn">${esc(w.msg.replace(/^\d+行目: /, ""))}</div>`).join("");
    // 見出し（日付・日数）も入力に合わせて直す
    const r = state.app.rows[i];
    if (r) {
      $(".sum", card).textContent = C.rowLabel(r);
      const d = C.rowDays(r);
      $(".days", card).textContent = d ? `${d}日間` : "";
    }
  });
  $("#apply-reiwa") && ($("#apply-reiwa").textContent = reiwaLabel(state.app.applyDate));
  renderPaper(errors);

  if (!errors.length) {
    el.innerHTML = `<div class="check-ok">✓ 申込書をつくれます（希望日 ${state.app.rows.length}行）</div>` +
      (warnings.length ? `<div class="check-list">${warnings.map((w) => `<div class="hint warn">${esc(w.msg)}</div>`).join("")}</div>` : "");
  } else {
    const list = errors.map((e) => {
      const where = e.row != null ? `${e.row + 1}行目: ` : "";
      const go = e.field === "profile" ? ` <button class="link" data-go="settings">設定を開く</button>` : "";
      return `<div class="hint err">${esc(where + e.msg)}${go}</div>`;
    }).join("");
    el.innerHTML = `<div class="check-list"><p style="font-weight:700;margin:0">あと${errors.length}か所、直すところがあります</p>${list}
      ${warnings.map((w) => `<div class="hint warn">${esc(w.msg)}</div>`).join("")}</div>`;
  }
}

// ---- PDFをつくる・保存 ------------------------------------------------------------

async function onMakePdf() {
  const { errors } = currentCheck();
  if (errors.length) {
    state.ui.showAllErrors = true;
    renderCheck();
    const firstRow = errors.find((e) => e.row != null);
    const target = firstRow ? $(`.row-card[data-row="${firstRow.row}"]`) : $("#check");
    target?.scrollIntoView({ behavior: "smooth", block: "center" });
    toast(`直すところが${errors.length}か所あります。赤い印のところを見てください。`, 4000);
    return;
  }
  const btn = $("#make-pdf");
  btn.disabled = true;
  btn.textContent = "つくっています…";
  try {
    const app = JSON.parse(JSON.stringify(state.app));
    app.rows = app.rows.map(C.tidyRow);
    const filename = `${C.filenameBase(app.applyDate, app.rows)}.pdf`;
    const result = await makePdf(C.toFormData(app), state.profile);
    // 作成履歴（入力した中身だけ。PDFは残さない）
    const histId = Date.now();
    state.history.unshift({ id: histId, createdAt: new Date().toISOString(), filename, app, profile: snapshotProfile() });
    state.history = state.history.slice(0, HISTORY_MAX);
    saveHistory();
    showResult(result, filename, app, state.profile, histId);
  } catch (e) {
    toast(`申込書をつくれませんでした: ${e.message || e}`, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = "📄 申込書をつくる";
  }
}

function snapshotProfile() {
  const p = state.profile || {};
  return { formName: p.formName, address: p.address, district: p.district };
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function showResult({ pdf, previewUrl }, filename, app, profile, histId) {
  const file = new File([pdf], filename, { type: "application/pdf" });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  const kb = Math.max(1, Math.round(pdf.size / 1024));
  const ios = isIOS();
  const mail = C.mailContent(app, profile || {});
  const to = state.mailTo;
  // iPhoneのホーム画面アプリでは、ダウンロードが全画面の表示になり戻れなくなることがあるので、共有だけにする
  const showDl = !(canShare && ios && isStandalone());
  const copyBtn = (key) => `<button class="btn small copy-btn" data-copy="${key}">コピー</button>`;
  const mailto = `mailto:${encodeURI(to)}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.body.replace(/\n/g, "\r\n"))}`;
  const layer = $("#layer");
  layer.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="申込書ができました">
    <div class="sheet-inner">
      <button class="btn small ghost close-x" data-close>✕ 閉じる</button>
      <h2>申込書ができました</h2>
      <p class="muted">${esc(filename)}（${kb}KB）</p>
      <div class="hint warn">まだ組合へ送っていません。下の「メールで組合へ送る」で送ってください。</div>
      <div class="preview-box" style="margin:12px 0"><img class="preview" src="${previewUrl}" alt="申込書の紙面"></div>
      <p class="muted small">日付・人数・丸の位置・氏名・住所を確かめてください。画像を押すと拡大します（もう一度押すと戻ります）。</p>

      <div class="card mail-card" id="mail-card" style="margin-top:12px">
        <b>✉ メールで組合へ送る</b>
        <dl class="mail-kv">
          <dt>宛先</dt><dd>${to ? `<span class="v">${esc(to)}</span>${copyBtn("to")}` : `<span class="v muted">組合のメールアドレスが、まだアプリに入っていません。宛先は手で入れてください。</span>`}</dd>
          <dt>件名</dt><dd><span class="v">${esc(mail.subject)}</span>${copyBtn("subject")}</dd>
          <dt>本文</dt><dd><span class="v" style="white-space:pre-wrap">${esc(mail.body)}</span>${copyBtn("body")}</dd>
          <dt>添付</dt><dd><span class="v">📄 ${esc(filename)}</span></dd>
        </dl>
        ${canShare
          ? `<button class="btn primary big" id="send-mail" style="margin-top:12px">✉ メールで組合へ送る</button>
             <ol class="small" style="padding-left:20px;margin:10px 0 0">
               <li>出てきたメニューで、いつも使うメール（${ios ? "「メール」・Gmail など" : "Gmail など"}）を選ぶ</li>
               <li>${to ? "「宛先」を長押しして<b>「貼り付け（ペースト）」</b>（組合のアドレスはコピーしてあります）" : "「宛先」に組合のメールアドレスを入れる"}</li>
               <li>件名・本文・PDFが入っているか確かめて、<b>送信</b>する</li>
             </ol>
             <p class="small muted" style="margin-top:6px">件名や本文が入っていないときは、上の「コピー」で写して貼り付けてください。</p>`
          : `<p class="small" style="margin-top:8px">この端末では、PDFを付けたメールを自動でつくれません。先に下の「PDFをダウンロード」で保存し、次のボタンで開くメールに、そのPDFを添付して送ってください。</p>
             <a class="btn primary big" id="send-mailto" style="margin-top:8px;text-decoration:none" href="${esc(mailto)}">✉ メールを開く</a>`}
      </div>

      ${calendarCardHtml(histId)}

      <div class="card" style="margin-top:12px">
        <b>手元に保存する（必要なとき）</b>
        <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
          ${canShare ? `<button class="btn" id="save-share">📁 保存先を選んで保存</button>` : ""}
          ${!showDl ? "" : `<button class="btn" id="save-dl">⬇ PDFをダウンロード</button>`}
        </div>
        ${!canShare ? ""
          : ios
          ? `<p class="small" style="margin-top:8px">「保存先を選んで保存」→ 出てきたメニューで<b>「"ファイル"に保存」</b>を選ぶと、保存する場所（iCloud Drive・このiPhone内など）を選べます。</p>`
          : `<p class="small" style="margin-top:8px">「保存先を選んで保存」→ 出てきたメニューで、Googleドライブなど保存先を選べます。</p>`}
        ${!showDl ? ""
          : ios
          ? `<p class="small">「ダウンロード」は「ファイル」アプリの「ダウンロード」フォルダに入ります。</p>`
          : `<p class="small">「ダウンロード」は「ダウンロード」フォルダに入ります（ブラウザの設定で、毎回保存先を聞くようにもできます）。</p>`}
        <p class="small muted">PDFはこのアプリの中には残りません。もう一度必要なときは「作成履歴」から同じ内容でつくり直せます。</p>
      </div>
      <button class="btn block" data-close style="margin-top:6px">申込書の画面へ戻る</button>
    </div></div>`;
  const close = () => { layer.innerHTML = ""; URL.revokeObjectURL(previewUrl); };
  $$("[data-close]", layer).forEach((b) => b.addEventListener("click", close));
  $(".preview", layer).addEventListener("click", () => $(".preview-box", layer).classList.toggle("zoom"));
  $("#cal-card", layer)?.addEventListener("click", (e) => { const a = e.target.closest(".cal-link"); if (a) markCalendarLink(a); });
  const copyTexts = { to, subject: mail.subject, body: mail.body };
  $$("[data-copy]", layer).forEach((b) => b.addEventListener("click", async () => {
    const ok = await copyText(copyTexts[b.dataset.copy]);
    toast(ok ? "コピーしました。貼り付けたいところを長押しして「ペースト」してください。" : "コピーできませんでした。文字を長押しして選び、コピーしてください。", 3500);
  }));
  $("#send-mail", layer)?.addEventListener("click", async () => {
    // 宛先は共有では入れられないので、先にコピーしておく（待たずに共有を開く。待つと共有を開けない端末がある）
    if (to) copyText(to);
    try {
      await navigator.share({ files: [file], title: mail.subject, text: mail.body });
      toast(to ? "宛先に組合のアドレスを貼り付けて、送信してください。" : "宛先を入れて、送信してください。", 5000);
    } catch (e) {
      if (e?.name !== "AbortError") toast("メールの画面を開けませんでした。PDFを保存して、メールに添付してください。", 5000);
    }
  });
  $("#save-share", layer)?.addEventListener("click", async () => {
    try {
      await navigator.share({ files: [file], title: filename });
      toast("保存（共有）しました");
    } catch (e) {
      if (e?.name !== "AbortError") toast("共有できませんでした。「ダウンロード」を使ってください。", 4000);
    }
  });
  $("#save-dl", layer)?.addEventListener("click", () => {
    const url = URL.createObjectURL(pdf);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast("ダウンロードを始めました。保存されたか確かめてください。", 4000);
  });
}

/** 文字をコピーする（新しいやり方が使えない端末では、昔のやり方で）。 */
function copyText(text) {
  if (!text) return Promise.resolve(false);
  const fallback = () => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  };
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallback());
  return Promise.resolve(fallback());
}

// ---- Googleカレンダー（予定作成リンク） ---------------------------------------------

/** 行ごとの「Googleカレンダーで開く」リンク。押すと、中身の入った予定の画面が開く。 */
function calendarLinksHtml(h) {
  return G.buildEvents(h.app, h.filename).map((e) =>
    `<a class="btn cal-link" href="${esc(e.url)}" target="_blank" rel="noopener">📅 ${esc(e.label)}</a>`).join("");
}

/** PDFの画面のカレンダー欄。 */
function calendarCardHtml(histId) {
  const h = state.history.find((x) => x.id === histId);
  if (!h) return "";
  return `<div class="card cal-card" id="cal-card" style="margin-top:12px">
    <b>📅 Googleカレンダーに予定を入れる</b>
    <p class="small" style="margin:6px 0 10px">希望日の行ごとにボタンがあります。押すとGoogleカレンダーが開くので、中身を確かめて<b>「保存」</b>を押してください（終日の予定で、開始日〜最終日の翌日までが入っています）。</p>
    <div class="cal-links">${calendarLinksHtml(h)}</div>
  </div>`;
}

/** 押したリンクに印を付ける（この画面のあいだだけ）。 */
function markCalendarLink(a) {
  if (a.dataset.opened) return;
  a.dataset.opened = "1";
  a.insertAdjacentHTML("beforeend", `<span class="cal-opened">✓ 開きました</span>`);
}

// ---- 画面: 作成履歴 --------------------------------------------------------------

function renderHistory() {
  const items = state.history.map((h) => {
    const rows = h.app.rows.map((r) => `<li>${esc(C.rowLabel(r))}　${esc(r.people)}名${r.meeting ? `・${esc(C.MEETING_NAMES[r.meeting])}` : ""}${r.time ? `・${esc(r.time)}時頃` : ""}</li>`).join("");
    const when = new Date(h.createdAt);
    return `<div class="card hist-item" data-id="${h.id}">
      <div class="t">${esc(h.filename)}</div>
      <div class="muted small">${when.getMonth() + 1}月${when.getDate()}日 ${pad2(when.getHours())}:${pad2(when.getMinutes())} につくった ／ ${+h.app.usageMonth}月分・申込日 ${esc(reiwaLabel(h.app.applyDate))}</div>
      <ul>${rows}</ul>
      <div class="btn-row"><button class="btn small" data-h="pdf">📄 もう一度PDFに</button><button class="btn small" data-h="load">✏️ 直して使う</button></div>
      <details class="cal-hist"><summary>📅 Googleカレンダーに入れる</summary>
        <p class="small muted" style="margin:6px 0 8px">押すとGoogleカレンダーが開くので「保存」を押します。</p>
        <div class="cal-links">${calendarLinksHtml(h)}</div></details>
      <div style="text-align:right;margin-top:6px"><button class="link" data-h="del" style="color:var(--red)">履歴から消す</button></div>
    </div>`;
  }).join("");
  $("#view").innerHTML = `<section class="card"><h2 style="font-size:18px">作成履歴</h2>
    <p class="muted small" style="margin-top:6px">つくった申込書の中身（日付・人数など）を覚えています。PDFそのものは残していないので、必要なときは「もう一度PDFに」でつくり直せます。</p></section>
    ${items || '<div class="card muted">まだありません。申込書をつくると、ここに並びます。</div>'}`;
}

async function onHistory(action, id) {
  const h = state.history.find((x) => x.id === id);
  if (!h) return;
  if (action === "pdf") {
    try {
      const prof = { ...(state.profile || {}), ...(h.profile || {}) };
      const result = await makePdf(C.toFormData(h.app), prof);
      showResult(result, h.filename, h.app, prof, h.id);
    } catch (e) {
      toast(`申込書をつくれませんでした: ${e.message || e}`, 5000);
    }
  } else if (action === "load") {
    if (state.app.rows.length && !(await confirmDialog("申込書に読み込みますか？", "<p>いま入力中の希望日は置き換わります。申込年月日は今日になります。</p>", "読み込む"))) return;
    state.app = { ...JSON.parse(JSON.stringify(h.app)), applyDate: todayIso(), usageManual: true };
    state.ui.viewYm = null;
    state.ui.detail = null;
    saveDraft();
    switchTab("make");
    toast("申込書に読み込みました。日付を確かめてください。");
  } else if (action === "del") {
    if (!(await confirmDialog("履歴から消しますか？", `<p>${esc(h.filename)}</p><p class="muted small">保存したPDFや、Googleカレンダーに入れた予定は消えません。</p>`, "消す", true))) return;
    state.history = state.history.filter((x) => x.id !== id);
    saveHistory();
    renderHistory();
  }
}

// ---- 画面: 設定 -----------------------------------------------------------------

function renderSettings() {
  const p = state.profile || {};
  const age = S.ageMinutes(state.schedule);
  const months = state.schedule?.months || [];
  $("#view").innerHTML = `
    <section class="card">
      <h2 style="font-size:18px;margin-bottom:10px">申込者（申込書に書く内容）</h2>
      <div class="field"><label for="s-user">稼働表での利用者名</label>
        <input type="text" id="s-user" value="${esc(p.userName || "")}" autocomplete="off">
        <p class="muted small">カレンダーで、あなたが頼んでいる日に青い線を付けるのに使います。</p></div>
      <div class="field"><label for="s-name">申込書の氏名</label><input type="text" id="s-name" value="${esc(p.formName || "")}" autocomplete="name"></div>
      <div class="field"><label for="s-addr">申込書の住所</label><input type="text" id="s-addr" value="${esc(p.address || "")}" autocomplete="street-address"></div>
      <div class="field"><span class="label">所属地区</span>
        <div class="seg wrap" id="s-district">${C.DISTRICTS.map(([k, n, ja]) => `<button data-district="${k}" aria-pressed="${p.district === k}">${n}<br><span class="small">（${ja}）</span></button>`).join("")}</div></div>
      <button class="btn primary block" id="s-save">この内容で保存</button>
      <div id="s-hint"></div>
    </section>

    <section class="card">
      <h2 style="font-size:18px;margin-bottom:10px">新しい行の最初の値</h2>
      <div class="field"><span class="label">打合せ希望形態</span>
        <div class="seg" id="s-meeting">${C.MEETING_OPTIONS.map(([k, n]) => `<button data-meeting="${k}" aria-pressed="${p.meeting === k}">${n.replace("での", "での<br>").replace("打合せ", "<br>打合せ")}</button>`).join("")}</div></div>
      <div class="field"><label for="s-time">希望時刻</label><div class="inline"><input type="text" inputmode="decimal" id="s-time" value="${esc(p.time || "")}" placeholder="例 18"><span class="unit">時頃</span></div></div>
      <button class="btn block" id="s-save-def">保存</button>
    </section>

    <section class="card">
      <h2 style="font-size:18px;margin-bottom:10px">稼働表</h2>
      <dl class="kv">
        <dt>取り込み</dt><dd>${state.schedule ? `${age == null ? "" : age < 60 ? `${age}分前` : age < 1440 ? `${Math.floor(age / 60)}時間前` : `${Math.floor(age / 1440)}日前`}` : "まだ"}</dd>
        <dt>月</dt><dd>${months.length ? `${months[0].year}年${months[0].month}月〜${last(months).year}年${last(months).month}月（${months.length}か月分）` : "—"}</dd>
      </dl>
      <button class="btn block" id="s-refresh" style="margin-top:10px">↻ 稼働表を最新にする</button>
      <details style="margin-top:10px"><summary class="small" style="font-weight:700">新しい年度の稼働表を足す（くわしい人向け）</summary>
        <p class="small muted">組合の稼働表一覧に新しい年度のスプレッドシートが増えて、カレンダーに出てこないときに、そのURLを1行に1つずつ貼ります。</p>
        <textarea id="s-sheets" rows="3" placeholder="https://docs.google.com/spreadsheets/d/…">${esc(state.extraSheets.join("\n"))}</textarea>
        <button class="btn small" id="s-sheets-save" style="margin-top:6px">保存して読み込む</button>
      </details>
    </section>

    <section class="card">
      <h2 style="font-size:18px;margin-bottom:10px">使い方</h2>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn block" id="s-tour">画面の説明（チュートリアル）を見る</button>
        <button class="btn block" id="s-setup">はじめの設定をやり直す</button>
        <button class="btn block danger" id="s-reset">このスマホのデータをすべて消す</button>
      </div>
      <p class="muted small" style="margin-top:10px">入力した内容は、このスマホの中にだけ保存されます（どこにも送りません）。稼働表は組合が公開しているGoogleスプレッドシートから読み込みます。</p>
      <p class="muted small">バージョン ${APP_VERSION}　<a href="privacy.html">プライバシーポリシー</a></p>
    </section>`;
}

function readSettingsProfile() {
  const p = { ...(state.profile || {}) };
  p.userName = $("#s-user").value.trim();
  p.formName = $("#s-name").value.trim();
  p.address = $("#s-addr").value.trim();
  p.district = $("#s-district [aria-pressed=true]")?.dataset.district || "";
  return p;
}

// ---- 困ったとき -----------------------------------------------------------------

function showHelp() {
  const layer = $("#layer");
  layer.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="使い方">
    <div class="sheet-inner">
      <button class="btn small ghost close-x" data-close>✕ 閉じる</button>
      <h2>使い方・困ったとき</h2>
      <button class="btn primary block" id="help-tour" style="margin:8px 0 14px">▶ 画面の説明（チュートリアル）を見る</button>
      <div class="card faq">
        <b>使う流れ</b>
        <ol class="small" style="padding-left:20px;margin:6px 0 0">
          <li>「頼みたい人数」を選ぶ</li>
          <li>カレンダーで空いている日（緑の日）を押す</li>
          <li>申込書の中身（人数・打合せ形態・時刻）を確かめる</li>
          <li>「申込書をつくる」→ できた紙面を確かめる</li>
          <li>「メールで組合へ送る」→ メールを選ぶ → 宛先に貼り付けて送信</li>
        </ol>
      </div>
      <div class="card faq">
        <details><summary>カレンダーの色の意味は？</summary>
          <p>濃い緑＝3名以上、緑＝2名、薄い緑＝1名頼める日です。灰色（×）は空きなし、点線（—）は稼働表がまだ無い日です。青い線はあなたが頼んでいる日です。</p></details>
        <details><summary>カレンダーに色が出ない</summary>
          <p>稼働表を読み込めていません。電波の良いところで「↻ 最新にする」を押してください。まだ組合が作っていない月は色が出ません。</p></details>
        <details><summary>申込期限は？</summary>
          <p>稼働表の注意書きによると、翌月の利用は毎月1日まで、空いている日の申込は毎月5日の午前中まで（5日が土・日・祝日のときはその前日）です。急ぎのときは組合へ電話してください。</p></details>
        <details><summary>メールの送り方は？</summary>
          <p>申込書をつくったあとの画面で「✉ メールで組合へ送る」を押し、いつも使うメール（「メール」・Gmail など）を選びます。件名・本文・PDFは入った状態で開きます。宛先は自動で入らないので、「宛先」を長押しして「ペースト」してください（組合のアドレスはボタンを押したときにコピーしてあります）。件名や本文が入っていないときは、画面の「コピー」で写して貼り付けます。</p></details>
        <details><summary>Googleカレンダーに予定を入れるには？</summary>
          <p>申込書をつくったあとの画面（または「作成履歴」の「📅 Googleカレンダーに入れる」）に、希望日の行ごとのボタンがあります。押すとGoogleカレンダーが中身の入った状態で開くので、「保存」を押してください。利用日の午後〜最終日の翌日の午前までが、終日の予定で入ります。同じボタンを2回保存すると、予定も2つになります。</p></details>
        <details><summary>PDFはどこに保存される？</summary>
          <p>このアプリの中には残りません。「保存先を選んで保存」で、ファイルアプリ・Googleドライブ・LINEなど好きな場所に保存してください。</p></details>
        <details><summary>1日だけ／何日か続けて頼みたい</summary>
          <p>続いた日を押すと1行にまとまります（例: 10日〜12日）。1行の「利用日数」は自動で数えます。申込書は5行までです。</p></details>
        <details><summary>名前や住所を変えたい</summary>
          <p>下の「設定」で変えられます。</p></details>
        <details><summary>機種を変えた・データを消してしまった</summary>
          <p>このスマホの中にだけ保存しているので、新しいスマホでは、はじめの設定からやり直してください（1分ほどで終わります）。</p></details>
      </div>
      <button class="btn block" data-close>閉じる</button>
    </div></div>`;
  $$("[data-close]", layer).forEach((b) => b.addEventListener("click", () => { layer.innerHTML = ""; }));
  $("#help-tour", layer).addEventListener("click", () => { layer.innerHTML = ""; beginTour(); });
}

function beginTour() {
  switchTab("make");
  setTimeout(() => startTour(() => {
    if (state.profile) { state.profile.tutorialDone = true; saveProfile(); }
  }), 120);
}

// ---- タブ・イベント ---------------------------------------------------------------

export function switchTab(tab) {
  state.ui.tab = tab;
  $$("#tabbar button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  if (tab === "make") renderMake();
  else if (tab === "history") renderHistory();
  else renderSettings();
  window.scrollTo(0, 0);
}

function bindEvents() {
  $("#tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) switchTab(b.dataset.tab);
  });
  $("#help-btn").addEventListener("click", showHelp);

  const view = $("#view");
  view.addEventListener("click", async (e) => {
    const t = e.target;
    const go = t.closest("[data-go]");
    if (go) return switchTab(go.dataset.go);
    if (t.closest("#refresh-btn") || t.closest("#s-refresh")) return refreshSchedule().then(() => state.ui.tab === "settings" && renderSettings());

    // 申込書をつくる
    const pb = t.closest("[data-people]");
    if (pb && pb.closest("#people-seg")) {
      state.ui.people = +pb.dataset.people;
      $$("#people-seg button").forEach((b) => b.setAttribute("aria-pressed", String(b === pb)));
      return renderCalendar();
    }
    const day = t.closest("[data-date]");
    if (day) {
      if (day.closest(".avail-items")) state.ui.viewYm = day.dataset.date.slice(0, 7);
      return toggleDate(day.dataset.date);
    }
    if (t.closest("#prev-m")) { state.ui.viewYm = shiftYm(state.ui.viewYm, -1); return renderCalendar(); }
    if (t.closest("#next-m")) { state.ui.viewYm = shiftYm(state.ui.viewYm, 1); return renderCalendar(); }
    const sortB = t.closest("[data-sort]");
    if (sortB) { state.ui.listSort = sortB.dataset.sort; state.ui.listOpen = true; return renderCalendar(); }

    const card = t.closest(".row-card");
    if (card) {
      const i = +card.dataset.row;
      const row = state.app.rows[i];
      const del = t.closest("[data-del]");
      if (del) {
        state.app.rows.splice(i, 1);
        autoUsageMonth();
        return afterRowsChanged(true);
      }
      const mb = t.closest("[data-meeting]");
      if (mb) {
        row.meeting = row.meeting === mb.dataset.meeting ? "" : mb.dataset.meeting;
        $$("[data-meeting]", card).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.meeting === row.meeting)));
        saveDraft();
        return renderCheck();
      }
      const st = t.closest("[data-step]");
      if (st) {
        const n = Math.max(1, Math.min(9, (parseInt(row.people, 10) || 0) + +st.dataset.step));
        row.people = String(n);
        $("[data-k=people]", card).value = row.people;
        card.dataset.touched = "1";
        saveDraft();
        renderCalendar();
        return renderCheck();
      }
    }
    if (t.closest("#add-row")) {
      if (state.app.rows.length >= C.ROW_COUNT) return;
      state.app.rows.push(C.newRow(state.profile || {}, "", "", String(state.ui.people)));
      afterRowsChanged(true);
      last($$(".row-card"))?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    if (t.closest("#make-pdf")) return onMakePdf();
    if (t.closest("#clear-checks")) {
      const n = state.app.rows.filter((r) => C.rowDates(r).length).length;
      if (!n) return;
      if (await confirmDialog("チェックをすべて消しますか？", `<p>カレンダーで選んだ日（申込書の${n}行）をすべて外します。</p>`, "すべて消す", true)) {
        state.app.rows = state.app.rows.filter((r) => !C.rowDates(r).length);
        state.ui.showAllErrors = false;
        autoUsageMonth();
        afterRowsChanged(true);
        toast("選んだ日をすべて外しました。");
      }
      return;
    }
    const goRow = t.closest("[data-goto]");
    if (goRow && goRow.closest("#paper")) {
      const card = $(`.row-card[data-row="${goRow.dataset.goto}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("flash");
        setTimeout(() => card.classList.remove("flash"), 1200);
      }
      return;
    }
    if (t.closest("#clear-all")) {
      if (await confirmDialog("入力をすべて消しますか？", "<p>希望日がすべて消え、申込年月日は今日に戻ります。</p>", "消す", true)) {
        state.app = freshApp();
        state.ui.showAllErrors = false;
        saveDraft();
        renderMake();
      }
      return;
    }

    // 作成履歴
    const hb = t.closest("[data-h]");
    if (hb) return onHistory(hb.dataset.h, +hb.closest("[data-id]").dataset.id);

    // 設定
    const db = t.closest("[data-district]");
    if (db) return $$("#s-district button").forEach((b) => b.setAttribute("aria-pressed", String(b === db)));
    const sm = t.closest("#s-meeting [data-meeting]");
    if (sm) return $$("#s-meeting button").forEach((b) => b.setAttribute("aria-pressed", String(b === sm && b.getAttribute("aria-pressed") !== "true")));
    if (t.closest("#s-save")) {
      const p = readSettingsProfile();
      const errs = [];
      if (!p.formName) errs.push("氏名を入れてください。");
      if (!p.address) errs.push("住所を入れてください。");
      if (!p.district) errs.push("所属地区を選んでください。");
      $("#s-hint").innerHTML = errs.map((m) => `<div class="hint err">${esc(m)}</div>`).join("");
      if (errs.length) return;
      state.profile = p;
      saveProfile();
      return toast("保存しました");
    }
    if (t.closest("#s-save-def")) {
      const time = C.normalizeTime($("#s-time").value);
      if (!C.checkTime(time)) return toast("希望時刻は数字で入れてください（例: 18）", 4000);
      state.profile = { ...(state.profile || {}), meeting: $("#s-meeting [aria-pressed=true]")?.dataset.meeting || "", time };
      saveProfile();
      return toast("保存しました。これから足す行に使います。");
    }
    if (t.closest("#s-sheets-save")) {
      const lines = $("#s-sheets").value.split(/\s+/).map((x) => x.trim()).filter(Boolean);
      const bad = lines.filter((x) => !S.sheetIdFromText(x));
      if (bad.length) return toast("Googleスプレッドシートのアドレスではないものがあります", 4000);
      state.extraSheets = lines;
      store.set("extraSheets", lines);
      return refreshSchedule().then(() => renderSettings());
    }
    if (t.closest("#s-tour")) return beginTour();
    if (t.closest("#s-setup")) {
      return runSetup({ redo: true }).then(() => { renderWho(); switchTab("make"); });
    }
    if (t.closest("#s-reset")) {
      if (await confirmDialog("データをすべて消しますか？", "<p>名前・住所・入力中の申込書・作成履歴・稼働表の控えが、このスマホから消えます。保存したPDFは消えません。</p>", "すべて消す", true)) {
        store.clearAll();
        location.reload();
      }
    }
  });

  // 入力欄（文字を打つたびに）
  view.addEventListener("input", (e) => {
    const t = e.target;
    const card = t.closest(".row-card");
    if (card && t.dataset.k) {
      const row = state.app.rows[+card.dataset.row];
      row[t.dataset.k] = t.value;
      if (t.dataset.k === "people" || t.dataset.k === "time") card.dataset.touched = "1";
      saveDraft();
      renderCheck();
      if (t.dataset.k === "people") renderCalendar();
    }
  });
  // 日付・選択（決めたとき）
  view.addEventListener("change", (e) => {
    const t = e.target;
    if (t.id === "apply-date") {
      state.app.applyDate = t.value;
      saveDraft();
      return renderCheck();
    }
    if (t.id === "usage-month") {
      state.app.usageMonth = +t.value;
      state.app.usageManual = true;
      saveDraft();
      return renderCheck();
    }
    const card = t.closest(".row-card");
    if (card && (t.dataset.k === "start" || t.dataset.k === "end")) {
      const i = +card.dataset.row;
      const row = state.app.rows[i];
      row[t.dataset.k] = t.value;
      card.dataset.touched = "1";
      // 開始日を入れたとき、終了日が開始日より前なら空にする
      if (t.dataset.k === "start" && row.end && row.end < row.start) row.end = "";
      state.app.rows[i] = C.tidyRow(row);
      if (t.dataset.k === "start" && row.start) state.ui.viewYm = row.start.slice(0, 7);
      autoUsageMonth();
      saveDraft();
      renderForm();
      // 触った行の印を残す
      const again = $(`.row-card[data-row="${i}"]`);
      if (again) again.dataset.touched = "1";
      renderCalendar();
      renderCheck();
      const sel = $("#usage-month");
      if (sel) sel.value = String(state.app.usageMonth);
    }
  });
  view.addEventListener("toggle", (e) => {
    if (e.target.id === "avail-list") state.ui.listOpen = e.target.open;
  }, true);
}

// ---- 新しい版への入れ替え ----------------------------------------------------------

let swReg = null;
let updateReady = false;

/** 新しい版が公開されたら、入れ替えて開き直す（作業中なら、終わってから押せる案内を出す）。 */
function watchUpdates() {
  if (!("serviceWorker" in navigator) || location.protocol !== "https:") return;
  const hadController = !!navigator.serviceWorker.controller;   // 初めて開いたときは入れ替えではない
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || updateReady) return;
    updateReady = true;
    reloadIfIdle();
  });
  navigator.serviceWorker.register("sw.js").then((reg) => { swReg = reg; }).catch(() => {});
}

function isBusy() {
  const el = document.activeElement;
  return !!$("#layer").innerHTML.trim() || !!$(".tour-bubble") || (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
}

function reloadIfIdle() {
  if (!updateReady) return;
  if (!isBusy()) { location.reload(); return; }
  if ($("#update-bar")) return;
  const bar = document.createElement("div");
  bar.id = "update-bar";
  bar.className = "update-bar";
  bar.innerHTML = `<span>新しい版があります</span><button class="btn small primary">新しくする</button>`;
  bar.querySelector("button").addEventListener("click", () => location.reload());
  document.body.appendChild(bar);
}

// ---- 起動 ---------------------------------------------------------------------

async function boot() {
  clearTimeout(window.__bootTimer);
  bindEvents();
  renderWho();
  watchUpdates();
  loadMailTo();
  // 前の版（利用IDあり）で残った値を片付ける
  ["accessHashes", "accessOk", "accessFails", "accessLock", "deviceCode", "unlockDevices"].forEach((k) => store.remove(k));
  if (!state.profile?.setupDone) {
    $("#view").innerHTML = "";
    await runSetup();
    renderWho();
    switchTab("make");
    if (!state.profile?.tutorialDone) beginTour();
    return;
  }
  switchTab("make");
  refreshIfOld();
}

/** 稼働表が古ければ、裏で取り込み直す（開いたとき・アプリに戻ってきたとき）。 */
function refreshIfOld() {
  if (!state.profile?.setupDone || navigator.onLine === false) return;
  const age = S.ageMinutes(state.schedule);
  if (age == null || age >= REFRESH_MINUTES) refreshSchedule({ quiet: true });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  refreshIfOld();
  swReg?.update().catch(() => {});   // アプリに戻ってきたときも、新しい版が出ていないか確かめる
  reloadIfIdle();
});

// できるだけデータを消されないようにお願いする（対応している端末だけ）
try { navigator.storage?.persist?.(); } catch { /* 何もしない */ }

boot().catch((e) => {
  $("#view").innerHTML = `<div class="card"><div class="hint err">うまく起動できませんでした: ${esc(e.message || e)}</div>
    <button class="btn block" onclick="location.reload()">もう一度読み込む</button></div>`;
});
