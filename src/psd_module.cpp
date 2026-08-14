//---------------------------------------------------------------------------
// PSD モジュール — /api/psd/* を appserve に生やす
//
// psdparse はスレッドセーフではないので、全ハンドラを Affinity::Main で登録
// する。appserve がメインスレッドへ運んで直列実行してくれるため、この中で
// 排他を書く必要は無い。
//---------------------------------------------------------------------------
#include "psd_module.h"
#include "document.h"
#include "fonts.h"
#include "settings.h"

#include <appserve/appserve.h>

#include <cstdlib>
#include <stdexcept>
#include <utility>
#include <vector>

using namespace appserve;

namespace psdtext {

namespace {

class PsdModule : public IModule {
public:
	explicit PsdModule(std::string startupPath) : startup_(std::move(startupPath)) {}

	const char* name() const override { return "psd"; }

	void registerApi(ApiRegistry& reg) override {
		app_ = &reg.app();

		// prefix 最長一致で 1 本受けて suffix で分岐する
		reg.route("/api/psd/", Affinity::Main,
		          [this](const Request& r) { return handle(r); });

		// 起動時に開くパスを UI へ渡す
		reg.route("/api/app/startup", Affinity::Any, [this](const Request&) {
			Json j = Json::object();
			j.set("open", Json(startup_));
			return Response::json(j);
		});

		// この PC のフォント一覧。
		// PSD が指すのは PostScript 名だが、人が探すのは日本語名なので両方返す。
		// ブラウザの Local Font Access は許可待ちで止まるので、こちらで読む。
		reg.route("/api/app/fonts", Affinity::Any, [](const Request&) {
			Json arr = Json::array();
			for (const auto& f : systemFonts()) {
				Json o = Json::object();
				o.set("postscript", Json(f.postscript));
				o.set("family",     Json(f.family));
				o.set("localName",  Json(f.localFamily));
				o.set("style",      Json(f.style));
				arr.push(std::move(o));
			}
			Json j = Json::object();
			j.set("fonts", std::move(arr));
			return Response::json(j);
		});

		// 画面をまたいで残す設定 (前回開いたフォルダなど)。
		// GET で全部返し、POST で渡されたキーだけ上書きする。
		reg.route("/api/app/settings", Affinity::Any, [](const Request& r) {
			if (r.method == "POST") {
				if (!Settings::merge(r.json()))
					return Response::error(500, "could not save settings");
			}
			return Response::json(Settings::load());
		});

		// --- REPL コマンド (エージェント / 手動デバッグ用) ---
		reg.replCommand("psd", "show the open document", [this](const std::string&) {
			if (!doc_.isOpen()) return std::string("(no document open)\n");
			return doc_.info().dump(2) + "\n";
		});
		reg.replCommand("texts", "list the text layers", [this](const std::string&) {
			if (!doc_.isOpen()) throw std::runtime_error("no document open");
			std::string s;
			for (const auto& t : doc_.textRows()) {
				s += (t.dirty ? "* " : "  ");
				s += std::to_string(t.index) + "  " + t.path + "\n";
				s += "      " + t.text + "\n";
			}
			return s.empty() ? std::string("(no text layers)\n") : s;
		});
		reg.replCommand("settext", "settext <index> <text> — replace a text layer",
		                [this](const std::string& args) {
			size_t sp = args.find(' ');
			if (sp == std::string::npos)
				throw std::runtime_error("usage: .settext <index> <text>");
			int index = atoi(args.substr(0, sp).c_str());
			std::string err;
			if (!doc_.setText(index, args.substr(sp + 1), err))
				throw std::runtime_error(err);
			notifyChanged();
			return "ok\n";
		});
	}

	void onShutdown() override { doc_.close(); }

private:
	App*        app_ = nullptr;
	Document    doc_;
	std::string startup_;

	/// 文書の状態が変わったことを UI へ push する (SSE /_app/sub/psd)
	void notifyChanged() {
		if (!app_) return;
		app_->browser().broadcastJson("psd", doc_.info());
	}

