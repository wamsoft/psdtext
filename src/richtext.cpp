//---------------------------------------------------------------------------
// タグ形式のリッチテキスト 実装
//---------------------------------------------------------------------------
#include "richtext.h"

#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace psdtext {

namespace {

//---------------------------------------------------------------------------
/// UTF-8 の 1 文字が UTF-16 で何コードユニットになるか + そのバイト長
void utf8Step(const std::string& s, size_t i, size_t& bytes, size_t& units)
{
	unsigned char c = (unsigned char)s[i];
	if (c < 0x80)                  { bytes = 1; units = 1; }
	else if ((c & 0xE0) == 0xC0)   { bytes = 2; units = 1; }
	else if ((c & 0xF0) == 0xE0)   { bytes = 3; units = 1; }
	else if ((c & 0xF8) == 0xF0)   { bytes = 4; units = 2; }   // サロゲートペア
	else                           { bytes = 1; units = 1; }   // 不正バイト
	if (i + bytes > s.size()) bytes = 1;
}

/// UTF-16 単位のオフセットを UTF-8 のバイトオフセットへ
size_t byteOffsetForUnit(const std::string& s, size_t targetUnits)
{
	size_t i = 0, units = 0;
	while (i < s.size() && units < targetUnits) {
		size_t b, u;
		utf8Step(s, i, b, u);
		if (units + u > targetUnits) break;   // サロゲートの途中では切らない
		i += b;
		units += u;
	}
	return i;
}

//---------------------------------------------------------------------------
std::string colorToHex(const float c[4])
{
	auto ch = [](float v) -> int {
		int n = (int)std::lround(v * 255.0f);
		return n < 0 ? 0 : (n > 255 ? 255 : n);
	};
	char buf[16];
	std::snprintf(buf, sizeof(buf), "#%02X%02X%02X", ch(c[0]), ch(c[1]), ch(c[2]));
	return buf;
}

bool hexToColor(const std::string& s, float out[4])
{
	std::string h = s;
	if (!h.empty() && h[0] == '#') h.erase(0, 1);
	if (h.size() != 6 && h.size() != 8) return false;
	auto v = [&](size_t i) -> int {
		char c = h[i];
		if (c >= '0' && c <= '9') return c - '0';
		if (c >= 'a' && c <= 'f') return c - 'a' + 10;
		if (c >= 'A' && c <= 'F') return c - 'A' + 10;
		return -1;
	};
	int comp[4] = {0, 0, 0, 255};
	for (size_t k = 0; k * 2 + 1 < h.size(); ++k) {
		int hi = v(k * 2), lo = v(k * 2 + 1);
		if (hi < 0 || lo < 0) return false;
		comp[k] = hi * 16 + lo;
	}
	for (int k = 0; k < 4; ++k) out[k] = (float)comp[k] / 255.0f;
	return true;
}

std::string trimStr(const std::string& s)
{
	size_t b = 0, e = s.size();
	while (b < e && isspace((unsigned char)s[b])) ++b;
	while (e > b && isspace((unsigned char)s[e - 1])) --e;
	return s.substr(b, e - b);
}

//---------------------------------------------------------------------------
/// 行揃えの数値 ⇄ 名前 (0=左 1=右 2=中央、3 以降は両端揃え系)
const char* justName(int j)
{
	switch (j) {
		case 0:  return "left";
		case 1:  return "right";
		case 2:  return "center";
		case 3:  return "justify-left";
		case 4:  return "justify-right";
		case 5:  return "justify-center";
		case 6:  return "justify-all";
		default: return "left";
	}
}

bool justValue(const std::string& name, int& out)
{
	std::string n = trimStr(name);
	// CSV の列に日本語で書かれることがある (Excel 上で直に打つため)
	if (n == "左" || n == "左揃え")     { out = 0; return true; }
	if (n == "右" || n == "右揃え")     { out = 1; return true; }
	if (n == "中央" || n == "中央揃え") { out = 2; return true; }
	if (n == "両端揃え")                { out = 6; return true; }
	for (char& c : n) c = (char)tolower((unsigned char)c);
	if (n == "left")           { out = 0; return true; }
	if (n == "right")          { out = 1; return true; }
	if (n == "center")         { out = 2; return true; }
	if (n == "justify-left")   { out = 3; return true; }
	if (n == "justify-right")  { out = 4; return true; }
	if (n == "justify-center") { out = 5; return true; }
	if (n == "justify-all" || n == "justify") { out = 6; return true; }
	// 数値指定も受ける
	if (!n.empty() && isdigit((unsigned char)n[0])) { out = atoi(n.c_str()); return true; }
	return false;
}

//---------------------------------------------------------------------------
/// サイズ値をタグ用に整形する (整数なら小数点なし、小数は往復で崩れない桁数)
std::string sizeText(double v)
{
	char b[48];
	if (std::fabs(v - std::lround(v)) < 0.0005) {
		std::snprintf(b, sizeof(b), "%lld", (long long)std::lround(v));
		return b;
	}
	std::snprintf(b, sizeof(b), "%.4f", v);
	std::string s(b);
	size_t e = s.find_last_not_of('0');
	if (e != std::string::npos && s[e] == '.') --e;
	s.erase(e + 1);
	return s;
}

//---------------------------------------------------------------------------
/// 直前の書式との差分だけをタグにする (閉じタグは無く、次の指定まで効き続ける)。
///
/// PSD のランは入れ子ではなく平坦な並びなので、閉じタグを持つ範囲指定よりも
/// 「そこから先の状態を変える」指定のほうが構造に素直に対応する。翻訳者が
/// 入れ子を壊す事故も起きない。
void emitStyleDelta(std::string& o, const StyleSpec& cur, const StyleSpec& prev)
{
	if (cur.hasFont && (!prev.hasFont || cur.font != prev.font))
		o += "[font=" + cur.font + "]";
	if (cur.hasSize && (!prev.hasSize || std::fabs(cur.size - prev.size) > 0.01))
		o += "[size=" + sizeText(cur.size) + "]";
	if (cur.hasColor && (!prev.hasColor ||
	                     colorToHex(cur.color) != colorToHex(prev.color)))
		o += "[color=" + colorToHex(cur.color) + "]";
	if (cur.bold      != prev.bold)      o += cur.bold      ? "[b]" : "[/b]";
	if (cur.italic    != prev.italic)    o += cur.italic    ? "[i]" : "[/i]";
	if (cur.underline != prev.underline) o += cur.underline ? "[u]" : "[/u]";
}

/// リテラルの '[' をエスケープしつつ本文を足す
void appendEscaped(std::string& o, const std::string& s)
{
	for (char c : s) {
		if (c == '[') o += "[[";
		else          o += c;
	}
}

} // anonymous

