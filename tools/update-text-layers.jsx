// psdtext — テキストレイヤの画像を作り直す (Photoshop 用スクリプト)
//
// なぜ要るか:
//   PSD のテキストレイヤは「テキストの中身」と「描画済みの画像」を別々に持って
//   いる。psdtext は中身を書き換えるが、画像は Photoshop でないと作れない。
//   そして **Photoshop はファイルを開いただけではテキストを描き直さない**ので、
//   開いた直後の画面には編集前の画像が出たままになる (中身は新しい)。
//
//   このスクリプトは開いている文書のテキストレイヤを一通り小突いて、Photoshop
//   自身に描き直させる。組版は Photoshop がやるので、字詰め・禁則・縦書きまで
//   正確に出る。
//
// 使い方:
//   1. psdtext で保存した PSD を Photoshop で開く
//   2. ファイル > スクリプト > 参照... からこのファイルを選ぶ
//   3. 上書き保存する
//
// メモ:
//   小突き方は position への再代入。textItem.contents や justification に
//   代入すると、ラン単位の書式や段落の行揃えが先頭のものへ潰れてしまう
//   (Photoshop 2026 で確認済み)。position は書式も行揃えも保たれる。

#target photoshop

function collectTextLayers(container, out) {
    var i;
    for (i = 0; i < container.artLayers.length; i++) {
        if (container.artLayers[i].kind == LayerKind.TEXT) out.push(container.artLayers[i]);
    }
    for (i = 0; i < container.layerSets.length; i++) {
        collectTextLayers(container.layerSets[i], out);   // グループの中も見る
    }
    return out;
}

function main() {
    if (app.documents.length === 0) {
        alert("PSD を開いてから実行してください。");
        return;
    }
    var doc = app.activeDocument;
    var layers = collectTextLayers(doc, []);
    if (layers.length === 0) {
        alert("テキストレイヤが見つかりませんでした。");
        return;
    }

    var done = 0, failed = 0;
    for (var i = 0; i < layers.length; i++) {
        try {
            layers[i].textItem.position = layers[i].textItem.position;
            done++;
        } catch (e) {
            failed++;
        }
    }

    var msg = "テキストレイヤ " + done + " 個を描き直しました。";
    if (failed > 0) msg += "\n" + failed + " 個は描き直せませんでした (ロック中など)。";
    msg += "\n\n上書き保存すると反映されます。";
    alert(msg);
}

main();
