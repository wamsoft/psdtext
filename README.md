# psdtext

PSD のテキストレイヤを一覧して書き換えるローカルツール。
Photoshop を開かずに、翻訳・校正・表記ゆれ修正といった**テキストの再編集**を行う。

- レイヤツリーとテキスト一覧を並べて表示し、その場で本文を編集
- **CSV 書き出し / 読み込み**で一括置換 (翻訳やレビューの外注に使える)
- 編集していないレイヤはバイト単位でそのまま保存される
- ブラウザが UI。exe 1 つで動き、閉じれば自動で終了する

```
psdtext                  ファイル選択から始める
psdtext foo.psd          起動と同時に開く
psdtext foo.psd --repl   REPL つき (エージェント / 自動テスト用)
```

構成:

| | |
|---|---|
| UI / フレームワーク | [wamsoft/appserve](https://github.com/wamsoft/appserve) — ローカル HTTP サーバ + ブラウザ UI |
| PSD 読み書き | [wamsoft/psdparse](https://github.com/wamsoft/psdparse) — pure C++17 PSD reader/writer |

---

## 使い方

1. `psdtext` を起動するとブラウザ (Edge / Chrome のアプリモード) が開く
2. 「開く…」で PSD を選ぶ
3. 中央の一覧または左のツリーからテキストレイヤを選び、右のペインで編集
4. **反映** (Ctrl+Enter) で文書に取り込み、**保存** (Ctrl+S) でファイルへ書き出す

保存時、元ファイルは `<name>.psd.bak` へ退避される (既存の `.bak` は上書きしない)。
別名で保存したい場合は保存ダイアログでパスを入れる。

### CSV での一括編集

「CSV 書き出し」で次の形式のファイルが得られる (UTF-8 BOM 付き / CRLF なので
Excel でそのまま開ける):

```csv
lyid,path,text
2,"dialog/名前","こんにちは"
4,"dialog/本文","1 行目
2 行目"
```

- `text` 列のセル内改行がそのまま PSD の段落区切りになる
- 照合は **`lyid` (Photoshop の永続レイヤ ID) が主キー**。レイヤの並べ替えや
  改名をしても対応が壊れない。`lyid` が無い行は `path` 列で照合する
  (同名レイヤが複数あるときは曖昧なので未解決として報告する)
- 列の順序は自由で、余分な列があっても無視される

「CSV 読み込み」は最初に**確認だけ**を行い、変更 / 同一 / 未解決の件数と内訳を
表示する。内容を確認してから「反映する」を押すと文書へ取り込まれる
(この時点ではまだメモリ上。ファイルへ書くのは「保存」)。

---

## ビルド

CMake 3.16+ と C++17 コンパイラだけあればよい。依存 (appserve / psdparse /
zlib) は CMake が自動で取得する。

```bash
cmake --preset windows          # MSVC (Developer Command Prompt から)
cmake --build --preset windows-rel
```

appserve や psdparse に手を入れながら開発する場合、`../appserve` /
`../psdparse` にチェックアウトがあれば**自動でそちらが使われる** (取得より優先)。
明示するときは:

```bash
cmake --preset windows -DPSDTEXT_APPSERVE_DIR=D:/test/appserve \
                       -DPSDTEXT_PSDPARSE_DIR=D:/test/psdparse
```

`web/` を編集した場合はブラウザをリロードするだけで反映される
(開発中はカレント/exe 隣の `web/` が、リリース時は exe 埋め込み zip が使われる)。

---

## API (派生ツール / 自動化向け)

すべて `X-App-Token` ヘッダが要る (起動時に払い出され、UI へは URL 経由で渡る)。

| ルート | 説明 |
|---|---|
| `POST /api/psd/open` | `{path}` を開く。文書情報 + ツリー + テキスト一覧を返す |
| `GET  /api/psd/info` | 開いている文書の概要 (パス / レイヤ数 / 未保存件数) |
| `GET  /api/psd/tree` | 全レイヤ (index / lyid / parent / depth / kind / rect) |
| `GET  /api/psd/texts` | テキストレイヤ一覧 (本文 / フォント / 行揃え / dirty) |
| `POST /api/psd/text` | `{index, text}` で本文を差し替える |
| `POST /api/psd/revert` | `{index}` を読み込み時の内容へ戻す |
| `POST /api/psd/name` | `{index, name}` でレイヤ名を変更 |
| `POST /api/psd/save` | `{path?, backup?}` で保存 (path 省略で上書き) |
| `GET  /api/psd/image?index=N` | レイヤの見た目を生 RGBA で返す (`X-Image-Width/Height`) |
| `GET  /api/psd/export` | テキストを CSV で書き出す |
| `POST /api/psd/import` | CSV を取り込む。`?apply=0` で確認のみ |

ファイル選択用に appserve 標準の `/api/fs/*` も使える。

### REPL

`--repl` (対話) / `--replfile=DIR` (エージェント) / `POST /_app/repl` (curl)。

| コマンド | 説明 |
|---|---|
| `.psd` | 開いている文書の情報 |
| `.texts` | テキストレイヤ一覧 (`*` が未保存) |
| `.settext <index> <text>` | 本文を差し替える |
| `.b state` | ブラウザ側 UI の状態を覗く |
| `.b call select 3` | UI の選択を動かす |

詳細は appserve の [docs/REPL.md](https://github.com/wamsoft/appserve/blob/master/docs/REPL.md)。

---

## 制限

- 対象は**既存のテキストレイヤの本文**。新規テキストレイヤの追加は行わない
- 文字スタイル (フォント / サイズ / 色) は編集すると先頭ランに畳まれる
  (psdparse の `editEngineDataText` の仕様。ラン単位のスタイル編集 API は
  psdparse 側にあるので、必要になれば繋ぎ込む)
- 合成プレビュー画像は編集後も古いまま。Photoshop で開き直すと再合成される
- テキストの流し込み枠 (bounds) は変えないので、長くすると枠からはみ出る

## ライセンス

MIT
