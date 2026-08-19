//---------------------------------------------------------------------------
// Document 実装
//---------------------------------------------------------------------------
#include "document.h"

#include <cmath>
#include "csv.h"
#include "richtext.h"

#include <psdfile.h>
#include <psdparse.h>

#include <appserve/log.h>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>

namespace fs = std::filesystem;
using appserve::Json;

namespace psdtext {

namespace {

//---------------------------------------------------------------------------
/// UTF-16 (host order) → UTF-8。psdbase.h には逆方向 (utf8ToU16) しか無い。
std::string u16ToUtf8(const psd::u16str& s)
{
	std::string o;
	o.reserve(s.size() * 3);
	for (size_t i = 0; i < s.size(); ++i) {
		unsigned cp = (unsigned)s[i];
		if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < s.size()) {
			unsigned lo = (unsigned)s[i + 1];
			if (lo >= 0xDC00 && lo <= 0xDFFF) {
				cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
				++i;
			}
		}
		if (cp < 0x80) {
			o += (char)cp;
		} else if (cp < 0x800) {
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
// PSD の段落区切りは CR。UI / CSV では LF で扱うので入口と出口で変換する。
// (CRLF が混ざっていても LF ひとつに畳む)
std::string crToLf(const std::string& s)
{
	std::string o;
	o.reserve(s.size());
	for (size_t i = 0; i < s.size(); ++i) {
		if (s[i] == '\r') {
			o += '\n';
			if (i + 1 < s.size() && s[i + 1] == '\n') ++i;
		} else {
			o += s[i];
		}
	}
	return o;
}

//---------------------------------------------------------------------------
/// 書き戻した書式を、パース済みのラン構成へも反映する。
///
/// psdparse の setLayerRichText は編集後にランの**長さだけ**追随させ、書式は
/// 元のまま残す (EngineData 側だけが新しい)。そのままだと
///   - 次に読む「基準」(先頭ランの書式) が古いまま = 初期書式パネルが嘘をつく
///   - toTagged が古い書式でタグを組み直す (行揃え変更のとき)
/// になるので、こちらで合わせておく。parseTagged が絶対値を返すのでそのまま
/// 写せばよい。
void syncParsedRunStyles(psd::TextLayerData& td,
                         const std::vector<psd::TextRunSpec>& runs)
{
	for (size_t i = 0; i < td.runs.size() && i < runs.size(); ++i) {
		const psd::RunStyleEdit& e = runs[i].style;
		psd::TextStyleRun& r = td.runs[i];
		if (e.hasFont && !e.font.empty()) r.font = psd::utf8ToU16(e.font);
		if (e.hasSize)  r.fontSize = e.size;
		if (e.hasColor) {
			r.hasColor = true;
			for (int k = 0; k < 4; ++k) r.color[k] = e.color[k];
		}
		if (e.hasBold)      r.bold      = e.bold;
		if (e.hasItalic)    r.italic    = e.italic;
		if (e.hasUnderline) r.underline = e.underline;
	}
}

/// 「この編集で書式は変わっていない (変わったのは本文だけ)」か。
///
/// psdparse へは書式を**絶対値**で渡している (指定なし = 元のまま、をやらない)
/// ので、指定の有無からは本文だけの編集かどうかを判別できない。そこで、編集前の
/// タグ表現と編集後のタグ表現を**同じ経路で**ラン構成へ落として突き合わせる。
/// 長さは当然変わるので、比べるのは書式と区切りの数だけ。
///
/// これが true のときだけ psdparse は Txt2 (文書ぜんたいの Text Engine Data)
/// へ追随する。false なら Txt2 は捨てられ、Photoshop はレイヤ毎の TySh を読む。
/// どちらでも Photoshop から見た結果は正しく、違うのは「Photoshop 自身が書く形
/// にどれだけ近いまま残すか」だけ。
bool sameFormatting(const std::vector<psd::TextRunSpec>& oldRuns,
                    const std::vector<psd::TextParagraphSpec>& oldParas,
                    const std::vector<psd::TextRunSpec>& newRuns,
                    const std::vector<psd::TextParagraphSpec>& newParas)
{
	// 区切りの数が変われば書式の構造が変わっている。
	if (oldRuns.size()  != newRuns.size())  return false;
	if (oldParas.size() != newParas.size()) return false;

	auto sameF = [](double a, double b) { return std::fabs(a - b) < 1e-6; };

	for (size_t i = 0; i < newRuns.size(); ++i) {
		const psd::RunStyleEdit& a = oldRuns[i].style;
		const psd::RunStyleEdit& b = newRuns[i].style;
		if (a.hasFont      != b.hasFont      || (a.hasFont      && a.font      != b.font))      return false;
		if (a.hasSize      != b.hasSize      || (a.hasSize      && !sameF(a.size, b.size)))     return false;
		if (a.hasTracking  != b.hasTracking  || (a.hasTracking  && a.tracking  != b.tracking))  return false;
		if (a.hasKerning   != b.hasKerning   || (a.hasKerning   && a.kerning   != b.kerning))   return false;
		if (a.hasBold      != b.hasBold      || (a.hasBold      && a.bold      != b.bold))      return false;
		if (a.hasItalic    != b.hasItalic    || (a.hasItalic    && a.italic    != b.italic))    return false;
		if (a.hasUnderline != b.hasUnderline || (a.hasUnderline && a.underline != b.underline)) return false;
		if (a.hasColor != b.hasColor) return false;
		if (a.hasColor)
			for (int k = 0; k < 4; ++k) if (!sameF(a.color[k], b.color[k])) return false;
	}
	for (size_t i = 0; i < newParas.size(); ++i) {
		const psd::TextParagraphSpec& a = oldParas[i];
		const psd::TextParagraphSpec& b = newParas[i];
		if (a.hasJustification != b.hasJustification) return false;
		if (a.hasJustification && a.justification != b.justification) return false;
	}
	return true;
}

/// t.base (タグ解釈の原点 = 読み込み時の先頭ランの書式) を JSON へ出せる形に
/// 写す。UI の「基準」パネルと仮描画の既定値がこれを読む。
void fillBaseStyle(TextRow& t)
{
	t.font      = t.base.hasFont ? t.base.font : std::string();
	t.fontSize  = t.base.hasSize ? t.base.size : 0.0;
	t.color     = t.base.colorHex();
	t.bold      = t.base.bold;
	t.italic    = t.base.italic;
	t.underline = t.base.underline;
}

std::string lfToCr(const std::string& s)
{
	std::string o;
	o.reserve(s.size());
	for (size_t i = 0; i < s.size(); ++i) {
		if (s[i] == '\r') {
			o += '\r';
			if (i + 1 < s.size() && s[i + 1] == '\n') ++i;   // CRLF → CR
		} else if (s[i] == '\n') {
			o += '\r';
		} else {
			o += s[i];
		}
	}
	return o;
}

//---------------------------------------------------------------------------
// Photoshop のテキストレイヤは本文の末尾に段落マーク (CR) を 1 つ持つ慣習が
// ある。そのまま見せると編集欄に空行が 1 行余計に出るし、「編集して保存 →
// 読み直すと末尾に改行が増えている」という往復の不安定さも生む。
// 表示側では 1 つだけ剥がし、書き戻すときに 1 つだけ足して辻褄を合わせる
// (末尾に本当に空段落を入れたい場合は 2 つになるので、意図は保たれる)。
std::string stripTrailingParagraph(std::string s)
{
	if (!s.empty() && s.back() == '\n') s.pop_back();
	return s;
}

std::string ensureTrailingParagraph(std::string s)
{
	if (s.empty() || s.back() != '\r') s += '\r';
	return s;
}

//---------------------------------------------------------------------------
const char* kindName(const psd::LayerInfo& l)
{
	switch (l.layerType) {
		case psd::LAYER_TYPE_FOLDER: return "folder";
		case psd::LAYER_TYPE_HIDDEN: return "divider";
		case psd::LAYER_TYPE_ADJUST: return "adjust";
		case psd::LAYER_TYPE_FILL:   return "fill";
		case psd::LAYER_TYPE_TEXT:   return "text";
		default:                     return "image";
	}
}

//---------------------------------------------------------------------------
/// PSD のブレンドモード → canvas の globalCompositeOperation
///
/// canvas は Photoshop のブレンドモードの大半を同名で持っている。持っていない
/// もの (vivid light 等) は見た目の近いものへ寄せる。完全一致ではないので、
/// 最終確認は Photoshop で行う前提の「作業用プレビュー」という位置づけ。
const char* blendName(psd::BlendMode m)
{
	switch (m) {
		case psd::BLEND_MODE_MULTIPLY:      return "multiply";
		case psd::BLEND_MODE_SCREEN:        return "screen";
		case psd::BLEND_MODE_OVERLAY:       return "overlay";
		case psd::BLEND_MODE_DARKEN:        return "darken";
		case psd::BLEND_MODE_LIGHTEN:       return "lighten";
		case psd::BLEND_MODE_COLOR_BURN:    return "color-burn";
		case psd::BLEND_MODE_COLOR_DODGE:   return "color-dodge";
		case psd::BLEND_MODE_HARD_LIGHT:    return "hard-light";
		case psd::BLEND_MODE_SOFT_LIGHT:    return "soft-light";
		case psd::BLEND_MODE_DIFFERENCE:    return "difference";
		case psd::BLEND_MODE_EXCLUSION:     return "exclusion";
		case psd::BLEND_MODE_HUE:           return "hue";
		case psd::BLEND_MODE_SATURATION:    return "saturation";
		case psd::BLEND_MODE_COLOR:         return "color";
		case psd::BLEND_MODE_LUMINOSITY:    return "luminosity";
		// canvas に相当が無いもの: 近いものへ寄せる
		case psd::BLEND_MODE_LINEAR_DODGE:  return "lighter";
		case psd::BLEND_MODE_LINEAR_BURN:   return "color-burn";
		case psd::BLEND_MODE_VIVID_LIGHT:   return "hard-light";
		case psd::BLEND_MODE_LINEAR_LIGHT:  return "hard-light";
		case psd::BLEND_MODE_PIN_LIGHT:     return "hard-light";
		case psd::BLEND_MODE_DARKER_COLOR:  return "darken";
		case psd::BLEND_MODE_LIGHTER_COLOR: return "lighten";
		case psd::BLEND_MODE_SUBTRACT:      return "difference";
		default:                            return "source-over";
	}
}

/// レイヤ名は unicode 名 (luni) を優先し、無ければ pascal 名を使う
std::string layerName(const psd::LayerInfo& l)
{
	if (!l.layerNameUnicode.empty()) return u16ToUtf8(l.layerNameUnicode);
	return l.layerName;
}

} // anonymous

//---------------------------------------------------------------------------
Document::Document() {}
Document::~Document() = default;

bool Document::isOpen() const { return psd_ && psd_->isLoaded; }
int  Document::width() const  { return isOpen() ? psd_->header.width : 0; }
int  Document::height() const { return isOpen() ? psd_->header.height : 0; }

void Document::close()
{
	psd_.reset();
	path_.clear();
	layers_.clear();
	texts_.clear();
}

//---------------------------------------------------------------------------
bool Document::open(const std::string& p, std::string& err)
{
	auto next = std::unique_ptr<psd::PSDFile>(new psd::PSDFile());
	if (!next->load(p.c_str())) {
		err = "could not load as PSD: " + p;
		return false;
	}
	psd_  = std::move(next);
	path_ = p;
	rebuildIndex();
	appserve::logI("opened " + p + " (" + std::to_string(layers_.size()) +
	               " layers, " + std::to_string(texts_.size()) + " text layers)");
	return true;
}

//---------------------------------------------------------------------------
void Document::rebuildIndex()
{
	layers_.clear();
	texts_.clear();
	if (!isOpen()) return;

	const auto& list = psd_->layerList;
	layers_.reserve(list.size());

	// まず名前と親を確定させてから、パスを親のパスに繋げて作る。
	// layerList は下から上の順なので、親は必ず自分より後ろにいるとは限らない
	// -> 2 パスに分ける。
	for (size_t i = 0; i < list.size(); ++i) {
		const psd::LayerInfo& l = list[i];
		LayerRow r;
		r.index   = (int)i;
		r.lyid    = l.layerId;
		r.parent  = l.parentIndex;
		r.name    = layerName(l);
		r.kind    = kindName(l);
		r.visible = l.isVisible();
		r.isText  = (l.layerType == psd::LAYER_TYPE_TEXT) && l.textData.present;
		r.left    = l.left;
		r.top     = l.top;
		r.right   = l.right;
		r.bottom  = l.bottom;
		r.blend       = blendName(l.blendMode);
		r.opacity     = l.opacity;
		r.fillOpacity = l.fill_opacity;
		r.clipping    = (l.clipping != 0);
		// フォルダ / 区切り / 空矩形は描画対象にならない
		r.hasPixels = (l.layerType != psd::LAYER_TYPE_FOLDER &&
		               l.layerType != psd::LAYER_TYPE_HIDDEN &&
		               l.right > l.left && l.bottom > l.top &&
		               !l.channels.empty());
		layers_.push_back(std::move(r));
	}

	// パスと深さ (親を辿る。循環していても打ち切る)
	for (auto& r : layers_) {
		std::vector<std::string> parts{ r.name };
		int guard = 0;
		int p = r.parent;
		while (p >= 0 && p < (int)layers_.size() && ++guard < 64) {
			parts.push_back(layers_[(size_t)p].name);
			p = layers_[(size_t)p].parent;
		}
		r.depth = (int)parts.size() - 1;
		std::string path;
		for (auto it = parts.rbegin(); it != parts.rend(); ++it) {
			if (!path.empty()) path += '/';
			path += *it;
		}
		r.path = std::move(path);
	}

	// テキストレイヤ
	for (const auto& r : layers_) {
		if (!r.isText) continue;
		const psd::LayerInfo& l = list[(size_t)r.index];
		TextRow t;
		t.index         = r.index;
		t.lyid          = r.lyid;
		t.path          = r.path;
		t.name          = r.name;
		t.text          = stripTrailingParagraph(crToLf(u16ToUtf8(l.textData.text)));
		t.justification = l.textData.justification;
		t.left = r.left; t.top = r.top; t.right = r.right; t.bottom = r.bottom;
		t.base = baseFromRuns(l.textData.runs);
		fillBaseStyle(t);
		for (const auto& p : l.textData.paragraphs) t.paragraphJust.push_back(p.justification);

		// 書式をタグで畳んだ表現を作る。書式が一様なら素の本文と同じになる。
		// toTagged は末尾の段落マークを剥がす前の長さで組まれた runs を使うので、
		// 剥がしたぶんは末尾ランが吸収する (取りこぼしは関数側で補われる)。
		t.tagged = toTagged(t.text, l.textData.runs, l.textData.paragraphs, t.base);
		t.styled = hasTags(t.tagged);
		t.original = t.tagged;

		psd_->getLayerFonts(r.index, t.fonts, nullptr);
		t.hasBounds = psd_->getLayerTextBounds(r.index, t.boundsL, t.boundsT,
		                                       t.boundsR, t.boundsB, nullptr);
		t.vertical = (l.textData.orientation == "vertical");
		texts_.push_back(std::move(t));
	}
}

//---------------------------------------------------------------------------
int Document::findByLyid(int lyid) const
{
	if (lyid == 0) return -1;
	for (const auto& t : texts_) if (t.lyid == lyid) return t.index;
	return -1;
}

int Document::findLayerByLyid(int lyid) const
{
	if (lyid == 0) return -1;
	for (const auto& l : layers_) if (l.lyid == lyid) return l.index;
	return -1;
}

int Document::findByPath(const std::string& path) const
{
	if (path.empty()) return -1;
	int hit = -1;
	for (const auto& t : texts_) {
		if (t.path != path) continue;
		if (hit >= 0) return -1;      // 同名が複数 → 曖昧なので解決しない
		hit = t.index;
	}
	return hit;
}

//---------------------------------------------------------------------------
appserve::Json Document::info() const
{
	Json j = Json::object();
	j.set("open", Json(isOpen()));
	if (!isOpen()) return j;
	j.set("path",   Json(path_));
	j.set("width",  Json(width()));
	j.set("height", Json(height()));
	j.set("layers", Json((long long)layers_.size()));
	j.set("texts",  Json((long long)texts_.size()));
	j.set("dirty",  Json((long long)dirtyCount()));
	j.set("csvPath", Json(defaultCsvPath()));   // CSV の既定の置き場所 (PSD の隣)
	return j;
}

appserve::Json Document::tree() const
{
	Json arr = Json::array();
	for (const auto& r : layers_) {
		Json o = Json::object();
		o.set("index",   Json(r.index));
		o.set("lyid",    Json(r.lyid));
		o.set("parent",  Json(r.parent));
		o.set("depth",   Json(r.depth));
		o.set("name",    Json(r.name));
		o.set("path",    Json(r.path));
		o.set("kind",    Json(r.kind));
		o.set("visible", Json(r.visible));
		o.set("text",    Json(r.isText));
		o.set("blend",   Json(r.blend));
		o.set("opacity", Json(r.opacity));
		o.set("fillOpacity", Json(r.fillOpacity));
		o.set("clipping",  Json(r.clipping));
		o.set("hasPixels", Json(r.hasPixels));
		Json rect = Json::array();
		rect.push(Json(r.left));  rect.push(Json(r.top));
		rect.push(Json(r.right)); rect.push(Json(r.bottom));
		o.set("rect", std::move(rect));
		arr.push(std::move(o));
	}
	return arr;
}

namespace {
Json textRowJson(const TextRow& t)
{
	Json o = Json::object();
	o.set("index",         Json(t.index));
	o.set("lyid",          Json(t.lyid));
	o.set("path",          Json(t.path));
	o.set("name",          Json(t.name));
	o.set("text",          Json(t.tagged));      // 編集対象はタグ付き表現
	o.set("plain",         Json(t.text));        // タグを除いた本文 (検索/表示用)
	o.set("original",      Json(t.original));
	o.set("styled",        Json(t.styled));
	Json fonts = Json::array();
	for (const auto& f : t.fonts) fonts.push(Json(f));
	o.set("fonts", std::move(fonts));
	Json pj = Json::array();
	for (int j : t.paragraphJust) pj.push(Json(j));
	o.set("paragraphJust", std::move(pj));
	o.set("vertical", Json(t.vertical));
	o.set("hasBounds", Json(t.hasBounds));
	if (t.hasBounds) {
		o.set("boxWidth",  Json(t.boundsR - t.boundsL));
		o.set("boxHeight", Json(t.boundsB - t.boundsT));
	}
	// 基準の書式 (UI の「基準」パネルと仮描画の既定値)
	o.set("font",          Json(t.font));
	o.set("fontSize",      Json(t.fontSize));
	o.set("color",         Json(t.color));
	o.set("bold",          Json(t.bold));
	o.set("italic",        Json(t.italic));
	o.set("underline",     Json(t.underline));
	o.set("justification", Json(t.justification));
	o.set("dirty",         Json(t.dirty));
	Json rect = Json::array();
	rect.push(Json(t.left));  rect.push(Json(t.top));
	rect.push(Json(t.right)); rect.push(Json(t.bottom));
	o.set("rect", std::move(rect));
	return o;
}
} // anonymous

appserve::Json Document::texts() const
{
	Json arr = Json::array();
	for (const auto& t : texts_) arr.push(textRowJson(t));
	return arr;
}

appserve::Json Document::textAt(int index) const
{
	for (const auto& t : texts_) if (t.index == index) return textRowJson(t);
	return Json();
}

//---------------------------------------------------------------------------
bool Document::setText(int index, const std::string& utf8, std::string& err,
                       std::string* warnOut)
{
	if (!isOpen()) { err = "no document is open"; return false; }
	for (auto& t : texts_) {
		if (t.index != index) continue;
		if (t.tagged == utf8) return true;             // 変化なし

		// タグを解析してラン構成へ戻す。base は読み込み時の先頭ランの書式で
		// 固定なので、タグの無い部分は元の見た目のまま保たれ、[/color] などの
		// 「基準へ戻す」は何度編集しても同じ書式を指す。
		std::string plain;
		std::vector<psd::TextRunSpec> runs;
		std::vector<psd::TextParagraphSpec> paras;
		parseTagged(utf8, t.base, plain, runs, paras, warnOut);

		// PSD 側は CR 区切り + 末尾に段落マーク。長さもそれに合わせる。
		std::string cr = ensureTrailingParagraph(lfToCr(plain));
		psd::u16str wide = psd::utf8ToU16(cr);

		// 編集前のタグ表現も同じ経路で落として、書式が変わっていないか見る。
		std::string oldPlain;
		std::vector<psd::TextRunSpec> oldRuns;
		std::vector<psd::TextParagraphSpec> oldParas;
		parseTagged(t.tagged, t.base, oldPlain, oldRuns, oldParas, nullptr);
		const bool keepTxt2 = sameFormatting(oldRuns, oldParas, runs, paras);

		if (!psd_->setLayerRichText(index, wide, runs, paras, &err, keepTxt2)) return false;

		t.text   = plain;
		t.tagged = utf8;
		t.styled = hasTags(utf8);
		t.dirty  = (t.tagged != t.original);
		psd::LayerInfo& nl = psd_->layerList[(size_t)index];
		syncParsedRunStyles(nl.textData, runs);
		t.paragraphJust.clear();
		for (const auto& p : nl.textData.paragraphs)
			t.paragraphJust.push_back(p.justification);
		return true;
	}
	err = "layer " + std::to_string(index) + " is not an editable text layer";
	return false;
}

//---------------------------------------------------------------------------
bool Document::setJustification(int index, int paraIndex, int just, std::string& err)
{
	if (!isOpen()) { err = "no document is open"; return false; }
	for (auto& t : texts_) {
		if (t.index != index) continue;
		if (!psd_->setLayerJustification(index, paraIndex, just, &err)) return false;

		const psd::LayerInfo& l = psd_->layerList[(size_t)index];
		t.paragraphJust.clear();
		for (const auto& p : l.textData.paragraphs) t.paragraphJust.push_back(p.justification);
		t.justification = l.textData.justification;
		// 行揃えはタグ表現にも出るので作り直す (基準は読み込み時のまま)
		t.tagged = toTagged(t.text, l.textData.runs, l.textData.paragraphs, t.base);
		t.styled = hasTags(t.tagged);
		t.dirty  = (t.tagged != t.original);
		return true;
	}
	err = "layer " + std::to_string(index) + " is not a text layer";
	return false;
}

//---------------------------------------------------------------------------
int Document::duplicateLayer(int index, const std::string& newName, std::string& err)
{
	if (!isOpen()) { err = "no document is open"; return -1; }
	if (index < 0 || index >= (int)layers_.size()) { err = "layer index out of range"; return -1; }

	int ni = psd_->duplicateLayer(index);
	if (ni < 0) { err = "could not duplicate the layer"; return -1; }
	if (!newName.empty() && !psd_->setLayerName(ni, newName.c_str()))
		appserve::logW("duplicated the layer but could not rename it");

	// 複製でインデックスがずれるので索引を作り直す。編集済みの本文は PSDFile
	// 側にあるので失われないが、dirty 表示は作り直しになる。
	// 複製前後で lyid は変わらない (複製側は新規採番) ので lyid で対応付ける。
	std::vector<TextRow> before = texts_;
	rebuildIndex();
	inheritTextState(before, true);
	appserve::logI("duplicated layer " + std::to_string(index) + " -> " + std::to_string(ni));
	return ni;
}

bool Document::revert(int index, std::string& err)
{
	for (auto& t : texts_) {
		if (t.index != index) continue;
		return setText(index, t.original, err, nullptr);
	}
	err = "layer " + std::to_string(index) + " is not a text layer";
	return false;
}

bool Document::setName(int index, const std::string& utf8, std::string& err)
{
	if (!isOpen()) { err = "no document is open"; return false; }
	if (index < 0 || index >= (int)layers_.size()) { err = "layer index out of range"; return false; }
	if (utf8.empty()) { err = "layer name must not be empty"; return false; }
	if (!psd_->setLayerName(index, utf8.c_str())) { err = "could not rename layer"; return false; }
	// 名前が変わるとパスも変わるので索引を作り直す。編集済みの本文は PSDFile
	// 側に入っているので、rebuild しても失われない (dirty 表示だけ作り直す)。
	std::vector<TextRow> before = texts_;
	rebuildIndex();
	inheritTextState(before, false);
	return true;
}

int Document::setNames(const std::vector<std::pair<int, std::string>>& names,
                       std::vector<std::pair<int, std::string>>* errOut)
{
	auto fail = [&](int index, const char* why) {
		if (errOut) errOut->push_back(std::make_pair(index, std::string(why)));
	};
	if (!isOpen()) {
		for (const auto& n : names) fail(n.first, "no document is open");
		return 0;
	}

	// 索引の作り直しは高くつくので、全部書き換えてから最後に一度だけ行う。
	int done = 0;
	for (const auto& n : names) {
		if (n.first < 0 || n.first >= (int)layers_.size()) {
			fail(n.first, "layer index out of range");
			continue;
		}
		if (n.second.empty()) { fail(n.first, "layer name must not be empty"); continue; }
		if (!psd_->setLayerName(n.first, n.second.c_str())) {
			fail(n.first, "could not rename layer");
			continue;
		}
		++done;
	}
	if (done) {
		std::vector<TextRow> before = texts_;
		rebuildIndex();
		inheritTextState(before, false);
	}
	return done;
}

//---------------------------------------------------------------------------
/// rebuildIndex の後に、引き継ぐべき編集状態を戻す。
///
/// 本文そのものは PSDFile 側にあるので rebuild しても残るが、
///   - original (読み込み時のタグ表現) は Document しか持っていない
///   - base (タグ解釈の原点) は「読み込み時の先頭ラン」で、rebuild すると
///     編集後のランから作り直されてしまう
/// ので、両方戻したうえでタグ表現を組み直す。
void Document::inheritTextState(const std::vector<TextRow>& before, bool byLyid)
{
	for (auto& t : texts_) {
		for (const auto& b : before) {
			bool hit = byLyid ? (b.lyid != 0 && b.lyid == t.lyid) : (b.index == t.index);
			if (!hit) continue;
			t.original = b.original;
			t.base     = b.base;
			fillBaseStyle(t);
			const psd::LayerInfo& l = psd_->layerList[(size_t)t.index];
			t.tagged = toTagged(t.text, l.textData.runs, l.textData.paragraphs, t.base);
			t.styled = hasTags(t.tagged);
			t.dirty  = (t.tagged != t.original);
			break;
		}
	}
}

//---------------------------------------------------------------------------
int Document::moveLayer(int index, bool up, std::string& err)
{
	if (!isOpen()) { err = "no document is open"; return -1; }
	if (index < 0 || index >= (int)layers_.size()) { err = "layer index out of range"; return -1; }

	int ni = -1;
	if (!psd_->moveLayerSibling(index, up, &ni)) {
		err = up ? "これ以上上へは動かせません" : "これ以上下へは動かせません";
		return -1;
	}

	// インデックスが総入れ替えになるので索引を作り直す。編集済みの本文は
	// PSDFile 側にあるので失われない。dirty 表示は lyid で引き継ぐ。
	std::vector<TextRow> before = texts_;
	rebuildIndex();
	for (auto& t : texts_) {
		for (const auto& b : before) {
			if (b.lyid == 0 || b.lyid != t.lyid) continue;
			t.original = b.original;
			t.dirty    = (t.tagged != t.original);
			break;
		}
	}
	appserve::logI("moved layer " + std::to_string(index) + " -> " + std::to_string(ni));
	return ni;
}

//---------------------------------------------------------------------------
bool Document::moveText(int index, double dx, double dy, std::string& err)
{
	if (!isOpen()) { err = "no document is open"; return false; }
	if (dx == 0 && dy == 0) return true;
	if (!psd_->moveTextLayer(index, dx, dy, &err)) return false;

	// 矩形が変わったので索引を作り直す (dirty は lyid で引き継ぐ)
	std::vector<TextRow> before = texts_;
	rebuildIndex();
	for (auto& t : texts_) {
		for (const auto& b : before) {
			if (b.lyid == 0 || b.lyid != t.lyid) continue;
			t.original = b.original;
			t.dirty    = true;   // 位置を動かした = 未保存の変更
			break;
		}
	}
	return true;
}

bool Document::resizeText(int index, double width, double height, std::string& err)
{
	if (!isOpen()) { err = "no document is open"; return false; }
	for (auto& t : texts_) {
		if (t.index != index) continue;
		if (!t.hasBounds) { err = "このテキストレイヤは枠を持っていません"; return false; }
		if (width < 1 || height < 1) { err = "枠が小さすぎます"; return false; }
		// 左上は動かさず、右下だけを動かす
		if (!psd_->setLayerTextBounds(index, t.boundsL, t.boundsT,
		                              t.boundsL + width, t.boundsT + height, &err))
			return false;
		t.boundsR = t.boundsL + width;
		t.boundsB = t.boundsT + height;
		t.dirty = true;
		return true;
	}
	err = "layer " + std::to_string(index) + " is not a text layer";
	return false;
}

//---------------------------------------------------------------------------
int Document::dirtyCount() const
{
	int n = 0;
	for (const auto& t : texts_) if (t.dirty) ++n;
	return n;
}

std::vector<int> Document::dirtyIndices() const
{
	std::vector<int> out;
	for (const auto& t : texts_) if (t.dirty) out.push_back(t.index);
	return out;
}

//---------------------------------------------------------------------------
bool Document::save(const std::string& outPath, bool backup, std::string& err)
{
	if (!isOpen()) { err = "no document is open"; return false; }
	std::string target = outPath.empty() ? path_ : outPath;

	std::error_code ec;
	if (backup && target == path_ && fs::exists(fs::u8path(target), ec)) {
		std::string bak = target + ".bak";
		if (!fs::exists(fs::u8path(bak), ec)) {         // 既存 .bak は上書きしない
			fs::copy_file(fs::u8path(target), fs::u8path(bak), ec);
			if (ec) {
				err = "could not create a backup: " + ec.message();
				return false;
			}
			appserve::logI("backup written: " + bak);
		}
	}

	// PSD の末尾には「全レイヤを合成した絵」が入っていて、Explorer や他のツール
	// はここを見る。テキストを書き換えると当然これは古くなるが、psdtext は
	// 合成をやり直せない (テキストの描画は Photoshop にしかできない)。古い絵を
	// そのまま配ると内容が違うプレビューが出回るので、空 (白) にしておく。
	// Photoshop はレイヤから合成し直すので Photoshop での表示には影響しない。
	// 「PSD 互換を優先」を切って保存したときに Photoshop 自身がやるのと同じ形。
	if (dirtyCount() > 0) psd_->setMergedImageSolid();

	// 上書き保存は、開いているファイルを mmap したまま同じパスへ書けないので
	// いったん一時ファイルへ出してから差し替える。
	std::string tmp = target + ".psdtext.tmp";
	if (!psd_->save(tmp.c_str())) {
		fs::remove(fs::u8path(tmp), ec);
		err = "could not write " + tmp;
		return false;
	}

	if (target == path_) {
		psd_->clearData();                              // mmap を解放してから差し替える
	}
	fs::remove(fs::u8path(target), ec);
	fs::rename(fs::u8path(tmp), fs::u8path(target), ec);
	if (ec) {
		err = "could not replace " + target + ": " + ec.message();
		return false;
	}

	// 保存後の状態を正とするため開き直す (dirty がクリアされ、
	// 次の編集も新しいファイルに対して行われる)
	std::string reopenErr;
	if (!open(target, reopenErr)) {
		err = "saved, but could not reopen " + target + ": " + reopenErr;
		return false;
	}
	appserve::logI("saved " + target);
	return true;
}

//---------------------------------------------------------------------------
bool Document::layerImage(int index, std::vector<uint8_t>& rgba, int& w, int& h,
                          std::string& err) const
{
	if (!isOpen()) { err = "no document is open"; return false; }
	if (index < 0 || index >= (int)psd_->layerList.size()) {
		err = "layer index out of range";
		return false;
	}
	const psd::LayerInfo& l = psd_->layerList[(size_t)index];
	w = l.right - l.left;
	h = l.bottom - l.top;
	if (w <= 0 || h <= 0) { err = "layer has no pixels"; return false; }
	if ((long long)w * h > 64ll * 1024 * 1024) { err = "layer is too large to preview"; return false; }

	// ColorFormat(0, 8, 16, 24) は uint32 = 0xAABBGGRR なので、リトルエンディアン
	// では R,G,B,A のバイト順になる = canvas の ImageData にそのまま渡せる。
	static const psd::ColorFormat kRgbaLe(0, 8, 16, 24);
	rgba.assign((size_t)w * (size_t)h * 4, 0);
	if (!psd_->getLayerImage(l, rgba.data(), kRgbaLe, w * 4,
	                         psd::IMAGE_MODE_MASKEDIMAGE)) {
		err = "could not render the layer";
		return false;
	}
	return true;
}

//---------------------------------------------------------------------------
// CSV
//---------------------------------------------------------------------------
//---------------------------------------------------------------------------
// CSV の形
//
//   lyid, path, font, size, color, align, text, tags
//
// 初期書式は列に分けて、text は**素の本文**にする。Excel 上でセルを掴んで
// 一括コピーしたいのに、[align=center] のようなタグが本文と同じセルに混ざって
// いると扱えないため。
//
// 本文の途中に書式指定がある行だけは列に分けきれないので、従来のタグ表現を
// tags 列へそのまま入れておく (取り込み時はそちらを優先する)。
// 大半のレイヤは「初期書式 + 素の本文」なので tags は空になる。
std::string Document::exportCsv(const std::vector<int>& only) const
{
	csv::Table t;
	t.push_back({ "lyid", "path", "font", "size", "color", "align", "text", "tags" });
	for (const auto& r : texts_) {
		if (!only.empty() &&
		    std::find(only.begin(), only.end(), r.index) == only.end()) continue;

		StyleSpec head = headStyle(r.tagged, r.base);
		const bool inlineTags = hasInlineTags(r.tagged);
		char size[32] = "";
		if (head.hasSize) std::snprintf(size, sizeof(size), "%g", head.size);

		t.push_back({
			std::to_string(r.lyid),
			r.path,
			head.hasFont ? head.font : std::string(),
			size,
			head.colorHex(),
			alignName(r.paragraphJust.empty() ? r.justification : r.paragraphJust[0]),
			r.text,                                   // 素の本文 (タグ無し)
			inlineTags ? r.tagged : std::string(),    // 途中に書式がある行だけ
		});
	}
	return csv::write(t, true);
}

//---------------------------------------------------------------------------
/// PSD の隣。…/foo.psd → …/foo_texts.csv
/// 「どこへ出したか分からない」「読み込むとき探し回る」を無くすための既定値。
std::string Document::defaultCsvPath() const
{
	if (path_.empty()) return std::string();
	size_t dot = path_.rfind('.');
	size_t sl  = path_.find_last_of("/\\");
	std::string base = (dot != std::string::npos && (sl == std::string::npos || dot > sl))
		? path_.substr(0, dot) : path_;
	return base + "_texts.csv";
}

bool Document::exportCsvTo(const std::string& path, std::string& err,
                           const std::vector<int>& only) const
{
	if (!isOpen()) { err = "no document is open"; return false; }
	std::string target = path.empty() ? defaultCsvPath() : path;
	if (target.empty()) { err = "no output path"; return false; }

	std::ofstream f(fs::u8path(target), std::ios::binary | std::ios::trunc);
	if (!f) { err = "could not write " + target; return false; }
	const std::string data = exportCsv(only);
	f.write(data.data(), (std::streamsize)data.size());
	if (!f) { err = "could not write " + target; return false; }
	appserve::logI("csv written: " + target);
	return true;
}

bool Document::readFile(const std::string& path, std::string& out, std::string& err) const
{
	std::ifstream f(fs::u8path(path), std::ios::binary);
	if (!f) { err = "could not read " + path; return false; }
	out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
	return true;
}

//---------------------------------------------------------------------------
std::vector<ImportRow> Document::importCsv(const std::string& text, bool apply,
                                           std::string& err,
                                           std::string* charsetOut)
{
	std::vector<ImportRow> out;

	// Excel が既定で吐く Shift-JIS をそのまま読むと、文字化けした本文で
	// 上書きできてしまう。ここで UTF-8 へ揃える (揃わなければ取り込まない)。
	std::string utf8;
	if (!csv::toUtf8(text, utf8, charsetOut, &err)) return out;

	csv::Table table;
	if (!csv::parse(utf8, table, &err)) return out;
	if (table.empty()) { err = "the CSV is empty"; return out; }

	// ヘッダから列位置を決める (順序が違っても、余分な列があっても読める)
	int colLyid = -1, colPath = -1, colText = -1, colTags = -1;
	int colFont = -1, colSize = -1, colColor = -1, colAlign = -1;
	{
		const csv::Row& head = table[0];
		for (size_t i = 0; i < head.size(); ++i) {
			std::string h = head[i];
			std::transform(h.begin(), h.end(), h.begin(),
			               [](unsigned char c) { return (char)tolower(c); });
			if (h == "lyid" || h == "id")             colLyid = (int)i;
			else if (h == "path" || h == "layer")     colPath = (int)i;
			else if (h == "text" || h == "本文")      colText = (int)i;
			else if (h == "tags")                     colTags = (int)i;
			else if (h == "font" || h == "フォント")  colFont = (int)i;
			else if (h == "size" || h == "サイズ")    colSize = (int)i;
			else if (h == "color" || h == "colour" || h == "色") colColor = (int)i;
			else if (h == "align" || h == "行揃え")   colAlign = (int)i;
		}
	}
	if (colText < 0) {
		err = "the CSV needs a 'text' column (got: " +
		      (table[0].empty() ? std::string("(no header)") : table[0][0]) + " ...)";
		return out;
	}
	// 初期書式を分けた新しい形か、text にタグを畳んだ古い形か。
	// どちらでも読めるようにしておく (前に書き出した CSV が手元に残っている)。
	const bool splitCols = (colTags >= 0 || colFont >= 0 || colSize >= 0 ||
	                        colColor >= 0 || colAlign >= 0);

	for (size_t r = 1; r < table.size(); ++r) {
		const csv::Row& row = table[r];
		auto cell = [&](int c) -> std::string {
			return (c >= 0 && c < (int)row.size()) ? row[(size_t)c] : std::string();
		};

		ImportRow ir;
		ir.lyid = colLyid >= 0 ? atoi(cell(colLyid).c_str()) : 0;
		ir.path = cell(colPath);
		ir.text = cell(colText);

		// lyid を主キーにする (レイヤの並べ替えや改名に強い)。無ければパス。
		ir.index = findByLyid(ir.lyid);
		if (ir.index < 0) ir.index = findByPath(ir.path);
		if (ir.index < 0) {
			ir.status  = "notfound";
			ir.message = ir.lyid ? "no text layer with lyid " + std::to_string(ir.lyid)
			                     : "no unique text layer at '" + ir.path + "'";
			out.push_back(std::move(ir));
			continue;
		}

		const TextRow* cur = nullptr;
		for (const auto& t : texts_) if (t.index == ir.index) { cur = &t; break; }

		// 列に分かれている形なら、ここでタグ表現へ組み直す。
		// tags 列に中身があればそれが正 (途中に書式がある行)。
		int wantAlign = -1;
		if (splitCols && cur) {
			// 列から「こうしたい初期書式」を組む (空欄は今のまま)
			StyleSpec want = headStyle(cur->tagged, cur->base);
			if (colFont >= 0 && !cell(colFont).empty()) {
				want.hasFont = true; want.font = cell(colFont);
			}
			if (colSize >= 0 && !cell(colSize).empty()) {
				want.hasSize = true; want.size = atof(cell(colSize).c_str());
			}
			if (colColor >= 0 && !cell(colColor).empty()) {
				float rgba[4];
				if (parseColorHex(cell(colColor), rgba)) {
					want.hasColor = true;
					for (int k = 0; k < 4; ++k) want.color[k] = rgba[k];
				}
			}

			// 本文を触っていなければ、途中の書式指定は残したまま先頭だけ差し替える。
			// 触っていれば位置が意味を失うので、初期書式 + 素の本文へ組み直す
			// (その行は tags 列に元の形が残っているので、戻したければそれを使える)。
			const std::string tags = cell(colTags);
			const std::string cursor = tags.empty() ? cur->tagged : tags;
			if (ir.text == cur->text) {
				ir.text = replaceHeadTags(cursor, want, cur->base);
			} else {
				ir.text = headTagsFor(want, cur->base) + escapeTagText(ir.text);
			}

			if (colAlign >= 0 && !cell(colAlign).empty()) {
				int a;
				if (alignValue(cell(colAlign), a)) wantAlign = a;
			}
		}

		if (cur && cur->tagged == ir.text &&
		    (wantAlign < 0 || (!cur->paragraphJust.empty() &&
		                       cur->paragraphJust[0] == wantAlign))) {
			ir.status = "same";
			out.push_back(std::move(ir));
			continue;
		}

		if (!apply) {
			ir.status = "changed";
			out.push_back(std::move(ir));
			continue;
		}

		std::string setErr;
		if (setText(ir.index, ir.text, setErr)) {
			ir.status = "changed";
			// 行揃えは段落の指定なので、本文とは別に当てる
			if (wantAlign >= 0) setJustification(ir.index, -1, wantAlign, setErr);
		} else {
			ir.status  = "error";
			ir.message = setErr;
		}
		out.push_back(std::move(ir));
	}
	return out;
}

} // namespace psdtext
