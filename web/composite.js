//---------------------------------------------------------------------------
// レイヤ合成 (ブラウザ側)
//
// サーバから各レイヤの生 RGBA を 1 回だけ取ってキャッシュし、canvas 上で
// 下から順に重ねる。表示 ON/OFF の切り替えがサーバ往復なしで即座に反映され、
// ブレンドモードも canvas の globalCompositeOperation でそのまま扱える。
//
// 完全な Photoshop 互換ではない (グループのブレンド、調整レイヤ、レイヤ効果は
// 未対応) ので、位置と内容を確認するための作業用プレビューという位置づけ。
//---------------------------------------------------------------------------

/// レイヤ画像のキャッシュ (index -> {canvas, w, h} / null = 画素なし)
const cache = new Map();
let cacheDocKey = '';

/// 文書が変わったらキャッシュを捨てる
export function resetCache(docKey) {
	if (cacheDocKey === docKey) return;
	cacheDocKey = docKey;
	cache.clear();
}

//---------------------------------------------------------------------------
/// レイヤ 1 枚を取得して ImageBitmap 相当 (offscreen canvas) にする
async function fetchLayer(app, index) {
	if (cache.has(index)) return cache.get(index);

	let entry = null;
	try {
		const res = await fetch(app._url('/api/psd/image', { index }), {
			headers: { 'X-App-Token': app.token },
		});
		if (res.ok) {
			const w = parseInt(res.headers.get('x-image-width') || '0', 10);
			const h = parseInt(res.headers.get('x-image-height') || '0', 10);
			const buf = await res.arrayBuffer();
			if (w > 0 && h > 0 && buf.byteLength >= w * h * 4) {
				const c = document.createElement('canvas');
				c.width = w;
				c.height = h;
				// C++ 側は ColorFormat(0,8,16,24) で書いているので RGBA 並び
				c.getContext('2d').putImageData(
					new ImageData(new Uint8ClampedArray(buf, 0, w * h * 4), w, h), 0, 0);
				entry = { canvas: c, w, h };
			}
		}
	} catch (e) { /* 画素の無いレイヤ等。null のままにする */ }

	cache.set(index, entry);
	return entry;
}

//---------------------------------------------------------------------------
/// 祖先を辿って実効的な表示状態を求める。
/// visible は index -> bool のマップ (UI が持つ一時的な表示状態)。
function effectiveVisible(layer, byIndex, visible) {
	let n = layer;
	let guard = 0;
	while (n && guard++ < 64) {
		if (visible.get(n.index) === false) return false;
		n = (n.parent >= 0) ? byIndex.get(n.parent) : null;
	}
	return true;
}

//---------------------------------------------------------------------------
/// 合成して ctx に描く。
///   tree     : /api/psd/tree の配列 (layerList 順 = 下から上)
///   visible  : Map<index, bool>
///   opts.textPainter : (ctx, layer) => bool  テキストを自前描画する差し込み口。
///                      true を返したらそのレイヤの PSD 内蔵画像は描かない。
export async function composite(app, ctx, canvasW, canvasH, tree, visible, opts = {}) {
	const byIndex = new Map(tree.map(l => [l.index, l]));

	ctx.clearRect(0, 0, canvasW, canvasH);
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = 'source-over';

	// 描くべきレイヤを先に決めてから、必要な画像だけまとめて取る
	const draw = tree.filter(l => l.hasPixels && effectiveVisible(l, byIndex, visible));
	const painted = new Set();
	if (opts.textPainter) {
		// テキスト仮描画は画像取得の要否に関わるので先に判定だけしておく
		for (const l of draw) if (opts.textPainter.wants && opts.textPainter.wants(l)) painted.add(l.index);
	}
	await Promise.all(draw.filter(l => !painted.has(l.index)).map(l => fetchLayer(app, l.index)));

	// クリッピングレイヤ (clipping=true) は直下の非クリッピングレイヤの
	// 不透明部分だけに乗る。連続するクリッピング群を 1 つのグループとして
	// オフスクリーンで合成してから、ベースのアルファで切り抜く。
	let i = 0;
	while (i < draw.length) {
		const base = draw[i];
		// この base に乗るクリッピング群を集める
		let j = i + 1;
		while (j < draw.length && draw[j].clipping) j++;
		const clips = draw.slice(i + 1, j);

		if (clips.length === 0) {
			paintLayer(ctx, base, cache.get(base.index), opts, painted);
			i = j;
			continue;
		}

		// ベースを一旦オフスクリーンへ描き、その上にクリッピング群を重ねてから
		// ベースのアルファで切り抜く
		const off = document.createElement('canvas');
		off.width = canvasW;
		off.height = canvasH;
		const octx = off.getContext('2d');
		paintLayer(octx, base, cache.get(base.index), opts, painted);

		const clipMask = document.createElement('canvas');
		clipMask.width = canvasW;
		clipMask.height = canvasH;
		const mctx = clipMask.getContext('2d');
		for (const c of clips) paintLayer(mctx, c, cache.get(c.index), opts, painted);
		// ベースの形で切り抜く
		mctx.globalCompositeOperation = 'destination-in';
		mctx.globalAlpha = 1;
		mctx.drawImage(off, 0, 0);

		octx.globalCompositeOperation = 'source-over';
		octx.globalAlpha = 1;
		octx.drawImage(clipMask, 0, 0);

		ctx.globalAlpha = 1;
		ctx.globalCompositeOperation = 'source-over';
		ctx.drawImage(off, 0, 0);
		i = j;
	}

	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = 'source-over';
}

//---------------------------------------------------------------------------
function paintLayer(ctx, layer, img, opts, painted) {
	const alpha = Math.max(0, Math.min(1, (layer.opacity ?? 255) / 255));
	if (alpha <= 0) return;

	ctx.globalAlpha = alpha;
	ctx.globalCompositeOperation = layer.blend || 'source-over';

	if (painted.has(layer.index) && opts.textPainter) {
		opts.textPainter.paint(ctx, layer);
	} else if (img) {
		ctx.drawImage(img.canvas, layer.rect[0], layer.rect[1]);
	}

	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = 'source-over';
}
