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
import * as tg from './tags.js';
import * as be from './bodyedit.js';
// ローカル変数 t (テキストレイヤ) と衝突するので tr という別名で受ける
import { t as tr, initLang, setLang, currentLang, applyI18n, serverMessage } from './i18n.js';

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
	sysFonts: [],         // この PC のフォント {postscript, family, localName, style}
	fontByPs: new Map(),  // PostScript 名 → 上の項目
	redrawTimer: 0,
	// 書式パネルが今どこを編集しているか
	//   {kind:'base'}              レイヤ全体の初期書式 (先頭のマーク)
	//   {kind:'mark', pos}         本文中のマーク (pos = マークの先頭位置)
	//   {kind:'new',  pos}         これから置くマーク (まだ本文には入っていない)
	//   {kind:'range', s, e}       選択範囲 (頭に指定 + 終わりに戻すマークを置く)
	fmtSel: { kind: 'base' },
	fmtSetAttrs: new Set(),  // 「指定する」に切り替えたが、まだ値を選んでいない属性
	fontTarget: 'base',   // フォント選択ダイアログの適用先
	applying: 0,          // 反映の往復が何本走っているか
	refreshPending: false,
	serverGone: false,    // サーバが終了した (画面は用済み)
	csvPath: '',          // 最後に書き出した CSV (読み込みの既定にする)
	settings: {},         // 画面をまたいで残す設定 (前回のフォルダなど)
	listFilter: { text: false, dirty: false, visible: false },  // 一覧に出す対象
	multi: new Set(),     // 選択中のレイヤ (1 枚のときは selected と同じ)
	copiedStyle: null,    // 「書式をコピー」で控えた初期書式
	multiStatus: null,    // 一括操作の結果表示
	exportSel: false,     // 書き出しダイアログを「選択ぶんだけ」で開く
	sheet: null,          // 一覧編集の行データ {rows, orig}
	headTag: '',          // 本文の先頭にある基準への指定 (編集欄には出さない)
	composing: false,     // IME 変換中
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
	badge.textContent = tr('app.unsaved') + ' ' + dirty;

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

/// 一覧に出すかどうか。表示 ON/OFF (プレビュー用) とは別で、
/// 「今いじりたいレイヤだけ並べる」ための絞り込み。
function passesListFilter(node) {
	const f = state.listFilter;
	if (f.text && !node.text) return false;
	if (f.dirty) {
		const t = textOf(node.index);
		if (!t || !t.dirty) return false;
	}
	if (f.visible && state.visible.get(node.index) === false) return false;
	return true;
}

/// フィルタが効いているとき、フォルダは中身が残っている場合だけ出す
/// (空のフォルダだけが並ぶと読みづらい)
function folderHasVisibleChild(index) {
	for (const l of state.tree) {
		if (l.kind === 'divider') continue;
		let p = l.parent, guard = 0;
		while (p >= 0 && guard++ < 64) {
			if (p === index) {
				if (l.kind !== 'folder' && matchesFilter(l) && passesListFilter(l)) return true;
				break;
			}
			const pn = state.byIndex.get(p);
			p = pn ? pn.parent : -1;
		}
	}
	return false;
}

function listFilterOn() {
	const f = state.listFilter;
	return !!(f.text || f.dirty || f.visible || state.filter.trim());
}

function renderTree() {
	const host = $('#tree');
	host.textContent = '';
	const dirtySet = new Set(state.texts.filter(t => t.dirty).map(t => t.index));
	const hasChild = new Set(state.tree.map(l => l.parent).filter(p => p >= 0));

	// PSD の layerList は下から上。Photoshop の表示に合わせて逆順にする。
	for (const l of [...state.tree].reverse()) {
		if (l.kind === 'divider') continue;   // フォルダの区切りは内部表現なので出さない
		if (hiddenByCollapse(l)) continue;
		if (l.kind === 'folder') {
			// フォルダは、中に出すものが残っているときだけ
			if (listFilterOn() && !folderHasVisibleChild(l.index)) continue;
		} else {
			if (!matchesFilter(l)) continue;
			if (!passesListFilter(l)) continue;
		}

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
		eye.title = tr(l.kind === 'folder' ? 'tree.eye.folder' : 'tree.eye.layer');
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
		name.title = tr('tree.rename.hint');
		name.addEventListener('dblclick', (e) => {
			e.stopPropagation();
			beginRename(l.index, name);
		});

		row.append(twist, eye, icon, name);
		row.title = l.path;
		if (state.multi.has(l.index) && state.multi.size > 1) row.classList.add('multi');
		row.addEventListener('click', (e) => clickLayer(l.index, e));
		host.appendChild(row);
	}

	const sel = state.selected === null ? null : nodeOf(state.selected);
	const multi = selectedTextLayers();
	$('#renameBtn').disabled   = !sel;                 // 名前はどのレイヤでも変えられる
	$('#dupBtn').disabled      = !multi.length;        // 複製はテキストレイヤのみ
	$('#moveUpBtn').disabled   = !sel;
	$('#moveDownBtn').disabled = !sel;
}

//---------------------------------------------------------------------------
// 複数選択
//
// 1 枚だけ選んでいるときは今までどおりの編集画面。複数のときは右ペインが
// 「N 枚まとめて」の操作に切り替わる (言語違いの一括処理のため)。
//---------------------------------------------------------------------------

/// 選択のうちテキストレイヤ (一括操作の対象)
function selectedTextLayers() {
	return [...state.multi].map(i => textOf(i)).filter(Boolean);
}

/// ツリーの行をクリックしたとき。
///   そのまま  : 1 枚だけ選ぶ
///   Ctrl      : 足す / 外す
///   Shift     : 直前に選んだ行からの範囲 (画面に並んでいる順)
function clickLayer(index, e) {
	if (e && (e.ctrlKey || e.metaKey)) {
		if (state.multi.has(index) && state.multi.size > 1) {
			state.multi.delete(index);
			if (state.selected === index) state.selected = [...state.multi][0];
		} else {
			state.multi.add(index);
			state.selected = index;
		}
		renderAll();
		scheduleRedraw();
		return;
	}
	if (e && e.shiftKey && state.selected !== null) {
		const order = listedLayers().map(l => l.index);
		const a = order.indexOf(state.selected);
		const b = order.indexOf(index);
		if (a >= 0 && b >= 0) {
			const [s, t] = a <= b ? [a, b] : [b, a];
			state.multi = new Set(order.slice(s, t + 1));
			state.selected = index;
			renderAll();
			scheduleRedraw();
			return;
		}
	}
	select(index);
}

/// 一括操作の結果表示。更新通知で描き直されても消えないよう state で持つ。
function setMultiStatus(msg, cls) {
	state.multiStatus = msg ? { msg, cls } : null;
	const el = $('#multiStatus');
	el.textContent = msg || '';
	el.className = 'status' + (cls ? ' ' + cls : '');
}

function renderMultiPane() {
	const rows = [...state.multi].map(i => nodeOf(i)).filter(Boolean);
	const texts = selectedTextLayers();
	$('#multiCount').textContent = tr('multi.count', rows.length, texts.length);

	const host = $('#multiList');
	host.textContent = '';
	for (const n of rows) {
		const d = document.createElement('div');
		d.className = 'multi-row' + (n.text ? '' : ' dim');
		const k = document.createElement('span');
		k.className = 'multi-kind';
		k.textContent = n.text ? 'T' : (KIND_ICON[n.kind] || '·');
		const nm = document.createElement('span');
		nm.textContent = n.name;
		d.append(k, nm);
		d.title = n.path;
		host.appendChild(d);
	}

	// 書式の一括操作はテキストレイヤが対象。1 枚も無ければ触れないようにする。
	const noText = texts.length === 0;
	for (const id of ['#mFontBtn', '#mSizeGo', '#mColorGo', '#mBold', '#mItalic',
	                  '#mUnder', '#mCopyStyle', '#mDup', '#mExport'])
		$(id).disabled = noText;
	document.querySelectorAll('.malign').forEach(b => { b.disabled = noText; });
	$('#mPasteStyle').disabled = noText || !state.copiedStyle;

	// 選択の代表 (最後に触った 1 枚) の値を初期値として出しておく
	const head = textOf(state.selected) || texts[0];
	if (head) {
		const st = tg.styleAtHead(head.text, baseOf(head));
		$('#mSize').value = st.size ? Math.round(st.size * 10) / 10 : '';
		$('#mColor').value = tg.normColor(st.color).toLowerCase();
	}
	const s = state.multiStatus;
	$('#multiStatus').textContent = s ? s.msg : '';
	$('#multiStatus').className = 'status' + (s && s.cls ? ' ' + s.cls : '');
}

//---------------------------------------------------------------------------
/// 選択レイヤの初期書式をまとめて変える。
/// 途中の書式マークには触らないので、「指定していないところだけ」が変わる。
async function applyStyleToSelection(changes) {
	const texts = selectedTextLayers();
	if (!texts.length) return;

	setMultiStatus(tr('multi.working'));
	let n = 0, failed = 0;
	for (const t of texts) {
		const b = tg.baseStyle(baseOf(t));
		const patch = {};
		for (const k of Object.keys(changes)) {
			// 読み込み時の値と同じなら指定を消す (余計なタグを残さない)
			patch[k] = tg.sameValue(k, changes[k], b[k]) ? undefined : changes[k];
		}
		const head = tg.headMark(t.text);
		const r = head ? tg.editMark(t.text, head, patch) : tg.editAt(t.text, 0, patch);
		if (r.text === t.text) continue;
		try {
			const res = await app.post('/api/psd/text', { index: t.index, text: r.text });
			Object.assign(textOf(t.index) || t, res);
			n++;
		} catch (e) { failed++; }
	}
	state.info.dirty = state.texts.filter(x => x.dirty).length;
	renderAll();
	scheduleRedraw();
	setMultiStatus(failed ? tr('multi.doneFailed', n, failed) : tr('multi.done', n),
	               failed ? 'error' : 'ok');
}

/// 太字などは、全部が ON なら OFF に、そうでなければ ON に揃える
function toggleSelectionFlag(attr) {
	const texts = selectedTextLayers();
	if (!texts.length) return;
	const allOn = texts.every(t => tg.styleAtHead(t.text, baseOf(t))[attr]);
	return applyStyleToSelection({ [attr]: !allOn });
}

/// 行揃えは段落の指定なので専用の口を使う (全段落へ)
async function applyAlignToSelection(align) {
	const texts = selectedTextLayers();
	if (!texts.length) return;
	setMultiStatus(tr('multi.working'));
	let n = 0;
	for (const t of texts) {
		try {
			const r = await app.post('/api/psd/align', { index: t.index, align });
			Object.assign(textOf(t.index) || t, r);
			n++;
		} catch (e) { /* 続ける */ }
	}
	state.info.dirty = state.texts.filter(x => x.dirty).length;
	bodyEl().dataset.loaded = '';
	renderAll();
	scheduleRedraw();
	setMultiStatus(tr('multi.done', n), 'ok');
}

/// 代表レイヤの初期書式を控える / 選択レイヤへ配る
function copyStyleFromSelection() {
	const t = textOf(state.selected) || selectedTextLayers()[0];
	if (!t) return;
	const st = tg.styleAtHead(t.text, baseOf(t));
	state.copiedStyle = {
		font: st.font, size: st.size, color: st.color,
		bold: st.bold, italic: st.italic, underline: st.underline,
		align: (t.paragraphJust && t.paragraphJust[0]) || 0,
		from: t.name,
	};
	renderAll();
	setMultiStatus(tr('multi.copied', t.name), 'ok');
}

async function pasteStyleToSelection() {
	const s = state.copiedStyle;
	if (!s) return;
	await applyStyleToSelection({
		font: s.font, size: s.size, color: s.color,
		bold: s.bold, italic: s.italic, underline: s.underline,
	});
	await applyAlignToSelection(s.align);
}

