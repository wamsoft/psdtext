//---------------------------------------------------------------------------
// psdtext — PSD のテキストレイヤを読み書きするローカルツール
//
//   psdtext                  ブラウザが開き、ファイルを選んで編集する
//   psdtext foo.psd          起動と同時に foo.psd を開く
//   psdtext foo.psd --repl   REPL つき (エージェント / 自動テスト用)
//---------------------------------------------------------------------------
#include <appserve/appserve.h>

#include "psd_module.h"
#include "settings.h"

#include <cstring>
#include <random>
#include <string>

#ifdef _WIN32
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace {

/// このポートが空いているか (使えるなら true)
bool portFree(int port)
{
#ifdef _WIN32
	WSADATA wsa;
	if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;
	SOCKET s = ::socket(AF_INET, SOCK_STREAM, 0);
	if (s == INVALID_SOCKET) { WSACleanup(); return false; }
#else
	int s = ::socket(AF_INET, SOCK_STREAM, 0);
	if (s < 0) return false;
#endif
	sockaddr_in a;
	std::memset(&a, 0, sizeof(a));
	a.sin_family = AF_INET;
	a.sin_port   = htons((unsigned short)port);
	a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	const bool ok = (::bind(s, (sockaddr*)&a, sizeof(a)) == 0);
#ifdef _WIN32
	::closesocket(s);
	WSACleanup();
#else
	::close(s);
#endif
	return ok;
}

/// 16 進のランダム文字列 (ブラウザへ渡すトークン用)
std::string randomToken()
{
	static const char* hex = "0123456789abcdef";
	std::random_device rd;
	std::string s;
	s.reserve(32);
	for (int i = 0; i < 32; ++i) s += hex[rd() & 15];
	return s;
}

/// ブラウザのウィンドウを前回と同じ場所に開くための下ごしらえ。
///
/// Edge / Chrome の --app ウィンドウは、位置と大きさを **URL ごと** に覚えて
/// いる。psdtext は既定でポートを OS 任せにし、トークンも毎回作り直すので、
/// URL が毎回変わって別のアプリと見なされ、開くたびに既定の場所へ戻っていた。
/// そこで
///   - 空いていれば決まったポートを使う (塞がっていれば従来どおり OS 任せ)
///   - トークンを設定ファイルに残して使い回す
/// ことで URL を固定し、ブラウザ自身に覚えてもらう。
///
/// トークンはローカル API を守るためのもので、%APPDATA% の設定ファイル
/// (本人しか読めない場所) に置く。毎回作り直すのと強さは変わらない。
///
/// あわせて、記録しておいた大きさ・位置を起動引数でも渡す。こちらはブラウザを
/// 新しく起こすときだけ効く (すでに起動している Edge が窓を作る場合は無視)。
///
/// **コマンドラインを読んだ後** に呼ぶこと。--port / --token / --no-token が
/// 指定されていればそちらが優先で、ここは指定が無かったときの既定値を埋める
/// 役目になる。特に appserve は「token が空でなければ検証する」と解釈するので、
/// 先に埋めてしまうと --no-token が効かなくなる (CI が 401 で落ちた)。
void applyWindowBox(appserve::App& app)
{
	const int kPreferredPort = 18990;
	if (app.options().port == 0 && portFree(kPreferredPort))
		app.options().port = kPreferredPort;

	appserve::Json s = psdtext::Settings::load();

	if (app.options().useToken && app.options().token.empty()) {
		std::string tok = s["browserToken"].asStr();
		if (tok.size() < 16) {
			tok = randomToken();
			appserve::Json patch = appserve::Json::object();
			patch.set("browserToken", appserve::Json(tok));
			psdtext::Settings::merge(patch);
		}
		app.options().token = tok;
	}

	const appserve::Json& w = s["window"];

	const int width  = (int)w["w"].asInt(0);
	const int height = (int)w["h"].asInt(0);
	if (width > 300 && height > 200) {
		app.options().browserArgs.push_back(
			"--window-size=" + std::to_string(width) + "," + std::to_string(height));
	} else {
		// 初回。3 ペインなので、狭いと右の編集ペインが窮屈になる
		app.options().browserArgs.push_back("--window-size=1400,900");
	}
	if (w.has("x") && w.has("y")) {
		const int x = (int)w["x"].asInt(0);
		const int y = (int)w["y"].asInt(0);
		// 画面の外に飛んでいると開けなくなるので、極端な値は捨てる
		if (x > -10000 && x < 20000 && y > -10000 && y < 20000) {
			app.options().browserArgs.push_back(
				"--window-position=" + std::to_string(x) + "," + std::to_string(y));
		}
	}
}

} // anonymous

int main(int argc, char** argv)
{
	appserve::App app;

	app.options().appName    = "psdtext";
	app.options().appVersion = "0.2.1";
	// PSD の保存には書き込みが要る。ファイル API の読み出しは既定で有効。
	app.options().allowWrite = true;

	std::string openPath;
	app.addOption({
		"open", "PATH", "open this PSD on startup",
		[&openPath](const std::string& v) { openPath = v; return true; }
	});

	if (!app.parseArgs(argc, argv)) return app.exitCode();

	applyWindowBox(app);

	// --open が無ければ最初の位置引数を使う (psdtext foo.psd と書ける)
	if (openPath.empty() && !app.options().args.empty())
		openPath = app.options().args.front();

	// ファイル選択ダイアログ相当の UI は appserve 標準の FS API を使う
	app.addModule(appserve::makeFsModule());
	app.addModule(psdtext::makePsdModule(openPath));

	return app.run();
}
