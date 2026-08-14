//---------------------------------------------------------------------------
// 書式マーク (web/tags.js) の単体テスト
//
//   node tests/tags.test.mjs
//
// タグの組み替えは目で追いにくく、間違えると本文の書式が静かに壊れる
// (閉じタグを作ってしまう / 戻し先を間違える) ので、ここで押さえておく。
// DOM は使わないので Node だけで走る。
//---------------------------------------------------------------------------
import * as tg from '../web/tags.js';

let fail = 0;
function eq(got, want, what) {
	const g = JSON.stringify(got), w = JSON.stringify(want);
	if (g !== w) { console.log(`FAIL ${what}\n  got  ${g}\n  want ${w}`); fail++; }
	else console.log(`ok   ${what}  ${g}`);
}
const base = { font: 'Noto', size: 48, color: '#202020', bold: false, italic: false, underline: false };

// --- 解析 ---
eq(tg.parseMarks('これは[b]太字[/b]で').map(m => [m.start, m.end, m.specs]),
   [[3, 6, { bold: true }], [8, 12, { bold: false }]], 'parseMarks');
eq(tg.parseMarks('[size=96][color=#FF0000]赤').map(m => [m.start, m.end, m.specs]),
   [[0, 24, { size: 96, color: '#FF0000' }]], '連続タグは 1 マーク');
eq(tg.parseMarks('a[foo]b').length, 0, '未知タグはマークではない');
eq(tg.parseMarks('a[[b]c').map(m => m.specs), [], '[[ はリテラルなのでマークにならない');

// --- 効いている書式 ---
eq(tg.styleAt('ab[size=96]cd', 0, base).size, 48, 'styleAt 前');
eq(tg.styleAt('ab[size=96]cd', 11, base).size, 96, 'styleAt 後');
eq(tg.styleAt('[/size]ab', 7, base).size, 48, '[/size] は基準へ');
eq(tg.styleAtHead('[size=96]ab', base).size, 96, '先頭マークは基準扱い');

// --- 範囲指定: 閉じタグを作らない ---
// 地が通常 → 太字の範囲。戻しは [/b] (= 太字を切る)
eq(tg.editRange('abcdef', 2, 4, { bold: true }, base).text, 'ab[b]cd[/b]ef', '範囲に太字');
// 地がすでに太字 → 範囲だけ通常に。戻しは [b]
eq(tg.editRange('[b]abcdef', 5, 7, { bold: false }, base).text,
   '[b]ab[/b]cd[b]ef', '太字の中で太字を切る → 戻しは [b]');
// サイズ: 手前が 96 の途中に 24 を入れる → 戻しは基準ではなく 96
eq(tg.editRange('[size=96]abcdef', 11, 13, { size: 24 }, base).text,
   '[size=96]ab[size=24]cd[size=96]ef', '戻し先は直後に効いていた値');
// 戻し先が基準と同じなら [/size] の形にする (後で基準を変えたら付いてくる)
eq(tg.editRange('abcdef', 2, 4, { size: 24 }, base).text,
   'ab[size=24]cd[/size]ef', '戻し先が基準なら [/size]');
// 範囲の末尾が本文の終わりなら戻しは要らない
eq(tg.editRange('abcdef', 2, 6, { bold: true }, base).text, 'ab[b]cdef', '末尾までなら戻し無し');
// 範囲の中にある同じ属性の指定は消える (上書きされるので)。他属性は残る。
eq(tg.editRange('ab[size=12]cd[color=#FF0000]ef', 2, 13, { size: 24 }, base).text,
   'ab[size=24]cd[size=12][color=#FF0000]ef', '範囲内の同属性は畳んで、後ろへ戻す');
// [reset] は展開されて、指定した属性だけ生き残る
eq(tg.editRange('ab[reset]cd', 2, 11, { bold: true }, base).text,
   'ab[b][/font][/size][/color][/i][/u]cd', '[reset] を展開して指定を生かす');

// 範囲の頭にすでにマークがあるときは、そこへ混ぜて 1 つにまとめる
eq(tg.editRange('[color=#F6005D]abcdef', 15, 17, { color: '#0000FF' }, base).text,
   '[color=#0000FF]ab[color=#F6005D]cdef', '頭のマークへ混ぜる / 戻しは元の色');
// 直後のマークが同じ属性を指定しているなら戻しは要らない
eq(tg.editRange('abc[color=#00FF00]def', 0, 3, { color: '#0000FF' }, base).text,
   '[color=#0000FF]abc[color=#00FF00]def', '直後が指定済みなら戻しを足さない');

