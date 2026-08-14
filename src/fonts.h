//---------------------------------------------------------------------------
// この PC に入っているフォントの名前を集める
//
// PSD がフォントを指すのは **PostScript 名** (NotoSansJP-Regular など) だが、
// Photoshop の画面には日本語名 (源ノ角ゴシック JP など) しか出ないうえ、
// コピーもできない。人が見て選べる名前と、PSD へ書く名前の対応が要る。
//
// ブラウザの Local Font Access API でも一覧は取れるが、許可を求められて
// 承認するまで止まってしまい、返る名前もブラウザ任せなので、フォントファイル
// の name テーブルを直接読む。
//---------------------------------------------------------------------------
#pragma once
#include <string>
#include <vector>

namespace psdtext {

struct FontEntry {
	std::string postscript;   ///< PSD が指す名前 (nameID 6)
	std::string family;       ///< 英語のファミリ名 (nameID 1)
	std::string localFamily;  ///< 日本語などその土地の名前 (無ければ空)
	std::string style;        ///< Regular / Bold など (nameID 2)
	std::string file;         ///< 元のファイル (デバッグ用)
};

/// この PC のフォントを列挙する (初回だけ走査し、以後は覚えておく)。
/// Windows 以外では空を返す (対応するときは同じ形で足せる)。
const std::vector<FontEntry>& systemFonts();

} // namespace psdtext