	//-----------------------------------------------------------------------
	Response handle(const Request& req) {
		const std::string& op = req.suffix;

		if (op == "info"    && req.method == "GET")  return opInfo(req);
		if (op == "open"    && req.method == "POST") return opOpen(req);
		if (op == "close"   && req.method == "POST") return opClose(req);
		if (op == "tree"    && req.method == "GET")  return opTree(req);
		if (op == "texts"   && req.method == "GET")  return opTexts(req);
		if (op == "text"    && req.method == "POST") return opSetText(req);
		if (op == "revert"  && req.method == "POST") return opRevert(req);
		if (op == "name"    && req.method == "POST") return opSetName(req);
		if (op == "names"   && req.method == "POST") return opSetNames(req);
		if (op == "align"   && req.method == "POST") return opSetAlign(req);
		if (op == "duplicate" && req.method == "POST") return opDuplicate(req);
		if (op == "move"      && req.method == "POST") return opMove(req);
		if (op == "place"     && req.method == "POST") return opPlace(req);
		if (op == "save"    && req.method == "POST") return opSave(req);
		if (op == "image"   && req.method == "GET")  return opImage(req);
		if (op == "export"  && req.method == "GET")  return opExport(req);
		if (op == "export"  && req.method == "POST") return opExportFile(req);
		if (op == "import"  && req.method == "POST") return opImport(req);

		return Response::error(404, "unknown psd operation: " + op);
	}

	Response requireOpen() const {
		if (doc_.isOpen()) return Response();
		return Response::error(409, "no document is open");
	}

	//-----------------------------------------------------------------------
	Response opInfo(const Request&) { return Response::json(doc_.info()); }

	Response opOpen(const Request& req) {
		std::string path = req.json()["path"].asStr();
		if (path.empty()) path = req.param("path");
		if (path.empty()) return Response::error(400, "path is required");

		std::string err;
		if (!doc_.open(path, err)) return Response::error(400, err);
		notifyChanged();

		Json j = doc_.info();
		j.set("tree",  doc_.tree());
		j.set("texts", doc_.texts());
		return Response::json(j);
	}

	Response opClose(const Request&) {
		doc_.close();
		notifyChanged();
		return Response::json(doc_.info());
	}

	Response opTree(const Request&) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;
		return Response::json(doc_.tree());
	}

	Response opTexts(const Request&) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;
		return Response::json(doc_.texts());
	}

	//-----------------------------------------------------------------------
	Response opSetText(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;

		const Json& j = req.json();
		if (!j.isObj() || !j.has("index")) return Response::error(400, "index is required");
		int index = (int)j["index"].asInt(-1);

		std::string err, warn;
		if (!doc_.setText(index, j["text"].asStr(), err, &warn))
			return Response::error(400, err);
		notifyChanged();
		Json out = doc_.textAt(index);
		// タグの書き損じは失敗にせず警告として返す (本文は失われない)
		if (!warn.empty()) out.set("warning", Json(warn));
		return Response::json(out);
	}

	//-----------------------------------------------------------------------
	Response opSetAlign(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;

		const Json& j = req.json();
		int index = (int)j["index"].asInt(-1);
		int para  = j.has("paragraph") ? (int)j["paragraph"].asInt(-1) : -1;
		int just  = (int)j["align"].asInt(0);

		std::string err;
		if (!doc_.setJustification(index, para, just, err))
			return Response::error(400, err);
		notifyChanged();
		return Response::json(doc_.textAt(index));
	}

	//-----------------------------------------------------------------------
	/// テキストレイヤの複製。新規追加もこれを使う (雛形になるレイヤを選んで
	/// 複製し、本文を差し替える形)。ゼロから TySh を組むより互換性が確実。
	Response opDuplicate(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;

		const Json& j = req.json();
		int index = (int)j["index"].asInt(-1);

		std::string err;
		int ni = doc_.duplicateLayer(index, j["name"].asStr(), err);
		if (ni < 0) return Response::error(400, err);

		// 続けて本文を差し替えられるようにする (新規追加の実体)
		if (j.has("text")) {
			std::string warn;
			if (!doc_.setText(ni, j["text"].asStr(), err, &warn))
				logW("duplicated the layer but could not set its text: " + err);
		}
		notifyChanged();

		Json out = doc_.info();
		out.set("index", Json(ni));
		out.set("tree",  doc_.tree());
		out.set("texts", doc_.texts());
		return Response::json(out);
	}

	Response opRevert(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;
		int index = (int)req.json()["index"].asInt(-1);
		std::string err;
		if (!doc_.revert(index, err)) return Response::error(400, err);
		notifyChanged();
		return Response::json(doc_.textAt(index));
	}

	Response opSetName(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;
		const Json& j = req.json();
		int index = (int)j["index"].asInt(-1);
		std::string err;
		if (!doc_.setName(index, j["name"].asStr(), err))
			return Response::error(400, err);
		notifyChanged();
		Json out = doc_.info();
		out.set("tree",  doc_.tree());
		out.set("texts", doc_.texts());
		return Response::json(out);
	}

