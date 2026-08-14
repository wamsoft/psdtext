//---------------------------------------------------------------------------
// フォント名の収集 実装
//
// sfnt (ttf / otf / ttc) の 'name' テーブルだけを読む。中身の字形には
// 触らないので、ヘッダ + name テーブルぶんしか読まない。
//---------------------------------------------------------------------------
#include "fonts.h"

#include <appserve/log.h>

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <map>

#ifdef _WIN32
#include <windows.h>
#include <shlobj.h>
#endif

namespace fs = std::filesystem;

namespace psdtext {

namespace {

//---------------------------------------------------------------------------
// ビッグエンディアン読み出し (sfnt は全部 BE)
uint16_t be16(const uint8_t* p) { return (uint16_t)((p[0] << 8) | p[1]); }
uint32_t be32(const uint8_t* p)
{
	return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) |
	       ((uint32_t)p[2] << 8)  |  (uint32_t)p[3];
}

/// UTF-16BE → UTF-8 (name テーブルの Windows プラットフォームはこれ)
std::string utf16beToUtf8(const uint8_t* p, size_t len)
{
	std::string o;
	o.reserve(len);
	for (size_t i = 0; i + 1 < len; i += 2) {
		unsigned cp = (unsigned)be16(p + i);
		if (cp >= 0xD800 && cp <= 0xDBFF && i + 3 < len) {
			unsigned lo = (unsigned)be16(p + i + 2);
			if (lo >= 0xDC00 && lo <= 0xDFFF) {
				cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
				i += 2;
			}
		}
		if (cp < 0x80) o += (char)cp;
		else if (cp < 0x800) {
			o += (char)(0xC0 | (cp >> 6));
			o += (char)(0x80 | (cp & 0x3F));
		} else if (cp < 0x10000) {
			o += (char)(0xE0 | (cp >> 12));
			o += (char)(0x80 | ((cp >> 6) & 0x3F));
			o += (char)(0x80 | (cp & 0x3F));
		} else {
			o += (char)(0xF0 | (cp >> 18));
			o += (char)(0x80 | ((cp >> 12) & 0x3F));
			o += (char)(0x80 | ((cp >> 6) & 0x3F));
			o += (char)(0x80 | (cp & 0x3F));
		}
	}
	return o;
}

//---------------------------------------------------------------------------
/// name テーブルから 1 フォントぶんの名前を取り出す。
/// offset は sfnt の先頭 (ttc なら各フォントの先頭)。
bool readNames(std::ifstream& f, uint32_t sfntOffset, FontEntry& out)
{
	uint8_t head[12];
	f.seekg(sfntOffset, std::ios::beg);
	if (!f.read((char*)head, sizeof(head))) return false;

	const uint32_t tag = be32(head);
	if (tag != 0x00010000 && tag != 0x4F54544F /*OTTO*/ && tag != 0x74727565 /*true*/)
		return false;

	const int numTables = be16(head + 4);
	uint32_t nameOff = 0, nameLen = 0;
	for (int i = 0; i < numTables; ++i) {
		uint8_t rec[16];
		if (!f.read((char*)rec, sizeof(rec))) return false;
		if (std::memcmp(rec, "name", 4) == 0) {
			nameOff = be32(rec + 8);
			nameLen = be32(rec + 12);
			break;
		}
	}
	if (!nameOff || nameLen < 6 || nameLen > (1u << 22)) return false;

	std::vector<uint8_t> tbl(nameLen);
	f.seekg(nameOff, std::ios::beg);
	if (!f.read((char*)tbl.data(), (std::streamsize)nameLen)) return false;

	const int count = be16(&tbl[2]);
	const uint32_t strBase = be16(&tbl[4]);
	if (6 + (size_t)count * 12 > tbl.size()) return false;

	// 同じ nameID でも言語違いが並ぶ。英語 (0x0409) を既定に、日本語
	// (0x0411) は別に取っておく。
	for (int i = 0; i < count; ++i) {
		const uint8_t* r = &tbl[6 + (size_t)i * 12];
		const int platform = be16(r);
		const int language = be16(r + 4);
		const int nameId   = be16(r + 6);
		const uint32_t len = be16(r + 8);
		const uint32_t off = strBase + be16(r + 10);
		if (off + len > tbl.size()) continue;
		if (nameId != 1 && nameId != 2 && nameId != 6) continue;

		std::string value;
		if (platform == 3)      value = utf16beToUtf8(&tbl[off], len);
		else if (platform == 1) value.assign((const char*)&tbl[off], len);  // Mac Roman
		else continue;
		if (value.empty()) continue;

		const bool japanese = (platform == 3 && language == 0x0411);
		if (nameId == 6) {
			if (out.postscript.empty()) out.postscript = value;
		} else if (nameId == 1) {
			if (japanese) { if (out.localFamily.empty()) out.localFamily = value; }
			else if (out.family.empty()) out.family = value;
		} else if (nameId == 2) {
			if (!japanese && out.style.empty()) out.style = value;
		}
	}
	return !out.postscript.empty();
}

//---------------------------------------------------------------------------
/// 1 ファイル (ttc なら中の全フォント) を読む
void readFile(const fs::path& path, std::vector<FontEntry>& out)
{
	std::ifstream f(path, std::ios::binary);
	if (!f) return;

	uint8_t head[12];
	if (!f.read((char*)head, sizeof(head))) return;

	std::vector<uint32_t> offsets;
	if (std::memcmp(head, "ttcf", 4) == 0) {
		const uint32_t n = be32(head + 8);
		if (n > 256) return;                       // 壊れたファイル避け
		std::vector<uint8_t> buf(n * 4);
		f.seekg(12, std::ios::beg);
		if (!f.read((char*)buf.data(), (std::streamsize)buf.size())) return;
		for (uint32_t i = 0; i < n; ++i) offsets.push_back(be32(&buf[i * 4]));
	} else {
		offsets.push_back(0);
	}

	for (uint32_t off : offsets) {
		FontEntry e;
		e.file = path.u8string();
		if (readNames(f, off, e)) out.push_back(std::move(e));
	}
}

//---------------------------------------------------------------------------
std::vector<fs::path> fontDirs()
{
	std::vector<fs::path> dirs;
#ifdef _WIN32
	wchar_t buf[MAX_PATH];
	if (GetWindowsDirectoryW(buf, MAX_PATH)) dirs.push_back(fs::path(buf) / L"Fonts");
	// ユーザ単位で入れたフォント (Windows 10 以降)
	wchar_t* local = nullptr;
	if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, NULL, &local)) && local) {
		dirs.push_back(fs::path(local) / L"Microsoft" / L"Windows" / L"Fonts");
		CoTaskMemFree(local);
	}
