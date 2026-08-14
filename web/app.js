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
	sysFonts: [],
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

function renderTree() {
	const host = $('#tree');
	host.textContent = '';
	const dirtySet = new Set(state.texts.filter(t => t.dirty).map(t => t.index));
	const hasChild = new Set(state.tree.map(l => l.parent).filter(p => p >= 0));

	// PSD の layerList は下から上。Photoshop の表示に合わせて逆順にする。
	for (const l of [...state.tree].reverse()) {
		if (l.kind === 'divider') continue;   // フォルダの区切りは内部表現なので出さない
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
		row.addEventListener('click', () => select(l.index));
		host.appendChild(row);
	}

	const sel = state.selected === null ? null : nodeOf(state.selected);
	$('#renameBtn').disabled   = !sel;                 // 名前はどのレイヤでも変えられる
	$('#dupBtn').disabled      = !(sel && sel.text);   // 複製はテキストレイヤのみ
	$('#moveUpBtn').disabled   = !sel;
	$('#moveDownBtn').disabled = !sel;
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
	for (const f of [st.font, ...(t.fonts || [])]) {
		if (!f || seen.has(f)) continue;
		seen.add(f);
		const o = document.createElement('option');
		o.value = f;
		o.textContent = f + (fontAvailable(f) ? '' : '  ' + tr('edit.fontNotHere'));
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
			btn.textContent = value || tr('fmt.pickFont');
			btn.title = tr('fmt.pickFont.title');
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
function openDupDialog() {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	$('#dupName').value = t.name + ' copy';
	$('#dupText').value = t.text;
	$('#dupDialog').hidden = false;
	$('#dupName').focus();
	$('#dupName').select();
}

async function duplicateLayer() {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	const body = {
		index: t.index,
		name: $('#dupName').value.trim() || (t.name + ' copy'),
		text: $('#dupText').value,
	};
	try {
		const r = await app.post('/api/psd/duplicate', body);
		$('#dupDialog').hidden = true;
		$('#editText').dataset.index = '';
		applyDoc(r, { keepVisibility: true });
		if (typeof r.index === 'number') {
			state.visible.set(r.index, true);
			select(r.index);
		}
		toast(tr('msg.duplicated'));
	} catch (e) {
		toast(serverMessage(e.message), true);
	}
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
/// target は 'base' (レイヤの初期書式) か 'mark' (選択中のマーク / 範囲)
async function openFontDialog(target) {
	if (!curText()) { toast(tr('msg.needText'), true); return; }
	state.fontTarget = target || 'base';
	$('#fontDialog').hidden = false;
	$('#fontManual').value = '';
	$('#fontDlgTarget').textContent =
		tr(state.fontTarget === 'base' ? 'dlg.fontForBase' : 'dlg.fontForMark');

	// まず PSD が持っているフォントだけで一覧を出す。システムフォントの取得は
	// 許可待ちで止まることがあり、それを待ってから描くと一覧が空のままになる。
	renderSysFonts();
	if (!state.sysFonts.length) {
		try {
			// Local Font Access API (Chromium)。使えなければ手入力に頼る。
			if (window.queryLocalFonts) {
				const list = await window.queryLocalFonts();
				const names = new Set();
				for (const f of list) names.add(f.postscriptName || f.fullName);
				state.sysFonts = [...names].sort();
				renderSysFonts();
			}
		} catch (e) { /* 権限拒否など。手入力へ */ }
	}
}

function renderSysFonts() {
	const host = $('#sysFontList');
	host.textContent = '';
	const f = $('#fontFilter').value.trim().toLowerCase();
	const hit = (n) => !f || n.toLowerCase().includes(f);

	const group = (label) => {
		const d = document.createElement('div');
		d.className = 'fs-group';
		d.textContent = label;
		host.appendChild(d);
	};
	const row = (n) => {
		const d = document.createElement('div');
		d.className = 'fs-row';
		d.textContent = n + (fontAvailable(n) ? '' : '  ' + tr('edit.fontNotHere'));
		d.style.fontFamily = `"${n}", sans-serif`;
		d.addEventListener('click', () => pickFont(n));
		host.appendChild(d);
	};

	// この PSD が持っているフォントを先に出す。Photoshop 側にも確実にある
	// ぶんなので、まずここから選べるほうが安全。
	const t = curText();
	const own = [...new Set(t ? (t.fonts || []) : [])].filter(hit);
	if (own.length) {
		group(tr('dlg.fontOwn'));
		own.forEach(row);
	}
	if (state.sysFonts.length) {
		group(tr('dlg.fontSystem'));
		state.sysFonts.filter(hit).slice(0, 400).forEach(row);
	} else {
		const p = document.createElement('p');
		p.className = 'hint';
		p.textContent = tr('dlg.fontNoList');
		host.appendChild(p);
	}
}

/// 一覧 / 手入力から選ばれたフォントを、開いたときの適用先へ入れる
function pickFont(name) {
	const n = String(name || '').trim();
	if (!n) return;
	const t = curText();
	if (!t) return;
	if (!t.fonts.includes(n)) t.fonts.push(n);
	$('#fontDialog').hidden = true;
	if (state.fontTarget === 'base') setBaseStyle('font', n);
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
	} catch (e) {
		toast(serverMessage(e.message), true);
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
		? tr('csv.applied', r.changed, r.same, r.notfound, r.failed)
		: tr('csv.dry', r.changed, r.same, r.notfound);
	host.appendChild(sum);

	const shown = (r.rows || []).filter(x => x.status !== 'same');
	if (!shown.length) {
		const p = document.createElement('p');
		p.className = 'hint';
		p.textContent = tr('csv.noDiff');
		host.appendChild(p);
		return;
	}
	const table = document.createElement('table');
	table.innerHTML = `<tr><th>${tr('csv.col.status')}</th><th>lyid</th>` +
		`<th>${tr('csv.col.layer')}</th><th>${tr('csv.col.note')}</th></tr>`;
	for (const row of shown.slice(0, 300)) {
		const tr = document.createElement('tr');
		const st = document.createElement('td');
		st.className = row.status;
		st.textContent = { changed: tr('csv.changed'), notfound: tr('csv.notfound'),
		                   error: tr('csv.error') }[row.status] || row.status;
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
	if (!file && !state.pendingCsv) { toast(tr('msg.pickCsv'), true); return; }
	const text = file ? await file.text() : state.pendingCsv;
	try {
		const r = await app.post('/api/psd/import', { csv: text, apply });
		renderReport(r);
		if (apply) {
			applyDoc(r, { keepVisibility: true });
			$('#editText').dataset.index = '';
			state.pendingCsv = null;
			$('#csvApply').disabled = true;
			toast(tr('msg.csvUpdated', r.changed));
		} else {
			state.pendingCsv = text;
			$('#csvApply').disabled = (r.changed === 0);
		}
	} catch (e) {
		toast(serverMessage(e.message), true);
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

	$('#helpBtn').addEventListener('click', () => openHelp());
	$('#viewNoteMore').addEventListener('click', () => openHelp('#h-limits'));
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
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyText(); }
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

	$('#fontAddBtn').addEventListener('click', () => openFontDialog('base'));
	$('#fontFilter').addEventListener('input', renderSysFonts);
	$('#fontAddGo').addEventListener('click', () => pickFont($('#fontManual').value));
	document.querySelectorAll('.align').forEach(b =>
		b.addEventListener('click', () => setAlign(Number(b.dataset.align))));

	document.addEventListener('keydown', e => {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#saveBtn').click(); }
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

	watchServer();

	// --- 起動時に開くファイル ---
	const startup = await app.get('/api/app/startup').catch(() => null);
	if (startup && startup.open) await openPsd(startup.open);
	else renderAll();
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
