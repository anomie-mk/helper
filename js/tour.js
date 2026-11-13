// 画面の説明（チュートリアル）
//  画面の部品を1つずつ明るく照らして、吹き出しで説明する。

import { $, esc } from "./util.js";

const STEPS = [
  { sel: null, title: "使い方の説明", text: "申込書をつくる流れを、画面の上で順に説明します。（1分ほど）<br>途中でやめても、右上の「？」からいつでも見られます。" },
  { sel: "#sync", title: "稼働表の読み込み", text: "組合の稼働表を読み込んだ時刻です。開くたびに自動で新しくなります。すぐ新しくしたいときは「最新にする」を押します。" },
  { sel: "#people-field", title: "① 頼みたい人数を選ぶ", text: "まず、1日に何名のヘルパーを頼みたいかを選びます。その人数を頼めない日は、カレンダーで薄く表示されます。" },
  { sel: "#cal-grid", title: "② 空いている日を押す", text: "色が濃いほど多く頼めます（濃い緑＝3名以上、緑＝2名、薄い緑＝1名、×＝空きなし）。<br><b>日を押すと申込書に入り</b>、オレンジの枠が付きます。もう一度押すと外れます。続いた日は1行にまとまります。<br>全部やり直したいときは、上の「チェックをすべて消す」を押します。" },
  { sel: "#card-form", title: "③ 申込書の中身を確かめる", text: "申込書の紙面と同じ形で、全部の行が並びます。行を押すと、その行の入力欄（希望人員・打合せ希望形態・希望時刻）に移って直せます。カレンダーを使わずに「希望日を手で足す」こともできます。" },
  { sel: "#card-pdf", title: "④ 申込書をつくってメールで送る", text: "直すところがあると<b style=\"color:#c62828\">赤</b>で、確かめてほしいことは<b style=\"color:#8a5a00\">黄色</b>で出ます。<br>問題がなければ「申込書をつくる」→ 次の画面の「メールで組合へ送る」で送ります。" },
  { sel: "#tabbar", title: "履歴と設定", text: "つくった申込書は「作成履歴」から、同じ内容でもう一度つくれます。氏名・住所などは「設定」で変えられます。" },
  { sel: "#help-btn", title: "困ったときは", text: "右上の「？」に、よくある質問とこの説明があります。<br>では、さっそく使ってみましょう！" },
];

export function startTour(onDone = () => {}) {
  let i = 0;
  const block = document.createElement("div");
  block.className = "tour-block";
  const hole = document.createElement("div");
  hole.className = "tour-hole";
  const bubble = document.createElement("div");
  bubble.className = "tour-bubble";
  bubble.setAttribute("role", "dialog");
  bubble.setAttribute("aria-live", "polite");
  document.body.append(block, hole, bubble);

  // 説明のあいだは、下の画面を指で動かせないようにする（照らす枠がずれないように）
  const stopMove = (e) => e.preventDefault();
  block.addEventListener("touchmove", stopMove, { passive: false });
  hole.addEventListener("touchmove", stopMove, { passive: false });
  const onScroll = () => place();

  function finish() {
    block.remove(); hole.remove(); bubble.remove();
    window.removeEventListener("resize", place);
    window.removeEventListener("scroll", onScroll, true);
    onDone();
  }

  function place() {
    const step = STEPS[i];
    const el = step.sel ? $(step.sel) : null;
    const vh = window.innerHeight;
    if (!el) {
      hole.style.cssText = `left:50%;top:40%;width:0;height:0;`;
      bubble.style.top = `${Math.max(80, vh * 0.25)}px`;
      bubble.style.bottom = "auto";
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = 6;
    const top = Math.max(4, r.top - pad), bottom = Math.min(vh - 4, r.bottom + pad);
    hole.style.cssText = `left:${Math.max(4, r.left - pad)}px;top:${top}px;width:${Math.min(window.innerWidth - 8, r.width + pad * 2)}px;height:${Math.max(0, bottom - top)}px;`;
    const bh = bubble.offsetHeight || 180;
    if (vh - bottom > bh + 16) { bubble.style.top = `${bottom + 10}px`; bubble.style.bottom = "auto"; }
    else if (top > bh + 16) { bubble.style.top = `${top - bh - 10}px`; bubble.style.bottom = "auto"; }
    else { bubble.style.top = "auto"; bubble.style.bottom = "12px"; }
  }

  function show() {
    const step = STEPS[i];
    bubble.innerHTML = `<div class="count">${i + 1} / ${STEPS.length}</div><h3>${esc(step.title)}</h3><div>${step.text}</div>
      <div class="btn-row">
        ${i > 0 ? `<button class="btn small" data-t="prev">戻る</button>` : `<button class="btn small ghost" data-t="skip">とばす</button>`}
        <button class="btn small primary" data-t="next">${i === STEPS.length - 1 ? "はじめる" : "次へ"}</button>
      </div>
      ${i > 0 && i < STEPS.length - 1 ? `<div style="text-align:center"><button class="link" data-t="skip">説明を終わる</button></div>` : ""}`;
    const el = step.sel ? $(step.sel) : null;
    if (el) {
      // 大きい部品は上の方を、小さい部品は真ん中に見せる
      const r = el.getBoundingClientRect();
      const block = r.height > window.innerHeight * 0.5 ? "start" : "center";
      el.scrollIntoView({ block, behavior: "auto" });
      if (block === "start") window.scrollBy(0, -70);
    }
    requestAnimationFrame(() => { place(); setTimeout(place, 60); });
  }

  bubble.addEventListener("click", (e) => {
    const a = e.target.closest("[data-t]")?.dataset.t;
    if (a === "next") { if (i === STEPS.length - 1) return finish(); i++; show(); }
    else if (a === "prev") { i = Math.max(0, i - 1); show(); }
    else if (a === "skip") finish();
  });
  window.addEventListener("resize", place);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  show();
}
