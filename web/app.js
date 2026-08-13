//---------------------------------------------------------------------------
// psdtext UI
//
// C++ 側 (/api/psd/*) が PSD の実体を持ち、ここは表示と編集操作だけを担当する。
// REPL から観測・操作できるよう app.command() / app.exposeState() も生やす。
//---------------------------------------------------------------------------
import { app } from './lib/appserve.js';

const $ = (s) => document.querySelector(s);

const state = {
	info: { open: false },
	tree: [],
	texts: [],
	selected: null,     // index
	filter: '',
	onlyText: true,
	fsCwd: null,
	pendingCsv: null,   // 確認済みで反映待ちの CSV 本文
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

function textOf(index) {
	return state.texts.find(t => t.index === index) || null;
}

//---------------------------------------------------------------------------
// 文書の反映
//---------------------------------------------------------------------------
function applyDoc(res) {
	if (res.info) {
		state.info = res.info;
	} else if (typeof res.open === 'boolean') {
		state.info = res;
	}
	if (Array.isArray(res.tree))  state.tree  = res.tree;
	if (Array.isArray(res.texts)) state.texts = res.texts;
	renderAll();
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

	$('#saveBtn').disabled = !info.open;
	$('#exportBtn').disabled = !info.open;
	$('#importBtn').disabled = !info.open;

	renderTree();
	renderList();
	renderEditor();
}

//---------------------------------------------------------------------------
// レイヤツリー
//---------------------------------------------------------------------------
const KIND_ICON = {
	folder: '📁', text: 'T', image: '🖼', adjust: '◐', fill: '■', divider: '·',
};

function renderTree() {
	const host = $('#tree');
	host.textContent = '';
	const dirtySet = new Set(state.texts.filter(t => t.dirty).map(t => t.index));

	// PSD の layerList は下から上の順。Photoshop の表示に合わせて逆順にする。
	for (const l of [...state.tree].reverse()) {
		if (state.onlyText && !l.text && l.kind !== 'folder') continue;
		const row = document.createElement('div');
		row.className = 'tree-row' + (l.text ? ' is-text' : '') +
			(l.visible ? '' : ' hidden-layer') +
			(dirtySet.has(l.index) ? ' dirty' : '') +
			(state.selected === l.index ? ' sel' : '');
		row.style.paddingLeft = (l.depth * 12 + 6) + 'px';
		row.dataset.index = l.index;

		const icon = document.createElement('span');
		icon.className = 'tree-icon';
		icon.textContent = KIND_ICON[l.kind] || '·';
		const name = document.createElement('span');
		name.className = 'tree-name';
		name.textContent = l.name;

		row.append(icon, name);
		row.title = l.path;
		if (l.text) row.addEventListener('click', () => select(l.index));
		host.appendChild(row);
	}
}

//---------------------------------------------------------------------------
// テキスト一覧
//---------------------------------------------------------------------------
function filtered() {
	const f = state.filter.trim().toLowerCase();
	if (!f) return state.texts;
	return state.texts.filter(t =>
		t.path.toLowerCase().includes(f) || t.text.toLowerCase().includes(f));
}

function renderList() {
	const rows = filtered();
	$('#listCount').textContent = state.info.open
		? `テキストレイヤ ${rows.length} / ${state.texts.length}`
		: 'PSD を開いてください';

	const host = $('#list');
	host.textContent = '';
	for (const t of rows) {
		const item = document.createElement('div');
		item.className = 'item' + (t.dirty ? ' dirty' : '') +
			(t.text ? '' : ' empty') + (state.selected === t.index ? ' sel' : '');
		item.dataset.index = t.index;

		const head = document.createElement('div');
		head.className = 'item-head';
		const path = document.createElement('span');
		path.className = 'item-path';
		path.textContent = t.path;
		const meta = document.createElement('span');
		meta.className = 'item-meta';
		meta.textContent = [t.font, t.fontSize ? t.fontSize.toFixed(1) + 'px' : '']
			.filter(Boolean).join(' ');
		head.append(path, meta);

		const body = document.createElement('div');
		body.className = 'item-text';
		body.textContent = t.text || '(空)';

		item.append(head, body);
		item.addEventListener('click', () => select(t.index));
		host.appendChild(item);
	}
}

//---------------------------------------------------------------------------
// 編集ペイン
//---------------------------------------------------------------------------
function select(index) {
	state.selected = index;
	renderTree();
	renderList();
	renderEditor();
	loadPreview(index);
	const el = document.querySelector(`.item[data-index="${index}"]`);
	if (el) el.scrollIntoView({ block: 'nearest' });
}

function renderEditor() {
	const t = state.selected === null ? null : textOf(state.selected);
	const ta = $('#editText');
	const meta = $('#editMeta');
	meta.textContent = '';

	if (!t) {
		ta.value = '';
		ta.disabled = true;
		$('#applyBtn').disabled = true;
		$('#revertBtn').disabled = true;
		setEditStatus('');
		return;
	}

	const rows = [
		['レイヤ', t.path],
		['lyid', String(t.lyid || '(なし)')],
		['フォント', [t.font, t.fontSize ? t.fontSize.toFixed(1) + 'px' : ''].filter(Boolean).join(' ') || '(不明)'],
		['位置', `${t.rect[0]}, ${t.rect[1]} — ${t.rect[2] - t.rect[0]}×${t.rect[3] - t.rect[1]}`],
	];
	for (const [k, v] of rows) {
		const d = document.createElement('div');
		const ks = document.createElement('span'); ks.className = 'k'; ks.textContent = k;
		const vs = document.createElement('span'); vs.className = 'v'; vs.textContent = v;
		d.append(ks, vs);
		meta.appendChild(d);
	}

	// 編集中の内容は保持したいので、選択が変わったときだけ値を入れ直す
	if (ta.dataset.index !== String(t.index)) {
		ta.value = t.text;
		ta.dataset.index = String(t.index);
	}
	ta.disabled = false;
	$('#applyBtn').disabled = (ta.value === t.text);
	$('#revertBtn').disabled = !t.dirty;
	setEditStatus(t.dirty ? '未保存の変更あり' : '', t.dirty ? 'ok' : '');
}

async function applyText() {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	const value = $('#editText').value;
	try {
		const updated = await app.post('/api/psd/text', { index: t.index, text: value });
		Object.assign(t, updated);
		state.info.dirty = state.texts.filter(x => x.dirty).length;
		renderAll();
		setEditStatus('反映しました', 'ok');
	} catch (e) {
		setEditStatus(e.message, 'error');
	}
}

async function revertText() {
	const t = state.selected === null ? null : textOf(state.selected);
	if (!t) return;
	try {
		const updated = await app.post('/api/psd/revert', { index: t.index });
		Object.assign(t, updated);
		$('#editText').dataset.index = '';       // 値を入れ直させる
		state.info.dirty = state.texts.filter(x => x.dirty).length;
		renderAll();
	} catch (e) {
		setEditStatus(e.message, 'error');
	}
}

//---------------------------------------------------------------------------
// プレビュー (生 RGBA を canvas へ)
//---------------------------------------------------------------------------
async function loadPreview(index) {
	const canvas = $('#preview');
	const ctx = canvas.getContext('2d');
	try {
		const res = await fetch(app._url('/api/psd/image', { index }), {
			headers: { 'X-App-Token': app.token },
		});
		if (!res.ok) throw new Error(String(res.status));
		const w = parseInt(res.headers.get('x-image-width') || '0', 10);
		const h = parseInt(res.headers.get('x-image-height') || '0', 10);
		const buf = await res.arrayBuffer();
		if (!w || !h || buf.byteLength < w * h * 4) throw new Error('empty');
		canvas.width = w;
		canvas.height = h;
		// C++ 側が ColorFormat(0,8,16,24) で書いているので、そのまま RGBA 並び。
		ctx.putImageData(new ImageData(new Uint8ClampedArray(buf, 0, w * h * 4), w, h), 0, 0);
		canvas.hidden = false;
	} catch (e) {
		canvas.width = canvas.height = 1;
		ctx.clearRect(0, 0, 1, 1);
	}
}

//---------------------------------------------------------------------------
// ファイルを開く (appserve 標準の FS API を使った簡易ブラウザ)
//---------------------------------------------------------------------------
function openModal(sel)  { $(sel).hidden = false; }
function closeModal(sel) { $(sel).hidden = true; }

async function browseTo(path) {
	try {
		const r = await app.get('/api/fs/list', { path });
		state.fsCwd = r.path;
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
		closeModal('#openDialog');
		state.selected = null;
		$('#editText').dataset.index = '';
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
function csvUrl() {
	return app._url('/api/psd/export', { t: app.token });
}

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
			applyDoc(r);
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
// 保存
//---------------------------------------------------------------------------
async function save() {
	try {
		const r = await app.post('/api/psd/save', {
			path: $('#savePath').value.trim(),
			backup: $('#saveBackup').checked,
		});
		closeModal('#saveDialog');
		$('#editText').dataset.index = '';
		applyDoc(r);
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
	app.command('apply',  () => applyText());
	app.command('save',   () => save());
	app.command('filter', (a) => { state.filter = String(a ?? ''); $('#filter').value = state.filter; renderList(); });

	app.exposeState(() => ({
		path: state.info.path || null,
		layers: state.tree.length,
		texts: state.texts.length,
		dirty: state.info.dirty || 0,
		selected: state.selected,
		selectedText: state.selected !== null ? (textOf(state.selected) || {}).text : null,
	}));
}

//---------------------------------------------------------------------------
// 起動
//---------------------------------------------------------------------------
async function main() {
	await app.ready();
	setupReplBridge();

	// サーバ側の変更通知 (REPL 経由の編集などを画面に反映する)
	app.on('psd', (info) => {
		state.info = info;
		if (info.open) refreshTexts();
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
		openModal('#openDialog');
		if (!state.fsCwd) {
			const roots = await app.get('/api/fs/roots');
			const cwd = (roots.roots || []).find(r => r.kind === 'cwd');
			browseTo(cwd ? cwd.path : '.');
		}
	});
	$('#openGo').addEventListener('click', () => {
		const p = $('#openPath').value.trim();
		if (/\.psd$/i.test(p)) openPsd(p); else browseTo(p);
	});
	$('#openPath').addEventListener('keydown', e => { if (e.key === 'Enter') $('#openGo').click(); });

	$('#exportBtn').addEventListener('click', () => { window.location.href = csvUrl(); });
	$('#importBtn').addEventListener('click', () => {
		state.pendingCsv = null;
		$('#csvApply').disabled = true;
		$('#csvReport').textContent = '';
		openModal('#importDialog');
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
		openModal('#saveDialog');
	});
	$('#saveGo').addEventListener('click', save);

	$('#logBtn').addEventListener('click', () => { $('#logPanel').hidden = !$('#logPanel').hidden; });
	$('#logClose').addEventListener('click', () => { $('#logPanel').hidden = true; });

	document.querySelectorAll('[data-close]').forEach(b =>
		b.addEventListener('click', e => { e.target.closest('.modal').hidden = true; }));
	document.querySelectorAll('.modal').forEach(m =>
		m.addEventListener('click', e => { if (e.target === m) m.hidden = true; }));

	// --- 絞り込み ---
	$('#filter').addEventListener('input', e => { state.filter = e.target.value; renderList(); });
	$('#onlyText').addEventListener('change', e => { state.onlyText = e.target.checked; renderTree(); });

	// --- 編集 ---
	$('#editText').addEventListener('input', () => {
		const t = state.selected === null ? null : textOf(state.selected);
		$('#applyBtn').disabled = !t || ($('#editText').value === t.text);
	});
	$('#editText').addEventListener('keydown', e => {
		if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyText(); }
	});
	$('#applyBtn').addEventListener('click', applyText);
	$('#revertBtn').addEventListener('click', revertText);

	document.addEventListener('keydown', e => {
		if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#saveBtn').click(); }
		if (e.key === 'Escape') document.querySelectorAll('.modal:not([hidden])')
			.forEach(m => { m.hidden = true; });
	});

	// --- 起動時に開くファイル ---
	const startup = await app.get('/api/app/startup').catch(() => null);
	if (startup && startup.open) await openPsd(startup.open);
	else renderAll();
}

async function refreshTexts() {
	try {
		state.texts = await app.get('/api/psd/texts');
		state.tree  = await app.get('/api/psd/tree');
		$('#editText').dataset.index = '';
		renderAll();
	} catch (e) { /* 文書が閉じられた等 */ }
}

main().catch(e => {
	toast('起動に失敗しました: ' + e.message, true);
	console.error(e);
});