#endif
	return dirs;
}

bool isFontFile(const fs::path& p)
{
	std::string ext = p.extension().string();
	for (char& c : ext) c = (char)tolower((unsigned char)c);
	return ext == ".ttf" || ext == ".otf" || ext == ".ttc" || ext == ".otc";
}

std::vector<FontEntry> scan()
{
	std::vector<FontEntry> out;
	for (const auto& dir : fontDirs()) {
		std::error_code ec;
		if (!fs::is_directory(dir, ec)) continue;
		for (fs::directory_iterator it(dir, ec), end; it != end; it.increment(ec)) {
			if (ec) break;
			if (!it->is_regular_file(ec) || !isFontFile(it->path())) continue;
			readFile(it->path(), out);
		}
	}

	// PostScript 名で重複を落とす (同じフォントが複数の場所にあることがある)
	std::sort(out.begin(), out.end(), [](const FontEntry& a, const FontEntry& b) {
		return a.postscript < b.postscript;
	});
	out.erase(std::unique(out.begin(), out.end(),
	                      [](const FontEntry& a, const FontEntry& b) {
		return a.postscript == b.postscript;
	}), out.end());

	appserve::logI("scanned system fonts: " + std::to_string(out.size()));
	return out;
}

} // anonymous

//---------------------------------------------------------------------------
const std::vector<FontEntry>& systemFonts()
{
	// 走査は数百ファイルぶんのヘッダ読みなので一度きりにする
	static const std::vector<FontEntry> cached = scan();
	return cached;
}

} // namespace psdtext
