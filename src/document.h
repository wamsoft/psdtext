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

#include "richtext.h"

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
	bool        visible  = true;   ///< PSD が持っている可視フラグ (初期値として使う)
	bool        isText   = false;
	int         left = 0, top = 0, right = 0, bottom = 0;

	// --- 合成に必要な情報 ---
	std::string blend;             ///< canvas の globalCompositeOperation 名
	int         opacity  = 255;    ///< 0..255
	int         fillOpacity = 255;
	bool        clipping = false;  ///< 直下のレイヤでクリップされる
	bool        hasPixels = false; ///< 描画できる画素を持つか (フォルダ等は false)
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
	// --- 基準の書式 --------------------------------------------------------
	// タグは「読み込んだ時点の先頭ランの書式」からの差分として書かれる。
	// 編集するとランの書式は動くが、基準はここに固定しておく:
	//   - 動かすと [/color] (基準へ戻す) の意味が編集ごとに変わってしまう
	//   - 本文の頭に置いた指定が基準へ吸われてしまい、タグ表現が読み込み時と
	//     同じなのに見た目が違う = 未保存判定も「元に戻す」も効かなくなる
	StyleSpec   base;          ///< タグ解釈の原点 (読み込み時のまま)
	std::string font;          ///< base のフォント (一覧表示 / UI 用)
	double      fontSize = 0;  ///< base のサイズ
	std::string color = "#000000";  ///< base の色
	bool        bold = false;
	bool        italic = false;
	bool        underline = false;
	int         justification = 0;
	bool        dirty = false;
	bool        styled = false;  ///< 複数の書式を持つ (タグが付いている)
	int         left = 0, top = 0, right = 0, bottom = 0;

	/// このレイヤの EngineData が持つフォント名 (UI の候補)
	std::vector<std::string> fonts;
	/// 段落ごとの行揃え (0=左 1=右 2=中央)
	std::vector<int> paragraphJust;

	/// 流し込み枠 (transform ローカル座標)。UI では幅と高さとして見せる。
	double boundsL = 0, boundsT = 0, boundsR = 0, boundsB = 0;
	bool   hasBounds = false;
	/// 縦書きか (Photoshop の Ornt)
	bool   vertical = false;
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

	/// 同じ階層の隣の兄弟と入れ替える (up=true で表示上ひとつ上へ)。
	/// フォルダは中身ごと動く。移動後の index を返す (動かせなければ -1)。
	int  moveLayer(int index, bool up, std::string& err);

	/// テキストレイヤを平行移動する (文書座標での差分)。
	bool moveText(int index, double dx, double dy, std::string& err);
	/// テキストの流し込み枠の大きさを変える (左上は固定、幅と高さを指定)。
	bool resizeText(int index, double width, double height, std::string& err);

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
	/// rebuildIndex の後に original / base を戻してタグ表現を組み直す
	void inheritTextState(const std::vector<TextRow>& before, bool byLyid);
	int  findByLyid(int lyid) const;
	int  findByPath(const std::string& path) const;

	std::unique_ptr<psd::PSDFile> psd_;
	std::string                   path_;
	std::vector<LayerRow>         layers_;
	std::vector<TextRow>          texts_;
};

} // namespace psdtext
