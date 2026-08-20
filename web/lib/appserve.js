//---------------------------------------------------------------------------
// appserve 標準ブラウザランタイム
//
// 派生アプリもこのファイルをそのまま使う。担当するのは:
//   - トークンの受け取りと全リクエストへの付与
//   - セッション確立 (/_app/hello) と死活通知
//   - サーバからのコマンド受信 (ロングポーリング) と実行結果の返送
//   - SSE によるログ / 任意チャネルの購読
//   - ページを閉じたときの即時通知 (サーバの自動終了を速める)
//
//   import { app } from './lib/appserve.js';
//   await app.ready();
//   const r = await app.get('/api/fs/list', { path: 'D:/' });
//   app.command('reload', () => refresh());       // .b call reload から呼べる
//   app.exposeState(() => ({ cwd, selected }));   // .b state から見える
//---------------------------------------------------------------------------

class Appserve {
	constructor() {
		this.sid = null;
		this.info = null;
		this.token = this._takeToken();
		this._commands = new Map();      // .b call <name>
		this._handlers = new Map();      // .b <custom>
		this._stateFn = null;
		this._listeners = new Map();     // channel -> Set<fn>
		this._sources = new Map();       // channel -> EventSource
		this._errors = [];
		this._readyPromise = null;
		this._stopped = false;
		this._pollBackoff = 0;

		// サーバが消えたときの自動終了。ブラウザ UI はサーバあってのものなので、
		// サーバが落ちたら窓も畳む (死んだ UI が残り続けるのを防ぐ)。
		// 一時的な通信断で閉じないよう、連続失敗が grace ms 続いてから判定する。
		this.exitOnDisconnect = true;    // ready() の前なら false にできる
		this.disconnectGraceMs = 6000;
		this._lostSince = null;
		this._lostListeners = new Set();

		window.addEventListener('error', (e) => {
			this._pushError(String(e.message) + ' @ ' + e.filename + ':' + e.lineno);
		});
		window.addEventListener('unhandledrejection', (e) => {
			this._pushError('unhandled rejection: ' + String(e.reason));
		});
		// ページを離れるときにセッションを畳む。これが届くとサーバは
		// idle-timeout を待たずに「接続ゼロ」を検知できる。
		window.addEventListener('pagehide', () => this._bye());
	}

	//-----------------------------------------------------------------------
	// 起動
	//-----------------------------------------------------------------------
	ready() {
		if (!this._readyPromise) this._readyPromise = this._start();
		return this._readyPromise;
	}

	async _start() {
		this.info = await this.get('/_app/info');
		const hello = await this.get('/_app/hello');
		this.sid = hello.sid;
		this._pollLoop();                 // await しない (常駐ループ)
		this._heartbeatLoop();
		return this.info;
	}

	/// URL の ?t=... を sessionStorage へ退避し、アドレスバーからは消す。
	/// (履歴やブックマークにトークンが残らないようにする)
	_takeToken() {
		const url = new URL(window.location.href);
		const t = url.searchParams.get('t');
		if (t) {
			try { sessionStorage.setItem('appserve.token', t); } catch (e) { /* private mode */ }
			url.searchParams.delete('t');
			window.history.replaceState({}, '', url.toString());
			return t;
		}
		try { return sessionStorage.getItem('appserve.token') || ''; } catch (e) { return ''; }
	}

	//-----------------------------------------------------------------------
	// HTTP
	//-----------------------------------------------------------------------
	_headers(extra) {
		const h = Object.assign({}, extra || {});
		if (this.token) h['X-App-Token'] = this.token;
		return h;
	}