/// いま一覧に出ている行 (Shift 範囲選択の順序に使う)
function listedLayers() {
	return [...state.tree].reverse().filter(l => {
		if (l.kind === 'divider' || hiddenByCollapse(l)) return false;
		if (l.kind === 'folder') return listFilterOn() ? folderHasVisibleChild(l.index) : true;
		return matchesFilter(l) && passesListFilter(l);
	});
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
			// 基準 = 先頭ランの書式。タグはここからの差分なので、ここを間違える
			// と書式指定の無い部分がまるごと違う色/太さで描かれる。
			const base = {
				font: t.font, size: t.fontSize || 24,
				color: t.color || '#000000',
				bold: !!t.bold, italic: !!t.italic, underline: !!t.underline,
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

	$('#viewStatus').textContent = tr('view.compositing');
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
		$('#viewStatus').textContent = tr('view.status', w, h, shown);
		updateViewNote();
	} catch (e) {
		$('#viewStatus').textContent = tr('view.failed', e.message);
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
/// canvas に相当が無く、近いモードで代用しているブレンド
const APPROX_BLENDS = new Set(['lighter']);

/// プレビューの限界を、いま開いている PSD の中身に即して書く。
/// 「一般論としての注意書き」だけだと読み飛ばされるので、実際に影響が出て
/// いるものを名指しする。
function updateViewNote() {
	const parts = [];
	const vis = (l) => state.visible.get(l.index) !== false;

	const adjust = state.tree.filter(l => l.kind === 'adjust' && vis(l)).length;
	if (adjust) parts.push(tr('note.adjust', adjust));

	// グループのブレンド / 不透明度は反映していない
	const groups = state.tree.filter(l => l.kind === 'folder' && vis(l) &&
		((l.blend && l.blend !== 'source-over') || (l.opacity ?? 255) < 255)).length;
	if (groups) parts.push(tr('note.groups', groups));

	const approx = state.tree.filter(l => vis(l) && APPROX_BLENDS.has(l.blend)).length;
	if (approx) parts.push(tr('note.approx', approx));

	// 仮描画しているレイヤと、そのフォントがこの PC に無いもの
	if (state.renderText) {
		const drawn = state.texts.filter(t => t.dirty);
		if (drawn.length) {
			const missing = [...new Set(drawn.map(t => t.font)
				.filter(f => f && !fontAvailable(f)))];
			parts.push(missing.length
				? tr('note.drawnMissing', drawn.length, missing.join(', '))
				: tr('note.drawn', drawn.length));
		}
	}

	// 基本の注意は必ず残す。レイヤ効果 (lfx2) は検出していないので、
	// 具体的な指摘が出たときにこの一文が消えると見落としに繋がる。
	const note = $('#viewNoteText');
	let text = tr('note.base');
	if (parts.length) text += tr('note.thisPsd', parts.join(' / '));
	text += tr('note.tail');
	note.textContent = text;
	$('#viewNote').classList.toggle('has-issue', parts.length > 0);
}

function applyZoom() {
	const canvas = $('#stage');
	const d = dpr();
	canvas.style.width = (canvas.width * state.zoom / d) + 'px';
	canvas.style.height = (canvas.height * state.zoom / d) + 'px';
	$('#zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
	$('#zoomLevel').title = d !== 1
		? tr('view.zoom.titleDpr', Math.round(d * 100))
		: tr('view.zoom.title');
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
/// プレビュー上で選択中のテキストレイヤをドラッグして動かす。
/// 動かしている間は枠だけを追従表示し、離したときに 1 回だけ反映する
/// (1 ドラッグ = 1 編集なので、取り消しの単位も分かりやすい)。
function setupCanvasDrag() {
	const canvas = $('#stage');
	let drag = null;

	const toImage = (ev) => {
		const rc = canvas.getBoundingClientRect();
		return {
			x: (ev.clientX - rc.left) / rc.width * canvas.width,
			y: (ev.clientY - rc.top) / rc.height * canvas.height,
		};
	};

	canvas.addEventListener('pointerdown', (ev) => {
		const t = state.selected === null ? null : textOf(state.selected);
		if (!t) return;
		const p = toImage(ev);
		// 選択中のレイヤの矩形の中を掴んだときだけドラッグを始める
		if (p.x < t.rect[0] || p.x > t.rect[2] || p.y < t.rect[1] || p.y > t.rect[3]) return;

		// 掴んだ時点の合成結果を控えておく。移動中はこれを貼り直して枠を描く
		// だけにする (毎フレーム合成し直すと重いうえ、非同期の描画が終了後に
		// 残って例外になる)。
		const snap = document.createElement('canvas');
		snap.width = canvas.width;
		snap.height = canvas.height;
		snap.getContext('2d').drawImage(canvas, 0, 0);

		drag = { startX: p.x, startY: p.y, dx: 0, dy: 0, rect: t.rect.slice(), snap };
		// 捕捉できない環境 (合成イベント等) でもドラッグ自体は続けられるように
		try { canvas.setPointerCapture(ev.pointerId); } catch (e) { /* 無くても動く */ }
		canvas.classList.add('dragging');
		ev.preventDefault();
	});

	canvas.addEventListener('pointermove', (ev) => {
		if (!drag) return;
		const p = toImage(ev);
		drag.dx = Math.round(p.x - drag.startX);
		drag.dy = Math.round(p.y - drag.startY);

		const ctx = canvas.getContext('2d');
		ctx.save();
		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = 'source-over';
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(drag.snap, 0, 0);
		ctx.strokeStyle = '#6cb6ff';
		ctx.lineWidth = Math.max(1, 2 / state.zoom);
		ctx.setLineDash([]);
		ctx.strokeRect(drag.rect[0] + drag.dx, drag.rect[1] + drag.dy,
		               drag.rect[2] - drag.rect[0], drag.rect[3] - drag.rect[1]);
		ctx.restore();
	});

	const end = (ev) => {
		if (!drag) return;
		const { dx, dy } = drag;
		drag = null;
		canvas.classList.remove('dragging');
		try {
			if (ev && ev.pointerId !== undefined && canvas.hasPointerCapture(ev.pointerId))
				canvas.releasePointerCapture(ev.pointerId);
		} catch (e) { /* 捕捉していなければ何もしなくてよい */ }
		if (dx || dy) moveText(dx, dy);
		else scheduleRedraw();
	};
	canvas.addEventListener('pointerup', end);
	canvas.addEventListener('pointercancel', end);
}

//---------------------------------------------------------------------------
// 編集ペイン
//---------------------------------------------------------------------------
function select(index) {
	state.selected = index;
	state.multi = new Set(index === null ? [] : [index]);
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

	// 複数選択しているときは、1 枚ぶんの編集ではなく一括操作の画面にする
	const many = state.multi.size > 1;
	$('#multiPane').hidden = !many;
	for (const id of ['#editMeta', '#placeBar', '#basePanel', '#markPanel',
	                  '#styleHint', '#editText', '.body-head', '.edit-actions']) {
		const el = document.querySelector(id);
		if (el) el.hidden = many;
	}
	if (many) { renderMultiPane(); return; }

	const styleEls = ['#fontSel', '#sizeInput', '#fontAddBtn', '#boldBtn', '#italicBtn',
	                  '#underBtn', '#colorInput', '#colorHex', '#markAddBtn',
	                  '#posX', '#posY'];
	for (const s of styleEls) $(s).disabled = !t;
	ta.dataset.ph = tr('edit.text.ph');
	$('#boxW').disabled = !(t && t.hasBounds);
	$('#boxH').disabled = !(t && t.hasBounds);
	document.querySelectorAll('.align').forEach(b => { b.disabled = !t; });

	if (!t) {
		ta.textContent = '';
		ta.contentEditable = 'false';
		ta.classList.add('off');
		ta.dataset.index = '';
		ta.dataset.loaded = '';
		state.headTag = '';
		$('#applyBtn').disabled = true;
		$('#revertBtn').disabled = true;
		setEditStatus(node ? tr('edit.notText', node.kind) : '');
		renderFormat();
		return;
	}

	const rows = [
		[tr('edit.meta.layer'), t.path],
		['lyid', String(t.lyid || '-')],
		[tr('edit.meta.pos'),
		 `${t.rect[0]}, ${t.rect[1]} — ${t.rect[2] - t.rect[0]}×${t.rect[3] - t.rect[1]}`],
	];
	for (const [k, v] of rows) {
		const d = document.createElement('div');
		const ks = document.createElement('span'); ks.className = 'k'; ks.textContent = k;
		const vs = document.createElement('span'); vs.className = 'v'; vs.textContent = v;
		d.append(ks, vs);
		meta.appendChild(d);
	}

	// 配置。位置はレイヤ矩形の左上 (文書座標)、枠は流し込み枠の大きさ。
	$('#posX').value = t.rect[0];
	$('#posY').value = t.rect[1];
	if (t.hasBounds) {
		$('#boxW').value = Math.round(t.boxWidth);
		$('#boxH').value = Math.round(t.boxHeight);
	} else {
		$('#boxW').value = '';
		$('#boxH').value = '';
	}
	// 枠を持たないテキストレイヤ (ポイントテキスト) は珍しくない。
	// 「情報が無い」ではなく「枠という概念が無い」ことを伝える。
	const notes = [];
	if (t.vertical) notes.push(tr('edit.vertical'));
	if (!t.hasBounds) notes.push(tr('edit.pointText'));
	$('#placeHint').textContent = notes.join(' / ');

	// 編集欄を入れ直すのは「別のレイヤになった」か「外から本文が変わった」とき
	// だけ。書式パネルからの変更は編集欄の中身そのものを組み替えて反映している
	// ので、入れ直すとカーソルと選んでいたマークが飛んでしまう。
	// 打ちかけ (未反映の入力) がある間は外からの変更でも上書きしない。
	// dataset.loaded は「最後に流し込んだタグ表現」。編集欄の中身と直接比べると
	// 書き方の揺れ (未知のタグの正規化など) で毎回入れ直しになってしまう。
	const pending = ta.dataset.pending === '1';
	if (ta.dataset.index !== String(t.index) ||
	    (!pending && ta.dataset.loaded !== t.text)) {
		ta.dataset.index = String(t.index);
		ta.dataset.pending = '';
		setFmtSel({ kind: 'base' });         // 位置がずれるので基準へ戻す
		setBody(t.text);
	}
	ta.contentEditable = 'plaintext-only';
	ta.classList.remove('off');
	$('#applyBtn').disabled = (bodyText() === t.text);
	$('#revertBtn').disabled = !t.dirty;

	renderFormat();

	let hint = t.styled ? tr('edit.styled') : '';
	if (t.font && !fontAvailable(t.font)) hint += tr('edit.fontMissing');
	setEditStatus(t.dirty ? tr('edit.unsaved') + (hint ? ' / ' + hint : '') : hint,
	              t.dirty ? 'ok' : '');
}

//---------------------------------------------------------------------------
// 本文と書式マーク
//
// 本文の中身は「タグ付きの 1 本の文字列」だが、編集欄にタグは出さない。書式の
// 変わり目には ◆ の札 (マーク) が入っていて、文字と同じように選んだり消したり
// できる。
//
//   - 編集の対象は **カーソルが属しているマーク** (カーソルより前で最後に効いた
//     もの)。手前にマークが無ければ「基準」= レイヤ全体の初期書式で、そこを
//     いじると書式指定の無いところがまとめて変わる
//   - だから基準の札は本文に出さない (先頭に置いた指定は隠したまま持っておく)
//   - 範囲選択しているときは、その範囲だけに書式を付ける。閉じタグではなく
//     「範囲の終わりに元の書式へ戻すマーク」を置くので、地の書式が何であっても
//     壊れない
//---------------------------------------------------------------------------

/// サーバが返す基準の書式 (読み込み時の先頭ランの書式)
function baseOf(t) {
	return {
		font: t.font, size: t.fontSize, color: t.color,
		bold: t.bold, italic: t.italic, underline: t.underline,
	};
}

function curText() {
	return state.selected === null ? null : textOf(state.selected);
}

const bodyEl = () => $('#editText');

/// 編集欄の中身をタグ表現で取り出す。
/// 先頭マーク (基準への指定) は本文に出していないので、こちらで前に足す。
function bodyText() {
	return state.headTag + be.serializeBody(bodyEl());
}

/// タグ表現を編集欄へ流し込む。sel を渡すとタグ表現上の位置で選択し直す。
function setBody(tagged, sel) {
	const head = tg.headMark(tagged);
	state.headTag = head ? tagged.slice(0, head.end) : '';
	const off = state.headTag.length;
	be.renderBody(bodyEl(), tagged.slice(off), {
		describe: (specs) => tg.describeMark(specs, tr),
		pendingPos: state.fmtSel.kind === 'new' ? state.fmtSel.pos - off : null,
		selected: state.fmtSel.kind === 'mark'
			? { kind: 'mark', start: state.fmtSel.pos - off } : state.fmtSel,
	});
	bodyEl().dataset.loaded = tagged;
	if (sel) setBodySel(sel[0], sel[1]);
}

/// 選択範囲をタグ表現上の位置で
function bodySel() {
	const r = be.selectionRange(bodyEl());
	if (!r) return null;
	const off = state.headTag.length;
	return { s: r.s + off, e: r.e + off };
}

function setBodySel(s, e) {
	const off = state.headTag.length;
	be.selectRange(bodyEl(), Math.max(0, s - off), Math.max(0, e - off));
}

/// 選択中のマーク (kind:'mark' のときだけ)。本文が変わって見失ったら null。
function selectedMark(v) {
	if (state.fmtSel.kind !== 'mark') return null;
	return tg.parseMarks(v).find(m => m.start === state.fmtSel.pos) || null;
}

/// 位置から編集対象を決める。
///   文字を選んでいる    → その範囲
///   置いたばかりのマーク → そのまま
///   それ以外            → カーソルが属しているマーク (無ければ基準)
function fmtSelFor(v, s, e) {
	if (s !== e && tg.textLengthIn(v, s, e) > 0) return { kind: 'range', s, e };
	if (state.fmtSel.kind === 'new' && state.fmtSel.pos === s) return null;  // 変えない
	return markSel(tg.governingMark(v, s));
}

/// カーソル / 選択が動いたとき
function syncFmtFromCaret() {
	const t = curText();
	if (!t) return;
	const r = bodySel();
	if (!r) return;
	const next = fmtSelFor(bodyText(), r.s, r.e);
	if (!next) return;
	setFmtSel(next);
	renderFormat();
}

/// 先頭のマーク (と、マークが無い場所) は「基準」
function markSel(m) {
	return (!m || m.start === 0) ? { kind: 'base' } : { kind: 'mark', pos: m.start };
}

/// 編集対象を切り替える (途中まで開いていた「指定する」欄は畳む)
function setFmtSel(sel) {
	state.fmtSel = sel;
	state.fmtSetAttrs.clear();
}

//---------------------------------------------------------------------------
function renderFormat() {
	const t = curText();
	if (!t) {
		$('#basePanel').hidden = false;
		$('#markPanel').hidden = true;
		$('#styleHint').textContent = '';
		renderBasePanel(null);
		return;
	}

	const v = bodyText();
	const isBase = state.fmtSel.kind === 'base';
	$('#basePanel').hidden = !isBase;
	$('#markPanel').hidden = isBase;
	if (isBase) renderBasePanel(t);
	else renderMarkPanel(t, v);

	// 本文の中の、いま編集している札を光らせる
	be.highlight(bodyEl(), state.fmtSel.kind === 'mark'
		? state.fmtSel.pos - state.headTag.length : null);

	$('#styleHint').textContent =
		isBase ? tr('fmt.hintBase')
		       : (state.fmtSel.kind === 'range' ? tr('fmt.hintRange') : tr('fmt.hintMark'));
}

//---------------------------------------------------------------------------
// 基準パネル — レイヤ全体の初期書式。値はそのまま選ぶだけ。
//---------------------------------------------------------------------------
function renderBasePanel(t) {
	const sel = $('#fontSel');
	sel.textContent = '';
	if (!t) { $('#sizeInput').value = ''; $('#colorHex').value = ''; return; }

	// 表示は「基準 + 先頭マーク」の結果。先頭マークは基準を書き換えている
	// だけなので、利用者から見れば区別する意味が無い。
	const st = tg.styleAtHead(bodyText(), baseOf(t));

	const seen = new Set();
	for (const f of [st.font, ...presetFonts(), ...(t.fonts || [])]) {
		if (!f || seen.has(f)) continue;
		seen.add(f);
		const o = document.createElement('option');
		o.value = f;
		o.textContent = fontLabel(f) + (fontAvailable(f) ? '' : '  ' + tr('edit.fontNotHere'));
		sel.appendChild(o);
	}
	sel.value = st.font || '';
	$('#sizeInput').value = st.size ? Math.round(st.size * 10) / 10 : '';
	$('#colorInput').value = tg.normColor(st.color).toLowerCase();
	$('#colorHex').value = tg.normColor(st.color);
	$('#boldBtn').classList.toggle('on', st.bold);
	$('#italicBtn').classList.toggle('on', st.italic);
	$('#underBtn').classList.toggle('on', st.underline);

	const curAlign = (t.paragraphJust && t.paragraphJust[0]) || 0;
	document.querySelectorAll('.align').forEach(b => {
		b.classList.toggle('on', Number(b.dataset.align) === curAlign);
	});
}

//---------------------------------------------------------------------------
// マーク / 選択範囲パネル — 属性ごとに「変更しない / 基準へ戻す / 指定」。
// 「変更しない」があるのが基準パネルとの違い。マークは差分の指定なので、
// 触っていない属性はその時点の書式がそのまま続く。
//---------------------------------------------------------------------------
function renderMarkPanel(t, v) {
	const body = $('#markPanelBody');
	body.textContent = '';

	const range = state.fmtSel.kind === 'range';
	const mark  = range ? null : selectedMark(v);
	const specs = mark ? mark.specs : {};
	const pos   = range ? state.fmtSel.s
	                    : (mark ? mark.start : (state.fmtSel.pos || 0));
	// そのマークの位置で、指定が無ければ何になるか (「変更しない」の中身)
	const inherited = tg.styleAt(v, pos, baseOf(t));

	// 札は本文の中にあるので、どれを編集しているのか番号でも示す
	const num = mark ? tg.parseMarks(v).filter(m => m.start > 0 && m.start <= mark.start).length
	                 : 0;
	$('#markPanelTitle').textContent =
		range ? tr('fmt.titleRange', state.fmtSel.e - state.fmtSel.s)
		      : (mark ? tr('fmt.titleMark', num) : tr('fmt.titleNew'));
	$('#markDelBtn').hidden = range || !mark;

	for (const a of tg.VALUE_ATTRS) body.appendChild(valueRow(t, a, specs, inherited));
	for (const a of tg.FLAG_ATTRS)  body.appendChild(flagRow(a, specs, inherited));
	body.appendChild(alignRow(v, specs, pos, range));
}

/// font / size / color の行
function valueRow(t, attr, specs, inherited) {
	const row = document.createElement('div');
	row.className = 'fmt-row';
	const k = document.createElement('span');
	k.className = 'fmt-k';
	k.textContent = tr('fmt.attr.' + attr);
	row.appendChild(k);

	const mode = document.createElement('select');
	mode.className = 'fmt-mode';
	for (const [val, key] of [['', 'fmt.mode.keep'], ['base', 'fmt.mode.base'],
	                          ['set', 'fmt.mode.set']]) {
		const o = document.createElement('option');
		o.value = val;
		o.textContent = tr(key);
		mode.appendChild(o);
	}
	const has = (attr in specs);
	// 「指定する」に切り替えただけでは何も入れない (値を選ぶ欄を出すだけ)。
	// いきなり今と同じ値のタグが入っても意味が無く、消す手間が増えるだけなので。
	const forced = state.fmtSetAttrs.has(attr);
	mode.value = forced ? 'set' : (!has ? '' : (specs[attr] === null ? 'base' : 'set'));
	mode.addEventListener('change', () => {
		if (mode.value === 'set') {
			state.fmtSetAttrs.add(attr);
			renderFormat();
			if (attr === 'font') openFontDialog('mark');   // フォントは一覧から選ぶ
			return;
		}
		state.fmtSetAttrs.delete(attr);
		commitSpec({ [attr]: mode.value === '' ? undefined : null });
	});
	row.appendChild(mode);

	const box = document.createElement('span');
	box.className = 'fmt-v';
	const value = (has && specs[attr] !== null) ? specs[attr] : inherited[attr];
	if (mode.value === 'set') {
		if (attr === 'font') {
			// フォントは一覧から選ぶ。名前を直に書ける欄はダイアログの中。
			const btn = document.createElement('button');
			btn.className = 'mini font-pick';
			btn.textContent = value ? fontLabel(value) : tr('fmt.pickFont');
			btn.title = value ? value + ' — ' + tr('fmt.pickFont.title')
			                  : tr('fmt.pickFont.title');
			btn.addEventListener('click', () => openFontDialog('mark'));
			box.appendChild(btn);
			if (value && !fontAvailable(value)) {
				const w = document.createElement('span');
				w.className = 'fmt-warn';
				w.textContent = tr('edit.fontNotHere');
				box.appendChild(w);
			}
		} else if (attr === 'size') {
			const inp = document.createElement('input');
			inp.type = 'number';
			inp.className = 'num';
			inp.min = '1'; inp.max = '2000'; inp.step = '0.5';
			inp.value = Math.round(Number(value) * 10) / 10 || '';
			inp.addEventListener('change', () => {
				const n = parseFloat(inp.value);
				if (n > 0) commitSpec({ size: n });
			});
			box.appendChild(inp);
		} else {
			const col = document.createElement('input');
			col.type = 'color';
			col.className = 'swatch';
			col.value = tg.normColor(value).toLowerCase();
			const hex = document.createElement('input');
			hex.type = 'text';
			hex.className = 'hex';
			hex.value = tg.normColor(value);
			col.addEventListener('change', () => commitSpec({ color: col.value.toUpperCase() }));
			hex.addEventListener('change', () => {
				const c = tg.normColor(hex.value);
				if (/^#[0-9A-F]{6}$/.test(c)) commitSpec({ color: c });
				else hex.value = tg.normColor(value);
			});
			box.append(col, hex);
		}
	} else {
		const s = document.createElement('span');
		s.className = 'fmt-inherit';
		s.textContent = attr === 'size' ? String(Math.round(inherited.size * 10) / 10)
		              : attr === 'color' ? tg.normColor(inherited.color)
		              : (inherited.font || '—');
		if (attr === 'color') {
			const sw = document.createElement('span');
			sw.className = 'mk-swatch';
			sw.style.background = tg.normColor(inherited.color);
			box.appendChild(sw);
		}
		box.appendChild(s);
	}
	row.appendChild(box);
	return row;
}

/// 太字 / 斜体 / 下線の行 ([/b] は「太字を切る」で、閉じタグではない)
function flagRow(attr, specs, inherited) {
	const row = document.createElement('div');
	row.className = 'fmt-row';
	const k = document.createElement('span');
	k.className = 'fmt-k';
	k.textContent = tr('fmt.attr.' + attr);
	row.appendChild(k);

	const mode = document.createElement('select');
	mode.className = 'fmt-mode';
	for (const [val, key] of [['', 'fmt.mode.keep'], ['on', 'fmt.mode.on'],
	                          ['off', 'fmt.mode.off']]) {
		const o = document.createElement('option');
		o.value = val;
		o.textContent = tr(key);
		mode.appendChild(o);
	}
	mode.value = (attr in specs) ? (specs[attr] ? 'on' : 'off') : '';
	mode.addEventListener('change', () => commitSpec({
		[attr]: mode.value === '' ? undefined : (mode.value === 'on'),
	}));
	row.appendChild(mode);

	const box = document.createElement('span');
	box.className = 'fmt-v fmt-inherit';
	if (!(attr in specs)) box.textContent = inherited[attr] ? tr('fmt.mode.on') : tr('fmt.mode.off');
	row.appendChild(box);
	return row;
}

/// 行揃えは段落の指定なので、行頭のマークでしか意味を持たない
function alignRow(v, specs, pos, range) {
	const row = document.createElement('div');
	row.className = 'fmt-row';
	const k = document.createElement('span');
	k.className = 'fmt-k';
	k.textContent = tr('fmt.attr.align');
	row.appendChild(k);

	const atLineHead = !range && (pos === 0 || v[pos - 1] === '\n' ||
		tg.parseMarks(v).some(m => m.end === pos && (m.start === 0 || v[m.start - 1] === '\n')));

	const mode = document.createElement('select');
	mode.className = 'fmt-mode wide';
	const opts = [['', 'fmt.mode.keep']];
	for (const a of [0, 2, 1]) opts.push([String(a), 'fmt.align.' + a]);
	if ('align' in specs && ![0, 1, 2].includes(specs.align))
		opts.push([String(specs.align), 'fmt.align.' + specs.align]);
	for (const [val, key] of opts) {
		const o = document.createElement('option');
		o.value = val;
		o.textContent = tr(key);
		mode.appendChild(o);
	}
	mode.value = ('align' in specs) ? String(specs.align) : '';
	mode.disabled = !atLineHead;
	mode.addEventListener('change', () => commitSpec({
		align: mode.value === '' ? undefined : Number(mode.value),
	}));
	row.appendChild(mode);

	const box = document.createElement('span');
	box.className = 'fmt-v fmt-inherit';
	box.textContent = atLineHead ? '' : tr('fmt.alignNeedsLineHead');
	row.appendChild(box);
	return row;
}

//---------------------------------------------------------------------------
// 書式の書き込み — どのモードでも、本文のタグを組み替えて即座に反映する
//---------------------------------------------------------------------------

/// マーク / 選択範囲パネルからの変更
async function commitSpec(changes) {
	const t = curText();
	if (!t) return;
	const v = bodyText();
	const sel = state.fmtSel;
	let r;

	if (sel.kind === 'range') {
		// 閉じタグは作らない。範囲の終わりには「元の書式へ戻すマーク」が入る。
		const s = sel.s, e = sel.e;
		if (!tg.textLengthIn(v, s, e)) return;
		r = tg.editRange(v, s, e, changes, baseOf(t));
	} else if (sel.kind === 'new') {
		r = tg.editAt(v, sel.pos, changes);
	} else {
		const m = selectedMark(v);
		if (!m) return;
		r = tg.editMark(v, m, changes);
	}
	state.fmtSetAttrs.clear();      // 入ったので「値待ち」ではなくなる
	await commitTagged(r, t);
}

/// 基準パネルからの変更 = 本文の先頭にあるマークを書き換える。
///
/// 「基準」はファイルを読んだ時点の書式で固定されていて動かない。初期書式を
/// 変えるというのは、その基準の上に先頭マークを重ねること。読み込み時の値に
/// 戻したときはマークごと消える (指定が要らなくなるので)。
async function setBaseStyle(attr, value) {
	const t = curText();
	if (!t) return;
	const v = bodyText();
	const b = tg.baseStyle(baseOf(t));
	const head = tg.headMark(v);
	const same = tg.sameValue(attr, value, b[attr]);
	const changes = { [attr]: same ? undefined : value };
	const r = head ? tg.editMark(v, head, changes) : tg.editAt(v, 0, changes);
	await commitTagged(r, t);
}

/// 基準の太字 / 斜体 / 下線を反転する
function toggleBaseFlag(attr) {
	const t = curText();
	if (!t) return;
	const st = tg.styleAtHead(bodyText(), baseOf(t));
	return setBaseStyle(attr, !st[attr]);
}

/// 本文が打ち替えられたとき (札の増減もここで拾う)
function onBodyInput() {
	const t = curText();
	const v = bodyText();
	bodyEl().dataset.pending = (t && v !== t.text) ? '1' : '';
	$('#applyBtn').disabled = !t || (v === t.text);
	renderFormat();
}

/// 本文中の札をクリックしたら、その札の書式を編集する
function onBodyClick(e) {
	const el = e.target.closest ? e.target.closest('.mk') : null;
	if (!el) return;
	const rel = be.markPosOf(bodyEl(), el);
	if (rel === null) return;             // まだ中身の無い札 (pending) はそのまま
	const pos = rel + state.headTag.length;
	const m = tg.parseMarks(bodyText()).find(x => x.start === pos);
	if (!m) return;
	setFmtSel(markSel(m));
	setBodySel(m.end, m.end);             // 札の直後 = このマークが効き始める場所
	renderFormat();
}

/// カーソル位置に書式マークを置く。中身が空のタグは書けないので、本文に入る
/// のは何か指定された時点。それまでは点線の札として置いておく。
function insertMark() {
	const t = curText();
	if (!t) { toast(tr('msg.needText'), true); return; }
	const v = bodyText();
	const r = bodySel();
	const pos = r ? r.s : v.length;
	const m = tg.governingMark(v, pos);
	// すでにその位置にマークがあるなら、新しく作らずそれを選び直す
	if (m && m.end === pos) setFmtSel(markSel(m));
	else setFmtSel({ kind: 'new', pos });
	setBody(v, [pos, pos]);
	bodyEl().focus();
	renderFormat();
}

async function deleteSelectedMark() {
	const t = curText();
	if (!t) return;
	const v = bodyText();
	const m = selectedMark(v);
	if (!m) return;
	setFmtSel({ kind: 'base' });
	await commitTagged(tg.removeMark(v, m), t);
}

/// 組み替えた本文を編集欄へ入れて、そのままサーバへ反映する。
/// カーソル / 選択範囲は編集に合わせてずらす (選んでいた文字を選んだまま)。
async function commitTagged(r, t) {
	const ta = bodyEl();
	if (r.text === bodyText()) return;
	const cur = bodySel() || { s: 0, e: 0 };
	const s = tg.shiftPos(cur.s, r.edits);
	const e = tg.shiftPos(cur.e, r.edits);
	if (state.fmtSel.kind === 'mark')
		state.fmtSel = { kind: 'mark', pos: tg.shiftPos(state.fmtSel.pos, r.edits) };
	else if (state.fmtSel.kind === 'range')
		state.fmtSel = { kind: 'range', s, e };
	else if (state.fmtSel.kind === 'new')
		state.fmtSel = markSel(tg.governingMark(r.text, tg.shiftPos(state.fmtSel.pos, r.edits)));
	setBody(r.text, [s, e]);
	// サーバへ届くまでの間に別の更新通知 (SSE) で描き直しが走ると、まだ
	// 送っていない中身が「外から変わった」と見なされて捨てられてしまう。
	// 反映が終わるまでは打ちかけと同じ扱いにしておく。
	ta.dataset.pending = '1';
	await applyText();
}

//---------------------------------------------------------------------------
// レイヤ間の移動 (打ち替え作業を止めないための足まわり)
//---------------------------------------------------------------------------

/// いま一覧に出ているテキストレイヤを、画面に並んでいる順で
function listedTextLayers() {
	return [...state.tree].reverse().filter(l =>
		l.text && !hiddenByCollapse(l) && matchesFilter(l) && passesListFilter(l));
}

/// 本文へカーソルを移す。selectAll なら全選択 (そのまま打ち替えられる)
function focusBody(selectAll) {
	const ta = bodyEl();
	if (ta.contentEditable === 'false') return;
	ta.focus();
	if (selectAll) setBodySel(state.headTag.length, bodyText().length);
}

/// 前後のテキストレイヤへ移る。dir = -1 で上、+1 で下 (画面の並び)。
/// 端まで来たら止まる (一周すると編集済みを踏み直すため)。
function gotoAdjacentText(dir) {
	const list = listedTextLayers();
	if (!list.length) return false;
	const i = list.findIndex(l => l.index === state.selected);
	const next = (i < 0) ? list[0] : list[i + dir];
	if (!next) return false;
	select(next.index);
	focusBody(true);
	return true;
}

/// 反映してから次のレイヤへ (Ctrl+Shift+Enter)
async function applyAndNext() {
	const t = curText();
	if (t && bodyText() !== t.text) await applyText();
	if (!gotoAdjacentText(1)) toast(tr('msg.lastLayer'));
}

//---------------------------------------------------------------------------
// 編集操作
//---------------------------------------------------------------------------
async function applyText() {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	state.applying++;
	try {
		const sent = bodyText();
		const r = await app.post('/api/psd/text', { index: t.index, text: sent });
		// 待っている間に一覧が作り直されていることがある (SSE の更新通知)。
		// 掴んでいた行はもう表に載っていないので、引き直してから書き込む。
		Object.assign(textOf(t.index) || t, r);
		bodyEl().dataset.pending = '';
		bodyEl().dataset.loaded = r.text !== undefined ? r.text : sent;
		state.info.dirty = state.texts.filter(x => x.dirty).length;
		renderAll();
		scheduleRedraw();
		setEditStatus(r.warning ? r.warning : tr('edit.applied'), r.warning ? 'error' : 'ok');
	} catch (e) {
		setEditStatus(serverMessage(e.message), 'error');
	} finally {
		state.applying--;
		if (!state.applying && state.refreshPending) {
			state.refreshPending = false;
			refreshAll();
		}
	}
}

async function revertText() {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	try {
		const r = await app.post('/api/psd/revert', { index: t.index });
		Object.assign(t, r);
		bodyEl().dataset.pending = '';         // 打ちかけも捨てて読み込み時へ戻す
		bodyEl().dataset.loaded = '';          // 中身を入れ直させる
		state.info.dirty = state.texts.filter(x => x.dirty).length;
		renderAll();
		scheduleRedraw();
	} catch (e) {
		setEditStatus(serverMessage(e.message), 'error');
	}
}

/// 段落の行揃え。基準パネルから呼ぶので全段落が対象。
/// サーバ側でタグ表現を作り直すので、編集途中の本文があるなら先に反映しておく
/// (そうしないと入力が消える)。
async function setAlign(align) {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	if (bodyText() !== t.text) await applyText();
	try {
		const r = await app.post('/api/psd/align', { index: t.index, align });
		Object.assign(t, r);
		bodyEl().dataset.loaded = '';        // タグ表現が変わるので入れ直す
		state.info.dirty = state.texts.filter(x => x.dirty).length;
		renderAll();
		scheduleRedraw();
	} catch (e) {
		toast(serverMessage(e.message), true);
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
			toast(tr('msg.renamed', value));
		} catch (e) {
			toast(serverMessage(e.message), true);
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

/// 複製ダイアログを開く。本文を書き換えれば実質「新規追加」になるので、
/// 「複製」と「新規追加」でボタンを分けず 1 本にしている。
/// 複製ダイアログ。1 枚なら名前と本文をその場で決められ、複数選択なら
/// 名前の頭 / 末尾に付ける文字だけを決める (言語別の下地づくり)。
function openDupDialog() {
	const texts = selectedTextLayers();
	if (!texts.length) return;
	const many = texts.length > 1;

	$('#dupOne').hidden = many;
	$('#dupMany').hidden = !many;
	$('#dupCount').textContent = tr('multi.dupCount', texts.length);
	if (many) {
		$('#dupPrefix').value = state.settings.dupPrefix || '';
		$('#dupSuffix').value = state.settings.dupSuffix || (state.settings.dupPrefix ? '' : ' copy');
	} else {
		const t = texts[0];
		$('#dupName').value = t.name + ' copy';
		$('#dupText').value = t.text;
	}
	$('#dupDialog').hidden = false;
	const focusEl = many ? $('#dupPrefix') : $('#dupName');
	focusEl.focus();
	focusEl.select();
}

async function duplicateLayer() {
	const texts = selectedTextLayers();
	if (!texts.length) return;

	// --- 1 枚だけ: 今までどおり名前と本文をその場で決める ---
	if (texts.length === 1) {
		const t = texts[0];
		try {
			const r = await app.post('/api/psd/duplicate', {
				index: t.index,
				name: $('#dupName').value.trim() || (t.name + ' copy'),
				text: $('#dupText').value,
			});
			$('#dupDialog').hidden = true;
			bodyEl().dataset.loaded = '';
			applyDoc(r, { keepVisibility: true });
			if (typeof r.index === 'number') {
				state.visible.set(r.index, true);
				select(r.index);
			}
			toast(tr('msg.duplicated'));
		} catch (e) {
			toast(serverMessage(e.message), true);
		}
		return;
	}

	// --- まとめて複製。本文はそのまま (訳を入れるのは複製したあと) ---
	const prefix = $('#dupPrefix').value;
	const suffix = $('#dupSuffix').value;
	app.post('/api/app/settings', { dupPrefix: prefix, dupSuffix: suffix }).catch(() => {});
	state.settings.dupPrefix = prefix;
	state.settings.dupSuffix = suffix;

	$('#dupDialog').hidden = true;
	setMultiStatus(tr('multi.working'));

	// index は複製のたびにずれる (挿入したぶん後ろが繰り下がる) ので、
	// 元レイヤも作ったレイヤも lyid で追いかける。
	const madeLyids = [];
	for (const src of texts) {
		const cur = state.texts.find(x => x.lyid === src.lyid) || src;
		try {
			const r = await app.post('/api/psd/duplicate', {
				index: cur.index,
				name: prefix + cur.name + suffix,
			});
			applyDoc(r, { keepVisibility: true });
			if (typeof r.index === 'number') {
				state.visible.set(r.index, true);
				const made = textOf(r.index);
				if (made) madeLyids.push(made.lyid);
			}
		} catch (e) { /* 続ける */ }
	}

	// 複製したものを選択状態にして、そのまま一括で書式を変えられるようにする
	const madeNow = state.texts.filter(t => madeLyids.includes(t.lyid));
	if (madeNow.length) {
		state.multi = new Set(madeNow.map(t => t.index));
		state.selected = madeNow[madeNow.length - 1].index;
	}
	renderAll();
	scheduleRedraw();
	setMultiStatus(tr('multi.duplicated', madeNow.length), 'ok');
	toast(tr('multi.duplicated', madeNow.length));
}

/// テキストレイヤを移動する (文書座標での差分)
async function moveText(dx, dy) {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t || (!dx && !dy)) return;
	try {
		// 位置を動かしても本文は変わらないので、編集欄はそのままにする
		const r = await app.post('/api/psd/place', { index: t.index, dx, dy });
		applyDoc(r, { keepVisibility: true });
		scheduleRedraw();
	} catch (e) {
		toast(serverMessage(e.message), true);
	}
}

/// 流し込み枠の大きさを変える (左上は固定)
async function resizeText(width, height) {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	try {
		const r = await app.post('/api/psd/place', { index: t.index, width, height });
		applyDoc(r, { keepVisibility: true });
		scheduleRedraw();
	} catch (e) {
		toast(serverMessage(e.message), true);
	}
}

/// 同じ階層の中でひとつ上/下へ動かす (フォルダは中身ごと)
async function moveLayer(up) {
	if (state.selected === null) return;
	try {
		const r = await app.post('/api/psd/move',
		                         { index: state.selected, direction: up ? 'up' : 'down' });
		$('#editText').dataset.index = '';
		applyDoc(r, { keepVisibility: true });
		if (typeof r.index === 'number') select(r.index);
		scheduleRedraw();
	} catch (e) {
		toast(serverMessage(e.message), true);   // 端で止まったときもここに来る
	}
}

//---------------------------------------------------------------------------
// フォント追加
//---------------------------------------------------------------------------
/// target は 'base' (レイヤの初期書式) / 'mark' (選択中のマーク・範囲) /
/// 'multi' (選択中のレイヤすべて)
async function openFontDialog(target) {
	if (!curText()) { toast(tr('msg.needText'), true); return; }
	state.fontTarget = target || 'base';
	$('#fontDialog').hidden = false;
	$('#fontManual').value = '';
	$('#fontDlgTarget').textContent = tr(
		state.fontTarget === 'multi' ? 'dlg.fontForMulti' :
		state.fontTarget === 'base'  ? 'dlg.fontForBase'  : 'dlg.fontForMark');

	renderPresetBar();
	renderSysFonts();
	await loadSystemFonts();
	renderSysFonts();
}

/// この PC のフォント一覧をサーバから取る (一度だけ)。
/// PSD が指すのは PostScript 名だが、人が覚えているのは日本語名なので、
/// フォントファイルの名前テーブルから両方もらう。
async function loadSystemFonts() {
	if (state.sysFonts.length) return;
	try {
		const r = await app.get('/api/app/fonts');
		state.sysFonts = (r.fonts || []).filter(f => f.postscript);
		state.fontByPs = new Map(state.sysFonts.map(f => [f.postscript, f]));
	} catch (e) { /* 取れなければ手入力に頼る */ }
}

/// 画面に出すフォント名。日本語名があれば添える。
function fontLabel(ps) {
	const f = state.fontByPs && state.fontByPs.get(ps);
	const local = f && (f.localName || '');
	return local && local !== ps ? `${local} (${ps})` : ps;
}

function renderSysFonts() {
	const host = $('#sysFontList');
	host.textContent = '';
	const q = $('#fontFilter').value.trim().toLowerCase();
	/// 日本語名・英語名・PostScript 名のどれで探しても当たるように
	const hit = (ps) => {
		if (!q) return true;
		const f = state.fontByPs && state.fontByPs.get(ps);
		const names = [ps, f && f.localName, f && f.family, f && f.style];
		return names.some(n => n && n.toLowerCase().includes(q));
	};

	const group = (label) => {
		const d = document.createElement('div');
		d.className = 'fs-group';
		d.textContent = label;
		host.appendChild(d);
	};
	const row = (ps, preset) => {
		const d = document.createElement('div');
		d.className = 'fs-row font-row';

		const star = document.createElement('span');
		star.className = 'fs-star' + (isPresetFont(ps) ? ' on' : '');
		star.textContent = isPresetFont(ps) ? '★' : '☆';
		star.title = tr('dlg.fontPresetToggle');
		star.addEventListener('click', (e) => { e.stopPropagation(); togglePresetFont(ps); });

		const name = document.createElement('span');
		name.className = 'fs-name';
		name.style.fontFamily = `"${ps}", sans-serif`;
		const f = state.fontByPs && state.fontByPs.get(ps);
		name.textContent = (f && f.localName) || (f && f.family) || ps;

		const sub = document.createElement('span');
		sub.className = 'fs-sub';
		sub.textContent = ps + (fontAvailable(ps) ? '' : '  ' + tr('edit.fontNotHere'));

		d.append(star, name, sub);
		d.addEventListener('click', () => pickFont(ps));
		host.appendChild(d);
	};

	// よく使うぶん → この PSD が持っているぶん → この PC のぶん、の順。
	// 上ふたつは Photoshop 側にも確実にあるので、まずそこから選べるほうが安全。
	const t = curText();
	const preset = presetFonts().filter(hit);
	if (preset.length) {
		group(tr('dlg.fontPreset', state.settings.fontPreset || tr('dlg.fontPresetDefault')));
		preset.forEach(ps => row(ps, true));
	}
	const own = [...new Set(t ? (t.fonts || []) : [])].filter(hit);
	if (own.length) {
		group(tr('dlg.fontOwn'));
		own.forEach(ps => row(ps));
	}
	if (state.sysFonts.length) {
		group(tr('dlg.fontSystem'));
		state.sysFonts.map(f => f.postscript).filter(hit).slice(0, 500).forEach(ps => row(ps));
	} else {
		const p = document.createElement('p');
		p.className = 'hint';
		p.textContent = tr('dlg.fontNoList');
		host.appendChild(p);
	}
}

//---------------------------------------------------------------------------
// フォントのプリセット (よく使うぶんを名前を付けて残す)
//---------------------------------------------------------------------------
function presetFonts() {
	const all = state.settings.fontPresets || {};
	const name = state.settings.fontPreset || Object.keys(all)[0];
	return (name && all[name]) || [];
}

function isPresetFont(ps) { return presetFonts().includes(ps); }

function togglePresetFont(ps) {
	const all = Object.assign({}, state.settings.fontPresets || {});
	const name = state.settings.fontPreset || Object.keys(all)[0] || tr('dlg.fontPresetDefault');
	const list = (all[name] || []).slice();
	const i = list.indexOf(ps);
	if (i >= 0) list.splice(i, 1);
	else list.push(ps);
	all[name] = list;
	state.settings.fontPresets = all;
	state.settings.fontPreset = name;
	app.post('/api/app/settings', { fontPresets: all, fontPreset: name }).catch(() => {});
	renderSysFonts();
	renderPresetBar();
}

/// プリセットの切り替え / 追加
function renderPresetBar() {
	const sel = $('#fontPresetSel');
	const all = state.settings.fontPresets || {};
	const names = Object.keys(all);
	sel.textContent = '';
	for (const n of names) {
		const o = document.createElement('option');
		o.value = n;
		o.textContent = `${n} (${all[n].length})`;
		sel.appendChild(o);
	}
	if (!names.length) {
		const o = document.createElement('option');
		o.value = '';
		o.textContent = tr('dlg.fontPresetNone');
		sel.appendChild(o);
	}
	sel.value = state.settings.fontPreset || names[0] || '';
}

/// 一覧 / 手入力から選ばれたフォントを、開いたときの適用先へ入れる
function pickFont(name) {
	const n = String(name || '').trim();
	if (!n) return;
	const t = curText();
	if (!t) return;
	if (!t.fonts.includes(n)) t.fonts.push(n);
	$('#fontDialog').hidden = true;
	if (state.fontTarget === 'multi') applyStyleToSelection({ font: n });
	else if (state.fontTarget === 'base') setBaseStyle('font', n);
	else commitSpec({ font: n });
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
		toast(serverMessage(e.message), true);
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
		toast(tr('msg.loaded', state.texts.length));
		// 次に開くときのために、この PSD のフォルダを覚えておく
		const dir = path.replace(/\\/g, '/').replace(/\/[^/]*$/, '');
		state.settings.lastDir = dir;
		app.post('/api/app/settings', { lastDir: dir, lastPsd: path }).catch(() => {});
	} catch (e) {
		toast(serverMessage(e.message), true);
	}
}

//---------------------------------------------------------------------------
// 一覧編集
//
// 選んだレイヤ (選んでいなければ全テキストレイヤ) を表にして、本文と初期書式を
// まとめて書き換える。CSV を経由せずに同じことをするための画面で、Excel から
// そのまま貼り付けられる (タブ区切りを配る)。
//
// 本文を変えていない行は、途中に置いた書式マークをそのまま残す。本文を変えた
// 行はマークの位置が意味を失うので落とす — その行には ⚠ を出して先に知らせる。
//---------------------------------------------------------------------------
const SHEET_COLS = ['name', 'text', 'font', 'size', 'color', 'align'];

function openSheet() {
	if (!state.info.open) { toast(tr('msg.needText'), true); return; }
	loadSheet();
	$('#sheetDialog').hidden = false;
}

/// 表の元データを作り直す (画面の値は捨てる)
function loadSheet() {
	const picked = selectedTextLayers();
	const rows = (picked.length > 1 ? picked : state.texts).map(t => {
		const st = tg.styleAtHead(t.text, baseOf(t));
		const marks = tg.parseMarks(t.text).filter(m => m.start > 0);
		return {
			index: t.index,
			lyid: t.lyid,
			name: t.name,
			text: tg.stripToPlain(t.text),
			font: st.font, size: st.size, color: tg.normColor(st.color),
			align: (t.paragraphJust && t.paragraphJust[0]) || 0,
			marks: marks.length,
		};
	});
	state.sheet = { rows, orig: rows.map(r => Object.assign({}, r)) };
	renderSheet();
	setSheetStatus('');
}

function setSheetStatus(msg, cls) {
	const el = $('#sheetStatus');
	el.textContent = msg || '';
	el.className = 'status' + (cls ? ' ' + cls : '');
}

function renderSheet() {
	const table = $('#sheetTable');
	table.textContent = '';
	const rows = state.sheet.rows;

	const head = document.createElement('tr');
	for (const key of SHEET_COLS) {
		const th = document.createElement('th');
		th.textContent = tr('sheet.col.' + key);
		th.className = 'c-' + key;
		head.appendChild(th);
	}
	table.appendChild(head);

	rows.forEach((row, i) => {
		const orig = state.sheet.orig[i];
		const line = document.createElement('tr');
		line.dataset.row = String(i);

		// レイヤ名 (読み取り専用。書式マークを持つ行には印を出す)
		const nameCell = document.createElement('td');
		nameCell.className = 'c-name';
		if (row.marks) {
			const w = document.createElement('span');
			w.className = 'sheet-warn';
			w.textContent = '⚠';
			w.title = tr('sheet.marksWarn', row.marks);
			nameCell.appendChild(w);
		}
		nameCell.appendChild(document.createTextNode(row.name));
		nameCell.title = row.name;
		line.appendChild(nameCell);

		line.appendChild(sheetCell(i, 'text', row.text, orig.text));
		line.appendChild(sheetCell(i, 'font', row.font, orig.font));
		line.appendChild(sheetCell(i, 'size', row.size, orig.size));
		line.appendChild(sheetCell(i, 'color', row.color, orig.color));
		line.appendChild(sheetAlignCell(i, row.align, orig.align));
		table.appendChild(line);
	});

	const changed = changedSheetRows().length;
	$('#sheetApply').disabled = !changed;
	$('#sheetApply').textContent = changed ? tr('sheet.applyN', changed) : tr('sheet.apply');
}

/// 文字を入れるセル。値が元と違えば色を付ける。
function sheetCell(i, key, value, orig) {
	const td = document.createElement('td');
	td.className = 'c-' + key + (String(value) !== String(orig) ? ' edited' : '');
	const el = document.createElement(key === 'text' ? 'textarea' : 'input');
	if (key === 'size') { el.type = 'number'; el.min = '1'; el.step = '0.5'; }
	else if (key === 'color') { el.type = 'text'; el.spellcheck = false; }
	else if (key !== 'text') { el.type = 'text'; el.spellcheck = false; }
	el.value = (key === 'size' && value) ? (Math.round(value * 10) / 10) : (value ?? '');
	if (key === 'text') { el.rows = Math.min(4, String(value || '').split('\n').length); }
	// フォントは PostScript 名がそのまま値。人が見て分かるよう日本語名を添える
	if (key === 'font' && value) el.title = fontLabel(value);
	el.dataset.row = String(i);
	el.dataset.key = key;
	el.addEventListener('input', onSheetInput);
	el.addEventListener('paste', onSheetPaste);
	td.appendChild(el);
	if (key === 'color') {
		const sw = document.createElement('input');
		sw.type = 'color';
		sw.className = 'swatch';
		sw.value = tg.normColor(value).toLowerCase();
		sw.addEventListener('change', () => {
			state.sheet.rows[i].color = sw.value.toUpperCase();
			renderSheet();
		});
		td.appendChild(sw);
	}
	return td;
}

function sheetAlignCell(i, value, orig) {
	const td = document.createElement('td');
	td.className = 'c-align' + (value !== orig ? ' edited' : '');
	const sel = document.createElement('select');
	for (const a of [0, 2, 1]) {
		const o = document.createElement('option');
		o.value = String(a);
		o.textContent = tr('fmt.align.' + a);
		sel.appendChild(o);
	}
	if (![0, 1, 2].includes(value)) {
		const o = document.createElement('option');
		o.value = String(value);
		o.textContent = tr('fmt.align.' + value);
		sel.appendChild(o);
	}
	sel.value = String(value);
	sel.addEventListener('change', () => {
		state.sheet.rows[i].align = Number(sel.value);
		renderSheet();
	});
	td.appendChild(sel);
	return td;
}

function onSheetInput(e) {
	const i = Number(e.target.dataset.row);
	const key = e.target.dataset.key;
	const row = state.sheet.rows[i];
	row[key] = (key === 'size') ? parseFloat(e.target.value) || 0 : e.target.value;
	// 入力のたびに作り直すとカーソルが飛ぶので、印と反映ボタンだけ更新する
	e.target.parentNode.classList.toggle('edited',
		String(row[key]) !== String(state.sheet.orig[i][key]));
	const changed = changedSheetRows().length;
	$('#sheetApply').disabled = !changed;
	$('#sheetApply').textContent = changed ? tr('sheet.applyN', changed) : tr('sheet.apply');
}

/// Excel からの貼り付け。タブ区切り / 改行区切りなら、そのセルを起点に配る。
function onSheetPaste(e) {
	const text = e.clipboardData && e.clipboardData.getData('text/plain');
	if (!text || !/[\t\n]/.test(text.trim())) return;   // 1 セルぶんは通常の貼り付け
	e.preventDefault();

	const startRow = Number(e.target.dataset.row);
	const startCol = SHEET_COLS.indexOf(e.target.dataset.key);
	const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
	let n = 0;
	lines.forEach((line, dy) => {
		const row = state.sheet.rows[startRow + dy];
		if (!row) return;
		line.split('\t').forEach((cell, dx) => {
			const key = SHEET_COLS[startCol + dx];
			if (!key || key === 'name') return;          // 名前の列は書き換えない
			if (key === 'size') row.size = parseFloat(cell) || row.size;
			else if (key === 'align') row.align = alignFromText(cell, row.align);
			else if (key === 'color') row.color = tg.normColor(cell);
			else row[key] = cell;
			n++;
		});
	});
	renderSheet();
	setSheetStatus(tr('sheet.pasted', n));
}

function alignFromText(s, def) {
	const v = tg.alignValue(String(s).trim());
	if (v !== null) return v;
	const ja = { '左': 0, '右': 1, '中央': 2, '左揃え': 0, '右揃え': 1, '中央揃え': 2 };
	return ja[String(s).trim()] ?? def;
}

function changedSheetRows() {
	if (!state.sheet) return [];
	return state.sheet.rows.filter((r, i) => {
		const o = state.sheet.orig[i];
		return SHEET_COLS.some(k => k !== 'name' && String(r[k]) !== String(o[k]));
	});
}

//---------------------------------------------------------------------------
/// 表の変更を文書へ流す。
async function applySheet() {
	const rows = state.sheet.rows;
	let done = 0, lostMarks = 0, failed = 0;
	setSheetStatus(tr('multi.working'));

	for (let i = 0; i < rows.length; i++) {
		const row = rows[i], orig = state.sheet.orig[i];
		const t = state.texts.find(x => x.lyid === row.lyid) || textOf(row.index);
		if (!t) { failed++; continue; }

		const textChanged = row.text !== orig.text;
		const styleChanged = ['font', 'size', 'color'].some(k =>
			!tg.sameValue(k, row[k], orig[k]));
		const alignChanged = row.align !== orig.align;
		if (!textChanged && !styleChanged && !alignChanged) continue;

		try {
			if (textChanged || styleChanged) {
				const b = tg.baseStyle(baseOf(t));
				const head = tg.headMark(t.text);
				// 先頭マーク (= 初期書式) は残したまま、指定を上書きする
				const specs = Object.assign({}, head ? head.specs : {});
				for (const k of ['font', 'size', 'color']) {
					if (tg.sameValue(k, row[k], b[k])) delete specs[k];
					else specs[k] = row[k];
				}
				let next;
				if (textChanged) {
					// 本文が変わると途中のマークは位置を失うので落とす
					if (row.marks) lostMarks++;
					next = tg.formatMark(specs) + tg.escapeText(row.text);
				} else {
					const r = head ? tg.editMark(t.text, head, diffSpecs(head.specs, specs))
					               : tg.editAt(t.text, 0, specs);
					next = r.text;
				}
				if (next !== t.text) {
					const res = await app.post('/api/psd/text', { index: t.index, text: next });
					Object.assign(textOf(t.index) || t, res);
				}
			}
			if (alignChanged) {
				const res = await app.post('/api/psd/align',
				                           { index: t.index, align: row.align });
				Object.assign(textOf(t.index) || t, res);
			}
			done++;
		} catch (e) { failed++; }
	}

	state.info.dirty = state.texts.filter(x => x.dirty).length;
	bodyEl().dataset.loaded = '';
	renderAll();
	scheduleRedraw();
	loadSheet();          // 反映後の姿を読み直す (元の値も更新される)
	setSheetStatus(
		failed ? tr('sheet.doneFailed', done, failed)
		       : (lostMarks ? tr('sheet.doneLost', done, lostMarks) : tr('sheet.done', done)),
		failed ? 'error' : 'ok');
}

/// 先頭マークを目的の形にするための差分 (消す指定は undefined)
function diffSpecs(cur, want) {
	const out = {};
	for (const k of new Set([...Object.keys(cur), ...Object.keys(want)])) {
		if (!(k in want)) out[k] = undefined;
		else if (cur[k] !== want[k]) out[k] = want[k];
	}
	return out;
}

//---------------------------------------------------------------------------
// CSV
//---------------------------------------------------------------------------
function renderReport(r, error) {
	const host = $('#csvReport');
	host.textContent = '';

	if (error) {
		const p = document.createElement('p');
		p.className = 'summary error';
		p.textContent = error;
		host.appendChild(p);
		return;
	}

	const sum = document.createElement('div');
	sum.className = 'summary';
	sum.textContent = r.applied
		? tr('csv.applied', r.changed, r.same, r.notfound, r.failed)
		: tr('csv.dry', r.changed, r.same, r.notfound);
	host.appendChild(sum);

	// 読めた文字コード。Excel から来た CSV は Shift-JIS のことがあるので、
	// どう読んだかを見せておく (化けていたら気付けるように)。
	if (r.charset && r.charset !== 'utf-8') {
		const cs = document.createElement('p');
		cs.className = 'hint';
		cs.textContent = tr('csv.charset', r.charset.toUpperCase());
		host.appendChild(cs);
	}

	// 「反映する」が押せない理由を出す。黙って無効になっているのが一番困る。
	if (!r.applied && r.changed === 0) {
		const p = document.createElement('p');
		p.className = 'hint';
		p.textContent = r.notfound
			? tr('csv.whyNotfound') : tr('csv.whySame');
		host.appendChild(p);
	}

	const shown = (r.rows || []).filter(x => x.status !== 'same');
	if (!shown.length) return;

	const table = document.createElement('table');
	const head = document.createElement('tr');
	for (const h of [tr('csv.col.status'), 'lyid', tr('csv.col.layer'), tr('csv.col.note')]) {
		const th = document.createElement('th');
		th.textContent = h;
		head.appendChild(th);
	}
	table.appendChild(head);

	const label = { changed: tr('csv.changed'), notfound: tr('csv.notfound'),
	                error: tr('csv.error') };
	for (const row of shown.slice(0, 300)) {
		const line = document.createElement('tr');
		const st = document.createElement('td');
		st.className = row.status;
		st.textContent = label[row.status] || row.status;
		const id = document.createElement('td'); id.textContent = row.lyid || '';
		const pa = document.createElement('td'); pa.textContent = row.path || '';
		const ms = document.createElement('td'); ms.textContent = row.message || '';
		line.append(st, id, pa, ms);
		table.appendChild(line);
	}
	host.appendChild(table);
}

//---------------------------------------------------------------------------
/// CSV を書き出す。既定の置き場所は PSD の隣なので、探し回らなくてよい。
function openExportDialog() {
	$('#expPath').value = state.csvPath || state.info.csvPath || '';
	$('#expStatus').textContent = '';
	// 選択中のレイヤだけ書き出す選択肢は、複数選んでいるときだけ意味がある
	const texts = selectedTextLayers();
	const many = texts.length > 1;
	$('#expSelRow').hidden = !many;
	$('#expSelOnly').checked = many && !!state.exportSel;
	$('#expSelCount').textContent = tr('multi.expCount', texts.length);
	state.exportSel = false;
	$('#exportDialog').hidden = false;
}

async function exportCsvToFile() {
	const path = $('#expPath').value.trim();
	const only = ($('#expSelOnly').checked && !$('#expSelRow').hidden)
		? selectedTextLayers().map(t => t.index) : undefined;
	try {
		const r = await app.post('/api/psd/export', only ? { path, indices: only } : { path });
		state.csvPath = r.path;                       // 読み込みの既定にも使う
		$('#exportDialog').hidden = true;
		toast(tr('msg.csvWritten', r.path));
	} catch (e) {
		$('#expStatus').textContent = serverMessage(e.message);
		$('#expStatus').className = 'status error';
	}
}

//---------------------------------------------------------------------------
/// 取り込み元は「選んだファイル」か「パス指定」。文字コードの判定はサーバに
/// 任せるので、ファイルは **生のバイトのまま** 送る (file.text() を通すと
/// Shift-JIS が化けたあとの文字列になり、もう元へ戻せない)。
async function importCsv(apply, source) {
	const src = source || state.pendingCsv;
	if (!src) { toast(tr('msg.pickCsv'), true); return; }
	try {
		const r = (src.path !== undefined)
			? await app.post('/api/psd/import', { path: src.path, apply })
			: await app.post('/api/psd/import', src.bytes, { apply: apply ? 1 : 0 });
		renderReport(r);
		if (apply) {
			applyDoc(r, { keepVisibility: true });
			$('#editText').dataset.index = '';
			state.pendingCsv = null;
			$('#csvApply').disabled = true;
			toast(tr('msg.csvUpdated', r.changed));
		} else {
			state.pendingCsv = src;
			$('#csvApply').disabled = (r.changed === 0);
		}
	} catch (e) {
		renderReport(null, serverMessage(e.message));
		state.pendingCsv = null;
		$('#csvApply').disabled = true;
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
		toast(tr('msg.saved', r.path));
	} catch (e) {
		toast(serverMessage(e.message), true);
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

	// --- 書式マーク ---
	/// いまの本文とマークの構成を覗く
	app.command('marks', () => {
		const t = curText();
		const v = bodyText();
		return {
			sel: state.fmtSel,
			base: t ? tg.baseStyle(baseOf(t)) : null,
			text: v,
			plain: tg.stripToPlain(v),
			caret: bodySel(),
			marks: tg.parseMarks(v).map(m => ({ start: m.start, end: m.end, specs: m.specs })),
		};
	});
	/// 編集対象を選ぶ: 'base' / {mark:N} (1 から) / {range:[s,e]} / {at:pos}
	app.command('marksel', (a) => {
		const v = bodyText();
		if (a === 'base') setFmtSel({ kind: 'base' });
		else if (a && a.range) {
			// カーソルを動かしたのと同じ判断をする (ウィンドウが前面に無いと
			// ブラウザの選択が入らないことがあるので、判断は自前で行う)
			const [s, e] = a.range;
			setBodySel(s, e);
			setFmtSel(fmtSelFor(v, s, e) || state.fmtSel);
		} else if (a && a.at !== undefined) {
			setFmtSel({ kind: 'new', pos: a.at });
			setBody(v, [a.at, a.at]);
		} else {
			const n = (typeof a === 'number') ? a : a.mark;
			const head = tg.headMark(v);
			const list = tg.parseMarks(v).filter(m => m !== head);
			const m = list[n - 1];
			if (!m) throw new Error('no such mark: ' + n);
			setFmtSel({ kind: 'mark', pos: m.start });
		}
		renderFormat();
		return state.fmtSel;
	});
	/// いまの対象へ書式を入れる。値は 値 / null (基準へ戻す) / "keep" (指定を消す)
	app.command('fmt', async (a) => {
		const changes = {};
		for (const k of Object.keys(a || {}))
			changes[k] = (a[k] === 'keep') ? undefined : a[k];
		if (state.fmtSel.kind === 'base') {
			for (const k of Object.keys(changes)) await setBaseStyle(k, changes[k]);
		} else {
			await commitSpec(changes);
		}
		return bodyText();
	});
	app.command('move', async (a) => {
		const up = (typeof a === 'string') ? a !== 'down' : (a.up ?? a.direction !== 'down');
		if (a && a.index !== undefined) state.selected = a.index;
		await moveLayer(up);
		return state.selected;
	});
	app.command('place', async (a) => {
		const t = textOf(state.selected);
		if (!t) throw new Error(tr('msg.needText'));
		const body = { index: t.index };
		if (a.dx !== undefined || a.dy !== undefined) {
			body.dx = a.dx || 0; body.dy = a.dy || 0;
		}
		if (a.x !== undefined) body.dx = a.x - t.rect[0];
		if (a.y !== undefined) body.dy = a.y - t.rect[1];
		if (a.width !== undefined)  body.width = a.width;
		if (a.height !== undefined) body.height = a.height;
		const r = await app.post('/api/psd/place', body);
		applyDoc(r, { keepVisibility: true });
		const n = textOf(t.index);
		return n ? { rect: n.rect, boxWidth: n.boxWidth, boxHeight: n.boxHeight } : null;
	});
	app.command('duplicate', async (a) => {
		const t = textOf(state.selected);
		if (!t) throw new Error(tr('msg.needText'));
		const r = await app.post('/api/psd/duplicate', {
			index: t.index,
			name: (a && a.name) || (t.name + ' copy'),
			text: (a && a.text !== undefined) ? a.text : t.text,
		});
		applyDoc(r, { keepVisibility: true });
		if (typeof r.index === 'number') select(r.index);
		return r.index;
	});
	app.command('rename', async (a) => {
		const index = (a.index !== undefined) ? a.index : state.selected;
		const r = await app.post('/api/psd/name', { index, name: a.name ?? String(a) });
		applyDoc(r, { keepVisibility: true });
		return nodeOf(index) ? nodeOf(index).name : null;
	});
	app.command('lang', (a) => changeLang(typeof a === 'string' ? a : a.lang));
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
/// 表示言語を切り替えて、動的に組んだ文言も作り直す。
/// viewStatus は描画のたびに作るので再描画も促す。
function changeLang(next) {
	setLang(next);
	$('#langSel').value = currentLang();
	helpLoaded = false;              // ヘルプは言語別ファイルなので読み直す
	$('#helpBody').textContent = '';
	renderAll();
	updateViewNote();
	applyZoom();
	scheduleRedraw();
	return currentLang();
}

//---------------------------------------------------------------------------
// 起動
//---------------------------------------------------------------------------
async function main() {
	// 文言は DOM を組み立てる前に一度当てておく (初期表示が英語で出るように)
	initLang();
	applyI18n();
	$('#langSel').value = currentLang();
	$('#langSel').addEventListener('change', (e) => changeLang(e.target.value));

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
		if ($('#fsList').childElementCount) return;      // 開いた場所を保つ
		// 前回開いたフォルダから始める。無ければカレント。
		if (state.settings.lastDir) { browseTo(state.settings.lastDir); return; }
		const roots = await app.get('/api/fs/roots').catch(() => null);
		const cwd = roots && (roots.roots || []).find(r => r.kind === 'cwd');
		browseTo(cwd ? cwd.path : '.');
	});
	$('#openGo').addEventListener('click', () => {
		const p = $('#openPath').value.trim();
		if (/\.psd$/i.test(p)) openPsd(p); else browseTo(p);
	});
	$('#openPath').addEventListener('keydown', e => { if (e.key === 'Enter') $('#openGo').click(); });

	$('#sheetBtn').addEventListener('click', openSheet);
	$('#sheetApply').addEventListener('click', applySheet);
	$('#sheetReload').addEventListener('click', () => { loadSheet(); setSheetStatus(tr('sheet.reloaded')); });
	$('#exportBtn').addEventListener('click', openExportDialog);
	$('#expGo').addEventListener('click', exportCsvToFile);
	$('#expDownload').addEventListener('click', () => {
		// ブラウザのダウンロードで受け取りたいとき用 (置き場所はブラウザ任せ)
		window.location.href = app._url('/api/psd/export', { t: app.token });
		$('#exportDialog').hidden = true;
	});
	$('#importBtn').addEventListener('click', () => {
		state.pendingCsv = null;
		$('#csvApply').disabled = true;
		$('#csvReport').textContent = '';
		$('#csvFile').value = '';
		$('#impPath').value = state.csvPath || state.info.csvPath || '';
		$('#importDialog').hidden = false;
	});
	$('#impRead').addEventListener('click', () => {
		const path = $('#impPath').value.trim();
		if (path) importCsv(false, { path });
	});
	$('#csvApply').addEventListener('click', () => importCsv(true));
	$('#csvFile').addEventListener('change', async () => {
		state.pendingCsv = null;
		$('#csvApply').disabled = true;
		const file = $('#csvFile').files[0];
		if (file) importCsv(false, { bytes: await file.arrayBuffer(), name: file.name });
	});

	$('#saveBtn').addEventListener('click', () => {
		$('#savePath').value = '';
		$('#saveDialog').hidden = false;
	});
	$('#saveGo').addEventListener('click', save);

	$('#helpBtn').addEventListener('click', () => openHelp());
	$('#viewNoteMore').addEventListener('click', () => openHelp('#h-limits'));
	$('#logBtn').addEventListener('click', () => { $('#logPanel').hidden = !$('#logPanel').hidden; });
	$('#logClose').addEventListener('click', () => { $('#logPanel').hidden = true; });

	document.querySelectorAll('[data-close]').forEach(b =>
		b.addEventListener('click', e => { e.target.closest('.modal').hidden = true; }));
	// 背景を押して背景で離したときだけ閉じる。
	// 入力欄の文字をドラッグで全選択すると、指を離す位置がダイアログの外へ
	// はみ出しがちで、離した位置だけを見ていると勝手に閉じてしまう。
	document.querySelectorAll('.modal').forEach(m => {
		let fromBackdrop = false;
		m.addEventListener('mousedown', e => { fromBackdrop = (e.target === m); });
		m.addEventListener('click', e => {
			if (e.target === m && fromBackdrop) m.hidden = true;
			fromBackdrop = false;
		});
	});

	// --- 左ペイン ---
	$('#filter').addEventListener('input', e => { state.filter = e.target.value; renderTree(); });
	document.querySelectorAll('.flt').forEach(b => b.addEventListener('click', () => {
		const k = b.dataset.flt;
		state.listFilter[k] = !state.listFilter[k];
		b.classList.toggle('on', state.listFilter[k]);
		renderTree();
	}));
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
	$('#dupBtn').addEventListener('click', openDupDialog);
	$('#dupGo').addEventListener('click', duplicateLayer);
	$('#dupClear').addEventListener('click', () => { $('#dupText').value = ''; $('#dupText').focus(); });
	$('#moveUpBtn').addEventListener('click', () => moveLayer(true));
	$('#moveDownBtn').addEventListener('click', () => moveLayer(false));

	// --- 中央ペイン ---
	$('#zoomIn').addEventListener('click', () => { state.zoom = Math.min(8, state.zoom * 1.25); applyZoom(); });
	$('#zoomOut').addEventListener('click', () => { state.zoom = Math.max(0.02, state.zoom / 1.25); applyZoom(); });
	$('#zoomLevel').addEventListener('click', () => { state.zoom = 1; applyZoom(); });
	$('#zoomFit').addEventListener('click', fitZoom);
	$('#renderText').addEventListener('change', e => {
		state.renderText = e.target.checked;
		scheduleRedraw();
	});
	updateViewNote();
	$('#showBounds').addEventListener('change', e => {
		state.showBounds = e.target.checked;
		scheduleRedraw();
	});
	setupCanvasDrag();
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
	const ta = bodyEl();
	ta.addEventListener('input', () => { if (!state.composing) onBodyInput(); });
	// IME の変換中に DOM を触ると入力が壊れるので、確定するまで待つ
	ta.addEventListener('compositionstart', () => { state.composing = true; });
	ta.addEventListener('compositionend', () => { state.composing = false; onBodyInput(); });
	ta.addEventListener('keydown', e => {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			// Shift 付きなら、反映してそのまま次のレイヤへ (打ち替えを続けやすく)
			if (e.shiftKey) applyAndNext();
			else applyText();
		}
	});
	ta.addEventListener('click', onBodyClick);
	// カーソル / 選択範囲が動いたら書式パネルの編集対象を切り替える
	document.addEventListener('selectionchange', () => {
		if (!state.composing && document.activeElement === ta) syncFmtFromCaret();
	});
	$('#applyBtn').addEventListener('click', applyText);
	$('#revertBtn').addEventListener('click', revertText);

	// --- 基準パネル (レイヤ全体の初期書式) ---
	$('#boldBtn').addEventListener('click',   () => toggleBaseFlag('bold'));
	$('#italicBtn').addEventListener('click', () => toggleBaseFlag('italic'));
	$('#underBtn').addEventListener('click',  () => toggleBaseFlag('underline'));
	$('#fontSel').addEventListener('change', e => setBaseStyle('font', e.target.value));
	$('#sizeInput').addEventListener('change', e => {
		const v = parseFloat(e.target.value);
		if (v > 0) setBaseStyle('size', v);
	});
	$('#colorInput').addEventListener('change',
		e => setBaseStyle('color', e.target.value.toUpperCase()));
	$('#colorHex').addEventListener('change', e => {
		const c = tg.normColor(e.target.value);
		if (/^#[0-9A-F]{6}$/.test(c)) setBaseStyle('color', c);
		else renderFormat();          // 書き損じは元の値へ戻す
	});

	// --- マーク ---
	$('#markAddBtn').addEventListener('click', insertMark);
	$('#markDelBtn').addEventListener('click', deleteSelectedMark);
	// 位置は絶対値で入れてもらい、差分にして送る
	const commitPos = () => {
		const t = state.selected === null ? null : textOf(state.selected);
		if (!t) return;
		const nx = parseFloat($('#posX').value);
		const ny = parseFloat($('#posY').value);
		if (!isFinite(nx) || !isFinite(ny)) return;
		moveText(nx - t.rect[0], ny - t.rect[1]);
	};
	$('#posX').addEventListener('change', commitPos);
	$('#posY').addEventListener('change', commitPos);

	const commitBox = () => {
		const w = parseFloat($('#boxW').value);
		const h = parseFloat($('#boxH').value);
		if (isFinite(w) && isFinite(h) && w >= 1 && h >= 1) resizeText(w, h);
	};
	$('#boxW').addEventListener('change', commitBox);
	$('#boxH').addEventListener('change', commitBox);

	// --- 複数選択したときの一括操作 ---
	$('#mFontBtn').addEventListener('click', () => openFontDialog('multi'));
	$('#mSizeGo').addEventListener('click', () => {
		const v = parseFloat($('#mSize').value);
		if (v > 0) applyStyleToSelection({ size: v });
	});
	$('#mColorGo').addEventListener('click',
		() => applyStyleToSelection({ color: $('#mColor').value.toUpperCase() }));
	$('#mBold').addEventListener('click',   () => toggleSelectionFlag('bold'));
	$('#mItalic').addEventListener('click', () => toggleSelectionFlag('italic'));
	$('#mUnder').addEventListener('click',  () => toggleSelectionFlag('underline'));
	document.querySelectorAll('.malign').forEach(b =>
		b.addEventListener('click', () => applyAlignToSelection(Number(b.dataset.align))));
	$('#mCopyStyle').addEventListener('click', copyStyleFromSelection);
	$('#mPasteStyle').addEventListener('click', pasteStyleToSelection);
	$('#mDup').addEventListener('click', openDupDialog);
	$('#mExport').addEventListener('click', () => { state.exportSel = true; openExportDialog(); });

	$('#fontAddBtn').addEventListener('click', () => openFontDialog('base'));
	$('#fontFilter').addEventListener('input', renderSysFonts);
	$('#fontAddGo').addEventListener('click', () => pickFont($('#fontManual').value));
	$('#fontPresetSel').addEventListener('change', (e) => {
		state.settings.fontPreset = e.target.value;
		app.post('/api/app/settings', { fontPreset: e.target.value }).catch(() => {});
		renderSysFonts();
	});
	$('#fontPresetNew').addEventListener('click', () => {
		const name = prompt(tr('dlg.fontPresetAsk'), '');
		if (!name) return;
		const all = Object.assign({}, state.settings.fontPresets || {});
		if (!all[name]) all[name] = [];
		state.settings.fontPresets = all;
		state.settings.fontPreset = name;
		app.post('/api/app/settings', { fontPresets: all, fontPreset: name }).catch(() => {});
		renderPresetBar();
		renderSysFonts();
	});
	document.querySelectorAll('.align').forEach(b =>
		b.addEventListener('click', () => setAlign(Number(b.dataset.align))));

	document.addEventListener('keydown', e => {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#saveBtn').click(); }
		// Alt+↑/↓ で前後のテキストレイヤへ (本文にカーソルがあっても効く)
		if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
			e.preventDefault();
			gotoAdjacentText(e.key === 'ArrowDown' ? 1 : -1);
			return;
		}
		// 編集欄や入力欄にカーソルが無いときだけ、矢印キーで 1px ずつ動かす
		// (本文は contenteditable なので isContentEditable でも見る)
		const el = document.activeElement || document.body;
		const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
		if (!inField && state.selected !== null &&
		    ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
			e.preventDefault();
			const step = e.shiftKey ? 10 : 1;
			moveText(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
			         e.key === 'ArrowUp'   ? -step : e.key === 'ArrowDown'  ? step : 0);
		}
		if (e.key === 'F1') { e.preventDefault(); openHelp(); }
		if (e.key === 'F2' && document.activeElement !== $('#editText')) {
			e.preventDefault();
			renameSelected();
		}
		if (e.key === 'Escape') document.querySelectorAll('.modal:not([hidden])')
			.forEach(m => { m.hidden = true; });
	});

	setupDrop();
	watchWindowBox();
	watchServer();

	// --- 起動時に開くファイル ---
	state.settings = await app.get('/api/app/settings').catch(() => ({})) || {};
	const startup = await app.get('/api/app/startup').catch(() => null);
	if (startup && startup.open) {
		await openPsd(startup.open);
	} else {
		// すでにサーバ側で開いている文書があれば拾う。REPL や API から開いた
		// 場合や、画面だけ開き直した場合に、空の画面が出てしまわないように。
		const info = await app.get('/api/psd/info').catch(() => null);
		if (info && info.open) {
			try {
				const [tree, texts] = await Promise.all([
					app.get('/api/psd/tree'), app.get('/api/psd/texts'),
				]);
				state.needFit = true;
				applyDoc({ info, tree, texts });
				const first = state.texts[0];
				if (first) select(first.index);
			} catch (e) { renderAll(); }
		} else {
			renderAll();
		}
	}
}

//---------------------------------------------------------------------------
/// 画面へのファイルのドロップ。
///
/// PSD は開けない。ブラウザはセキュリティ上、ドロップされたファイルの
/// **実際のパス**を渡してくれないので、「元のファイルをその場で開いて、
/// 編集していないレイヤはバイト単位で保つ」という psdtext のやり方が成立
/// しない。PSD は exe / ショートカットへ落としてもらう (それは今でも動く)。
///
/// CSV は中身さえあればよいので、そのまま取り込みに回せる。
function setupDrop() {
	// 既定の動作 (ページがそのファイルへ遷移して UI が消える) は必ず止める
	document.addEventListener('dragover', e => { e.preventDefault(); });
	document.addEventListener('drop', async (e) => {
		e.preventDefault();
		const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
		if (!file) return;

		if (/\.csv$/i.test(file.name)) {
			if (!state.info.open) { toast(tr('msg.dropNeedPsd'), true); return; }
			$('#csvReport').textContent = '';
			$('#csvApply').disabled = true;
			$('#csvFile').value = '';
			$('#impPath').value = state.csvPath || state.info.csvPath || '';
			$('#importDialog').hidden = false;
			importCsv(false, { bytes: await file.arrayBuffer(), name: file.name });
			return;
		}
		toast(tr('msg.dropPsd', file.name), true);
	});
}

//---------------------------------------------------------------------------
/// ウィンドウの大きさと位置を覚えておく (次に開いたとき同じ場所に出す)。
/// 起動時のブラウザ引数はサーバ側が settings.json から組み立てるので、
/// ここでは記録するだけ。
function watchWindowBox() {
	let last = '';
	const save = () => {
		const box = {
			w: window.outerWidth, h: window.outerHeight,
			x: window.screenX, y: window.screenY,
		};
		if (box.w < 300 || box.h < 200) return;      // 最小化中などは覚えない
		const key = [box.w, box.h, box.x, box.y].join(',');
		if (key === last) return;
		last = key;
		app.post('/api/app/settings', { window: box }).catch(() => {});
	};
	let timer = 0;
	window.addEventListener('resize', () => {
		clearTimeout(timer);
		timer = setTimeout(save, 800);
	});
	// 位置だけ動かしたときはイベントが来ないので、ときどき見る
	setInterval(save, 5000);
	window.addEventListener('pagehide', save);
}

//---------------------------------------------------------------------------
/// サーバが終了したらこの画面も畳む。
///
/// psdtext は「exe 1 本 + ブラウザ」なので、サーバを止めた (テストで開き直した /
/// 別の PSD で起動し直した) あとにウィンドウだけが残る。見た目は生きている
/// ままなので、どれが今の作業用なのか分からなくなる。
///
/// script から開いたウィンドウでないと close() が効かないブラウザがあるので、
/// 閉じられなかった場合に備えて画面にも大きく出しておく。
function watchServer() {
	let miss = 0;
	const opened = performance.now();
	setInterval(async () => {
		if (state.serverGone) return;
		try {
			await app.get('/_app/info');
			miss = 0;
		} catch (e) {
			// 開いた直後は、まだ起動中 / 再起動待ちのことがあるので数えない
			if (performance.now() - opened < 15000) return;
			// HTTP の答えが返っている (状態コードがある) ならサーバは生きている。
			// 閉じるのは、続けて繋がらなくなったときだけ。
			if (e && e.status) { miss = 0; return; }
			if (++miss >= 3) serverGone();
		}
	}, 3000);
}

function serverGone() {
	if (state.serverGone) return;
	state.serverGone = true;
	clearTimeout(state.redrawTimer);
	document.title = '× ' + document.title;
	const box = document.createElement('div');
	box.id = 'goneOverlay';
	const msg = document.createElement('div');
	msg.className = 'gone-msg';
	msg.textContent = tr('app.serverGone');
	box.appendChild(msg);
	document.body.appendChild(box);
	window.close();     // 閉じられれば一番よい (閉じられなければ上の表示が残る)
}

/// 内蔵ヘルプを開く (web/help.html を読み込む。exe にも埋め込まれている)
let helpLoaded = false;
async function openHelp(anchor) {
	const dlg = $('#helpDialog');
	dlg.hidden = false;
	if (!helpLoaded) $('#helpBody').textContent = tr('dlg.loading');
	if (!helpLoaded) {
		try {
			// 英語が help.html、日本語が help_ja.html (README と同じ規約)
			const res = await fetch(currentLang() === 'ja' ? './help_ja.html' : './help.html');
			$('#helpBody').innerHTML = await res.text();
			helpLoaded = true;
			// 目次のリンクはモーダル内でスクロールさせる (ページ遷移させない)
			$('#helpBody').querySelectorAll('.help-toc a').forEach(a => {
				a.addEventListener('click', (e) => {
					e.preventDefault();
					const el = $('#helpBody').querySelector(a.getAttribute('href'));
					if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
				});
			});
		} catch (e) {
			$('#helpBody').textContent = tr('msg.helpFailed', e.message);
		}
	}
	if (anchor) {
		const el = $('#helpBody').querySelector(anchor);
		if (el) el.scrollIntoView({ block: 'start' });
	} else {
		$('#helpBody').scrollTop = 0;
	}
}

/// 更新通知 (SSE) を受けて一覧を取り直す。
/// 反映の途中で走らせると、取ってきた内容のほうが古くて編集を巻き戻して
/// しまうことがあるので、そのときは後回しにする。
async function refreshAll() {
	if (state.applying) { state.refreshPending = true; return; }
	try {
		const [texts, tree] = await Promise.all([
			app.get('/api/psd/texts'), app.get('/api/psd/tree'),
		]);
		if (state.applying) { state.refreshPending = true; return; }
		// 編集欄の入れ直しは renderEditor が中身を見て決める (自分の編集で
		// カーソルが飛ばないように)
		applyDoc({ info: state.info, texts, tree }, { keepVisibility: true });
	} catch (e) { /* 文書が閉じられた等 */ }
}

main().catch(e => {
	toast(tr('msg.startFailed', e.message), true);
	console.error(e);
});
