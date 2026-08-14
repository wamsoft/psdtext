//---------------------------------------------------------------------------
// psdtext UI
//
//   左   : レイヤツリー (階層 + 個別の表示 ON/OFF、テキストレイヤの選択)
//   中央 : 表示 ON/OFF を反映した合成プレビュー
//   右   : 選択したテキストレイヤの編集 (書式はタグ表現)
//
// 表示 ON/OFF はプレビュー専用で、PSD には保存しない。
//---------------------------------------------------------------------------
import { app } from './lib/appserve.js';
import { composite, resetCache } from './composite.js';
import { parseTagged, drawText, fontAvailable } from './textrender.js';

const $ = (s) => document.querySelector(s);

const state = {
	info: { open: false },
	tree: [],
	texts: [],
	byIndex: new Map(),      // index -> tree node
	visible: new Map(),      // index -> bool (プレビュー専用の一時状態)
	collapsed: new Set(),    // 折り畳んだフォルダ
	selected: null,
	filter: '',
	zoom: 1,
	fitZoom: 1,
	renderText: true,
	showBounds: true,
	pendingCsv: null,
	needFit: false,       // 次の描画後に「全体表示」へ合わせる
	sysFonts: [],
	redrawTimer: 0,
};

//---------------------------------------------------------------------------
// 汎用
//---------------------------------------------------------------------------
let toastTimer = 0;
function toast(msg, isError) {
	const el = $('#toast');
	el.textContent = msg;
	el.classList.toggle('error', !!isError);
	el.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2500);
}

function setEditStatus(msg, cls) {
	const el = $('#editStatus');
	el.textContent = msg || '';
	el.className = 'status' + (cls ? ' ' + cls : '');
}

const textOf = (index) => state.texts.find(t => t.index === index) || null;
const nodeOf = (index) => state.byIndex.get(index) || null;

//---------------------------------------------------------------------------
// 文書の反映
//---------------------------------------------------------------------------
function applyDoc(res, { keepVisibility = false } = {}) {
	if (res.info) state.info = res.info;
	else if (typeof res.open === 'boolean') state.info = res;

	if (Array.isArray(res.tree)) {
		state.tree = res.tree;
		state.byIndex = new Map(state.tree.map(l => [l.index, l]));
		if (!keepVisibility) resetVisibility();
	}
	if (Array.isArray(res.texts)) state.texts = res.texts;

	resetCache(state.info.path || '');
	renderAll();
	scheduleRedraw();
}

/// PSD が持っている可視フラグを初期状態にする
function resetVisibility() {
	state.visible = new Map(state.tree.map(l => [l.index, l.visible !== false]));
}

function renderAll() {
	const info = state.info;
	$('#docPath').textContent = info.open ? info.path : '';
	$('#docPath').title = info.open ? info.path : '';
	document.title = info.open ? 'psdtext — ' + info.path.split('/').pop() : 'psdtext';

	const dirty = info.dirty || 0;
	const badge = $('#dirtyBadge');
	badge.hidden = !dirty;
	badge.textContent = '未保存 ' + dirty;

	for (const id of ['#saveBtn', '#exportBtn', '#importBtn']) $(id).disabled = !info.open;

	renderTree();
	renderEditor();
}

//---------------------------------------------------------------------------
// レイヤツリー
//---------------------------------------------------------------------------
const KIND_ICON = {
	folder: '📁', text: 'T', image: '🖼', adjust: '◐', fill: '■', divider: '·',
};

/// 祖先が畳まれているか
function hiddenByCollapse(node) {
	let p = node.parent;
	let guard = 0;
	while (p >= 0 && guard++ < 64) {
		if (state.collapsed.has(p)) return true;
		const pn = state.byIndex.get(p);
		p = pn ? pn.parent : -1;
	}
	return false;
}

function matchesFilter(node) {
	const f = state.filter.trim().toLowerCase();
	if (!f) return true;
	if (node.path.toLowerCase().includes(f)) return true;
	const t = textOf(node.index);
	return !!(t && (t.plain || '').toLowerCase().includes(f));
}

