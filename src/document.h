//---------------------------------------------------------------------------
// Document — 開いている PSD 1 つぶんの状態
//
// psdparse はスレッドセーフではないので、この型に触れるのは常に appserve の
// メインスレッド (Affinity::Main) からだけ。ハンドラ側で排他を書く必要は無い。
//---------------------------------------------------------------------------
#pragma once
#include <memory>
#include <string>
#include <vector>

#include <appserve/json.h>

namespace psd { class PSDFile; }

namespace psdtext {

//---------------------------------------------------------------------------
/// レイヤ 1 枚の要約 (ツリー表示用)
struct LayerRow {
	int         index    = 0;      ///< PSDFile::layerList のインデックス
	int         lyid     = 0;      ///< Photoshop 永続レイヤ ID (0 = 無し)
	int         parent   = -1;     ///< 親フォルダの index (-1 = トップレベル)
	int         depth    = 0;
	std::string name;              ///< UTF-8
	std::string path;              ///< "フォルダ/レイヤ" (UTF-8)
	std::string kind;              ///< "text" / "folder" / "image" / "adjust" / "fill"
	bool        visible  = true;
	bool        isText   = false;
	int         left = 0, top = 0, right = 0, bottom = 0;
};

//---------------------------------------------------------------------------
/// テキストレイヤ 1 件
struct TextRow {
	int         index = 0;
	int         lyid  = 0;
	std::string path;
	std::string name;
	std::string text;          ///< UTF-8。段落区切りは \n (PSD の \r から変換済み)
	std::string tagged;        ///< 書式をタグで埋め込んだ形 (編集/CSV はこちらが正)
	std::string original;      ///< 読み込み時の tagged (差分表示 / 復元用)
	std::string font;          ///< 先頭ランのフォント (一覧表示用)
	double      fontSize = 0;  ///< 先頭ランのサイズ
	int         justification = 0;
	bool        dirty = false;
	bool        styled = false;  ///< 複数の書式を持つ (タグが付いている)
	int         left = 0, top = 0, right = 0, bottom = 0;

	/// このレイヤの EngineData が持つフォント名 (UI の候補)
	std::vector<std::string> fonts;
	/// 段落ごとの行揃え (0=左 1=右 2=中央)
	std::vector<int> paragraphJust;
};

//---------------------------------------------------------------------------
/// CSV 取り込みの 1 行ぶんの判定結果
struct ImportRow {
	int         index = -1;        ///< 解決できたレイヤ (-1 = 未解決)
	int         lyid  = 0;
	std::string path;
	std::string text;
	std::string status;            ///< "changed" / "same" / "notfound" / "error"
	std::string message;
};

//---------------------------------------------------------------------------
class Document {
public:
	Document();
	~Document();

	bool open(const std::string& path, std::string& err);
	void close();
	bool isOpen() const;

	const std::string& path() const { return path_; }
	int  width() const;
	int  height() const;

	/// %[ path, width, height, layers, texts, dirty ]
	appserve::Json info() const;
	/// 全レイヤ (ツリー構築用のフラット配列。parent/depth 付き)
	appserve::Json tree() const;
	/// テキストレイヤのみ
	appserve::Json texts() const;
	/// 1 件だけ返す (index 指定)
	appserve::Json textAt(int index) const;

	/// 本文を差し替える。utf8 はタグ付き表現 (書式が一様ならタグ無しの素の本文)。
	/// 改行は \n。警告があれば warnOut に入る。
	bool setText(int index, const std::string& utf8, std::string& err,
	             std::string* warnOut = nullptr);
	/// レイヤ名を変更する
	bool setName(int index, const std::string& utf8, std::string& err);
	/// 読み込み時の内容へ戻す
	bool revert(int index, std::string& err);
	/// 段落の行揃えを変える (paraIndex < 0 で全段落)
	bool setJustification(int index, int paraIndex, int just, std::string& err);

	/// レイヤを複製する。新しいレイヤの index を返す (失敗で -1)。
	int  duplicateLayer(int index, const std::string& newName, std::string& err);

	/// outPath が空なら開いたファイルへ上書き。backup=true なら <name>.psd.bak へ退避。
	bool save(const std::string& outPath, bool backup, std::string& err);

	/// レイヤの見た目を RGBA (幅*高さ*4) で取り出す。空レイヤなら false。
	bool layerImage(int index, std::vector<uint8_t>& rgba, int& w, int& h,
	                std::string& err) const;

	int  dirtyCount() const;
	/// 変更されたテキストレイヤの index 一覧
	std::vector<int> dirtyIndices() const;

	// --- CSV ---------------------------------------------------------------
	/// UTF-8 BOM 付き CSV (lyid, path, text)。Excel でそのまま開ける。
	std::string exportCsv() const;
	/// CSV を取り込む。apply=false なら判定だけ行い、文書は変更しない。
	std::vector<ImportRow> importCsv(const std::string& csv, bool apply,
	                                 std::string& err);

	const std::vector<TextRow>&  textRows() const { return texts_; }
	const std::vector<LayerRow>& layerRows() const { return layers_; }

private:
	void rebuildIndex();
	int  findByLyid(int lyid) const;
	int  findByPath(const std::string& path) const;

	std::unique_ptr<psd::PSDFile> psd_;
	std::string                   path_;
	std::vector<LayerRow>         layers_;
	std::vector<TextRow>          texts_;
};

} // namespace psdtext
