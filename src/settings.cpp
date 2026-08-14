//---------------------------------------------------------------------------
// 設定ファイル 実装
//---------------------------------------------------------------------------
#include "settings.h"

#include <appserve/log.h>

#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>

#ifdef _WIN32
#include <windows.h>
#include <shlobj.h>
#endif

namespace fs = std::filesystem;
using appserve::Json;

namespace psdtext {

namespace {

/// 設定を置くフォルダ (末尾に区切りは付けない)
std::string configDir()
{
#ifdef _WIN32
	// %APPDATA% (無い環境はまず無いが、無ければカレントへ落とす)
	wchar_t* w = nullptr;
	std::string base;
	if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, NULL, &w)) && w) {
		int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
		if (n > 1) {
			base.assign((size_t)n - 1, '\0');
			WideCharToMultiByte(CP_UTF8, 0, w, -1, &base[0], n, NULL, NULL);
		}
		CoTaskMemFree(w);
	}
	if (base.empty()) return ".";
	return base + "/psdtext";
#else
	const char* xdg = std::getenv("XDG_CONFIG_HOME");
	if (xdg && *xdg) return std::string(xdg) + "/psdtext";
	const char* home = std::getenv("HOME");
	if (home && *home) return std::string(home) + "/.config/psdtext";
	return ".";
#endif
}

} // anonymous

//---------------------------------------------------------------------------
std::string Settings::path()
{
	return configDir() + "/settings.json";
}

Json Settings::load()
{
	std::ifstream f(fs::u8path(path()), std::ios::binary);
	if (!f) return Json::object();
	std::string text((std::istreambuf_iterator<char>(f)), std::istreambuf_iterator<char>());
	Json j = Json::parse(text);
	return j.isObj() ? j : Json::object();
}

bool Settings::merge(const Json& patch)
{
	if (!patch.isObj()) return false;

	Json cur = load();
	for (const auto& kv : patch.members()) cur.set(kv.first, kv.second);

	std::error_code ec;
	fs::create_directories(fs::u8path(configDir()), ec);

	std::ofstream f(fs::u8path(path()), std::ios::binary | std::ios::trunc);
	if (!f) {
		appserve::logW("could not write settings: " + path());
		return false;
	}
	const std::string out = cur.dump(2);
	f.write(out.data(), (std::streamsize)out.size());
	return (bool)f;
}

} // namespace psdtext
