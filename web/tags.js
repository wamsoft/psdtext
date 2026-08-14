//---------------------------------------------------------------------------
// 書式マークのモデル (タグ付き本文の読み書き)
//
// 本文はタグ付きの 1 本の文字列で、書式は「マーク」で表す。マークはその位置
// から先の書式を変える指定で、閉じタグは無い (C++ 側 richtext.cpp と同じ規則)。
//
//   これは[b]太字[/b]で[size=96][color=#FF0000]大きい赤
//        ~~~      ~~~~ ~~~~~~~~~~~~~~~~~~~~~~~
//        マーク    マーク  マーク (連続したタグはひとつのマーク)
//
// 「範囲に書式を付ける」も、閉じタグではなく **範囲の終わりに戻すマークを置く**
// ことで表す。戻す先は範囲直後に効いていた書式そのものなので、入れ子や地の
// 書式が何であっても壊れない ([/b] は「太字を切る」であって「閉じ」ではない)。
//
// ここは DOM に触れない純粋な文字列操作だけ。UI は app.js。
//---------------------------------------------------------------------------

/// タグとして解釈する名前 (これ以外は本文の文字として扱う = C++ 側と同じ)
const KNOWN = new Set(['b', 'bold', 'i', 'italic', 'u', 'underline',
                       'size', 'font', 'color', 'reset', 'align']);

/// 書式の属性 (align は段落の指定なので別扱い)
export const STYLE_ATTRS = ['font', 'size', 'color', 'bold', 'italic', 'underline'];
/// 値を持つ属性 (「基準へ戻す」= null を表せる)
export const VALUE_ATTRS = ['font', 'size', 'color'];
/// on/off だけの属性
export const FLAG_ATTRS = ['bold', 'italic', 'underline'];

export const ALIGN_NAMES = ['left', 'right', 'center', 'justify-left',
                            'justify-right', 'justify-center', 'justify-all'];

function attrOf(name) {
	switch (name) {
		case 'b': case 'bold':      return 'bold';
		case 'i': case 'italic':    return 'italic';
		case 'u': case 'underline': return 'underline';
		default:                    return name;
	}
}

export function alignValue(name) {
	const n = String(name).trim().toLowerCase();
	const i = ALIGN_NAMES.indexOf(n);
	if (i >= 0) return i;
	if (n === 'justify') return 6;
	if (/^\d+$/.test(n)) return Number(n);
	return null;
}

/// 比較用に色を "#RRGGBB" へ揃える (アルファは無視。無効な値はそのまま返す)
export function normColor(v) {
	if (v === null || v === undefined) return v;
	const h = String(v).replace('#', '').trim();
	if (!/^[0-9a-fA-F]{6,8}$/.test(h)) return String(v);
	return '#' + h.slice(0, 6).toUpperCase();
}

/// サイズをタグ用の文字列へ (整数は小数点なし)
export function sizeText(v) {
	const n = Number(v);
	if (!isFinite(n)) return '';
	return (Math.abs(n - Math.round(n)) < 0.0005)
		? String(Math.round(n)) : String(Math.round(n * 10000) / 10000);
}

//---------------------------------------------------------------------------
// タグ表現 ⇄ 見せる本文
//
// 編集欄にはタグを出さず、マークは札として置く。そのため「タグ付きの 1 本の
// 文字列」と「素の本文 + マークの位置」を行き来する必要がある。
//---------------------------------------------------------------------------