	_url(path, params) {
		const url = new URL(path, window.location.origin);
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
			}
		}
		return url.toString();
	}

	async _fetch(url, init) {
		const res = await fetch(url, init);
		const ctype = res.headers.get('content-type') || '';
		if (!res.ok) {
			let msg = res.status + ' ' + res.statusText;
			if (ctype.includes('json')) {
				try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
			}
			const err = new Error(msg);
			err.status = res.status;
			throw err;
		}
		if (res.status === 204) return null;
		if (ctype.includes('json')) return res.json();
		if (ctype.startsWith('text/')) return res.text();
		return res.arrayBuffer();
	}

	/// GET。params はクエリ文字列になる。
	get(path, params) {
		return this._fetch(this._url(path, params), { headers: this._headers() });
	}

	/// POST。body がオブジェクトなら JSON 化する。
	post(path, body, params) {
		const isObj = body !== undefined && body !== null && typeof body === 'object' &&
		              !(body instanceof ArrayBuffer) && !(body instanceof Blob);
		return this._fetch(this._url(path, params), {
			method: 'POST',
			headers: this._headers(isObj ? { 'Content-Type': 'application/json' } : {}),
			body: isObj ? JSON.stringify(body) : body,
		});
	}

	/// バイナリを ArrayBuffer で取る
	async bytes(path, params) {
		const res = await fetch(this._url(path, params), { headers: this._headers() });
		if (!res.ok) throw new Error(res.status + ' ' + res.statusText);
		return res.arrayBuffer();
	}

	//-----------------------------------------------------------------------
	// サーバ → ブラウザ のコマンド (ロングポーリング)
	//-----------------------------------------------------------------------
	async _pollLoop() {
		while (!this._stopped) {
			try {
				const r = await this.get('/_app/poll', { sid: this.sid, wait: 15000 });
				this._pollBackoff = 0;
				this._lostSince = null;
				for (const c of (r.cmds || [])) this._runCommand(c);
			} catch (e) {
				if (this._stopped) break;
				if (e.status === 404) {
					// セッションが失われた (TTL 切れ / サーバ再起動)。張り直す。
					try {
						const hello = await this.get('/_app/hello');
						this.sid = hello.sid;
						this._lostSince = null;
						continue;
					} catch (e2) { /* サーバが落ちている。下のバックオフへ */ }
				}
				// サーバに届かない状態が続いたら「落ちた」と見なす。
				// HTTP エラー (status あり) は届いている = 生きているので数えない。
				if (e.status === undefined) {
					if (this._lostSince === null) this._lostSince = Date.now();
					else if (Date.now() - this._lostSince >= this.disconnectGraceMs) {
						this._lost();
						break;
					}
				} else {
					this._lostSince = null;
				}
				this._pollBackoff = Math.min((this._pollBackoff || 250) * 2, 5000);
				await new Promise(r => setTimeout(r, this._pollBackoff));
			}
		}
	}

	async _runCommand(c) {
		let ok = true, value = null, error = '';
		try {
			value = await this._dispatch(c.cmd, c.arg || {});
		} catch (e) {
			ok = false;
			error = String(e && e.message ? e.message : e);
		}
		if (!c.id) return;    // post() は結果を待っていない
		try {
			await this.post('/_app/result', {
				sid: this.sid, id: c.id, ok, value: this._safe(value), error,
			});
		} catch (e) { /* サーバが消えた。次の poll でエラーになる */ }
	}

	/// 循環参照や DOM ノードを JSON 化できる形に落とす
	_safe(v, depth = 0) {
		if (v === null || v === undefined) return null;
		const t = typeof v;
		if (t === 'string' || t === 'number' || t === 'boolean') return v;
		if (t === 'function') return '(function ' + (v.name || 'anonymous') + ')';
		if (depth > 6) return '(too deep)';
		if (v instanceof Error) return v.name + ': ' + v.message;
		if (v instanceof Node) return '(' + v.nodeName.toLowerCase() + ')';
		if (Array.isArray(v)) return v.slice(0, 500).map(x => this._safe(x, depth + 1));
		const out = {};
		let n = 0;
		for (const k of Object.keys(v)) {
			if (++n > 200) { out['...'] = 'truncated'; break; }
			try { out[k] = this._safe(v[k], depth + 1); } catch (e) { out[k] = '(unreadable)'; }
		}
		return out;
	}

	//-----------------------------------------------------------------------
	// 標準コマンド。REPL の .b <sub> がそのままここへ来る。
	//-----------------------------------------------------------------------
	async _dispatch(cmd, arg) {
		switch (cmd) {
			// サーバの終了予告 (stopServer が畳む直前に投げる)。
			// 通信断の検出を待たずにその場で窓を閉じる。
			case 'shutdown': {
				setTimeout(() => this._lost(), 0);   // 応答を返してから畳む
				return true;
			}
			case 'eval': {
				// 式でも文でも通るように、まず式として評価してみる
				let fn;
				try { fn = new Function('app', 'return (' + arg.code + ')'); }
				catch (e) { fn = new Function('app', arg.code); }
				return await fn(this);
			}
			case 'dom': {
				const el = document.querySelector(arg.sel || 'body');
				if (!el) throw new Error('no element matches ' + arg.sel);
				const html = el.outerHTML;
				const limit = arg.limit || 20000;
				return html.length > limit
					? html.slice(0, limit) + '\n... (' + html.length + ' chars total)'
					: html;
			}
			case 'text': {
				const el = document.querySelector(arg.sel || 'body');
				if (!el) throw new Error('no element matches ' + arg.sel);
				return el.innerText;
			}
			case 'click': {
				const el = document.querySelector(arg.sel);
				if (!el) throw new Error('no element matches ' + arg.sel);
				el.scrollIntoView({ block: 'nearest' });
				el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
				return 'clicked ' + (el.id ? '#' + el.id : el.tagName.toLowerCase());
			}
			case 'set': {
				const el = document.querySelector(arg.sel);
				if (!el) throw new Error('no element matches ' + arg.sel);
				el.value = arg.value;
				el.dispatchEvent(new Event('input',  { bubbles: true }));
				el.dispatchEvent(new Event('change', { bubbles: true }));
				return el.value;
			}
			case 'state':
				return this._stateFn ? await this._stateFn() : { note: 'no state exposed' };
			case 'err':
				return this._errors.slice(-30);
			case 'nav': {
				const h = this._handlers.get('nav');
				if (h) return await h(arg);
				window.location.hash = arg.path || '';
				return window.location.hash;
			}
			case 'call': {
				const fn = this._commands.get(arg.name);
				if (!fn) {
					throw new Error('no command named "' + arg.name + '" (available: ' +
						[...this._commands.keys()].join(', ') + ')');
				}
				return await fn(arg.arg);
			}
			default: {
				const h = this._handlers.get(cmd);
				if (!h) throw new Error('unknown browser command "' + cmd + '"');
				return await h(arg);
			}
		}
	}

	//-----------------------------------------------------------------------
	// アプリ側の登録口
	//-----------------------------------------------------------------------
	/// .b call <name> [json] から呼べる関数を登録する
	command(name, fn) { this._commands.set(name, fn); return this; }
	/// .b <name> [json] を丸ごと処理するハンドラを登録する
	handler(name, fn) { this._handlers.set(name, fn); return this; }
	/// .b state で返す状態を提供する
	exposeState(fn) { this._stateFn = fn; return this; }

	//-----------------------------------------------------------------------
	// SSE
	//-----------------------------------------------------------------------
	/// channel を購読する ('log' はサーバログ、それ以外は .push / broadcast の宛先)
	on(channel, fn) {
		if (!this._listeners.has(channel)) this._listeners.set(channel, new Set());
		this._listeners.get(channel).add(fn);
		this._ensureSource(channel);
		return () => this._listeners.get(channel).delete(fn);
	}

	_ensureSource(channel) {
		if (this._sources.has(channel)) return;
		const path = (channel === 'log') ? '/_app/events' : '/_app/sub/' + channel;
		// EventSource はカスタムヘッダを付けられないので、トークンはクエリで渡す
		const url = this._url(path, { t: this.token || undefined, sid: this.sid || undefined });
		const es = new EventSource(url);
		es.onmessage = (ev) => {
			let data = ev.data;
			try { data = JSON.parse(ev.data); } catch (e) { /* プレーンテキスト */ }
			for (const fn of (this._listeners.get(channel) || [])) {
				try { fn(data); } catch (e) { this._pushError('sse handler: ' + e.message); }
			}
		};
		es.onerror = () => { /* EventSource は自動再接続する */ };
		this._sources.set(channel, es);
	}

	//-----------------------------------------------------------------------
	// 死活
	//-----------------------------------------------------------------------
	async _heartbeatLoop() {
		// poll が張れている間は不要だが、poll が失敗している間の保険として送る
		while (!this._stopped) {
			await new Promise(r => setTimeout(r, 5000));
			if (!this.sid || this._pollBackoff === 0) continue;
			try { await this.post('/_app/hb', null, { sid: this.sid }); } catch (e) {}
		}
	}

	/// サーバが落ちたときに呼ばれる関数を登録する (自動終了より先に走る)。
	/// 戻り値は解除関数。
	onDisconnected(fn) {
		this._lostListeners.add(fn);
		return () => this._lostListeners.delete(fn);
	}

	/// サーバが消えたと判断したときの後始末 + 自動終了
	_lost() {
		if (this._stopped) return;
		this._stopped = true;
		for (const es of this._sources.values()) { try { es.close(); } catch (e) {} }
		this._sources.clear();
		for (const fn of this._lostListeners) {
			try { fn(); } catch (e) { this._pushError('onDisconnected: ' + e.message); }
		}
		if (!this.exitOnDisconnect) return;

		// --app モードの窓は script から閉じられる。閉じられない文脈
		// (自分で開いたタブなど) のために、少し待って画面を差し替える。
		try { window.close(); } catch (e) {}
		setTimeout(() => this._showClosed(), 400);
	}

	_showClosed() {
		if (document.getElementById('__appserve_closed')) return;
		const name = (this.info && this.info.appName) || 'アプリ';
		const box = document.createElement('div');
		box.id = '__appserve_closed';
		box.setAttribute('style', [
			'position:fixed', 'inset:0', 'z-index:2147483647',
			'display:flex', 'flex-direction:column',
			'align-items:center', 'justify-content:center', 'gap:10px',
			'background:#16181c', 'color:#c8ccd2',
			'font:14px/1.6 system-ui, sans-serif',
		].join(';'));
		const h = document.createElement('div');
		h.textContent = name + ' は終了しました';
		const p = document.createElement('div');
		p.setAttribute('style', 'opacity:.6;font-size:13px');
		p.textContent = 'このウィンドウは閉じて構いません。';
		box.append(h, p);
		document.body.appendChild(box);
	}

	_bye() {
		this._stopped = true;
		if (!this.sid) return;
		const url = this._url('/_app/bye', { sid: this.sid, t: this.token || undefined });
		// unload 中は fetch が中断されうるので sendBeacon を使う
		if (navigator.sendBeacon) navigator.sendBeacon(url, '');
		else fetch(url, { method: 'POST', keepalive: true, headers: this._headers() });
	}

	_pushError(msg) {
		this._errors.push({ t: Date.now(), msg });
		if (this._errors.length > 100) this._errors.shift();
	}

	/// サーバの REPL コマンドをブラウザから実行する (デバッグ用)
	repl(line) { return this.post('/_app/repl', { cmd: line }); }
}

export const app = new Appserve();
export default app;