	/// レイヤ名をまとめて変える。%[ names: [ %[index|lyid, name], ... ] ]
	///
	/// 1 件ずつ /api/psd/name を叩くと、そのたびに索引の作り直しとツリー全体の
	/// 送り返しが起きる。一括リネームは数十〜数百件になるのでここでまとめる。
	Response opSetNames(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;
		const Json& j = req.json();
		if (!j.isObj() || !j["names"].isArr())
			return Response::error(400, "names[] is required");

		const Json& list = j["names"];
		std::vector<std::pair<int, std::string>> names;
		Json errors = Json::array();
		for (size_t i = 0; i < list.size(); ++i) {
			const Json& e = list[i];
			// lyid は名前を変えても動かないので、指定があればそちらを優先する
			int index = e.has("lyid") ? doc_.findLayerByLyid((int)e["lyid"].asInt(0))
			                          : (int)e["index"].asInt(-1);
			if (index < 0) {
				Json o = Json::object();
				o.set("index",   Json((long long)e["index"].asInt(-1)));
				o.set("lyid",    Json((long long)e["lyid"].asInt(0)));
				o.set("message", Json(std::string("layer not found")));
				errors.push(std::move(o));
				continue;
			}
			names.push_back(std::make_pair(index, e["name"].asStr()));
		}

		std::vector<std::pair<int, std::string>> failed;
		int done = doc_.setNames(names, &failed);
		for (const auto& f : failed) {
			Json o = Json::object();
			o.set("index",   Json((long long)f.first));
			o.set("message", Json(f.second));
			errors.push(std::move(o));
		}
		if (done) notifyChanged();

		Json out = doc_.info();
		out.set("renamed", Json((long long)done));
		out.set("errors",  std::move(errors));
		out.set("tree",  doc_.tree());
		out.set("texts", doc_.texts());
		return Response::json(out);
	}

	//-----------------------------------------------------------------------
	/// 同じ階層の中でレイヤを 1 つ上/下へ動かす。フォルダは中身ごと動く。
	Response opMove(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;

		const Json& j = req.json();
		int index = (int)j["index"].asInt(-1);
		bool up = (j["direction"].asStr("up") != "down");

		std::string err;
		int ni = doc_.moveLayer(index, up, err);
		if (ni < 0) return Response::error(400, err);
		notifyChanged();

		Json out = doc_.info();
		out.set("index", Json(ni));
		out.set("tree",  doc_.tree());
		out.set("texts", doc_.texts());
		return Response::json(out);
	}

	//-----------------------------------------------------------------------
	/// テキストレイヤの配置 (移動 / 枠の大きさ)。
	///   {index, dx, dy}            相対移動
	///   {index, width, height}     枠の大きさ (左上は固定)
	Response opPlace(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;

		const Json& j = req.json();
		int index = (int)j["index"].asInt(-1);
		std::string err;

		if (j.has("dx") || j.has("dy")) {
			if (!doc_.moveText(index, j["dx"].asReal(0), j["dy"].asReal(0), err))
				return Response::error(400, err);
		}
		if (j.has("width") || j.has("height")) {
			Json cur = doc_.textAt(index);
			double w = j.has("width")  ? j["width"].asReal(0)  : cur["boxWidth"].asReal(0);
			double h = j.has("height") ? j["height"].asReal(0) : cur["boxHeight"].asReal(0);
			if (!doc_.resizeText(index, w, h, err))
				return Response::error(400, err);
		}
		notifyChanged();

		Json out = doc_.info();
		out.set("index", Json(index));
		out.set("tree",  doc_.tree());
		out.set("texts", doc_.texts());
		return Response::json(out);
	}

	//-----------------------------------------------------------------------
	Response opSave(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;

		const Json& j = req.json();
		std::string out    = j["path"].asStr();
		bool        backup = j.has("backup") ? j["backup"].asBool(true) : true;

		std::string err;
		if (!doc_.save(out, backup, err)) return Response::error(500, err);
		notifyChanged();

		Json res = doc_.info();
		res.set("tree",  doc_.tree());
		res.set("texts", doc_.texts());
		return Response::json(res);
	}

