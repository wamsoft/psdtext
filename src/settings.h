//---------------------------------------------------------------------------
// 画面をまたいで残しておきたい設定 (前回開いたフォルダなど)
//
// ポートは起動のたびに変わりうるので、ブラウザの localStorage では消えて
// しまう。サーバ側の小さな JSON ファイルに置く。
//
//   Windows : %APPDATA%/psdtext/settings.json
//   その他  : $XDG_CONFIG_HOME (無ければ ~/.config)/psdtext/settings.json
//
// 中身は素の JSON オブジェクト 1 つ。書き込みに失敗しても動作は止めない
// (設定が残らないだけ)。
//---------------------------------------------------------------------------
#pragma once
#include <string>

#include <appserve/json.h>

namespace psdtext {

class Settings {
public:
	/// 設定ファイルの置き場所 (フォルダは書き込み時に作る)
	static std::string path();

	/// 読み込む (無ければ空のオブジェクト)
	static appserve::Json load();

	/// 渡された値だけ上書きして保存する。成功したら true。
	static bool merge(const appserve::Json& patch);
};

} // namespace psdtext