function renderTree() {
	const host = $('#tree');
	host.textContent = '';
	const dirtySet = new Set(state.texts.filter(t => t.dirty).map(t => t.index));
	const hasChild = new Set(state.tree.map(l => l.parent).filter(p => p >= 0));

	// PSD の layerList は下から上。Photoshop の表示に合わせて逆順にする。
	for (const l of [...state.tree].reverse()) {
		if (hiddenByCollapse(l)) continue;
		if (!matchesFilter(l)) continue;

		const row = document.createElement('div');
		row.className = 'tree-row' +
			(l.text ? ' is-text' : '') +
			(dirtySet.has(l.index) ? ' dirty' : '') +
			(state.selected === l.index ? ' sel' : '');
		row.style.paddingLeft = (l.depth * 14 + 4) + 'px';
		row.dataset.index = l.index;

		// 折り畳み
		const twist = document.createElement('span');
		twist.className = 'twist';
		if (hasChild.has(l.index)) {
			twist.textContent = state.collapsed.has(l.index) ? '▸' : '▾';
			twist.addEventListener('click', (e) => {
				e.stopPropagation();
				if (state.collapsed.has(l.index)) state.collapsed.delete(l.index);
				else state.collapsed.add(l.index);
				renderTree();
			});
		}

		// 表示 ON/OFF (フォルダは配下ごと効く)
		const eye = document.createElement('span');
		const on = state.visible.get(l.index) !== false;
		eye.className = 'eye' + (on ? '' : ' off');
		eye.textContent = on ? '👁' : '·';
		eye.title = l.kind === 'folder'
			? 'このフォルダ以下の表示を切り替え (プレビュー専用)'
			: '表示を切り替え (プレビュー専用)';
		eye.addEventListener('click', (e) => {
			e.stopPropagation();
			state.visible.set(l.index, !on);
			renderTree();
			scheduleRedraw();
		});

		const icon = document.createElement('span');
		icon.className = 'tree-icon';
		icon.textContent = KIND_ICON[l.kind] || '·';

		const name = document.createElement('span');
		name.className = 'tree-name';
		name.textContent = l.name;
		name.title = 'ダブルクリックで名前を変更';
		name.addEventListener('dblclick', (e) => {
			e.stopPropagation();
			beginRename(l.index, name);
		});

		row.append(twist, eye, icon, name);
		row.title = l.path;
		row.addEventListener('click', () => select(l.index));
		host.appendChild(row);
	}

	const sel = state.selected === null ? null : nodeOf(state.selected);
	$('#renameBtn').disabled = !sel;                 // 名前はどのレイヤでも変えられる
	$('#dupBtn').disabled = !(sel && sel.text);
	$('#addBtn').disabled = !(sel && sel.text);
}

//---------------------------------------------------------------------------
// 合成プレビュー
//---------------------------------------------------------------------------
function scheduleRedraw() {
	clearTimeout(state.redrawTimer);
	state.redrawTimer = setTimeout(redraw, 30);
}

/// 編集済みテキストを仮描画する差し込み口
function makeTextPainter() {
	if (!state.renderText) return null;
	return {
		// 仮描画するのは「変更されたテキストレイヤ」だけ。未編集のものは
		// PSD 内蔵のラスタのほうが正確なのでそちらを使う。
		wants: (layer) => {
			if (!layer.text) return false;
			const t = textOf(layer.index);
			return !!(t && t.dirty);
		},
		paint: (ctx, layer) => {
			const t = textOf(layer.index);
			if (!t) return;
			const base = {
				font: t.font, size: t.fontSize || 24,
				color: '#000000', bold: false, italic: false, underline: false,
				align: (t.paragraphJust && t.paragraphJust[0]) || 0,
			};
			drawText(ctx, layer.rect, parseTagged(t.text, base), base);
		},
	};
}

async function redraw() {
	const canvas = $('#stage');
	const ctx = canvas.getContext('2d');
	const w = state.info.width || 0;
	const h = state.info.height || 0;
	if (!w || !h) {
		canvas.width = canvas.height = 1;
		ctx.clearRect(0, 0, 1, 1);
		return;
	}
	if (canvas.width !== w || canvas.height !== h) {
		canvas.width = w;
		canvas.height = h;
	}

	$('#viewStatus').textContent = '合成中…';
	try {
		await composite(app, ctx, w, h, state.tree, state.visible,
		                { textPainter: makeTextPainter() });
		// 選択レイヤの枠
		if (state.showBounds && state.selected !== null) {
			const n = nodeOf(state.selected);
			if (n && n.rect) {
				ctx.save();
				ctx.strokeStyle = '#6cb6ff';
				ctx.lineWidth = Math.max(1, 2 / state.zoom);
				ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
				ctx.strokeRect(n.rect[0], n.rect[1],
				               n.rect[2] - n.rect[0], n.rect[3] - n.rect[1]);
				ctx.restore();
			}
		}
		const shown = state.tree.filter(l => l.hasPixels &&
			state.visible.get(l.index) !== false).length;
		$('#viewStatus').textContent = `${w}×${h} / 表示 ${shown} レイヤ`;
	} catch (e) {
		$('#viewStatus').textContent = '合成に失敗: ' + e.message;
	}
	// 起動直後は右ペインや canvas のサイズが確定していないので、描画を終えて
	// レイアウトが落ち着いてから「全体表示」を計算する。
	if (state.needFit) {
		state.needFit = false;
		requestAnimationFrame(() => requestAnimationFrame(fitZoom));
	} else {
		applyZoom();
	}
}

