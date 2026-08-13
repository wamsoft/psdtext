#---------------------------------------------------------------------------
# 依存 (appserve / psdparse) の取得
#
# 解決順:
#   1. -DPSDTEXT_<NAME>_DIR=<path>   明示指定
#   2. ../<name>                      隣のチェックアウト (開発時はこれが勝つ)
#   3. GitHub から FetchContent       それ以外 (CI / 新規クローン)
#
# 隣を優先するのは、appserve や psdparse に手を入れながら psdtext を動かす
# 開発フローが主だから。CI では checkout が無いので自動的に 3 になる。
#---------------------------------------------------------------------------
include(FetchContent)

set(PSDTEXT_APPSERVE_REPO "https://github.com/wamsoft/appserve.git" CACHE STRING
    "appserve git repository")
set(PSDTEXT_APPSERVE_TAG  "master" CACHE STRING "appserve git tag/branch")
set(PSDTEXT_PSDPARSE_REPO "https://github.com/wamsoft/psdparse.git" CACHE STRING
    "psdparse git repository")
set(PSDTEXT_PSDPARSE_TAG  "master" CACHE STRING "psdparse git tag/branch")

set(PSDTEXT_APPSERVE_DIR "" CACHE PATH "Local appserve checkout (overrides fetch)")
set(PSDTEXT_PSDPARSE_DIR "" CACHE PATH "Local psdparse checkout (overrides fetch)")

# name / NAME / 既定の隣パス を受けて、ローカル or FetchContent で取り込む
function(_psdtext_add_dep name upper sibling)
    if(PSDTEXT_${upper}_DIR)
        set(_local "${PSDTEXT_${upper}_DIR}")
    elseif(EXISTS "${sibling}/CMakeLists.txt")
        set(_local "${sibling}")
    else()
        set(_local "")
    endif()

    if(_local)
        get_filename_component(_local "${_local}" ABSOLUTE)
        message(STATUS "psdtext: using local ${name} at ${_local}")
        add_subdirectory("${_local}" "${CMAKE_BINARY_DIR}/_local/${name}" EXCLUDE_FROM_ALL)
    else()
        message(STATUS "psdtext: fetching ${name} from ${PSDTEXT_${upper}_REPO}")
        FetchContent_Declare(${name}
            GIT_REPOSITORY "${PSDTEXT_${upper}_REPO}"
            GIT_TAG        "${PSDTEXT_${upper}_TAG}"
            GIT_SHALLOW    TRUE)
        FetchContent_MakeAvailable(${name})
    endif()
endfunction()

function(psdtext_fetch_dependencies)
    get_filename_component(_parent "${CMAKE_CURRENT_SOURCE_DIR}/.." ABSOLUTE)

    # appserve は自前アプリのビルドを持っているので、ここでは無効にする
    set(APPSERVE_BUILD_APP OFF CACHE BOOL "" FORCE)
    _psdtext_add_dep(appserve APPSERVE "${_parent}/appserve")

    # psdparse は Python バインディングと CLI を持っているが、こちらは要らない
    set(PSDPARSE_BUILD_PYTHON OFF CACHE BOOL "" FORCE)
    _psdtext_add_dep(psdparse PSDPARSE "${_parent}/psdparse")

    # appserve_embed_web() は appserve が提供する。ローカル取り込みでも
    # FetchContent でも include 済みになっているはず。
    if(NOT COMMAND appserve_embed_web)
        message(FATAL_ERROR
            "appserve_embed_web() not found — appserve was not configured correctly")
    endif()
endfunction()
