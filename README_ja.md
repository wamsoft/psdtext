# psdtext

*[English version](README.md)*

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

## 画面

| ペイン | 役割 |
|---|---|
| 左 | レイヤツリー。階層の折り畳みと、フォルダ / 個別レイヤの表示 ON/OFF |
| 中央 | 表示 ON/OFF を反映した**合成プレビュー** |
| 右 | 選択したテキストレイヤの編集 (書式・行揃え・フォント) |

表示 ON/OFF は**プレビュー専用**で PSD には保存されない。「元に戻す」で PSD が
持っている表示状態へ戻る。

合成はブラウザの canvas 上で行うので、ON/OFF の切り替えはサーバ往復なしで
即座に反映される。ブレンドモードと不透明度、クリッピングレイヤに対応している
(グループのブレンド・調整レイヤ・レイヤ効果は未対応)。最終確認は Photoshop で
行う前提の**作業用プレビュー**という位置づけで、その旨と、開いている PSD で
実際に影響が出ている箇所は画面下に常時表示される。

UI は英語と日本語に対応している。既定はブラウザの言語で、ツールバーから切り替え
られる。

使い方は本体内に組み込んである (`?` ボタン / <kbd>F1</kbd>)。

ズームの 100% は**実ドット等倍** (画像 1px = 画面 1 デバイス px)。システムの
表示スケールが 200% でも倍サイズにならないよう逆補正している。

### テキストの仮描画

PSD 内蔵のテキスト画像は Photoshop で開き直すまで更新されないので、**編集した
テキストレイヤは canvas に描き直して重ねる**(「テキスト仮描画」で切替)。
組版 (字詰め / 禁則 / 縦書き / 変形) までは再現しないので、内容と位置の確認用。
フォントもこの PC に入っているものしか使えない (無い場合は編集欄に注記が出る)。

## 使い方

1. `psdtext` を起動するとブラウザ (Edge / Chrome のアプリモード) が開く
2. 「開く…」で PSD を選ぶ
3. 左のツリーからテキストレイヤを選び、右のペインで編集
4. **反映** (Ctrl+Enter) で文書に取り込み、**保存** (Ctrl+S) でファイルへ書き出す

書式ボタン (B / I / U / フォント / サイズ) は、編集欄で選んだ範囲にタグを
入れる。行揃えボタンは段落全体に効く。

左ペイン下の **▲▼** は同じ階層の中での並べ替え (フォルダは中身ごと動く)。
**複製** は名前と本文をその場で決められるので、本文を書き換えれば実質
「新規テキストレイヤの追加」になる。

テキストレイヤの**位置と流し込み枠**は、右ペインの数値欄・プレビュー上の
ドラッグ・矢印キー (Shift で 10px) のどれでも変えられる。位置を動かすと
PSD 内蔵のラスタも一緒に動くので、Photoshop で開き直すまでの間も見た目が
ずれない。

**レイヤ名の変更**は、ツリーの名前をダブルクリックするか、選択して `F2`
(または「名前」ボタン)。Enter で確定、Escape で取り消し。テキストレイヤ以外
にも使える。

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

### 書式付きテキスト (タグ表現)

PSD のテキストレイヤは「ラン (連続する文字に同じ書式)」の並びで書式を持つが、
CSV のセルや素の編集欄には構造を入れられない。そこで本文の中にタグを埋め込む
形で 1 本の文字列に畳んでいる。

```
text test [color=#F6005D]テキスト
[align=right][b]TEST[font=SourceHanSansJP-Normal][size=33.3333][color=#0017F6][/b]フォント[size=50]変更
[align=center][font=HGPKyokashotai]別のフォント
```

**閉じタグは無い。** タグはその位置から先の状態を変え、次の指定まで効き続ける。
PSD のランは入れ子ではなく平坦な並びなので、この形が構造にそのまま対応し、
翻訳者が入れ子を壊す事故も起きない。

| タグ | 効果 |
|---|---|
| `[font=名前]` | そこから先のフォント。PSD に無い名前は FontSet へ追記される |
| `[size=48]` | 文字サイズ (px)。小数可 |
| `[color=#FF0000]` | 文字色 |
| `[b]` `[i]` `[u]` | 太字 / 斜体 / 下線を **on** |
| `[/b]` `[/i]` `[/u]` | 同じく **off** |
| `[/font]` `[/size]` `[/color]` | その属性を基準 (先頭ランの書式) へ戻す |
| `[reset]` | 全属性を基準へ戻す |
| `[align=left\|right\|center]` | 段落の行揃え。段落の先頭に置く |
| `[[` | リテラルの `[` |

- **書式が一様なテキストにはタグが 1 つも付かない**ので、普通の翻訳作業では
  タグを意識しなくてよい
- 基準は「先頭ランの書式」。そこから変わる箇所だけタグが出る
- 未知のタグはそのままの文字として残る (壊れた入力で本文を失わない)
- 生成された表現は**往復で完全に安定** (編集 → 保存 → 開き直しで同じ文字列)

CSV の `text` 列にもこの形式が入るので、Excel 上で書式ごと一括編集できる。

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
| `POST /api/psd/align` | `{index, paragraph?, align}` で行揃えを変更 (paragraph 省略で全段落) |
| `POST /api/psd/duplicate` | `{index, name?, text?}` でレイヤを複製 (本文を変えれば新規追加) |
| `POST /api/psd/move` | `{index, direction}` で同じ階層内をひとつ上/下へ (フォルダは中身ごと) |
| `POST /api/psd/place` | `{index, dx, dy}` で移動 / `{index, width, height}` で流し込み枠 |
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
| `.b call lang ja` | 表示言語を切り替える |

詳細は appserve の [docs/REPL.md](https://github.com/wamsoft/appserve/blob/master/docs/REPL.md)。

---

## 制限

- 対象は**既存のテキストレイヤの本文**。新規テキストレイヤの追加は行わない
- テキストレイヤの追加は既存レイヤの複製が土台 (Photoshop が受け付ける構造を
  確実に保つため)。書式と位置は複製元を引き継ぎ、テキストレイヤが 1 枚も無い
  PSD には追加できない
- 位置と流し込み枠を変えられるのはテキストレイヤだけ。画像レイヤの移動や
  拡大縮小は Photoshop 側で行う
- テキストの回転・変形はできない (変換行列のうち移動成分だけを扱う)
- 重ね順の変更は同じ階層の中だけ。フォルダへの出し入れはできない
- 合成プレビュー画像は編集後も古いまま。Photoshop で開き直すと再合成される
- テキストの流し込み枠 (bounds) は変えないので、長くすると枠からはみ出る

## 配布とリリース

`appserve_package()` (appserve 提供) で zip / インストーラを作る。タグを打つと
GitHub Actions が Release を自動生成する。

```bash
cmake --build --preset windows-rel
cpack --config build/windows/CPackConfig.cmake -C Release -B dist   # 手元で作る
git tag v0.1.0 && git push origin v0.1.0                            # リリースする
```

配布物は `psdtext.exe` + README + LICENSE の 3 つだけ。UI は exe に埋め込まれ、
依存 (appserve / psdparse / zlib) は静的リンクされるので DLL は要らない。

リリースの再現性を確保したいときは依存をタグに固定する:

```bash
cmake -B build -DPSDTEXT_APPSERVE_TAG=v0.1.0 -DPSDTEXT_PSDPARSE_TAG=v0.8.1
```

詳細は appserve の [docs/RELEASE.md](https://github.com/wamsoft/appserve/blob/master/docs/RELEASE.md)。


## ライセンス

MIT