//---------------------------------------------------------------------------
size_t utf16Length(const std::string& utf8)
{
	size_t i = 0, units = 0;
	while (i < utf8.size()) {
		size_t b, u;
		utf8Step(utf8, i, b, u);
		i += b;
		units += u;
	}
	return units;
}

//---------------------------------------------------------------------------
psd::RunStyleEdit StyleSpec::toRunStyleEdit() const
{
	psd::RunStyleEdit e;
	e.hasFont = hasFont;           e.font = font;
	e.hasSize = hasSize;           e.size = size;
	e.hasColor = hasColor;
	for (int i = 0; i < 4; ++i) e.color[i] = color[i];
	e.hasBold = hasBold;           e.bold = bold;
	e.hasItalic = hasItalic;       e.italic = italic;
	e.hasUnderline = hasUnderline; e.underline = underline;
	return e;
}

std::string StyleSpec::colorHex() const
{
	if (!hasColor) return "#000000";
	return colorToHex(color);
}

bool StyleSpec::sameAs(const StyleSpec& o) const
{
	if (hasFont != o.hasFont || (hasFont && font != o.font)) return false;
	if (hasSize != o.hasSize || (hasSize && std::fabs(size - o.size) > 0.01)) return false;
	if (hasColor != o.hasColor ||
	    (hasColor && colorToHex(color) != colorToHex(o.color))) return false;
	if (bold != o.bold || italic != o.italic || underline != o.underline) return false;
	return true;
}

