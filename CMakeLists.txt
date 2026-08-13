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
project(psdtext LANGUAGES CXX)

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
)

target_include_directories(psdtext PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(psdtext PRIVATE appserve::core psdparse)

# web/ を zip 化して実行ファイルへ埋め込む (単一 exe 配布用)。
# 開発中はカレント/exe 隣の web/ が優先されるので、編集はそのまま反映される。
appserve_embed_web(psdtext WEB_DIR ${CMAKE_CURRENT_SOURCE_DIR}/web)

install(TARGETS psdtext RUNTIME DESTINATION .)
