//---------------------------------------------------------------------------
// PSD モジュール — /api/psd/* を appserve に生やす
//
// psdparse はスレッドセーフではないので、全ハンドラを Affinity::Main で登録
// する。appserve がメインスレッドへ運んで直列実行してくれるため、この中で
// 排他を書く必要は無い。
//---------------------------------------------------------------------------
#include "psd_module.h"
#include "document.h"

#include <appserve/appserve.h>

#include <stdexcept>

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
		if (op == "save"    && req.method == "POST") return opSave(req);
		if (op == "image"   && req.method == "GET")  return opImage(req);
		if (op == "export"  && req.method == "GET")  return opExport(req);
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

		std::string err;
		if (!doc_.setText(index, j["text"].asStr(), err))
			return Response::error(400, err);
		notifyChanged();
		return Response::json(doc_.textAt(index));
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

	Response opImport(const Request& req) {
		Response deny = requireOpen();
		if (deny.status != 200) return deny;

		// body は CSV そのもの (text/csv) か、{"csv": "...", "apply": bool}
		std::string csvText;
		bool apply = req.param("apply", "1") != "0";
		if (!req.body.empty() && req.body[0] == '{') {
			const Json& j = req.json();
			if (j.isObj() && j.has("csv")) {
				csvText = j["csv"].asStr();
				if (j.has("apply")) apply = j["apply"].asBool(true);
			}
		}
		if (csvText.empty()) csvText = req.body;
		if (csvText.empty()) return Response::error(400, "the request body is empty");

		std::string err;
		auto rows = doc_.importCsv(csvText, apply, err);
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
