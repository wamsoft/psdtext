//---------------------------------------------------------------------------
// 本文の編集欄 (書式マークを埋め込んだ contenteditable)
//
// 本文にタグを生で出すのはやめて、書式の変わり目を ◆ の札として置く。札は
// contenteditable=false のひと塊なので、文字と同じように選べるし Backspace で
// 消せる。編集対象は「カーソルが属しているマーク」= カーソルより前で最後に
// 効いた札 (手前に札が無ければ基準 = レイヤ全体の初期書式)。
//
// ここが持つのは 文字列 (タグ表現) ⇄ DOM の変換と位置の対応だけ。書式の意味は
// tags.js、UI の組み立ては app.js。
//
// 位置は常に「タグ表現の文字列上の位置」で扱う。こうしておくと選択範囲もマーク
// の位置も、そのまま tags.js の編集関数へ渡せる。
//---------------------------------------------------------------------------
import * as tg from './tags.js';

const BLOCK = /^(DIV|P|LI|H[1-6]|SECTION|ARTICLE)$/;

//---------------------------------------------------------------------------
// 組み立て
//---------------------------------------------------------------------------

/// 本文 DOM を tagged から作り直す。
///   opts.describe   : specs → 札に出す部品の配列 (app.js が i18n 込みで渡す)
///   opts.pendingPos : まだ本文に入っていない「これから置くマーク」の位置
///   opts.selected   : 光らせる札 {kind:'mark', start} / {kind:'new'}
export function renderBody(root, tagged, opts = {}) {
	const { describe = () => [], pendingPos = null, selected = null } = opts;
	root.textContent = '';

	const addText = (raw) => {
		if (raw) root.appendChild(document.createTextNode(tg.unescapeText(raw)));
	};
	const addMark = (seg) => {
		const on = !!(selected && selected.kind === 'mark' && selected.start === seg.start);
		root.appendChild(markElement(seg.tag, describe(seg.specs), on));
	};
	const addPending = () => {
		root.appendChild(pendingElement(!!(selected && selected.kind === 'new')));
	};

	let placed = (pendingPos === null);
	for (const seg of tg.segments(tagged)) {
		const raw = tagged.slice(seg.start, seg.end);
		if (!placed && seg.kind === 'text' &&
		    pendingPos > seg.start && pendingPos < seg.end) {
			addText(raw.slice(0, pendingPos - seg.start));   // 本文の途中に挟む
			addPending();
			addText(raw.slice(pendingPos - seg.start));
			placed = true;
			continue;
		}
		if (!placed && pendingPos <= seg.start) { addPending(); placed = true; }
		if (seg.kind === 'text') addText(raw);
		else addMark(seg);
	}
	if (!placed) addPending();

	// 末尾が札や改行で終わっていると、その後ろにカーソルを置けないので受け皿を足す
	// (走査側で「見せかけの BR」として無視する)
	const last = root.lastChild;
	if (!last || last.nodeType !== 3 || /\n$/.test(last.data))
		root.appendChild(document.createElement('br'));
}

/// 書式マークの札
function markElement(tag, parts, on) {
	const el = document.createElement('span');
	el.className = 'mk' + (on ? ' on' : '');
	el.contentEditable = 'false';
	el.dataset.mark = tag;

	const dot = document.createElement('span');
	dot.className = 'mk-dot';
	dot.textContent = '◆';
	el.appendChild(dot);

	for (const p of parts) {
		if (p.color) {
			const sw = document.createElement('span');
			sw.className = 'mk-swatch';
			sw.style.background = p.color;
			el.appendChild(sw);
		}
		if (p.text) {
			const s = document.createElement('span');
			s.className = 'mk-part' + (p.strike ? ' off' : '');
			s.textContent = p.text;
			el.appendChild(s);
		}
	}
	el.title = parts.map(p => p.text || p.color).filter(Boolean).join(' ');
	return el;
}

/// まだ何も指定されていない札 (「＋マーク」を押した直後)
function pendingElement(on) {
	const el = document.createElement('span');
	el.className = 'mk pending' + (on ? ' on' : '');
	el.contentEditable = 'false';
	el.dataset.mark = '';
	el.textContent = '◆';
	return el;
}

//---------------------------------------------------------------------------
// 走査 (DOM ⇄ 位置)
//---------------------------------------------------------------------------

