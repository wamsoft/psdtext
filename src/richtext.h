//---------------------------------------------------------------------------
// タグ形式のリッチテキスト表現
//
// PSD のテキストレイヤは「ラン (連続する文字に同じ書式)」の並びで書式を持つ
// が、CSV のセルや素の textarea には構造を入れられない。そこで本文の中に
// タグを埋め込む形で 1 本の文字列に畳み、読み込み時に解析してラン構成へ
// 戻す。
//
//   これは[b]太字[/b]で[size=96]大きい[size=48]文字
//   [color=#FF0000]赤い文字[color=#000000]黒に戻す
//   [font=NotoSansJP-Bold]別フォント[/font]基準のフォントへ
//   [align=center]中央揃えの段落
//
// 方針:
//   - **閉じタグは無い**。タグはその位置から先の状態を変え、次の指定まで
//     効き続ける。戻すときは値を指定し直すか、[/xxx] で基準へ戻す。
//     PSD のランは入れ子ではなく平坦な並びなので、この形が構造にそのまま
//     対応し、翻訳者が入れ子を壊す事故も起きない
//   - [b] [i] [u] は on、[/b] [/i] [/u] は off。[/size] [/font] [/color] は
//     その属性を基準へ戻す。[reset] で全部戻す
//   - [align=...] は段落の先頭に置き、その段落全体に効く
//   - リテラルの '[' は '[[' と書く
//   - 未知のタグはそのままの文字として扱う (壊れた入力で本文を失わない)
//---------------------------------------------------------------------------
#pragma once
#include <string>
#include <vector>

#include <psdengine.h>

namespace psdtext {

//---------------------------------------------------------------------------
/// タグで表現できる書式一式 (has* が false なら base のまま)
struct StyleSpec {
	bool        hasFont = false;      std::string font;
	bool        hasSize = false;      double      size = 0;
	bool        hasColor = false;     float       color[4] = {0, 0, 0, 1};
	bool        hasBold = false;      bool        bold = false;
	bool        hasItalic = false;    bool        italic = false;
	bool        hasUnderline = false; bool        underline = false;

	/// psdparse の編集構造へ変換する
	psd::RunStyleEdit toRunStyleEdit() const;
	/// 表示上の差が無いか (タグを出す必要があるか)
	bool sameAs(const StyleSpec& o) const;
	/// 色を "#RRGGBB" で (hasColor が false なら黒)
	std::string colorHex() const;
};

//---------------------------------------------------------------------------
/// UTF-8 文字列の UTF-16 コードユニット長 (PSD のラン長はこの単位)
size_t utf16Length(const std::string& utf8);

//---------------------------------------------------------------------------
/// PSD から読んだラン/段落を、タグ付きの 1 本の文字列へ畳む。
///   plainUtf8 : 本文 (改行は \n。末尾の段落マークは剥がしてあること)
///   runs      : psd::TextStyleRun の並び (length は UTF-16 単位)
///   paras     : psd::TextParagraph の並び
/// base には先頭ランの書式が入る (呼び出し側が baseFromRuns で作る)。
std::string toTagged(const std::string& plainUtf8,
                     const std::vector<psd::TextStyleRun>& runs,
                     const std::vector<psd::TextParagraph>& paras,
                     const StyleSpec& base);

/// runs[0] から base の書式を作る
StyleSpec baseFromRuns(const std::vector<psd::TextStyleRun>& runs);

//---------------------------------------------------------------------------
/// タグ付き文字列を解析してラン構成へ戻す。
///   plainOut  : タグを除いた本文 (改行は \n)
///   runsOut   : length は UTF-16 単位。style は絶対値 (base + タグの積み上げ)
///   parasOut  : 段落ごとの length と行揃え
/// 解析は失敗しない設計 (未知タグは文字として残す)。err は警告の集約。
void parseTagged(const std::string& tagged, const StyleSpec& base,
                 std::string& plainOut,
                 std::vector<psd::TextRunSpec>& runsOut,
                 std::vector<psd::TextParagraphSpec>& parasOut,
                 std::string* warnings = nullptr);

/// タグを取り除いた素の本文だけが欲しいとき
std::string stripTags(const std::string& tagged);

/// 本文にタグが含まれているか (UI が「書式付き」表示にするかの判定用)
bool hasTags(const std::string& tagged);

/// 本文の**途中**にタグがあるか。先頭のタグ (= 初期書式の指定) は数えない。
/// CSV で「初期書式は列に分けられるが、途中の書式は分けられない」行を見分ける。
bool hasInlineTags(const std::string& tagged);

/// 先頭に置かれたタグまで適用した書式 (= 利用者から見た「初期書式」)
StyleSpec headStyle(const std::string& tagged, const StyleSpec& base);

/// 初期書式を先頭タグとして書き出す (base と同じ属性は出さない)
std::string headTagsFor(const StyleSpec& style, const StyleSpec& base);

/// 先頭のタグだけ差し替える (本文と途中の書式指定はそのまま)
std::string replaceHeadTags(const std::string& tagged, const StyleSpec& style,
                            const StyleSpec& base);

/// 行揃えの名前 ("left" / "right" / "center" …)。CSV の列に使う。
std::string alignName(int justification);
/// その逆 (解釈できなければ false)
bool alignValue(const std::string& name, int& out);

/// "#RRGGBB" / "RRGGBBAA" を 0..1 の RGBA へ (解釈できなければ false)
bool parseColorHex(const std::string& s, float out[4]);

/// 素の本文をタグ表現へ入れる形にする ('[' は '[[' と書く決まり)
std::string escapeTagText(const std::string& plain);

} // namespace psdtext