//---------------------------------------------------------------------------
StyleSpec baseFromRuns(const std::vector<psd::TextStyleRun>& runs)
{
	StyleSpec b;
	if (runs.empty()) return b;
	const psd::TextStyleRun& r = runs[0];
	if (!r.font.empty()) {
		b.hasFont = true;
		// u16str → UTF-8
		for (size_t i = 0; i < r.font.size(); ++i) {
			unsigned cp = (unsigned)r.font[i];
			if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < r.font.size()) {
				unsigned lo = (unsigned)r.font[i + 1];
				if (lo >= 0xDC00 && lo <= 0xDFFF) {
					cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
					++i;
				}
			}
			if (cp < 0x80) b.font += (char)cp;
			else if (cp < 0x800) {
				b.font += (char)(0xC0 | (cp >> 6));
				b.font += (char)(0x80 | (cp & 0x3F));
			} else if (cp < 0x10000) {
				b.font += (char)(0xE0 | (cp >> 12));
				b.font += (char)(0x80 | ((cp >> 6) & 0x3F));
				b.font += (char)(0x80 | (cp & 0x3F));
			} else {
				b.font += (char)(0xF0 | (cp >> 18));
				b.font += (char)(0x80 | ((cp >> 12) & 0x3F));
				b.font += (char)(0x80 | ((cp >> 6) & 0x3F));
				b.font += (char)(0x80 | (cp & 0x3F));
			}
		}
	}
	if (r.fontSize > 0) { b.hasSize = true; b.size = r.fontSize; }
	if (r.hasColor) {
		b.hasColor = true;
		for (int i = 0; i < 4; ++i) b.color[i] = r.color[i];
	}
	b.hasBold = b.hasItalic = b.hasUnderline = true;
	b.bold      = r.bold;
	b.italic    = r.italic;
	b.underline = r.underline;
	return b;
}

//---------------------------------------------------------------------------
namespace {
/// psd::TextStyleRun → StyleSpec (base と比べる用)
StyleSpec specFromRun(const psd::TextStyleRun& r)
{
	std::vector<psd::TextStyleRun> one{ r };
	return baseFromRuns(one);
}
} // anonymous

std::string toTagged(const std::string& plainUtf8,
                     const std::vector<psd::TextStyleRun>& runs,
                     const std::vector<psd::TextParagraph>& paras,
                     const StyleSpec& base)
{
	const size_t totalUnits = utf16Length(plainUtf8);

	// --- 1) ランを「同じ書式が続く区間」へ連結する ---------------------------
	// 連結しないと、書式が変わらない箇所でもラン境界ごとにタグを閉じて開き直す
	// ことになり、読めない文字列になる。
	struct Span { size_t start; size_t end; StyleSpec style; };
	std::vector<Span> spans;
	{
		size_t pos = 0;
		for (size_t ri = 0; ri < runs.size(); ++ri) {
			size_t n = (size_t)(runs[ri].length > 0 ? runs[ri].length : 0);
			if (n == 0) continue;
			StyleSpec sp = specFromRun(runs[ri]);
			if (!spans.empty() && spans.back().style.sameAs(sp)) spans.back().end = pos + n;
			else spans.push_back(Span{ pos, pos + n, sp });
			pos += n;
		}
		// ランが本文より短ければ、末尾を最後の書式で埋める
		if (spans.empty()) spans.push_back(Span{ 0, totalUnits, base });
		else if (spans.back().end < totalUnits) spans.back().end = totalUnits;
	}

	// --- 2) 段落頭の行揃えマーカー -----------------------------------------
	// 直前の段落と同じ行揃えなら出さない (先頭段落は既定=左 以外のときだけ)。
	std::vector<std::pair<size_t, int>> alignAt;
	{
		size_t off = 0;
		int prev = 0;
		for (size_t i = 0; i < paras.size(); ++i) {
			if (paras[i].justification != prev) alignAt.emplace_back(off, paras[i].justification);
			prev = paras[i].justification;
			off += (size_t)(paras[i].length > 0 ? paras[i].length : 0);
		}
	}
	auto alignAtPos = [&](size_t p) -> const std::pair<size_t, int>* {
		for (const auto& a : alignAt) if (a.first == p) return &a;
		return nullptr;
	};
	auto nextAlignAfter = [&](size_t p) -> size_t {
		size_t best = (size_t)-1;
		for (const auto& a : alignAt) if (a.first > p && a.first < best) best = a.first;
		return best;
	};

	// --- 3) 走査して書き出す -----------------------------------------------
	std::string out;
	StyleSpec prev = base;      // 直前まで有効だった書式

	for (const Span& span : spans) {
		size_t p = span.start;
		while (p < span.end) {
			// 段落の頭に [align] を置く (行頭に来るので段落指定だと分かりやすい)
			if (const auto* a = alignAtPos(p))
				out += std::string("[align=") + justName(a->second) + "]";
			// 直前との差分だけタグにする
			if (!prev.sameAs(span.style)) {
				emitStyleDelta(out, span.style, prev);
				prev = span.style;
			}
			// 次の段落頭 or 区間末尾まで書き出す
			size_t next = span.end;
			size_t na = nextAlignAfter(p);
			if (na < next) next = na;

			size_t b0 = byteOffsetForUnit(plainUtf8, p);
			size_t b1 = byteOffsetForUnit(plainUtf8, next);
			if (b1 > plainUtf8.size()) b1 = plainUtf8.size();
			if (b0 < b1) appendEscaped(out, plainUtf8.substr(b0, b1 - b0));
			p = next;
		}
	}
	return out;
}