/// 表示スケール (システムの拡大率 + ブラウザのズーム)
function dpr() { return window.devicePixelRatio || 1; }

// zoom は「画像 1px = 何デバイス px か」。canvas の backing は画像サイズその
// ままなので、CSS サイズを backing*zoom/dpr にすることで 100% が実ドット等倍
// (1 画像 px = 1 デバイス px) になる。こうしないと 200% 表示の環境で 100% が
// 倍ドットになり、原寸確認にならない。
function applyZoom() {
	const canvas = $('#stage');
	const d = dpr();
	canvas.style.width = (canvas.width * state.zoom / d) + 'px';
	canvas.style.height = (canvas.height * state.zoom / d) + 'px';
	$('#zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
	$('#zoomLevel').title = d !== 1
		? `クリックで等倍 (表示スケール ${Math.round(d * 100)}% を補正済み)`
		: 'クリックで等倍';
}

function fitZoom() {
	const wrap = $('#canvasWrap');
	const w = state.info.width || 0, h = state.info.height || 0;
	if (!w || !h || wrap.clientWidth <= 0) return;   // まだ測れない
	// clientWidth は CSS px、zoom はデバイス px 基準なので dpr を掛けて揃える。
	// 既定では拡大しない (1 を上限) ので、小さい PSD は等倍で出る。
	const d = dpr();
	const z = Math.min((wrap.clientWidth - 24) * d / w,
	                   (wrap.clientHeight - 24) * d / h, 1);
	state.fitZoom = Math.min(8, Math.max(0.02, z));
	state.zoom = state.fitZoom;
	applyZoom();
}

//---------------------------------------------------------------------------
// 編集ペイン
//---------------------------------------------------------------------------
function select(index) {
	state.selected = index;
	renderTree();
	renderEditor();
	scheduleRedraw();
}

function renderEditor() {
	const node = state.selected === null ? null : nodeOf(state.selected);
	const t = state.selected === null ? null : textOf(state.selected);
	const ta = $('#editText');
	const meta = $('#editMeta');
	meta.textContent = '';

	const styleEls = ['#fontSel', '#sizeInput', '#fontAddBtn', '#boldBtn',
	                  '#italicBtn', '#underBtn'];
	for (const s of styleEls) $(s).disabled = !t;
	document.querySelectorAll('.align').forEach(b => { b.disabled = !t; });

	if (!t) {
		ta.value = '';
		ta.disabled = true;
		ta.dataset.index = '';
		$('#applyBtn').disabled = true;
		$('#revertBtn').disabled = true;
		setEditStatus(node ? `${node.kind} レイヤ (テキストではありません)` : '');
		return;
	}

	const rows = [
		['レイヤ', t.path],
		['lyid', String(t.lyid || '(なし)')],
		['位置', `${t.rect[0]}, ${t.rect[1]} — ${t.rect[2] - t.rect[0]}×${t.rect[3] - t.rect[1]}`],
	];
	for (const [k, v] of rows) {
		const d = document.createElement('div');
		const ks = document.createElement('span'); ks.className = 'k'; ks.textContent = k;
		const vs = document.createElement('span'); vs.className = 'v'; vs.textContent = v;
		d.append(ks, vs);
		meta.appendChild(d);
	}

	// フォント候補 = この PSD が持っているもの + 追加したもの
	const sel = $('#fontSel');
	sel.textContent = '';
	const seen = new Set();
	for (const f of (t.fonts || [])) {
		if (seen.has(f)) continue;
		seen.add(f);
		const o = document.createElement('option');
		o.value = f;
		o.textContent = f + (fontAvailable(f) ? '' : '  (この PC に無し)');
		sel.appendChild(o);
	}
	sel.value = t.font || '';
	$('#sizeInput').value = t.fontSize ? Math.round(t.fontSize * 10) / 10 : '';

	const curAlign = (t.paragraphJust && t.paragraphJust[0]) || 0;
	document.querySelectorAll('.align').forEach(b => {
		b.classList.toggle('on', Number(b.dataset.align) === curAlign);
	});

	if (ta.dataset.index !== String(t.index)) {
		ta.value = t.text;
		ta.dataset.index = String(t.index);
	}
	ta.disabled = false;
	$('#applyBtn').disabled = (ta.value === t.text);
	$('#revertBtn').disabled = !t.dirty;

	let hint = t.styled ? '書式タグを含みます。' : '';
	if (t.font && !fontAvailable(t.font)) hint += '仮描画のフォントは代替表示です。';
	setEditStatus(t.dirty ? '未保存の変更あり' + (hint ? ' / ' + hint : '') : hint,
	              t.dirty ? 'ok' : '');
}

//---------------------------------------------------------------------------
// 編集操作
//---------------------------------------------------------------------------
async function applyText() {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	try {
		const r = await app.post('/api/psd/text',
		                         { index: t.index, text: $('#editText').value });
		Object.assign(t, r);
		state.info.dirty = state.texts.filter(x => x.dirty).length;
		renderAll();
		scheduleRedraw();
		setEditStatus(r.warning ? r.warning : '反映しました', r.warning ? 'error' : 'ok');
	} catch (e) {
		setEditStatus(e.message, 'error');
	}
}

async function revertText() {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	try {
		const r = await app.post('/api/psd/revert', { index: t.index });
		Object.assign(t, r);
		$('#editText').dataset.index = '';
		state.info.dirty = state.texts.filter(x => x.dirty).length;
		renderAll();
		scheduleRedraw();
	} catch (e) {
		setEditStatus(e.message, 'error');
	}
}

/// 文字列中のタグ [..] の範囲を列挙する ([[ は文字なので除く)
function tagRanges(v) {
	const out = [];
	for (let i = 0; i < v.length;) {
		if (v[i] !== '[') { i++; continue; }
		if (v[i + 1] === '[') { i += 2; continue; }
		const close = v.indexOf(']', i + 1);
		if (close < 0) break;
		out.push([i, close + 1]);
		i = close + 1;
	}
	return out;
}

/// 位置がタグの内側なら外へ寄せる (dir<0 でタグ先頭、dir>0 でタグ末尾へ)
function snapOutOfTag(v, pos, dir) {
	for (const [a, b] of tagRanges(v)) {
		if (pos > a && pos < b) return dir < 0 ? a : b;
	}
	return pos;
}

/// 編集欄の選択範囲をタグで囲む (閉じなし方式なので「入れる/戻す」の 2 つ)
function wrapSelection(openTag, closeTag) {
	const ta = $('#editText');
	const v = ta.value;
	// タグの途中で切ると [b][ali[/b]gn=right] のような壊れ方をするので、
	// 選択がタグの内側に食い込んでいたら外側へ吸着させる
	const s = snapOutOfTag(v, ta.selectionStart, -1);
	const e = snapOutOfTag(v, ta.selectionEnd, +1);
	if (s === e) {
		// 選択が無ければカーソル位置に指定タグだけ入れる (そこから先に効く)
		ta.value = v.slice(0, s) + openTag + v.slice(s);
		ta.selectionStart = ta.selectionEnd = s + openTag.length;
	} else {
		ta.value = v.slice(0, s) + openTag + v.slice(s, e) + closeTag + v.slice(e);
		ta.selectionStart = s + openTag.length;
		ta.selectionEnd = e + openTag.length;
	}
	ta.focus();
	ta.dispatchEvent(new Event('input', { bubbles: true }));
}

async function setAlign(align) {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	try {
		const r = await app.post('/api/psd/align', { index: t.index, align });
		Object.assign(t, r);
		$('#editText').dataset.index = '';   // タグ表現が変わるので入れ直す
		state.info.dirty = state.texts.filter(x => x.dirty).length;
		renderAll();
		scheduleRedraw();
	} catch (e) {
		toast(e.message, true);
	}
}

/// ツリー上でレイヤ名をその場編集する。Enter で確定、Escape で取り消し。
function beginRename(index, span) {
	if (span.dataset.editing) return;
	const node = nodeOf(index);
	if (!node) return;

	span.dataset.editing = '1';
	const input = document.createElement('input');
	input.className = 'rename-input';
	input.value = node.name;
	span.textContent = '';
	span.appendChild(input);
	input.focus();
	input.select();

	let done = false;
	const finish = async (commit) => {
		if (done) return;
		done = true;
		const value = input.value.trim();
		delete span.dataset.editing;
		if (!commit || !value || value === node.name) {
			renderTree();          // 元の表示へ戻す
			return;
		}
		try {
			const r = await app.post('/api/psd/name', { index, name: value });
			applyDoc(r, { keepVisibility: true });
			toast(`レイヤ名を「${value}」に変更しました`);
		} catch (e) {
			toast(e.message, true);
			renderTree();
		}
	};

	input.addEventListener('click', (e) => e.stopPropagation());
	input.addEventListener('keydown', (e) => {
		e.stopPropagation();
		if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
		if (e.key === 'Escape') { e.preventDefault(); finish(false); }
	});
	input.addEventListener('blur', () => finish(true));
}

/// 選択中のレイヤの名前編集を開始する (ボタン / F2 から)
function renameSelected() {
	if (state.selected === null) return;
	const row = document.querySelector(`.tree-row[data-index="${state.selected}"]`);
	const span = row && row.querySelector('.tree-name');
	if (span) {
		row.scrollIntoView({ block: 'nearest' });
		beginRename(state.selected, span);
	}
}

async function duplicateLayer(asNew) {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	const body = { index: t.index };
	if (asNew) {
		const name = prompt('新しいレイヤ名', t.name + ' のコピー');
		if (name === null) return;
		body.name = name;
		body.text = 'テキスト';
	} else {
		body.name = t.name + ' のコピー';
	}
	try {
		const r = await app.post('/api/psd/duplicate', body);
		applyDoc(r, { keepVisibility: true });
		// 新しく出来たレイヤも表示 ON にしておく
		if (typeof r.index === 'number') {
			state.visible.set(r.index, true);
			select(r.index);
		}
		toast(asNew ? 'テキストレイヤを追加しました' : 'レイヤを複製しました');
	} catch (e) {
		toast(e.message, true);
	}
}

//---------------------------------------------------------------------------
// フォント追加
//---------------------------------------------------------------------------
async function openFontDialog() {
	$('#fontDialog').hidden = false;
	$('#fontManual').value = '';
	if (!state.sysFonts.length) {
		try {
			// Local Font Access API (Chromium)。使えなければ手入力に頼る。
			if (window.queryLocalFonts) {
				const list = await window.queryLocalFonts();
				const names = new Set();
				for (const f of list) names.add(f.postscriptName || f.fullName);
				state.sysFonts = [...names].sort();
			}
		} catch (e) { /* 権限拒否など。手入力へ */ }
	}
	renderSysFonts();
}

function renderSysFonts() {
	const host = $('#sysFontList');
	host.textContent = '';
	if (!state.sysFonts.length) {
		const p = document.createElement('p');
		p.className = 'hint';
		p.textContent = 'システムフォントの一覧を取得できませんでした。'
			+ '下の欄に PostScript 名を直接入力してください。';
		host.appendChild(p);
		return;
	}
	const f = $('#fontFilter').value.trim().toLowerCase();
	const shown = state.sysFonts.filter(n => !f || n.toLowerCase().includes(f));
	for (const n of shown.slice(0, 400)) {
		const row = document.createElement('div');
		row.className = 'fs-row';
		row.textContent = n;
		row.style.fontFamily = `"${n}", sans-serif`;
		row.addEventListener('click', () => addFont(n));
		host.appendChild(row);
	}
}

function addFont(name) {
	if (!name) return;
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	if (!t.fonts.includes(name)) t.fonts.push(name);
	$('#fontDialog').hidden = true;
	renderEditor();
	$('#fontSel').value = name;
	// 選択範囲にフォント指定を入れる
	wrapSelection(`[font=${name}]`, '[/font]');
	toast(`フォント「${name}」を候補に追加しました`);
}

//---------------------------------------------------------------------------
// ファイルを開く
//---------------------------------------------------------------------------
async function browseTo(path) {
	try {
		const r = await app.get('/api/fs/list', { path });
		$('#openPath').value = r.path + '/';

		const crumbs = $('#fsCrumbs');
		crumbs.textContent = '';
		const parts = r.path.split('/').filter(Boolean);
		let acc = r.path.startsWith('/') ? '' : null;
		parts.forEach((p, i) => {
			if (i > 0) crumbs.appendChild(document.createTextNode('/'));
			acc = (acc === null) ? p + '/' : acc + '/' + p;
			const target = acc;
			const a = document.createElement('a');
			a.href = '#';
			a.textContent = p;
			a.addEventListener('click', ev => { ev.preventDefault(); browseTo(target); });
			crumbs.appendChild(a);
		});

		const list = $('#fsList');
		list.textContent = '';
		if (r.parent) {
			const up = document.createElement('div');
			up.className = 'fs-row dir';
			up.textContent = '📁 ..';
			up.addEventListener('click', () => browseTo(r.parent));
			list.appendChild(up);
		}
		const entries = (r.entries || [])
			.filter(e => e.dir || /\.psd$/i.test(e.name))
			.sort((a, b) => (a.dir !== b.dir) ? (a.dir ? -1 : 1)
				: a.name.localeCompare(b.name, 'ja', { numeric: true }));
		for (const e of entries) {
			const row = document.createElement('div');
			row.className = 'fs-row' + (e.dir ? ' dir' : ' psd');
			row.textContent = (e.dir ? '📁 ' : '🎨 ') + e.name;
			row.addEventListener('click', () => e.dir ? browseTo(e.path) : openPsd(e.path));
			list.appendChild(row);
		}
	} catch (e) {
		toast(e.message, true);
	}
}

async function openPsd(path) {
	try {
		const res = await app.post('/api/psd/open', { path });
		$('#openDialog').hidden = true;
		state.selected = null;
		state.collapsed.clear();
		$('#editText').dataset.index = '';
		state.needFit = true;
		applyDoc(res);
		const first = state.texts[0];
		if (first) select(first.index);
		toast(`${state.texts.length} 個のテキストレイヤを読み込みました`);
	} catch (e) {
		toast(e.message, true);
	}
}

//---------------------------------------------------------------------------
// CSV
//---------------------------------------------------------------------------
function renderReport(r) {
	const host = $('#csvReport');
	host.textContent = '';

	const sum = document.createElement('div');
	sum.className = 'summary';
	sum.textContent = r.applied
		? `反映: 変更 ${r.changed} / 同一 ${r.same} / 未解決 ${r.notfound} / 失敗 ${r.failed}`
		: `確認: 変更予定 ${r.changed} / 同一 ${r.same} / 未解決 ${r.notfound}`;
	host.appendChild(sum);

	const shown = (r.rows || []).filter(x => x.status !== 'same');
	if (!shown.length) {
		const p = document.createElement('p');
		p.className = 'hint';
		p.textContent = '差分はありません。';
		host.appendChild(p);
		return;
	}
	const table = document.createElement('table');
	table.innerHTML = '<tr><th>状態</th><th>lyid</th><th>レイヤ</th><th>備考</th></tr>';
	for (const row of shown.slice(0, 300)) {
		const tr = document.createElement('tr');
		const st = document.createElement('td');
		st.className = row.status;
		st.textContent = { changed: '変更', notfound: '未解決', error: '失敗' }[row.status] || row.status;
		const id = document.createElement('td'); id.textContent = row.lyid || '';
		const pa = document.createElement('td'); pa.textContent = row.path || '';
		const ms = document.createElement('td'); ms.textContent = row.message || '';
		tr.append(st, id, pa, ms);
		table.appendChild(tr);
	}
	host.appendChild(table);
}

async function importCsv(apply) {
	const file = $('#csvFile').files[0];
	if (!file && !state.pendingCsv) { toast('CSV ファイルを選んでください', true); return; }
	const text = file ? await file.text() : state.pendingCsv;
	try {
		const r = await app.post('/api/psd/import', { csv: text, apply });
		renderReport(r);
		if (apply) {
			applyDoc(r, { keepVisibility: true });
			$('#editText').dataset.index = '';
			state.pendingCsv = null;
			$('#csvApply').disabled = true;
			toast(`${r.changed} 件のテキストを更新しました`);
		} else {
			state.pendingCsv = text;
			$('#csvApply').disabled = (r.changed === 0);
		}
	} catch (e) {
		toast(e.message, true);
	}
}

//---------------------------------------------------------------------------
async function save() {
	try {
		const r = await app.post('/api/psd/save', {
			path: $('#savePath').value.trim(),
			backup: $('#saveBackup').checked,
		});
		$('#saveDialog').hidden = true;
		$('#editText').dataset.index = '';
		applyDoc(r, { keepVisibility: true });
		toast('保存しました: ' + r.path);
	} catch (e) {
		toast(e.message, true);
	}
}

//---------------------------------------------------------------------------
// REPL からの操作口
//---------------------------------------------------------------------------
function setupReplBridge() {
	app.command('open',   (a) => openPsd(typeof a === 'string' ? a : a.path));
	app.command('select', (a) => { select(typeof a === 'number' ? a : a.index); return state.selected; });
	app.command('texts',  () => state.texts.map(t => ({ index: t.index, path: t.path, text: t.text, dirty: t.dirty })));
	app.command('layers', () => state.tree.map(l => ({
		index: l.index, path: l.path, kind: l.kind,
		visible: state.visible.get(l.index) !== false,
	})));
	app.command('show',   (a) => { state.visible.set(a.index ?? a, true);  renderTree(); scheduleRedraw(); });
	app.command('hide',   (a) => { state.visible.set(a.index ?? a, false); renderTree(); scheduleRedraw(); });
	app.command('apply',  () => applyText());
	app.command('save',   () => save());
	app.command('align',  (a) => setAlign(typeof a === 'number' ? a : a.align));
	app.command('rename', async (a) => {
		const index = (a.index !== undefined) ? a.index : state.selected;
		const r = await app.post('/api/psd/name', { index, name: a.name ?? String(a) });
		applyDoc(r, { keepVisibility: true });
		return nodeOf(index) ? nodeOf(index).name : null;
	});
	app.command('filter', (a) => { state.filter = String(a ?? ''); $('#filter').value = state.filter; renderTree(); });

	app.exposeState(() => ({
		path: state.info.path || null,
		layers: state.tree.length,
		texts: state.texts.length,
		dirty: state.info.dirty || 0,
		selected: state.selected,
		selectedText: state.selected !== null ? (textOf(state.selected) || {}).text : null,
		hidden: [...state.visible].filter(([, v]) => !v).map(([k]) => k),
		zoom: state.zoom,
		devicePixelRatio: dpr(),
	}));
}

//---------------------------------------------------------------------------
// 起動
//---------------------------------------------------------------------------
async function main() {
	await app.ready();
	setupReplBridge();

	app.on('psd', (info) => {
		state.info = info;
		if (info.open) refreshAll();
		else renderAll();
	});
	app.on('log', (e) => {
		const line = document.createElement('div');
		line.className = e.level || 'info';
		line.textContent = e.text;
		const body = $('#logBody');
		body.appendChild(line);
		while (body.childElementCount > 400) body.removeChild(body.firstChild);
		body.scrollTop = body.scrollHeight;
	});

	// --- ツールバー ---
	$('#openBtn').addEventListener('click', async () => {
		$('#openDialog').hidden = false;
		const roots = await app.get('/api/fs/roots');
		const cwd = (roots.roots || []).find(r => r.kind === 'cwd');
		if (!$('#fsList').childElementCount) browseTo(cwd ? cwd.path : '.');
	});
	$('#openGo').addEventListener('click', () => {
		const p = $('#openPath').value.trim();
		if (/\.psd$/i.test(p)) openPsd(p); else browseTo(p);
	});
	$('#openPath').addEventListener('keydown', e => { if (e.key === 'Enter') $('#openGo').click(); });

	$('#exportBtn').addEventListener('click', () => {
		window.location.href = app._url('/api/psd/export', { t: app.token });
	});
	$('#importBtn').addEventListener('click', () => {
		state.pendingCsv = null;
		$('#csvApply').disabled = true;
		$('#csvReport').textContent = '';
		$('#importDialog').hidden = false;
	});
	$('#csvDry').addEventListener('click', () => importCsv(false));
	$('#csvApply').addEventListener('click', () => importCsv(true));
	$('#csvFile').addEventListener('change', () => {
		state.pendingCsv = null;
		$('#csvApply').disabled = true;
		importCsv(false);
	});

	$('#saveBtn').addEventListener('click', () => {
		$('#savePath').value = '';
		$('#saveDialog').hidden = false;
	});
	$('#saveGo').addEventListener('click', save);

	$('#logBtn').addEventListener('click', () => { $('#logPanel').hidden = !$('#logPanel').hidden; });
	$('#logClose').addEventListener('click', () => { $('#logPanel').hidden = true; });

	document.querySelectorAll('[data-close]').forEach(b =>
		b.addEventListener('click', e => { e.target.closest('.modal').hidden = true; }));
	document.querySelectorAll('.modal').forEach(m =>
		m.addEventListener('click', e => { if (e.target === m) m.hidden = true; }));

	// --- 左ペイン ---
	$('#filter').addEventListener('input', e => { state.filter = e.target.value; renderTree(); });
	$('#showAllBtn').addEventListener('click', () => {
		state.tree.forEach(l => state.visible.set(l.index, true));
		renderTree();
		scheduleRedraw();
	});
	$('#textOnlyBtn').addEventListener('click', () => {
		// テキストレイヤと、その祖先フォルダだけ ON
		const keep = new Set();
		for (const l of state.tree) {
			if (!l.text) continue;
			keep.add(l.index);
			let p = l.parent, guard = 0;
			while (p >= 0 && guard++ < 64) {
				keep.add(p);
				const pn = state.byIndex.get(p);
				p = pn ? pn.parent : -1;
			}
		}
		state.tree.forEach(l => state.visible.set(l.index, keep.has(l.index)));
		renderTree();
		scheduleRedraw();
	});
	$('#resetVisBtn').addEventListener('click', () => {
		resetVisibility();
		renderTree();
		scheduleRedraw();
	});
	$('#renameBtn').addEventListener('click', renameSelected);
	$('#dupBtn').addEventListener('click', () => duplicateLayer(false));
	$('#addBtn').addEventListener('click', () => duplicateLayer(true));

	// --- 中央ペイン ---
	$('#zoomIn').addEventListener('click', () => { state.zoom = Math.min(8, state.zoom * 1.25); applyZoom(); });
	$('#zoomOut').addEventListener('click', () => { state.zoom = Math.max(0.02, state.zoom / 1.25); applyZoom(); });
	$('#zoomLevel').addEventListener('click', () => { state.zoom = 1; applyZoom(); });
	$('#zoomFit').addEventListener('click', fitZoom);
	$('#renderText').addEventListener('change', e => {
		state.renderText = e.target.checked;
		scheduleRedraw();
	});
	$('#showBounds').addEventListener('change', e => {
		state.showBounds = e.target.checked;
		scheduleRedraw();
	});
	window.addEventListener('resize', () => { if (state.zoom === state.fitZoom) fitZoom(); });
	// 別 DPI のモニタへ移動したりブラウザのズームが変わったら CSS サイズを取り直す
	if (window.matchMedia) {
		const watch = () => {
			applyZoom();
			matchMedia(`(resolution: ${dpr()}dppx)`)
				.addEventListener('change', watch, { once: true });
		};
		watch();
	}

	// --- 右ペイン ---
	$('#editText').addEventListener('input', () => {
		const t = state.selected === null ? null : textOf(state.selected);
		$('#applyBtn').disabled = !t || ($('#editText').value === t.text);
	});
	$('#editText').addEventListener('keydown', e => {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyText(); }
	});
	$('#applyBtn').addEventListener('click', applyText);
	$('#revertBtn').addEventListener('click', revertText);

	$('#boldBtn').addEventListener('click',   () => wrapSelection('[b]', '[/b]'));
	$('#italicBtn').addEventListener('click', () => wrapSelection('[i]', '[/i]'));
	$('#underBtn').addEventListener('click',  () => wrapSelection('[u]', '[/u]'));
	$('#fontSel').addEventListener('change', e => {
		wrapSelection(`[font=${e.target.value}]`, '[/font]');
	});
	$('#sizeInput').addEventListener('change', e => {
		const v = parseFloat(e.target.value);
		if (v > 0) wrapSelection(`[size=${v}]`, '[/size]');
	});
	$('#fontAddBtn').addEventListener('click', openFontDialog);
	$('#fontFilter').addEventListener('input', renderSysFonts);
	$('#fontAddGo').addEventListener('click', () => addFont($('#fontManual').value.trim()));
	document.querySelectorAll('.align').forEach(b =>
		b.addEventListener('click', () => setAlign(Number(b.dataset.align))));

	document.addEventListener('keydown', e => {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#saveBtn').click(); }
		if (e.key === 'F2' && document.activeElement !== $('#editText')) {
			e.preventDefault();
			renameSelected();
		}
		if (e.key === 'Escape') document.querySelectorAll('.modal:not([hidden])')
			.forEach(m => { m.hidden = true; });
	});

	// --- 起動時に開くファイル ---
	const startup = await app.get('/api/app/startup').catch(() => null);
	if (startup && startup.open) await openPsd(startup.open);
	else renderAll();
}

async function refreshAll() {
	try {
		const [texts, tree] = await Promise.all([
			app.get('/api/psd/texts'), app.get('/api/psd/tree'),
		]);
		applyDoc({ info: state.info, texts, tree }, { keepVisibility: true });
		$('#editText').dataset.index = '';
	} catch (e) { /* 文書が閉じられた等 */ }
}

main().catch(e => {
	toast('起動に失敗しました: ' + e.message, true);
	console.error(e);
});
