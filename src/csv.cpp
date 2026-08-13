//---------------------------------------------------------------------------
// 最小 CSV 実装
//---------------------------------------------------------------------------
#include "csv.h"

namespace psdtext {
namespace csv {

//---------------------------------------------------------------------------
bool parse(const std::string& textIn, Table& out, std::string* err)
{
	out.clear();

	// UTF-8 BOM を落とす (Excel が書き出すと必ず付く)
	size_t i = 0;
	if (textIn.size() >= 3 &&
	    (unsigned char)textIn[0] == 0xEF && (unsigned char)textIn[1] == 0xBB &&
	    (unsigned char)textIn[2] == 0xBF) {
		i = 3;
	}
	const std::string& s = textIn;

	Row         row;
	std::string field;
	bool        inQuotes = false;
	bool        rowStarted = false;

	auto endField = [&] {
		row.push_back(field);
		field.clear();
	};
	auto endRow = [&] {
		endField();
		out.push_back(row);
		row.clear();
		rowStarted = false;
	};

	while (i < s.size()) {
		char c = s[i];
		if (inQuotes) {
			if (c == '"') {
				if (i + 1 < s.size() && s[i + 1] == '"') {   // "" → リテラルの "
					field += '"';
					i += 2;
					continue;
				}
				inQuotes = false;
				++i;
				continue;
			}
			// 引用符の中では改行もそのままフィールドの一部。
			// CRLF はセル内改行として LF に正規化する。
			if (c == '\r') {
				field += '\n';
				if (i + 1 < s.size() && s[i + 1] == '\n') ++i;
				++i;
				continue;
			}
			field += c;
			++i;
			continue;
		}

		if (c == '"' && field.empty()) { inQuotes = true; rowStarted = true; ++i; continue; }
		if (c == ',')  { endField(); rowStarted = true; ++i; continue; }
		if (c == '\r' || c == '\n') {
			if (c == '\r' && i + 1 < s.size() && s[i + 1] == '\n') ++i;
			++i;
			// 完全な空行は読み飛ばす (末尾の余分な改行対策)
			if (!rowStarted && field.empty() && row.empty()) continue;
			endRow();
			continue;
		}
		field += c;
		rowStarted = true;
		++i;
	}

	if (inQuotes) {
		if (err) *err = "unterminated quoted field";
		return false;
	}
	if (rowStarted || !field.empty() || !row.empty()) endRow();
	return true;
}

//---------------------------------------------------------------------------
std::string quote(const std::string& field)
{
	bool need = false;
	for (char c : field) {
		if (c == ',' || c == '"' || c == '\n' || c == '\r') { need = true; break; }
	}
	if (!need) return field;

	std::string o;
	o.reserve(field.size() + 8);
	o += '"';
	for (char c : field) {
		if (c == '"') o += "\"\"";
		else          o += c;
	}
	o += '"';
	return o;
}

//---------------------------------------------------------------------------
std::string write(const Table& table, bool bom)
{
	std::string o;
	if (bom) o += "\xEF\xBB\xBF";
	for (const auto& row : table) {
		for (size_t i = 0; i < row.size(); ++i) {
			if (i) o += ',';
			o += quote(row[i]);
		}
		o += "\r\n";
	}
	return o;
}

} // namespace csv
} // namespace psdtext
