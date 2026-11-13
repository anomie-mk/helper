// はじめの設定（初回起動時）
//  1. ようこそ  2. 稼働表を読み込んで、利用者名で自分の牧場を探す  3. 申込書に書く氏名・住所・地区
//  4. いつもの打合せ形態・時刻  5. できあがり

import { $, $$, esc } from "./util.js";
import * as S from "./schedule.js";
import * as C from "./core.js";
import { renderForm, releaseCanvas } from "./pdf.js";
import { state, saveProfile, refreshSchedule } from "./app.js";

const TOTAL = 5;

function standaloneNow() {
  return window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
}

/** 開いている場所についての案内（LINEの中のブラウザ・iPhoneのSafari）。 */
export function envNotice() {
  const ua = navigator.userAgent;
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || navigator.standalone === true;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (/\bLine\//i.test(ua)) {
    return `<div class="hint warn">LINEの中で開いています。保存がうまくいかないことがあるので、右下（または右上）のメニューから<b>「ブラウザで開く」</b>を選んで開き直してください。</div>`;
  }
  if (ios && !standalone) {
    return `<div class="hint info">iPhoneでは、<b>先に「ホーム画面に追加」</b>して、そのアイコンから開いてから設定すると、設定のやり直しがいりません（Safariとホーム画面のアイコンでは、保存される場所が別になるため）。<br>Safariの共有ボタン（□に↑）→「ホーム画面に追加」</div>`;
  }
  return "";
}

