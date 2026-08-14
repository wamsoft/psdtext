//---------------------------------------------------------------------------
// 最小 CSV 実装
//---------------------------------------------------------------------------
#include "csv.h"

#ifdef _WIN32
#include <windows.h>
#endif

namespace psdtext {
namespace csv {

namespace {

/// UTF-8 として妥当か (継続バイト数・過長符号化・サロゲート・上限を見る)
bool isUtf8(const std::string& s)
{
	size_t i = 0;
	while (i < s.size()) {
		unsigned char c = (unsigned char)s[i];
		if (c < 0x80) { ++i; continue; }

		int n;                       // 続くバイト数
		unsigned cp;
		if ((c & 0xE0) == 0xC0)      { n = 1; cp = c & 0x1F; }
		else if ((c & 0xF0) == 0xE0) { n = 2; cp = c & 0x0F; }
		else if ((c & 0xF8) == 0xF0) { n = 3; cp = c & 0x07; }
		else return false;           // 継続バイトや 5 バイト以上の先頭

		if (i + (size_t)n >= s.size()) return false;          // 継続バイトが足りない
		for (int k = 1; k <= n; ++k) {
			unsigned char cc = (unsigned char)s[i + (size_t)k];
			if ((cc & 0xC0) != 0x80) return false;
			cp = (cp << 6) | (cc & 0x3F);
		}
		if (n == 1 && cp < 0x80) return false;              // 過長
		if (n == 2 && cp < 0x800) return false;
		if (n == 3 && cp < 0x10000) return false;
		if (cp > 0x10FFFF) return false;
		if (cp >= 0xD800 && cp <= 0xDFFF) return false;      // サロゲート
		i += (size_t)n + 1;
	}
	return true;
}

} // anonymous

//---------------------------------------------------------------------------
bool toUtf8(const std::string& in, std::string& out,
            std::string* charsetOut, std::string* err)
{
	if (isUtf8(in)) {
		out = in;
		if (charsetOut) *charsetOut = "utf-8";
		return true;
	}

#ifdef _WIN32
	// Excel が既定で書く Shift-JIS (CP932) とみなして変換する
	int wlen = MultiByteToWideChar(932, MB_ERR_INVALID_CHARS,
	                               in.data(), (int)in.size(), NULL, 0);
	if (wlen > 0) {
		std::wstring wide((size_t)wlen, L'\0');
		MultiByteToWideChar(932, MB_ERR_INVALID_CHARS, in.data(), (int)in.size(),
		                    &wide[0], wlen);
		int ulen = WideCharToMultiByte(CP_UTF8, 0, wide.data(), wlen, NULL, 0, NULL, NULL);
		if (ulen > 0) {
			out.assign((size_t)ulen, '\0');
			WideCharToMultiByte(CP_UTF8, 0, wide.data(), wlen, &out[0], ulen, NULL, NULL);
			if (charsetOut) *charsetOut = "cp932";
			return true;
		}
	}
	if (err) *err = "the CSV is neither UTF-8 nor Shift-JIS (save it as UTF-8)";
#else
	if (err) *err = "the CSV is not UTF-8 (save it as UTF-8; Shift-JIS is converted on Windows only)";
#endif
	return false;
}

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