	//-----------------------------------------------------------------------
	/// レイヤの見た目を生 RGBA で返す。ブラウザは ImageData 経由で canvas に置く。
	/// (PNG エンコーダを持ち込まずに済むので依存が増えない)
	Response opImage(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;

		int index = (int)req.paramInt("index", -1);
		std::vector<uint8_t> rgba;
		int w = 0, h = 0;
		std::string err;
		if (!doc_.layerImage(index, rgba, w, h, err))
			return Response::error(404, err);

		Response r = Response::bytes(
			std::string((const char*)rgba.data(), rgba.size()),
			"application/octet-stream");
		r.headers.set("x-image-width",  std::to_string(w));
		r.headers.set("x-image-height", std::to_string(h));
		return r;
	}

	//-----------------------------------------------------------------------
	Response opExport(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;

		std::string name = "texts.csv";
		{
			// 元ファイル名から <name>_texts.csv を作る
			const std::string& p = doc_.path();
			size_t sl = p.find_last_of("/\\");
			std::string base = (sl == std::string::npos) ? p : p.substr(sl + 1);
			size_t dot = base.rfind('.');
			if (dot != std::string::npos) base = base.substr(0, dot);
			if (!base.empty()) name = base + "_texts.csv";
		}
		Response r = Response::bytes(doc_.exportCsv(), "text/csv; charset=utf-8");
		r.attachment(name);
		return r;
	}

	/// CSV をファイルへ書き出す。既定は PSD の隣 (…/foo_texts.csv)。
	/// ブラウザのダウンロードだと「どこへ落ちたか分からない」ので、
	/// 置き場所をこちらで決められるようにしてある。
	Response opExportFile(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;

		const Json& body = req.json();
		std::string path = body["path"].asStr();

		// indices があれば、そのレイヤだけ書き出す (選択したものだけ渡すとき)
		std::vector<int> only;
		if (body.has("indices") && body["indices"].isArr()) {
			for (const auto& v : body["indices"].elements()) only.push_back((int)v.asInt(-1));
		}

		std::string err;
		if (!doc_.exportCsvTo(path, err, only)) return Response::error(500, err);

		Json j = Json::object();
		j.set("path",  Json(path.empty() ? doc_.defaultCsvPath() : path));
		j.set("texts", Json((long long)(only.empty() ? doc_.textRows().size() : only.size())));
		return Response::json(j);
	}

	Response opImport(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;

		// body は CSV そのもの (text/csv) か、{"csv": "..."} / {"path": "..."}。
		// 文字コードは document 側で見る (Excel の既定は Shift-JIS) ので、
		// ここではバイト列のまま渡す。
		std::string csvText;
		bool apply = req.param("apply", "1") != "0";
		if (!req.body.empty() && req.body[0] == '{') {
			const Json& j = req.json();
			if (j.isObj()) {
				if (j.has("apply")) apply = j["apply"].asBool(true);
				if (j.has("csv")) csvText = j["csv"].asStr();
				else if (j.has("path")) {
					std::string err;
					if (!doc_.readFile(j["path"].asStr(), csvText, err))
						return Response::error(400, err);
				}
			}
		}
		if (csvText.empty() && (req.body.empty() || req.body[0] != '{')) csvText = req.body;
		if (csvText.empty()) return Response::error(400, "the request body is empty");

		std::string err, charset;
		auto rows = doc_.importCsv(csvText, apply, err, &charset);
		if (!err.empty()) return Response::error(400, err);
		if (apply) notifyChanged();

		int changed = 0, same = 0, notfound = 0, failed = 0;
		Json arr = Json::array();
		for (const auto& r : rows) {
			if (r.status == "changed")       ++changed;
			else if (r.status == "same")     ++same;
			else if (r.status == "notfound") ++notfound;
			else                             ++failed;
			Json o = Json::object();
			o.set("index",   Json(r.index));
			o.set("lyid",    Json(r.lyid));
			o.set("path",    Json(r.path));
			o.set("status",  Json(r.status));
			if (!r.message.empty()) o.set("message", Json(r.message));
			arr.push(std::move(o));
		}
		Json j = Json::object();
		j.set("applied",  Json(apply));
		j.set("charset",  Json(charset));      // "utf-8" / "cp932" (画面に出す)
		j.set("changed",  Json(changed));
		j.set("same",     Json(same));
		j.set("notfound", Json(notfound));
		j.set("failed",   Json(failed));
		j.set("rows",     std::move(arr));
		j.set("info",     doc_.info());
		if (apply) j.set("texts", doc_.texts());
		return Response::json(j);
	}
};

} // anonymous

//---------------------------------------------------------------------------
std::unique_ptr<appserve::IModule> makePsdModule(const std::string& startupPath)
{
	return std::unique_ptr<appserve::IModule>(new PsdModule(startupPath));
}

} // namespace psdtext