/// 本文の文字をタグ表現へ ('[' は '[[' と書く決まり)
export function escapeText(s) {
	return String(s).replace(/\[/g, '[[');
}

/// その逆
export function unescapeText(s) {
	return String(s).replace(/\[\[/g, '[');
}

/// タグ表現を「本文の切れ端」と「マーク」の並びへ分ける。
/// start / end はタグ表現上の位置なので、そのまま編集 API へ渡せる。
export function segments(tagged) {
	const out = [];
	let i = 0;
	for (const m of parseMarks(tagged)) {
		if (m.start > i)
			out.push({ kind: 'text', start: i, end: m.start,
			           text: unescapeText(tagged.slice(i, m.start)) });
		out.push({ kind: 'mark', start: m.start, end: m.end, specs: m.specs,
		           tag: tagged.slice(m.start, m.end) });
		i = m.end;
	}
	if (i < tagged.length)
		out.push({ kind: 'text', start: i, end: tagged.length,
		           text: unescapeText(tagged.slice(i)) });
	return out;
}

/// タグを取り除いた素の本文 (編集欄に見えているとおりの文字列)
export function stripToPlain(tagged) {
	return segments(tagged).filter(s => s.kind === 'text').map(s => s.text).join('');
}

/// pos の文字を支配しているマーク (pos より前で最後に効いたもの)。
/// 手前にマークが無ければ null = 基準がそのまま効いている場所。
export function governingMark(tagged, pos) {
	let hit = null;
	for (const m of parseMarks(tagged)) {
		if (m.start > pos) break;
		// 札のすぐ手前 (m.start == pos) はまだそのマークの効き始めではない
		if (m.end <= pos || (m.start < pos && pos < m.end)) hit = m;
	}
	return hit;
}

//---------------------------------------------------------------------------
/// 本文中のタグを前から拾う。'[[' はリテラルの '['、未知のタグは本文の文字。
export function scanTokens(s) {
	const out = [];
	for (let i = 0; i < s.length;) {
		if (s[i] !== '[') { i++; continue; }
		if (s[i + 1] === '[') { i += 2; continue; }
		const close = s.indexOf(']', i + 1);
		if (close < 0) break;                       // 閉じていない = 本文
		const body = s.slice(i + 1, close);
		const off = body.startsWith('/');
		const spec = off ? body.slice(1) : body;
		const eq = spec.indexOf('=');
		const name = (eq < 0 ? spec : spec.slice(0, eq)).trim().toLowerCase();
		const value = eq < 0 ? '' : spec.slice(eq + 1).trim();
		if (KNOWN.has(name) || name === '')         // [] / [/] は [reset] と同じ
			out.push({ start: i, end: close + 1, name: name || 'reset', off, value });
		i = close + 1;
	}
	return out;
}

//---------------------------------------------------------------------------
/// タグを「マーク」へまとめる。連続したタグ ([size=96][color=#F00]) は 1 つの
/// マーク — 同じ場所に効くものを別々に見せても操作しづらいだけなので。
///
/// specs は属性 → 値。値の意味は:
///   font/size/color : 文字列/数値 = その値を指定 / null = 基準へ戻す
///   bold/italic/underline : true = on / false = off
///   align : 0..6 / reset : true
/// キーが無い = その属性については何もしない (前の状態がそのまま続く)
export function parseMarks(s) {
	const marks = [];
	for (const tk of scanTokens(s)) {
		let m = marks[marks.length - 1];
		if (!m || m.end !== tk.start) {
			m = { start: tk.start, end: tk.start, specs: {} };
			marks.push(m);
		}
		m.end = tk.end;
		const a = attrOf(tk.name);
		if (a === 'reset') {
			m.specs = { reset: true };          // 以前の指定はまとめて無効になる
		} else if (FLAG_ATTRS.includes(a)) {
			m.specs[a] = !tk.off;
		} else if (a === 'align') {
			const v = alignValue(tk.value);
			if (v !== null) m.specs.align = v;
		} else if (a === 'size') {
			const v = parseFloat(tk.value);
			m.specs.size = (tk.off || !isFinite(v)) ? null : v;
		} else {
			m.specs[a] = (tk.off || tk.value === '') ? null : tk.value;
		}
	}
	return marks;
}

//---------------------------------------------------------------------------
/// レイヤの基準書式 (サーバが返す先頭ランの書式) を正規化する
export function baseStyle(base) {
	return {
		font:      base.font || '',
		size:      Number(base.size) || 0,
		color:     normColor(base.color || '#000000'),
		bold:      !!base.bold,
		italic:    !!base.italic,
		underline: !!base.underline,
	};
}

function applySpecs(cur, specs, b) {
	if (specs.reset) Object.assign(cur, b);
	for (const a of VALUE_ATTRS)
		if (a in specs) cur[a] = (specs[a] === null) ? b[a] : specs[a];
	for (const a of FLAG_ATTRS)
		if (a in specs) cur[a] = specs[a];
}

/// pos の文字に効いている書式 (pos より前で閉じているマークをすべて適用)
export function styleAt(tagged, pos, base) {
	const b = baseStyle(base);
	const cur = Object.assign({}, b);
	for (const m of parseMarks(tagged)) {
		if (m.end > pos) break;
		applySpecs(cur, m.specs, b);
	}
	cur.color = normColor(cur.color);
	return cur;
}

/// 本文の先頭 (= 基準マークまで適用した状態)。基準パネルが出す値。
export function styleAtHead(tagged, base) {
	const marks = parseMarks(tagged);
	const head = (marks.length && marks[0].start === 0) ? marks[0] : null;
	return styleAt(tagged, head ? head.end : 0, base);
}

/// 本文の先頭にあるマーク (= 基準を書き換えているマーク。無ければ null)
export function headMark(tagged) {
	const marks = parseMarks(tagged);
	return (marks.length && marks[0].start === 0) ? marks[0] : null;
}

//---------------------------------------------------------------------------
/// specs をタグ文字列へ戻す (並びは固定。reset が先頭)
export function formatMark(specs) {
	let o = '';
	if (specs.reset) o += '[reset]';
	if ('align' in specs) o += `[align=${ALIGN_NAMES[specs.align] || 'left'}]`;
	if ('font' in specs)  o += specs.font === null ? '[/font]' : `[font=${specs.font}]`;
	if ('size' in specs)  o += specs.size === null ? '[/size]' : `[size=${sizeText(specs.size)}]`;
	if ('color' in specs) o += specs.color === null ? '[/color]' : `[color=${specs.color}]`;
	for (const [a, on, off] of [['bold', '[b]', '[/b]'], ['italic', '[i]', '[/i]'],
	                            ['underline', '[u]', '[/u]']])
		if (a in specs) o += specs[a] ? on : off;
	return o;
}

/// マークが何も指定していない (= 消してよい) か
export function isEmptySpecs(specs) {
	return Object.keys(specs).length === 0;
}

//---------------------------------------------------------------------------
// 編集 — どれも {text, edits} を返す。edits は本文中の置換区間で、UI が
// カーソル位置を追従させるのに使う。
//---------------------------------------------------------------------------
function applyEdits(s, edits) {
	// 後ろから当てれば、前の編集で位置がずれない
	const list = edits.slice().sort((a, b) => (b.start - a.start) || (b.end - a.end));
	let out = s;
	for (const e of list) out = out.slice(0, e.start) + e.text + out.slice(e.end);
	return { text: out, edits };
}

/// 編集後の位置。bias='left' の挿入は「その位置の手前に入る」扱い。
export function shiftPos(pos, edits) {
	let p = pos;
	for (const e of edits) {
		const grow = e.text.length - (e.end - e.start);
		if (e.start === e.end && e.start === pos) {
			if (e.bias !== 'left') p += e.text.length;
		} else if (e.end <= pos) {
			p += grow;
		} else if (e.start < pos) {
			p = e.start + e.text.length;      // 編集区間の中にいた
		}
	}
	return p;
}

/// マークの指定を書き換える。changes の値が undefined ならその指定を消す。
/// mark が null なら pos に新しいマークを作る。
export function editMark(tagged, mark, changes) {
	const specs = Object.assign({}, mark ? mark.specs : {});
	for (const k of Object.keys(changes)) {
		if (changes[k] === undefined) delete specs[k];
		else specs[k] = changes[k];
	}
	const start = mark ? mark.start : 0;
	const end   = mark ? mark.end   : 0;
	return applyEdits(tagged, [{ start, end, text: formatMark(specs), bias: 'right' }]);
}

/// pos にマークを置く (すでにその位置に接しているマークがあれば混ぜる)
export function editAt(tagged, pos, changes) {
	const m = parseMarks(tagged).find(x => x.start === pos || x.end === pos) || null;
	if (m) return editMark(tagged, m, changes);
	return applyEdits(tagged,
		[{ start: pos, end: pos, text: formatMark(pickSpecs(changes)), bias: 'right' }]);
}

function pickSpecs(changes) {
	const o = {};
	for (const k of Object.keys(changes)) if (changes[k] !== undefined) o[k] = changes[k];
	return o;
}

/// マークを消す
export function removeMark(tagged, mark) {
	return applyEdits(tagged, [{ start: mark.start, end: mark.end, text: '' }]);
}

//---------------------------------------------------------------------------
/// 選択範囲 [s, e) に書式を付ける。
///
/// 閉じタグは使わない。範囲の終わりには「直後に効いていた書式へ戻すマーク」を
/// 置く。戻し先が基準と同じなら [/font] のような基準へ戻す形にしておく (後から
/// 基準を変えたときに一緒に付いてくるので、そのほうが意図に合う)。
export function editRange(tagged, s, e, changes, base) {
	const b = baseStyle(base);
	const attrs = Object.keys(changes).filter(k => changes[k] !== undefined);
	if (!attrs.length || s >= e) return { text: tagged, edits: [] };

	const after = styleAt(tagged, e, base);     // 範囲の直後に効いている書式
	const edits = [];

	const marks = parseMarks(tagged);
	// 範囲の頭にすでにマークがあるなら、そこへ混ぜる (同じ位置にタグを 2 つ
	// 並べても意味は同じだが、読みづらいだけなので)
	const atStart = marks.find(m => m.end === s && m.start < s) || null;

	// 範囲の中のマークから、これから指定する属性を取り除く (上書きされるので)
	for (const m of marks) {
		if (m.start < s || m.end > e) continue;
		const specs = Object.assign({}, m.specs);
		let touched = false;
		if (specs.reset) {
			// [reset] は範囲の中で書式を基準へ戻してしまう。指定する属性だけは
			// 生き残るように、他の属性への reset へ展開する。
			delete specs.reset;
			for (const a of VALUE_ATTRS) if (!attrs.includes(a)) specs[a] = null;
			for (const a of FLAG_ATTRS)  if (!attrs.includes(a)) specs[a] = b[a];
			touched = true;
		}
		for (const a of attrs) if (a in specs) { delete specs[a]; touched = true; }
		if (touched) edits.push({ start: m.start, end: m.end, text: formatMark(specs) });
	}

	// 範囲の頭 — ここから指定が効く
	if (atStart) {
		edits.push({ start: atStart.start, end: atStart.end,
		             text: formatMark(Object.assign({}, atStart.specs, pickSpecs(changes))) });
	} else {
		edits.push({ start: s, end: s, text: formatMark(pickSpecs(changes)), bias: 'right' });
	}

	// 範囲の終わり — 元の書式へ戻す (後ろに本文が無ければ要らない)
	if (hasTextAfter(tagged, e)) {
		// 直後のマークが自分で指定している属性は、戻しても上書きされるだけ
		const next = marks.find(m => m.start === e);
		const restore = {};
		for (const a of attrs) {
			if (next && a in next.specs) continue;
			const inside = (changes[a] === null) ? b[a] : changes[a];
			if (sameValue(a, inside, after[a])) continue;
			restore[a] = (VALUE_ATTRS.includes(a) && sameValue(a, after[a], b[a]))
				? null : after[a];
		}
		if (Object.keys(restore).length)
			edits.push({ start: e, end: e, text: formatMark(restore), bias: 'left' });
	}
	return applyEdits(tagged, edits);
}

export function sameValue(attr, a, x) {
	if (attr === 'size')  return Math.abs(Number(a) - Number(x)) < 0.01;
	if (attr === 'color') return normColor(a) === normColor(x);
	return a === x;
}

/// [s, e) にある本文の文字数 (タグは数えない)。
/// タグしか選ばれていない範囲に書式を付けても意味が無いので、その判定に使う。
export function textLengthIn(tagged, s, e) {
	const toks = scanTokens(tagged);
	let n = 0;
	// 範囲の端がタグの内側から始まっていても数え間違えないよう、位置ごとに
	// 「どれかのタグの中か」で判定する
	for (let i = Math.max(0, s); i < e && i < tagged.length;) {
		const tk = toks.find(x => i >= x.start && i < x.end);
		if (tk) { i = tk.end; continue; }
		if (tagged[i] === '[' && tagged[i + 1] === '[') { n++; i += 2; continue; }
		n++;
		i++;
	}
	return n;
}

/// pos より後ろに本文の文字があるか (マークだけなら false)
export function hasTextAfter(tagged, pos) {
	const marks = parseMarks(tagged);
	let i = pos;
	while (i < tagged.length) {
		const m = marks.find(x => x.start === i);
		if (!m) return true;
		i = m.end;
	}
	return false;
}

//---------------------------------------------------------------------------
/// pos がタグの内側なら外へ寄せる (dir<0 でタグの手前、dir>0 でタグの後ろ)。
/// 編集欄はタグを見せないので UI では使わないが、タグを直に扱う道具 (CSV の
/// 手直しなど) を足すときに要るので残してある。
export function snapOutOfTag(tagged, pos, dir) {
	for (const tk of scanTokens(tagged))
		if (pos > tk.start && pos < tk.end) return dir < 0 ? tk.start : tk.end;
	return pos;
}

/// pos に重なっているマーク (タグの内側 or 端)。編集対象を決めるのは
/// governingMark のほうで、こちらは位置の判定用。
export function markAtCaret(tagged, pos) {
	return parseMarks(tagged).find(m => pos >= m.start && pos <= m.end) || null;
}

//---------------------------------------------------------------------------
/// マークの中身を短い札にする。tr は i18n の引き当て関数。
/// 色は呼び出し側でスウォッチにするので、値も一緒に返す。
export function describeMark(specs, tr) {
	const parts = [];
	if (specs.reset) parts.push({ text: tr('fmt.chip.reset') });
	if ('align' in specs) parts.push({ text: tr('fmt.align.' + (specs.align ?? 0)) });
	if ('font' in specs)
		parts.push({ text: specs.font === null ? tr('fmt.chip.fontBase') : shortFont(specs.font) });
	if ('size' in specs)
		parts.push({ text: specs.size === null ? tr('fmt.chip.sizeBase') : sizeText(specs.size) + 'px' });
	if ('color' in specs)
		parts.push(specs.color === null ? { text: tr('fmt.chip.colorBase') }
		                                : { text: '', color: normColor(specs.color) });
	for (const [a, on, off] of [['bold', 'B', 'B'], ['italic', 'I', 'I'], ['underline', 'U', 'U']])
		if (a in specs) parts.push({ text: (specs[a] ? on : off), strike: !specs[a] });
	return parts;
}

/// "NotoSansJP-Bold" は札には長い。末尾のウェイトだけ残して詰める。
function shortFont(name) {
	const s = String(name);
	return s.length <= 16 ? s : s.slice(0, 15) + '…';
}
