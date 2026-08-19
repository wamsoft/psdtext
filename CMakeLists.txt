#---------------------------------------------------------------------------
# psdtext — PSD のテキストレイヤを一括で読み書きするローカルツール
#
#   UI/フレームワーク : wamsoft/appserve  (ブラウザ UI + ローカル HTTP サーバ)
#   PSD 読み書き      : wamsoft/psdparse  (pure C++17 PSD reader/writer)
#
# どちらも FetchContent で取得するが、隣に checkout があればそれを使う
# (appserve / psdparse を並行して直す開発フローを壊さないため)。
# 明示するときは -DPSDTEXT_APPSERVE_DIR=... / -DPSDTEXT_PSDPARSE_DIR=...
#---------------------------------------------------------------------------
cmake_minimum_required(VERSION 3.16)
project(psdtext VERSION 0.3.1 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(MSVC)
    add_compile_options(/utf-8 /Zc:__cplusplus)
endif()

include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/Dependencies.cmake)
psdtext_fetch_dependencies()

add_executable(psdtext
    src/main.cpp
    src/document.cpp
    src/psd_module.cpp
    src/csv.cpp
    src/richtext.cpp
    src/settings.cpp
    src/fonts.cpp
)

target_include_directories(psdtext PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(psdtext PRIVATE appserve::core psdparse)

# web/ を zip 化して実行ファイルへ埋め込む (単一 exe 配布用)。
# 開発中はカレント/exe 隣の web/ が優先されるので、編集はそのまま反映される。
appserve_embed_web(psdtext WEB_DIR ${CMAKE_CURRENT_SOURCE_DIR}/web)

# 配布物 (zip / Windows は NSIS インストーラも)。install() の設定込み。
#   cmake --build build --config Release
#   cpack --config build/CPackConfig.cmake -C Release -B dist
# リリース workflow はタグの値を -DPSDTEXT_VERSION=... で渡す
set(PSDTEXT_VERSION "${PROJECT_VERSION}" CACHE STRING
    "Version stamped into release packages")

# Photoshop 側で走らせる再描画スクリプト。
# psdtext はテキストの中身しか直せず、描画済み画像は Photoshop でないと作れない
# (しかも Photoshop は開いただけでは描き直さない)。その最後の一手間を配る。
install(FILES ${CMAKE_CURRENT_SOURCE_DIR}/tools/update-text-layers.jsx
        DESTINATION tools)

appserve_package(psdtext
    VERSION     ${PSDTEXT_VERSION}
    DESCRIPTION "Edit PSD text layers without opening Photoshop")
appserve_package_finalize()