//---------------------------------------------------------------------------
void parseTagged(const std::string& tagged, const StyleSpec& base,
                 std::string& plainOut,
                 std::vector<psd::TextRunSpec>& runsOut,
                 std::vector<psd::TextParagraphSpec>& parasOut,
                 std::string* warnings)
{
	plainOut.clear();
	runsOut.clear();
	parasOut.clear();

	// 閉じタグの無い状態指定なので、書式は 1 つの「現在値」だけで足りる。
	// タグに出会ったらそこから先の状態が変わり、次の指定まで効き続ける。
	StyleSpec live = base;      // これから書く文字に乗る書式

	// 現在のランの蓄積
	StyleSpec curStyle = base;
	size_t    curUnits = 0;

	// 段落の蓄積 (改行で区切る)
	int    curJust = 0;
	bool   curJustSet = false;
	size_t paraUnits = 0;
	bool   sawAnyAlign = false;

	auto flushRun = [&](const StyleSpec& next) {
		if (curUnits > 0) {
			psd::TextRunSpec rs;
			rs.length = (int)curUnits;
			// 書式は **絶対値** で渡す (差分ではない)。
			//
			// psdparse は書き戻すときにラン構成を作り直すが、指定の無い属性は
			// 「同じ位置にあった元のラン」から引き継ぐ。差分だけ渡すと、マーク
			// を足したり消したりしてラン構成が変わった瞬間に、無関係なランの
			// 書式が混ざり込む (基準へ戻したつもりが元の 2 番目のランの書式に
			// なる、等)。curStyle は base から積み上げた状態そのままなので、
			// そのまま渡せば「タグの内容だけで書式が決まる」形になる。
			rs.style = curStyle.toRunStyleEdit();
			runsOut.push_back(rs);
		}
		curStyle = next;
		curUnits = 0;
	};

	auto flushPara = [&]() {
		if (paraUnits == 0) return;
		psd::TextParagraphSpec ps;
		ps.length = (int)paraUnits;
		ps.hasJustification = curJustSet || sawAnyAlign;
		ps.justification = curJust;
		parasOut.push_back(ps);
		paraUnits = 0;
	};

	auto emitText = [&](const std::string& utf8) {
		size_t u = utf16Length(utf8);
		plainOut += utf8;
		curUnits += u;
		paraUnits += u;
	};

	size_t i = 0;
	while (i < tagged.size()) {
		char c = tagged[i];

		if (c == '[') {
			if (i + 1 < tagged.size() && tagged[i + 1] == '[') {   // "[[" -> リテラル '['
				emitText("[");
				i += 2;
				continue;
			}
			size_t close = tagged.find(']', i + 1);
			if (close == std::string::npos) {                       // 閉じていない
				emitText(tagged.substr(i));
				break;
			}
			std::string body = tagged.substr(i + 1, close - i - 1);
			std::string lower = body;
			for (char& ch : lower) ch = (char)tolower((unsigned char)ch);

			bool handled = false;
			bool styleChanged = false;

			// "/xxx" は「その属性を切る」指定 (範囲の終わりではない)
			bool off = (!lower.empty() && lower[0] == '/');
			std::string spec = off ? lower.substr(1) : lower;

			size_t eq = spec.find('=');
			std::string name  = (eq == std::string::npos) ? spec : spec.substr(0, eq);
			std::string value;
			if (eq != std::string::npos) {
				// 値は元の大小文字のまま取る (フォント名が壊れないように)
				size_t beq = body.find('=');
				value = (beq == std::string::npos) ? std::string() : body.substr(beq + 1);
			}

			StyleSpec next = live;

			if (name == "b" || name == "bold") {
				next.hasBold = true; next.bold = !off;
				handled = styleChanged = true;
			} else if (name == "i" || name == "italic") {
				next.hasItalic = true; next.italic = !off;
				handled = styleChanged = true;
			} else if (name == "u" || name == "underline") {
				next.hasUnderline = true; next.underline = !off;
				handled = styleChanged = true;
			} else if (name == "size") {
				if (off || value.empty()) {          // [/size] で基準へ戻す
					next.hasSize = base.hasSize; next.size = base.size;
				} else {
					next.hasSize = true; next.size = atof(value.c_str());
				}
				handled = styleChanged = true;
			} else if (name == "font") {
				if (off || value.empty()) {
					next.hasFont = base.hasFont; next.font = base.font;
				} else {
					next.hasFont = true; next.font = trimStr(value);
				}
				handled = styleChanged = true;
			} else if (name == "color") {
				if (off || value.empty()) {
					next.hasColor = base.hasColor;
					for (int k = 0; k < 4; ++k) next.color[k] = base.color[k];
					handled = styleChanged = true;
				} else {
					float rgba[4];
					if (hexToColor(trimStr(value), rgba)) {
						next.hasColor = true;
						for (int k = 0; k < 4; ++k) next.color[k] = rgba[k];
						handled = styleChanged = true;
					} else if (warnings) {
						*warnings += "色の指定を解釈できません: [" + body + "]\n";
					}
				}
			} else if (name == "reset" || name.empty()) {
				// [reset] / [/] ですべて基準へ戻す
				next = base;
				handled = styleChanged = true;
			} else if (name == "align") {
				int j;
				if (justValue(value, j)) {
					// 段落の途中で切り替わったら、そこで段落を区切る
					flushPara();
					curJust = j;
					curJustSet = true;
					sawAnyAlign = true;
					handled = true;          // 書式ではないので styleChanged は立てない
				} else if (warnings) {
					*warnings += "行揃えの指定を解釈できません: [" + body + "]\n";
				}
			}

			if (styleChanged) {
				flushRun(next);
				live = next;
			}
			// 未知タグは文字として残す (壊れた入力で本文を失わないため)
			if (!handled) emitText(tagged.substr(i, close - i + 1));
			i = close + 1;
			continue;
		}

		if (c == '\n') {
			emitText("\n");
			flushPara();
			++i;
			continue;
		}

		// 通常文字: UTF-8 の 1 文字ぶん進める
		size_t b, u;
		utf8Step(tagged, i, b, u);
		emitText(tagged.substr(i, b));
		i += b;
	}

	flushRun(curStyle);
	flushPara();
}

