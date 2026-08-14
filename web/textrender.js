//---------------------------------------------------------------------------
// テキストの仮描画
//
// PSD 内蔵のテキストラスタは Photoshop で開き直すまで更新されないので、編集
// した内容がプレビューに反映されない。そこで編集済みのテキストレイヤについて
// は、タグ表現を解析して canvas に自前で描き直す。
//
// あくまで「仮再現」。Photoshop の組版 (字詰め / 禁則 / 縦書き / 変形) までは
// 再現しないので、位置と内容の確認用と割り切る。フォントもこの PC に入って
// いるものしか使えない。
//---------------------------------------------------------------------------

/// タグ付き文字列を「書式付きの行」へ分解する。
/// C++ 側 (richtext.cpp) と同じ規則: 閉じタグは無く、次の指定まで状態が続く。
export function parseTagged(tagged, base) {
	const lines = [];
	let cur = Object.assign({}, base);
	let line = { align: base.align ?? 0, spans: [] };
	let buf = '';

	const flushSpan = () => {
		if (buf) line.spans.push({ text: buf, style: Object.assign({}, cur) });
		buf = '';
	};
	const flushLine = () => {
		flushSpan();
		lines.push(line);
		line = { align: line.align, spans: [] };
	};

	for (let i = 0; i < tagged.length;) {
		const c = tagged[i];
		if (c === '[') {
			if (tagged[i + 1] === '[') { buf += '['; i += 2; continue; }
			const close = tagged.indexOf(']', i + 1);
			if (close < 0) { buf += tagged.slice(i); break; }
			const body = tagged.slice(i + 1, close);
			const off = body.startsWith('/');
			const spec = off ? body.slice(1) : body;
			const eq = spec.indexOf('=');
			const name = (eq < 0 ? spec : spec.slice(0, eq)).toLowerCase();
			const value = eq < 0 ? '' : spec.slice(eq + 1);
			let handled = true;

			switch (name) {
				case 'b': case 'bold':      flushSpan(); cur.bold = !off; break;
				case 'i': case 'italic':    flushSpan(); cur.italic = !off; break;
				case 'u': case 'underline': flushSpan(); cur.underline = !off; break;
				case 'size':
					flushSpan();
					cur.size = (off || !value) ? base.size : parseFloat(value);
					break;
				case 'font':
					flushSpan();
					cur.font = (off || !value) ? base.font : value.trim();
					break;
				case 'color':
					flushSpan();
					cur.color = (off || !value) ? base.color : normalizeColor(value.trim());
					break;
				case 'reset':
					flushSpan();
					cur = Object.assign({}, base);
					break;
				case 'align': {
					const a = { left: 0, right: 1, center: 2 }[value.trim().toLowerCase()];
					if (a === undefined) handled = false;
					else line.align = a;
					break;
				}
				default: handled = false;
			}
			if (!handled) buf += tagged.slice(i, close + 1);   // 未知タグは文字扱い
			i = close + 1;
			continue;
		}
		if (c === '\n') { flushLine(); i++; continue; }
		buf += c;
		i++;
	}
	flushLine();
	return lines;
}

function normalizeColor(v) {
	if (!v) return '#000000';
	return v[0] === '#' ? v : '#' + v;
}

//---------------------------------------------------------------------------
/// CSS の font 指定を組み立てる。PSD のフォント名は PostScript 名なので、
/// そのままでは当たらないことがある。ファミリ名っぽい形も候補に並べておく。
function cssFont(style) {
	const parts = [];
	if (style.italic) parts.push('italic');
	if (style.bold)   parts.push('bold');
	parts.push(`${Math.max(1, style.size || 12)}px`);

	const names = [];
	if (style.font) {
		names.push(`"${style.font}"`);
		// "NotoSansJP-Regular" -> "Noto Sans JP"
		const m = style.font.replace(/-(Regular|Medium|Bold|Light|Normal|ExtraLight|Thin|Black|Heavy|SemiBold|ExtraBold)$/i, '');
		const spaced = m.replace(/([a-z])([A-Z])/g, '$1 $2');
		if (spaced !== style.font) names.push(`"${spaced}"`);
	}
	names.push('sans-serif');
	parts.push(names.join(', '));
	return parts.join(' ');
}

//---------------------------------------------------------------------------
/// レイヤ矩形の中にテキストを描く。
///   rect  : [left, top, right, bottom]
///   lines : parseTagged の結果
export function drawText(ctx, rect, lines, base) {
	const [l, t, r, b] = rect;
	const boxW = r - l;

	ctx.save();
	ctx.textBaseline = 'alphabetic';

	// 各行の最大文字サイズ (行送りとアセントの基準)
	const lineMax = lines.map(line => {
		let mx = base.size || 12;
		for (const s of line.spans) mx = Math.max(mx, s.style.size || mx);
		return mx;
	});
	// 行送りは最大サイズの 1.4 倍 (Photoshop の自動行送りに近い経験則)
	const lineHeights = lineMax.map(m => m * 1.4);

	// 1 行目のベースラインは「上端 + アセント」。行送りぶん下げてしまうと
	// 1 行あたり 0.3〜0.4 文字ぶん低く描かれ、元のラスタと目に見えてずれる。
	// アセントは実測できるなら実測し、取れなければ 0.82 * サイズで概算する。
	let firstAscent = (lineMax[0] || 16) * 0.82;
	if (lines[0] && lines[0].spans.length) {
		const sp = lines[0].spans.reduce(
			(a, b) => ((b.style.size || 0) > (a.style.size || 0) ? b : a));
		ctx.font = cssFont(sp.style);
		const m = ctx.measureText(sp.text || 'M');
		if (m.actualBoundingBoxAscent > 0) {
			// 実測アセントは字形依存なので、フォントの標準アセント寄りに寄せる
			firstAscent = Math.max(m.actualBoundingBoxAscent,
			                       (sp.style.size || lineMax[0]) * 0.72);
		}
	}
	let y = t + firstAscent;

	lines.forEach((line, li) => {
		// 行全体の幅を測ってから、行揃えに応じて開始 x を決める
		let width = 0;
		for (const s of line.spans) {
			ctx.font = cssFont(s.style);
			width += ctx.measureText(s.text).width;
		}
		let x = l;
		if (line.align === 1)      x = r - width;         // 右
		else if (line.align === 2) x = l + (boxW - width) / 2;  // 中央

		for (const s of line.spans) {
			ctx.font = cssFont(s.style);
			ctx.fillStyle = s.style.color || '#000000';
			ctx.fillText(s.text, x, y);
			const w = ctx.measureText(s.text).width;
			if (s.style.underline) {
				const th = Math.max(1, (s.style.size || 12) / 16);
				ctx.fillRect(x, y + th * 2, w, th);
			}
			x += w;
		}
		y += lineHeights[li] || 16;
	});

	ctx.restore();
}

//---------------------------------------------------------------------------
/// このブラウザで使えるフォントかどうか (仮描画の精度の目安)
export function fontAvailable(name) {
	if (!name || !document.fonts || !document.fonts.check) return false;
	try { return document.fonts.check(`16px "${name}"`); } catch (e) { return false; }
}
