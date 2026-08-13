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