//---------------------------------------------------------------------------
std::string stripTags(const std::string& tagged)
{
	StyleSpec base;
	std::string plain;
	std::vector<psd::TextRunSpec> runs;
	std::vector<psd::TextParagraphSpec> paras;
	parseTagged(tagged, base, plain, runs, paras, nullptr);
	return plain;
}

bool hasTags(const std::string& tagged)
{
	for (size_t i = 0; i + 1 < tagged.size(); ++i) {
		if (tagged[i] != '[') continue;
		if (tagged[i + 1] == '[') { ++i; continue; }
		if (tagged.find(']', i + 1) != std::string::npos) return true;
	}
	return false;
}

//---------------------------------------------------------------------------
namespace {

/// i の位置にあるタグを読む。タグでなければ false。
/// name は小文字 (別名は畳まない)、value は元の大小文字のまま。
bool readTag(const std::string& s, size_t i, size_t& end,
             std::string& name, std::string& value, bool& off)
{
	if (i >= s.size() || s[i] != '[') return false;
	if (i + 1 < s.size() && s[i + 1] == '[') return false;      // リテラルの '['
	size_t close = s.find(']', i + 1);
	if (close == std::string::npos) return false;

	std::string body = s.substr(i + 1, close - i - 1);
	off = (!body.empty() && body[0] == '/');
	std::string spec = off ? body.substr(1) : body;
	size_t eq = spec.find('=');
	name = trimStr(eq == std::string::npos ? spec : spec.substr(0, eq));
	for (char& c : name) c = (char)tolower((unsigned char)c);
	value = (eq == std::string::npos) ? std::string() : trimStr(spec.substr(eq + 1));
	end = close + 1;

	// 知らないタグは本文の文字 (parseTagged と同じ扱い)
	if (name.empty()) return true;              // [] / [/] は [reset]
	static const char* KNOWN[] = { "b", "bold", "i", "italic", "u", "underline",
	                               "size", "font", "color", "reset", "align" };
	for (const char* k : KNOWN) if (name == k) return true;
	return false;
}

/// 先頭に連なっているタグの終わり (= 初期書式の指定が終わる位置)
size_t headEnd(const std::string& tagged)
{
	size_t i = 0;
	for (;;) {
		size_t end; std::string n, v; bool off;
		if (!readTag(tagged, i, end, n, v, off)) break;
		i = end;
	}
	return i;
}

} // anonymous

