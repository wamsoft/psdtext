//---------------------------------------------------------------------------
// PSD モジュールの生成
//---------------------------------------------------------------------------
#pragma once
#include <memory>
#include <string>

#include <appserve/module.h>

namespace psdtext {

/// /api/psd/* を提供する appserve モジュールを作る。
/// startupPath が非空なら UI が起動時にそのファイルを開く。
std::unique_ptr<appserve::IModule> makePsdModule(const std::string& startupPath);

} // namespace psdtext
