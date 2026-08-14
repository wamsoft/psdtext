//---------------------------------------------------------------------------
// 最小 CSV (RFC 4180) の読み書き
//
// Excel / スプレッドシートとの往復が前提なので:
//   - 書き出しは UTF-8 BOM 付き + CRLF 改行 (Excel が文字化けしない条件)
//   - フィールド内の改行は LF のまま二重引用符で囲む (セル内改行として開ける)
//   - 読み込みは BOM / CRLF / LF / CR を全部受ける
//---------------------------------------------------------------------------
#pragma once
#include <string>
#include <vector>

namespace psdtext {
namespace csv {

//---------------------------------------------------------------------------
/// 取り込んだ CSV の文字コードを UTF-8 へ揃える。
///
/// 日本語版 Excel の「CSV (コンマ区切り)」は Shift-JIS (CP932) で保存される。
/// そのまま UTF-8 として読むと本文が文字化けしたまま通ってしまい、しかも
/// 「変更あり」に見えるので、気付かないまま PSD を壊せてしまう。
///
/// UTF-8 として妥当ならそのまま、そうでなければ CP932 とみなして変換する。
/// charsetOut には "utf-8" / "cp932" が入る (画面に出して判断材料にする)。
/// 変換できない環境 (Windows 以外) や CP932 としても壊れている場合は false。
bool toUtf8(const std::string& in, std::string& out,
            std::string* charsetOut = nullptr, std::string* err = nullptr);

using Row   = std::vector<std::string>;
using Table = std::vector<Row>;

/// CSV テキストを解析する。行数が 0 でも失敗にはしない。
/// 引用符が閉じていない等の破損は err に理由を入れて false。
bool parse(const std::string& text, Table& out, std::string* err = nullptr);

/// 1 フィールドを必要に応じて引用符で囲む
std::string quote(const std::string& field);

/// テーブルを CSV テキストへ (BOM 付き / CRLF 区切り)
std::string write(const Table& table, bool bom = true);

} // namespace csv
} // namespace psdtext