bool hasInlineTags(const std::string& tagged)
{
	for (size_t i = headEnd(tagged); i < tagged.size();) {
		if (tagged[i] == '[' && i + 1 < tagged.size() && tagged[i + 1] == '[') { i += 2; continue; }
		size_t end; std::string n, v; bool off;
		if (readTag(tagged, i, end, n, v, off)) return true;
		++i;
	}
	return false;
}

StyleSpec headStyle(const std::string& tagged, const StyleSpec& base)
{
	StyleSpec cur = base;
	size_t i = 0;
	for (;;) {
		size_t end; std::string name, value; bool off;
		if (!readTag(tagged, i, end, name, value, off)) break;
		i = end;

		if (name == "b" || name == "bold")           { cur.hasBold = true; cur.bold = !off; }
		else if (name == "i" || name == "italic")    { cur.hasItalic = true; cur.italic = !off; }
		else if (name == "u" || name == "underline") { cur.hasUnderline = true; cur.underline = !off; }
		else if (name == "size") {
			if (off || value.empty()) { cur.hasSize = base.hasSize; cur.size = base.size; }
			else { cur.hasSize = true; cur.size = atof(value.c_str()); }
		} else if (name == "font") {
			if (off || value.empty()) { cur.hasFont = base.hasFont; cur.font = base.font; }
			else { cur.hasFont = true; cur.font = value; }
		} else if (name == "color") {
			if (off || value.empty()) {
				cur.hasColor = base.hasColor;
				for (int k = 0; k < 4; ++k) cur.color[k] = base.color[k];
			} else {
				float rgba[4];
				if (hexToColor(value, rgba)) {
					cur.hasColor = true;
					for (int k = 0; k < 4; ++k) cur.color[k] = rgba[k];
				}
			}
		} else if (name == "reset" || name.empty()) {
			cur = base;
		}
		// align は段落の指定なので書式には効かない (別の列で扱う)
	}
	return cur;
}

std::string headTagsFor(const StyleSpec& style, const StyleSpec& base)
{
	std::string o;
	emitStyleDelta(o, style, base);
	return o;
}

std::string replaceHeadTags(const std::string& tagged, const StyleSpec& style,
                            const StyleSpec& base)
{
	// 先頭タグの中の [align=...] は段落の指定なので残す (書式ではない)
	std::string keep;
	size_t i = 0;
	for (;;) {
		size_t end; std::string name, value; bool off;
		if (!readTag(tagged, i, end, name, value, off)) break;
		if (name == "align") keep += tagged.substr(i, end - i);
		i = end;
	}
	return keep + headTagsFor(style, base) + tagged.substr(i);
}

//---------------------------------------------------------------------------
std::string alignName(int justification)
{
	return justName(justification);
}

bool alignValue(const std::string& name, int& out)
{
	return justValue(name, out);
}

bool parseColorHex(const std::string& s, float out[4])
{
	return hexToColor(trimStr(s), out);
}

std::string escapeTagText(const std::string& plain)
{
	std::string o;
	appendEscaped(o, plain);
	return o;
}

} // namespace psdtext
