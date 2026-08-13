//---------------------------------------------------------------------------
// psdtext — PSD のテキストレイヤを読み書きするローカルツール
//
//   psdtext                  ブラウザが開き、ファイルを選んで編集する
//   psdtext foo.psd          起動と同時に foo.psd を開く
//   psdtext foo.psd --repl   REPL つき (エージェント / 自動テスト用)
//---------------------------------------------------------------------------
#include <appserve/appserve.h>

#include "psd_module.h"

int main(int argc, char** argv)
{
	appserve::App app;

	app.options().appName    = "psdtext";
	app.options().appVersion = "0.1.0";
	// PSD の保存には書き込みが要る。ファイル API の読み出しは既定で有効。
	app.options().allowWrite = true;

	std::string openPath;
	app.addOption({
		"open", "PATH", "open this PSD on startup",
		[&openPath](const std::string& v) { openPath = v; return true; }
	});

	if (!app.parseArgs(argc, argv)) return app.exitCode();

	// --open が無ければ最初の位置引数を使う (psdtext foo.psd と書ける)
	if (openPath.empty() && !app.options().args.empty())
		openPath = app.options().args.front();

	// ファイル選択ダイアログ相当の UI は appserve 標準の FS API を使う
	app.addModule(appserve::makeFsModule());
	app.addModule(psdtext::makePsdModule(openPath));

	return app.run();
}