export function runSetup({ redo = false } = {}) {
  return new Promise((resolve) => {
    const p = { ...(state.profile || {}) };
    const w = { step: redo ? 1 : 0, query: p.userName || "", picked: p.userName ? { name: p.userName, area: "" } : null, notFound: false };
    const layer = $("#layer");

    const dots = (n) => `<div class="steps-dots">${Array.from({ length: TOTAL }, (_, i) => `<i class="${i === n ? "on" : ""}"></i>`).join("")}</div>`;

    function show() {
      const fn = [stepWelcome, stepName, stepForm, stepDefaults, stepDone][w.step];
      layer.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="はじめの設定"><div class="sheet-inner">${dots(w.step)}${fn()}</div></div>`;
      $(".sheet", layer).scrollTop = 0;
      after[w.step]?.();
    }

    // ---- 1. ようこそ ----
    function stepWelcome() {
      return `<img class="welcome-icon" src="img/icon-192.png" alt="">
        <h2 style="text-align:center">ヘルパー申込アプリへ<br>ようこそ</h2>
        <p class="muted" style="text-align:center">酪農ヘルパー利用申込書（PDF）を、スマホでかんたんにつくれます。</p>
        <ul class="points">
          <li><span class="em">📅</span><span>組合の<b>稼働表</b>を読み込んで、ヘルパーの空いている日をカレンダーで見られます。</span></li>
          <li><span class="em">👆</span><span>空いている日を<b>押すだけ</b>で、申込書に日付が入ります。</span></li>
          <li><span class="em">📄</span><span>申込書を<b>PDF</b>にして、そのまま<b>メールで組合へ送れます</b>。</span></li>
          <li><span class="em">🔒</span><span>入力した内容は<b>このスマホの中だけ</b>に保存されます。</span></li>
        </ul>
        ${envNotice()}
        <p class="muted small">はじめに、あなたの牧場の情報を設定します（1分ほど）。</p>
        <div class="wizard-foot"><button class="btn primary big" data-next>はじめる</button></div>`;
    }

    // ---- 2. 利用者名 ----
    function stepName() {
      return `<h2>あなたの牧場を探します</h2>
        <p class="muted">組合の稼働表に載っている<b>利用者名</b>（ご自身のお名前や牧場名）を入れてください。</p>
        <div id="w-sync"></div>
        <div class="field"><label for="w-q">稼働表での利用者名</label>
          <input type="search" id="w-q" value="${esc(w.query)}" placeholder="例: 十勝太郎 や 〇〇牧場" autocomplete="off" enterkeyhint="search"></div>
        <div id="w-cands"></div>
        <div id="w-hint"></div>
        <div class="wizard-foot"><button class="btn" data-back>戻る</button><button class="btn primary" data-next id="w-next">次へ</button></div>`;
    }

    function renderSyncBox() {
      const el = $("#w-sync");
      if (!el) return;
      if (state.ui.fetching) {
        el.innerHTML = `<div class="hint info">${esc(state.ui.progressText || "稼働表を読み込んでいます…")}<div class="progress"><div style="width:${Math.round(state.ui.progress * 100)}%"></div></div></div>`;
      } else if (!state.schedule) {
        el.innerHTML = `<div class="hint warn">稼働表を読み込めませんでした。${esc(state.ui.fetchError || "")}<br>
          電波の良いところで <button class="btn small" id="w-retry">もう一度読み込む</button><br>
          読み込めなくても、名前を入れて先へ進めます（あとで「最新にする」を押せば出ます）。</div>`;
      } else {
        el.innerHTML = "";
      }
    }

    function renderCands() {
      const el = $("#w-cands");
      if (!el) return;
      const q = $("#w-q")?.value ?? w.query;
      w.query = q;
      if (!state.schedule || !q.trim()) { el.innerHTML = ""; return; }
      const list = S.searchNames(state.schedule, q);
      if (!list.length) {
        el.innerHTML = `<div class="hint warn">稼働表に「${esc(q)}」は見つかりませんでした。字が違っていないか（例: 斉藤／斎藤）確かめてください。
          稼働表にまだ載っていない（はじめて頼む）ときは、このまま「次へ」で進めます。</div>`;
        w.picked = { name: q.trim(), area: "" };
        w.notFound = true;
        return;
      }
      w.notFound = false;
      const exact = list.some((c) => c.score === 0);
      const self = q.trim();
      if (!w.picked || !(list.some((c) => c.name === w.picked.name) || (w.picked.self && w.picked.name === self))) {
        w.picked = exact ? list.find((c) => c.score === 0) : null;
      }
      el.innerHTML = `<p class="small" style="margin:0">見つかった利用者（あなたの牧場を押してください）</p><div class="cand">${list.map((c) => `
        <button data-cand="${esc(c.name)}" aria-pressed="${w.picked?.name === c.name}">
          <div class="nm">${w.picked?.name === c.name ? "✓ " : ""}${esc(c.name)}</div>
          <div class="muted small">${esc(C.DISTRICT_NAMES[C.districtFromArea(c.area)] || "地区不明")}・稼働表に${c.count}回${c.last ? `・最近 ${+c.last.slice(5, 7)}月${+c.last.slice(8)}日` : ""}</div>
        </button>`).join("")}
        ${exact ? "" : `<button data-cand-self="1" aria-pressed="${!!w.picked?.self}">
          <div class="nm">${w.picked?.self ? "✓ " : ""}「${esc(self)}」で進む</div>
          <div class="muted small">上にあなたの牧場が無いとき（稼働表にまだ載っていない・はじめて頼む）</div>
        </button>`}</div>`;
    }

    // ---- 3. 申込書に書く内容 ----
    function stepForm() {
      if (!p.formName) p.formName = w.picked?.name || "";
      if (!p.district && w.picked?.area) p.district = C.districtFromArea(w.picked.area);
      return `<h2>申込書に書く内容</h2>
        <p class="muted">申込書の「所属地区・住所・氏名」の欄に入ります。</p>
        <div class="field" id="wf-district"><span class="label">所属地区</span>
          <div class="seg wrap" id="w-district">${C.DISTRICTS.map(([k, n, ja]) => `<button data-district="${k}" aria-pressed="${p.district === k}">${n}<br><span class="small">（${ja}）</span></button>`).join("")}</div>
          ${w.picked?.area && p.district ? `<p class="muted small">稼働表の地区（${esc(w.picked.area)}）から選んでいます。違うときは押し直してください。</p>` : ""}</div>
        <div class="field" id="wf-address"><label for="w-addr">住所</label>
          <input type="text" id="w-addr" value="${esc(p.address || "")}" placeholder="例: 中川郡幕別町〇〇123-4" autocomplete="street-address"></div>
        <div class="field" id="wf-name"><label for="w-name">氏名</label>
          <input type="text" id="w-name" value="${esc(p.formName || "")}" placeholder="例: 十勝　太郎" autocomplete="name">
          <p class="muted small">稼働表の名前が牧場名のときは、代表者のお名前にしてもかまいません。</p></div>
        <div id="w-form-hint"></div>
        <p class="small" style="font-weight:700;margin:8px 0 4px">申込書ではこう見えます</p>
        <img class="form-crop" id="w-crop" alt="申込書の上の部分">
        <div class="wizard-foot"><button class="btn" data-back>戻る</button><button class="btn primary" data-next>次へ</button></div>`;
    }

    let cropTimer = null;
    function updateCrop() {
      clearTimeout(cropTimer);
      cropTimer = setTimeout(async () => {
        const img = $("#w-crop");
        if (!img) return;
        try {
          const canvas = await renderForm({ apply_year: "", apply_month: "", apply_day: "", usage_month: "", rows: [] }, p);
          const sy = canvas.height / 1767;
          const top = Math.round(240 * sy), h = Math.round(240 * sy);
          // 見本は画面に出すだけなので小さくする（大きい canvas はすぐ手放す。iPhoneはcanvasのメモリに上限がある）
          const outW = 900, outH = Math.round(h * outW / canvas.width);
          const out = document.createElement("canvas");
          out.width = outW; out.height = outH;
          out.getContext("2d").drawImage(canvas, 0, top, canvas.width, h, 0, 0, outW, outH);
          releaseCanvas(canvas);
          img.src = out.toDataURL("image/jpeg", 0.85);
          releaseCanvas(out);
        } catch { /* 見本が出なくても先へ進める */ }
      }, 150);
    }

    function readForm() {
      p.address = $("#w-addr").value.trim();
      p.formName = $("#w-name").value.trim();
      p.district = $("#w-district [aria-pressed=true]")?.dataset.district || p.district || "";
    }

    // ---- 4. いつもの打合せ ----
    function stepDefaults() {
      return `<h2>いつもの打合せ方法</h2>
        <p class="muted">申込書の「打合せ希望形態」と「希望時刻」に、最初から入れておく値です。あとで1行ずつ変えられます。</p>
        <div class="field"><span class="label">打合せ希望形態</span>
          <div class="seg" id="w-meeting">${C.MEETING_OPTIONS.map(([k, n]) => `<button data-meeting="${k}" aria-pressed="${p.meeting === k}">${n.replace("での", "での<br>").replace("打合せ", "<br>打合せ")}</button>`).join("")}</div></div>
        <div class="field"><label for="w-time">希望時刻 <span class="opt">空欄でもよい</span></label>
          <div class="inline"><input type="text" inputmode="decimal" id="w-time" value="${esc(p.time || "")}" placeholder="例 18"><span class="unit">時頃</span></div></div>
        <div id="w-def-hint"></div>
        <div class="wizard-foot"><button class="btn" data-back>戻る</button><button class="btn primary" data-next>次へ</button></div>`;
    }

    // ---- 5. できあがり ----
    function stepDone() {
      return `<div style="text-align:center;font-size:56px">🎉</div>
        <h2 style="text-align:center">準備ができました</h2>
        <div class="card"><dl class="kv">
          <dt>利用者名</dt><dd>${esc(p.userName || "—")}</dd>
          <dt>氏名</dt><dd>${esc(p.formName)}</dd>
          <dt>住所</dt><dd>${esc(p.address)}</dd>
          <dt>所属地区</dt><dd>${esc(C.DISTRICT_NAMES[p.district] || "")}</dd>
          <dt>打合せ</dt><dd>${esc(C.MEETING_NAMES[p.meeting] || "選ばない")}${p.time ? `・${esc(p.time)}時頃` : ""}</dd>
        </dl></div>
        <p class="muted small">あとから「設定」で変えられます。</p>
        ${standaloneNow() ? "" : `<div class="hint info">ホーム画面に追加すると、アプリのように開けます。<br>
          iPhone: Safariの共有ボタン（□↑）→「ホーム画面に追加」<br>Android: Chromeの「︙」→「ホーム画面に追加」</div>`}
        <div class="wizard-foot"><button class="btn" data-back>戻る</button><button class="btn primary big" data-next>使いはじめる</button></div>`;
    }

    const after = {
      1() {
        renderSyncBox();
        renderCands();
        if (!state.schedule && !state.ui.fetching) {
          refreshSchedule({ quiet: true }).then(() => { if (w.step === 1) { renderSyncBox(); renderCands(); } });
        }
        const poll = setInterval(() => {
          if (w.step !== 1 || !$("#w-sync")) return clearInterval(poll);
          if (state.ui.fetching) renderSyncBox(); else clearInterval(poll);
        }, 300);
        $("#w-q").addEventListener("input", () => { w.picked = null; renderCands(); });
      },
      2() {
        updateCrop();
        $("#w-addr").addEventListener("input", () => { readForm(); updateCrop(); });
        $("#w-name").addEventListener("input", () => { readForm(); updateCrop(); });
      },
    };

    function validateStep() {
      if (w.step === 1) {
        const q = ($("#w-q")?.value || "").trim();
        if (!q) return "利用者名を入れてください。";
        if (state.schedule && !w.notFound && !w.picked) return "見つかった利用者の中からあなたの牧場を押してください（無いときは、いちばん下の「〜で進む」を押します）。";
        p.userName = (w.picked?.name || q).trim();
        if (!p.district && w.picked?.area) p.district = C.districtFromArea(w.picked.area);
        if (!p.formName || (redo && p.formName === state.profile?.userName)) p.formName = p.userName;
        return "";
      }
      if (w.step === 2) {
        readForm();
        const errs = [];
        if (!p.district) errs.push("所属地区を選んでください。");
        if (!p.address) errs.push("住所を入れてください。");
        if (!p.formName) errs.push("氏名を入れてください。");
        return errs.join("\n");
      }
      if (w.step === 3) {
        p.meeting = $("#w-meeting [aria-pressed=true]")?.dataset.meeting || "";
        p.time = C.normalizeTime($("#w-time").value);
        if (!C.checkTime(p.time)) return "希望時刻は数字で入れてください（例: 18 や 18:30）。";
        return "";
      }
      return "";
    }

    layer.onclick = (e) => {
      const t = e.target;
      if (t.closest("[data-next]")) {
        const msg = validateStep();
        if (msg) {
          const box = $("#w-hint") || $("#w-form-hint") || $("#w-def-hint");
          if (box) {
            box.innerHTML = msg.split("\n").map((m) => `<div class="hint err">${esc(m)}</div>`).join("");
            box.scrollIntoView({ behavior: "smooth", block: "center" });
          }
          return;
        }
        if (w.step === TOTAL - 1) {
          state.profile = { ...p, setupDone: true };
          saveProfile();
          layer.innerHTML = "";
          layer.onclick = null;
          return resolve();
        }
        w.step++;
        return show();
      }
      if (t.closest("[data-back]")) {
        if (w.step === 2) readForm();
        if (w.step === 3) {
          p.meeting = $("#w-meeting [aria-pressed=true]")?.dataset.meeting || "";
          p.time = $("#w-time").value.trim();
        }
        w.step = Math.max(0, w.step - 1);
        return show();
      }
      if (t.closest("#w-retry")) {
        refreshSchedule({ quiet: true }).then(() => { if (w.step === 1) { renderSyncBox(); renderCands(); } });
        return setTimeout(renderSyncBox, 50);
      }
      const cand = t.closest("[data-cand]") || t.closest("[data-cand-self]");
      if (cand) {
        const next = cand.dataset.candSelf
          ? { name: w.query.trim(), area: "", self: true }
          : S.searchNames(state.schedule, w.query).find((c) => c.name === cand.dataset.cand) || null;
        // 別の利用者を選び直したときだけ、氏名・地区を選んだ利用者から始め直す
        if (next && next.name !== (state.profile?.userName || p.userName || w.picked?.name)) {
          p.formName = "";
          p.district = "";
        }
        w.picked = next;
        renderCands();
        $("#w-hint").innerHTML = "";
        return;
      }
      const d = t.closest("[data-district]");
      if (d) {
        $$("#w-district button").forEach((b) => b.setAttribute("aria-pressed", String(b === d)));
        readForm();
        return updateCrop();
      }
      const m = t.closest("#w-meeting [data-meeting]");
      if (m) {
        const on = m.getAttribute("aria-pressed") !== "true";
        $$("#w-meeting button").forEach((b) => b.setAttribute("aria-pressed", String(b === m && on)));
      }
    };

    show();
  });
}