// --- マークの編集 ---
const v = 'ab[size=96]cd';
const m = tg.parseMarks(v)[0];
eq(tg.editMark(v, m, { color: '#FF0000' }).text, 'ab[size=96][color=#FF0000]cd', 'マークに追加');
eq(tg.editMark(v, m, { size: undefined }).text, 'abcd', '指定を消すとタグも消える');
eq(tg.editMark(v, m, { size: null }).text, 'ab[/size]cd', '基準へ戻す形');
eq(tg.removeMark(v, m).text, 'abcd', 'マーク削除');
eq(tg.editAt('abcd', 2, { bold: true }).text, 'ab[b]cd', '新しいマーク');
eq(tg.editAt('ab[b]cd', 5, { size: 12 }).text, 'ab[size=12][b]cd', '隣接マークへ混ぜる (並びは正規化)');

// --- 基準パネルの流れ (先頭マークに書いて、要らなくなったら消える) ---
eq(tg.editAt('abc', 0, { color: '#FF0000' }).text, '[color=#FF0000]abc', '基準に色を入れる');
{
	// 反映後は基準そのものが赤になるので、先頭のタグは要らなくなる
	const v2 = '[color=#FF0000]abc';
	const after = { ...base, color: '#FF0000' };
	const head = tg.headMark(v2);
	eq(tg.sameValue('color', head.specs.color, tg.baseStyle(after).color), true, '基準に吸われた');
	eq(tg.editMark(v2, head, { color: undefined }).text, 'abc', '先頭のタグを片付ける');
}
// 行揃えは段落の指定として先頭マークに乗る
eq(tg.parseMarks('[align=center]abc')[0].specs, { align: 2 }, 'align の解析');
eq(tg.formatMark({ align: 2, bold: true }), '[align=center][b]', 'formatMark の並び');

// --- 見せる本文 ⇄ タグ表現 (編集欄はタグを出さず ◆ の札にする) ---
eq(tg.escapeText('a[b'), 'a[[b', 'リテラルの [ を書く');
eq(tg.unescapeText('a[[b'), 'a[b', 'その逆');
eq(tg.segments('ab[b]cd').map(s => [s.kind, s.start, s.end, s.text || s.tag]),
   [['text', 0, 2, 'ab'], ['mark', 2, 5, '[b]'], ['text', 5, 7, 'cd']], '本文と札に分ける');
eq(tg.segments('[[x[b]y').map(s => s.kind === 'text' ? s.text : s.tag),
   ['[x', '[b]', 'y'], 'リテラルの [ は本文として戻る');
eq(tg.stripToPlain('ab[size=90]cd[[e'), 'abcd[e', '素の本文');

// --- カーソルが属しているマーク (編集の対象) ---
{
	const v = 'ab[b]cd[i]ef';
	const at = (p) => { const m = tg.governingMark(v, p); return m ? m.start : null; };
	eq([at(0), at(2), at(5), at(7), at(10), at(12)], [null, null, 2, 2, 7, 7],
	   'カーソルより前で最後に効いたマーク');
}

// --- 選択範囲に本文が入っているか (タグだけの選択を弾く) ---
eq(tg.textLengthIn('ab[b]cd', 0, 7), 4, 'タグは数えない');
eq(tg.textLengthIn('ab[b]cd', 2, 5), 0, 'タグだけの範囲は 0');
eq(tg.textLengthIn('ab[b]cd', 3, 4), 0, 'タグの途中から始まっても 0');
eq(tg.textLengthIn('a[[b', 0, 4), 3, '[[ は本文 1 文字ぶん (a [ b で 3)');

// --- カーソル追従 ---
const r = tg.editRange('abcdef', 2, 4, { bold: true }, base);
eq([tg.shiftPos(2, r.edits), tg.shiftPos(4, r.edits)], [5, 7], '選択範囲がずれても同じ文字を選ぶ');

// --- 色 ---
eq(tg.normColor('ff0000'), '#FF0000', 'normColor');
eq(tg.normColor('#FF000080'), '#FF0000', 'normColor アルファ切り捨て');
eq(tg.sizeText(48.0), '48', 'sizeText 整数');
eq(tg.sizeText(48.25), '48.25', 'sizeText 小数');

console.log(fail ? `\n${fail} 件 失敗` : '\nすべて通過');
process.exit(fail ? 1 : 0);