/// DOM を頭から辿って、各ノードがタグ表現のどこに当たるかを並べる
function scan(root) {
	const items = [];
	let pos = 0;
	const walk = (parent) => {
		for (const n of parent.childNodes) {
			if (n.nodeType === 3) {                            // 文字
				const raw = tg.escapeText(n.data);
				items.push({ node: n, kind: 'text', raw, start: pos, end: pos + raw.length });
				pos += raw.length;
			} else if (n.nodeType !== 1) {
				continue;
			} else if (n.dataset && n.dataset.mark !== undefined) {   // 札
				const tag = n.dataset.mark || '';
				items.push({ node: n, kind: 'mark', tag, raw: tag,
				             start: pos, end: pos + tag.length });
				pos += tag.length;
			} else if (n.tagName === 'BR') {
				if (isBogusBr(root, n)) continue;              // 末尾の受け皿
				items.push({ node: n, kind: 'text', raw: '\n', start: pos, end: pos + 1 });
				pos += 1;
			} else {
				if (BLOCK.test(n.tagName) && pos > 0) {        // 段落の区切り
					items.push({ node: n, kind: 'break', raw: '\n', start: pos, end: pos + 1 });
					pos += 1;
				}
				walk(n);
			}
		}
	};
	walk(root);
	return items;
}

/// contenteditable の末尾にブラウザが足す「見せかけの改行」か
function isBogusBr(root, br) {
	if (br.parentNode !== root) return false;
	for (let n = br.nextSibling; n; n = n.nextSibling) {
		if (n.nodeType === 3 && n.data !== '') return false;
		if (n.nodeType === 1) return false;
	}
	return true;
}

//---------------------------------------------------------------------------
/// 本文 DOM をタグ表現の文字列へ戻す
export function serializeBody(root) {
	let out = '';
	for (const it of scan(root)) out += it.raw;
	return out;
}

/// 選択範囲をタグ表現上の位置で返す。編集欄の外なら null。
export function selectionRange(root) {
	const sel = document.getSelection();
	if (!sel || !sel.rangeCount) return null;
	const r = sel.getRangeAt(0);
	if (!root.contains(r.startContainer) || !root.contains(r.endContainer)) return null;
	const items = scan(root);
	const s = toPos(root, items, r.startContainer, r.startOffset);
	const e = toPos(root, items, r.endContainer, r.endOffset);
	if (s === null || e === null) return null;
	return (s <= e) ? { s, e } : { s: e, e: s };
}

/// タグ表現上の位置で選択し直す
export function selectRange(root, s, e) {
	const items = scan(root);
	const a = toDom(root, items, s);
	const b = toDom(root, items, e);
	if (!a || !b) return;
	const r = document.createRange();
	try {
		r.setStart(a.node, a.offset);
		r.setEnd(b.node, b.offset);
	} catch (err) { return; }
	const sel = document.getSelection();
	sel.removeAllRanges();
	sel.addRange(r);
}

/// (node, offset) → タグ表現上の位置
function toPos(root, items, node, offset) {
	if (node.nodeType === 3) {
		const it = items.find(x => x.node === node);
		if (!it) return null;
		return it.start + tg.escapeText(node.data.slice(0, offset)).length;
	}
	// 要素ノード = 「offset 番目の子の直前」
	const kids = node.childNodes;
	if (offset < kids.length) {
		const p = startOf(items, kids[offset]);
		if (p !== null) return p;
	}
	// 末尾を指しているときは、その要素に含まれる最後の位置
	let end = null;
	for (const it of items) if (node.contains(it.node)) end = it.end;
	if (end !== null) return end;
	return (node === root) ? 0 : null;
}

function startOf(items, node) {
	for (const it of items) {
		if (it.node === node || node.contains(it.node)) return it.start;
	}
	return null;
}

/// タグ表現上の位置 → (node, offset)
function toDom(root, items, pos) {
	for (const it of items) {
		if (pos < it.start || pos > it.end) continue;
		if (it.kind === 'text' && it.node.nodeType === 3) {
			const raw = it.raw.slice(0, pos - it.start);
			return { node: it.node, offset: tg.unescapeText(raw).length };
		}
		// 札や改行の上に落ちたら、その手前 / 後ろへ寄せる
		const parent = it.node.parentNode;
		const idx = [...parent.childNodes].indexOf(it.node);
		return { node: parent, offset: (pos <= it.start) ? idx : idx + 1 };
	}
	return { node: root, offset: root.childNodes.length };
}

//---------------------------------------------------------------------------
/// 札の DOM 要素がタグ表現のどこにあるか (中身が空の札は null)
export function markPosOf(root, el) {
	for (const it of scan(root)) {
		if (it.node === el) return it.tag ? it.start : null;
	}
	return null;
}

/// カーソルが属している札を光らせる (start は tags.js が返すマークの位置)
export function highlight(root, start) {
	for (const it of scan(root)) {
		// 中身の無い札 (これから置くマーク) は renderBody 側で光らせている
		if (it.kind !== 'mark' || !it.tag) continue;
		it.node.classList.toggle('on', start !== null && it.start === start);
	}
}
