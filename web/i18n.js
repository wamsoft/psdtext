//---------------------------------------------------------------------------
// 表示言語の切り替え
//
// HTML 側は data-i18n / data-i18n-title / data-i18n-ph 属性で印を付けておき、
// applyI18n() が DOM を走査して差し替える。JS 側の文言は t('key') で引く。
// 既定はブラウザの言語 (日本語環境なら日本語、それ以外は英語)。
// 明示的に選んだ言語は localStorage に残り、そちらが優先される。
//
// サーバから返るエラーメッセージは英語で統一してあるので、よく出るものだけ
// SERVER_JA で日本語へ寄せる (未知のものはそのまま出す — 情報を失わないため)。
//---------------------------------------------------------------------------

const DICT = {
	ja: {
		// --- ツールバー ---
		'app.open':        '開く…',
		'app.open.title':  'PSD を開く',
		'app.unsaved':     '未保存',
		'app.filter.ph':   'レイヤ名 / 本文で絞り込み',
		'app.csvExport':   'CSV 書き出し',
		'app.csvExport.title': 'テキストを CSV で書き出す',
		'app.csvImport':   'CSV 読み込み',
		'app.csvImport.title': 'CSV を読み込んで一括反映',
		'app.save':        '保存',
		'app.save.title':  'PSD を保存 (元ファイルは .bak へ退避)',
		'app.help.title':  '使い方 (F1)',
		'app.log.title':   'ログ',
		'app.lang.title':  '表示言語 / Display language',
		'app.serverGone':  'psdtext は終了しました。この画面はもう使えません (閉じてください)。',

		// --- 左ペイン ---
		'tree.title':      'レイヤ',
		'tree.showAll':    '全表示',
		'tree.showAll.title': 'すべて表示',
		'tree.textOnly':   'テキストのみ',
		'tree.textOnly.title': 'テキストレイヤだけ表示',
		'tree.reset':      '元に戻す',
		'tree.reset.title': 'PSD の表示状態へ戻す',
		'tree.up.title':   'ひとつ上へ (フォルダは中身ごと)',
		'tree.down.title': 'ひとつ下へ (フォルダは中身ごと)',
		'tree.rename':     '名前',
		'tree.rename.title': 'レイヤ名を変更 (F2 / 名前をダブルクリック)',
		'tree.dup':        '複製',
		'tree.dup.title':  '選択中のテキストレイヤを複製する (名前と本文はその場で決められる)',
		'tree.eye.folder': 'このフォルダ以下の表示を切り替え (プレビュー専用)',
		'tree.eye.layer':  '表示を切り替え (プレビュー専用)',
		'tree.rename.hint': 'ダブルクリックで名前を変更',

		// --- 中央ペイン ---
		'view.zoomOut.title': '縮小',
		'view.zoomIn.title':  '拡大',
		'view.fit':           '全体',
		'view.fit.title':     'ウィンドウに合わせる',
		'view.zoom.title':    'クリックで等倍',
		'view.zoom.titleDpr': 'クリックで等倍 (表示スケール {0}% を補正済み)',
		'view.renderText':    'テキスト仮描画',
		'view.renderText.title': '編集したテキストを画面上で描き直して重ねる (PSD 内蔵の画像は古いままなので)',
		'view.bounds':        '枠',
		'view.bounds.title':  '選択中のレイヤの枠を表示',
		'view.compositing':   '合成中…',
		'view.status':        '{0}×{1} / 表示 {2} レイヤ',
		'view.failed':        '合成に失敗: {0}',
		'view.more':          '詳しく',
		'note.base':          '簡易合成: 調整レイヤ・レイヤ効果・グループの合成設定は未反映。',
		'note.thisPsd':       ' この PSD では {0}。',
		'note.tail':          ' 最終確認は Photoshop で。',
		'note.adjust':        '調整レイヤ {0} 枚は未反映',
		'note.groups':        'グループの合成設定 {0} 件は未反映',
		'note.approx':        '代用しているブレンド {0} 件',
		'note.drawn':         'テキスト {0} 件を仮描画中',
		'note.drawnMissing':  'テキスト {0} 件を仮描画中 (フォント {1} は代替表示)',

		// --- 右ペイン ---
		'edit.title':      '編集',
		'edit.font':       'フォント',
		'edit.font.add':   'システムのフォントから追加',
		'edit.size':       'サイズ',
		'edit.alignL':     '左揃え',
		'edit.alignC':     '中央揃え',
		'edit.alignR':     '右揃え',
		'edit.color':      '色',
		'edit.color.title': '文字色',
		'edit.bold':       '太字',
		'edit.italic':     '斜体',
		'edit.under':      '下線',

		// --- 書式マーク ---
		'fmt.insert':      '＋マーク',
		'fmt.insert.title': 'カーソル位置に書式マークを置く (そこから先の書式が変わる)',
		'fmt.baseTitle':   '基準 — レイヤ全体の初期書式',
		'fmt.remove':      'マークを削除',
		'fmt.remove.title': 'このマークを取り除く (前の書式がそのまま続く)',
		'fmt.chip.reset':  '基準へ',
		'fmt.chip.fontBase': 'フォント基準',
		'fmt.chip.sizeBase': 'サイズ基準',
		'fmt.chip.colorBase': '色基準',
		'fmt.titleMark':   'マーク {0} — ここから先の書式',
		'fmt.titleNew':    '新しいマーク — ここから先の書式',
		'fmt.titleRange':  '選択範囲 ({0} 字) に書式を付ける',
		'fmt.hintBase':    'カーソルの手前にマークが無いので、書式指定の無い部分すべてが変わる。ふだんはここだけで済む。',
		'fmt.hintMark':    'このマークから先に効く。「変更しない」の属性は手前の書式がそのまま続く。',
		'fmt.hintRange':   '範囲の頭に指定を入れ、終わりに元の書式へ戻すマークを置く (閉じタグは作らない)。',
		'fmt.attr.font':   'フォント',
		'fmt.attr.size':   'サイズ',
		'fmt.attr.color':  '色',
		'fmt.attr.bold':   '太字',
		'fmt.attr.italic': '斜体',
		'fmt.attr.underline': '下線',
		'fmt.attr.align':  '行揃え',
		'fmt.mode.keep':   '変更しない',
		'fmt.mode.base':   '基準へ戻す',
		'fmt.mode.set':    '指定する',
		'fmt.mode.on':     'ON',
		'fmt.mode.off':    'OFF',
		'fmt.pickFont':    'フォントを選ぶ…',
		'fmt.pickFont.title': '一覧から選んで、このマークに適用する',
		'fmt.alignNeedsLineHead': '行頭のマークだけ',
		'fmt.align.0':     '左揃え',
		'fmt.align.1':     '右揃え',
		'fmt.align.2':     '中央揃え',
		'fmt.align.3':     '均等 (左)',
		'fmt.align.4':     '均等 (右)',
		'fmt.align.5':     '均等 (中央)',
		'fmt.align.6':     '両端揃え',
		'edit.pos':        '位置',
		'edit.posX.title': '文書上の X 座標',
		'edit.posY.title': '文書上の Y 座標',
		'edit.box':        '枠',
		'edit.boxW.title': '流し込み枠の幅',
		'edit.boxH.title': '流し込み枠の高さ',
		'edit.body':       '本文',
		'edit.text.ph':    'レイヤを選ぶと編集できます',
		'edit.apply':      '反映',
		'edit.apply.title': '本文を反映 (Ctrl+Enter)',
		'edit.revert':     '元に戻す',
		'edit.revert.title': '読み込み時の内容へ戻す',
		'edit.meta.layer': 'レイヤ',
		'edit.meta.pos':   '位置',
		'edit.applied':    '反映しました',
		'edit.unsaved':    '未保存の変更あり',
		'edit.styled':     '書式タグを含みます。',
		'edit.fontMissing': '仮描画のフォントは代替表示です。',
		'edit.notText':    '{0} レイヤ (テキストではありません)',
		'edit.vertical':   '縦書き (仮描画は横書きで代用)',
		'edit.pointText':  'ポイントテキスト (流し込み枠なし)',
		'edit.fontNotHere': '(この PC に無し)',

		// --- ダイアログ ---
		'dlg.openPsd':     'PSD を開く',
		'dlg.openPath.ph': 'D:/work/foo.psd',
		'dlg.openGo':      '開く',
		'dlg.dupTitle':    'テキストレイヤを複製',
		'dlg.dupHint':     '選択中のテキストレイヤを複製する。書式・フォント・位置・流し込み枠は複製元をそのまま引き継ぐ (位置を変えたい場合は Photoshop 側で移動)。本文を書き換えれば、実質「新規テキストレイヤの追加」になる。',
		'dlg.name':        '名前',
		'dlg.body':        '本文 (書式タグを含む)',
		'dlg.dupClear':    '本文を空にする',
		'dlg.dupGo':       '複製する',
		'dlg.fontTitle':   'フォントを追加',
		'dlg.fontHint':    'PSD が持っているフォント以外を使いたいときに追加する。一覧はこの PC にインストールされているフォント。Photoshop 側にも同じフォントが必要で、無い場合は代替表示になる。',
		'dlg.fontFilter.ph': '絞り込み',
		'dlg.fontForBase': '適用先: 基準 (レイヤ全体)',
		'dlg.fontForMark': '適用先: 選択中のマーク / 範囲',
		'dlg.fontOwn':     'この PSD が使っているフォント',
		'dlg.fontSystem':  'この PC のフォント',
		'dlg.fontManual.ph': '名前を直接入力 (PostScript 名)',
		'dlg.fontAdd':     '追加',
		'dlg.fontNoList':  'システムフォントの一覧を取得できませんでした。下の欄に PostScript 名を直接入力してください。',
		'dlg.expTitle':    'CSV を書き出す',
		'dlg.expHint':     '既定の書き出し先は PSD と同じフォルダです。読み込むときも同じ場所が最初に出ます。',
		'dlg.expGo':       '書き出す',
		'dlg.expDownload': 'ブラウザにダウンロード',
		'dlg.csvTitle':    'CSV を読み込む',
		'dlg.csvHint':     'lyid 列でレイヤを照合します (並べ替えや改名に強い)。lyid が無い行は path 列で照合します。text 列には書式タグを含められます。Excel で保存した Shift-JIS の CSV もそのまま読めます。',
		'dlg.impRead':     'このファイルを読む',
		'dlg.csvApply':    '反映する',
		'dlg.saveTitle':   '保存',
		'dlg.saveBackup':  '元ファイルを .bak に退避',
		'dlg.savePath.ph': '空欄なら上書き保存',
		'dlg.saveGo':      '保存',
		'dlg.saveHint':    '編集していないレイヤはバイト単位でそのまま保持されます。表示 ON/OFF はプレビュー用なので保存されません。合成プレビューは Photoshop で開き直すまで更新されません。',
		'dlg.helpTitle':   'psdtext の使い方',
		'dlg.logTitle':    'ログ',
		'dlg.loading':     '読み込み中…',

		// --- CSV レポート ---
		'csv.applied':     '反映: 変更 {0} / 同一 {1} / 未解決 {2} / 失敗 {3}',
		'csv.dry':         '確認: 変更予定 {0} / 同一 {1} / 未解決 {2}',
		'csv.charset':     '{0} として読みました (文字化けしていたら、UTF-8 で保存し直してください)。',
		'csv.whySame':     '中身が今の本文と同じなので「反映する」は押せません。編集した CSV を選んでください。',
		'csv.whyNotfound': 'どの行もレイヤに結び付きませんでした。別の PSD から書き出した CSV かもしれません (lyid が一致しません)。',
		'csv.col.status':  '状態',
		'csv.col.layer':   'レイヤ',
		'csv.col.note':    '備考',
		'csv.changed':     '変更',
		'csv.notfound':    '未解決',
		'csv.error':       '失敗',

		// --- トースト ---
		'msg.loaded':      '{0} 個のテキストレイヤを読み込みました',
		'msg.saved':       '保存しました: {0}',
		'msg.csvUpdated':  '{0} 件のテキストを更新しました',
		'msg.csvWritten':  '書き出しました: {0}',
		'msg.duplicated':  'レイヤを複製しました',
		'msg.renamed':     'レイヤ名を「{0}」に変更しました',
		'msg.startFailed': '起動に失敗しました: {0}',
		'msg.pickCsv':     'CSV ファイルを選んでください',
		'msg.helpFailed':  'ヘルプを読み込めませんでした: {0}',
		'msg.needText':    'テキストレイヤを選んでください',
	},

	en: {
		'app.open':        'Open…',
		'app.open.title':  'Open a PSD',
		'app.unsaved':     'unsaved',
		'app.filter.ph':   'Filter by layer name or text',
		'app.csvExport':   'Export CSV',
		'app.csvExport.title': 'Export the text as CSV',
		'app.csvImport':   'Import CSV',
		'app.csvImport.title': 'Import a CSV and apply it in bulk',
		'app.save':        'Save',
		'app.save.title':  'Save the PSD (the original is kept as .bak)',
		'app.help.title':  'Help (F1)',
		'app.log.title':   'Log',
		'app.lang.title':  '表示言語 / Display language',
		'app.serverGone':  'psdtext has stopped. This window is no longer live — you can close it.',

		'tree.title':      'Layers',
		'tree.showAll':    'Show all',
		'tree.showAll.title': 'Show every layer',
		'tree.textOnly':   'Text only',
		'tree.textOnly.title': 'Show only the text layers',
		'tree.reset':      'Reset',
		'tree.reset.title': 'Go back to the visibility stored in the PSD',
		'tree.up.title':   'Move up (folders move with their contents)',
		'tree.down.title': 'Move down (folders move with their contents)',
		'tree.rename':     'Rename',
		'tree.rename.title': 'Rename the layer (F2, or double-click the name)',
		'tree.dup':        'Duplicate',
		'tree.dup.title':  'Duplicate the selected text layer (you can set its name and body)',
		'tree.eye.folder': 'Toggle this folder and its contents (preview only)',
		'tree.eye.layer':  'Toggle visibility (preview only)',
		'tree.rename.hint': 'Double-click to rename',

		'view.zoomOut.title': 'Zoom out',
		'view.zoomIn.title':  'Zoom in',
		'view.fit':           'Fit',
		'view.fit.title':     'Fit to the window',
		'view.zoom.title':    'Click for 1:1',
		'view.zoom.titleDpr': 'Click for 1:1 (compensated for {0}% display scaling)',
		'view.renderText':    'Redraw text',
		'view.renderText.title': 'Redraw edited text on screen (the raster inside the PSD stays stale)',
		'view.bounds':        'Bounds',
		'view.bounds.title':  'Outline the selected layer',
		'view.compositing':   'Compositing…',
		'view.status':        '{0}×{1} / {2} layers shown',
		'view.failed':        'Compositing failed: {0}',
		'view.more':          'Details',
		'note.base':          'Approximate composite: adjustment layers, layer effects and group blending are not applied.',
		'note.thisPsd':       ' In this PSD: {0}.',
		'note.tail':          ' Check the result in Photoshop.',
		'note.adjust':        '{0} adjustment layer(s) not applied',
		'note.groups':        '{0} group blend setting(s) not applied',
		'note.approx':        '{0} blend mode(s) approximated',
		'note.drawn':         '{0} text layer(s) redrawn',
		'note.drawnMissing':  '{0} text layer(s) redrawn (font {1} substituted)',

		'edit.title':      'Edit',
		'edit.font':       'Font',
		'edit.font.add':   'Add from the fonts installed on this PC',
		'edit.size':       'Size',
		'edit.alignL':     'Align left',
		'edit.alignC':     'Align center',
		'edit.alignR':     'Align right',
		'edit.color':      'Colour',
		'edit.color.title': 'Text colour',
		'edit.bold':       'Bold',
		'edit.italic':     'Italic',
		'edit.under':      'Underline',

		'fmt.insert':      '＋Mark',
		'fmt.insert.title': 'Put a formatting mark at the caret (it changes the formatting from there on)',
		'fmt.baseTitle':   'Base — the initial formatting of the whole layer',
		'fmt.remove':      'Remove mark',
		'fmt.remove.title': 'Remove this mark (the preceding formatting simply carries on)',
		'fmt.chip.reset':  'to base',
		'fmt.chip.fontBase': 'font: base',
		'fmt.chip.sizeBase': 'size: base',
		'fmt.chip.colorBase': 'colour: base',
		'fmt.titleMark':   'Mark {0} — formatting from here on',
		'fmt.titleNew':    'New mark — formatting from here on',
		'fmt.titleRange':  'Format the selection ({0} char(s))',
		'fmt.hintBase':    'No mark before the caret, so this changes everything that has no explicit formatting. Usually all you need.',
		'fmt.hintMark':    'Applies from this mark on. Attributes left at "keep" simply carry on from before.',
		'fmt.hintRange':   'Inserts the change at the start and a mark restoring the previous formatting at the end (no closing tags).',
		'fmt.attr.font':   'Font',
		'fmt.attr.size':   'Size',
		'fmt.attr.color':  'Colour',
		'fmt.attr.bold':   'Bold',
		'fmt.attr.italic': 'Italic',
		'fmt.attr.underline': 'Underline',
		'fmt.attr.align':  'Align',
		'fmt.mode.keep':   'keep',
		'fmt.mode.base':   'back to base',
		'fmt.mode.set':    'set',
		'fmt.mode.on':     'on',
		'fmt.mode.off':    'off',
		'fmt.pickFont':    'Pick a font…',
		'fmt.pickFont.title': 'Pick one from the list and apply it to this mark',
		'fmt.alignNeedsLineHead': 'only at the start of a line',
		'fmt.align.0':     'Left',
		'fmt.align.1':     'Right',
		'fmt.align.2':     'Centre',
		'fmt.align.3':     'Justify (last left)',
		'fmt.align.4':     'Justify (last right)',
		'fmt.align.5':     'Justify (last centred)',
		'fmt.align.6':     'Justify all',
		'edit.pos':        'Position',
		'edit.posX.title': 'X in document coordinates',
		'edit.posY.title': 'Y in document coordinates',
		'edit.box':        'Box',
		'edit.boxW.title': 'Width of the text box',
		'edit.boxH.title': 'Height of the text box',
		'edit.body':       'Body',
		'edit.text.ph':    'Select a layer to edit it',
		'edit.apply':      'Apply',
		'edit.apply.title': 'Apply the body (Ctrl+Enter)',
		'edit.revert':     'Revert',
		'edit.revert.title': 'Go back to the text as loaded',
		'edit.meta.layer': 'Layer',
		'edit.meta.pos':   'Bounds',
		'edit.applied':    'Applied',
		'edit.unsaved':    'Unsaved changes',
		'edit.styled':     'Contains formatting tags.',
		'edit.fontMissing': 'The redraw uses a substitute font.',
		'edit.notText':    '{0} layer (not a text layer)',
		'edit.vertical':   'Vertical text (redrawn horizontally)',
		'edit.pointText':  'Point text (no text box)',
		'edit.fontNotHere': '(not on this PC)',

		'dlg.openPsd':     'Open a PSD',
		'dlg.openPath.ph': 'D:/work/foo.psd',
		'dlg.openGo':      'Open',
		'dlg.dupTitle':    'Duplicate a text layer',
		'dlg.dupHint':     'Duplicates the selected text layer. Formatting, font, position and text box are inherited from the source (move it in Photoshop if you need a different position). Rewrite the body and this becomes, in effect, "add a new text layer".',
		'dlg.name':        'Name',
		'dlg.body':        'Body (may contain formatting tags)',
		'dlg.dupClear':    'Clear the body',
		'dlg.dupGo':       'Duplicate',
		'dlg.fontTitle':   'Add a font',
		'dlg.fontHint':    'Add a font that the PSD does not already carry. The list shows the fonts installed on this PC. Photoshop needs the same font as well, otherwise it substitutes one.',
		'dlg.fontFilter.ph': 'Filter',
		'dlg.fontForBase': 'Target: base (whole layer)',
		'dlg.fontForMark': 'Target: the selected mark / range',
		'dlg.fontOwn':     'Fonts this PSD uses',
		'dlg.fontSystem':  'Fonts on this PC',
		'dlg.fontManual.ph': 'Type a name directly (PostScript name)',
		'dlg.fontAdd':     'Add',
		'dlg.fontNoList':  'Could not list the system fonts. Type a PostScript name in the field below.',
		'dlg.expTitle':    'Export a CSV',
		'dlg.expHint':     'It goes next to the PSD by default — and the import dialog starts in the same place.',
		'dlg.expGo':       'Export',
		'dlg.expDownload': 'Download instead',
		'dlg.csvTitle':    'Import a CSV',
		'dlg.csvHint':     'Layers are matched by the lyid column (robust against reordering and renaming). Rows without an lyid fall back to the path column. The text column may contain formatting tags. A Shift-JIS file saved by Excel is read as-is.',
		'dlg.impRead':     'Read this file',
		'dlg.csvApply':    'Apply',
		'dlg.saveTitle':   'Save',
		'dlg.saveBackup':  'Keep the original as .bak',
		'dlg.savePath.ph': 'Leave empty to overwrite',
		'dlg.saveGo':      'Save',
		'dlg.saveHint':    'Layers you did not edit are written back byte for byte. Visibility toggles are preview-only and are not saved. The composite preview stays stale until Photoshop reopens the file.',
		'dlg.helpTitle':   'How to use psdtext',
		'dlg.logTitle':    'Log',
		'dlg.loading':     'Loading…',

		'csv.applied':     'Applied: {0} changed / {1} identical / {2} unresolved / {3} failed',
		'csv.dry':         'Check: {0} to change / {1} identical / {2} unresolved',
		'csv.charset':     'Read as {0} — if the text looks garbled, save the file as UTF-8 instead.',
		'csv.whySame':     'Nothing differs from the current text, so there is nothing to apply. Pick the CSV you edited.',
		'csv.whyNotfound': 'None of the rows matched a layer — this CSV may come from a different PSD (the lyid values do not match).',
		'csv.col.status':  'Status',
		'csv.col.layer':   'Layer',
		'csv.col.note':    'Note',
		'csv.changed':     'changed',
		'csv.notfound':    'unresolved',
		'csv.error':       'failed',

		'msg.loaded':      'Loaded {0} text layer(s)',
		'msg.saved':       'Saved: {0}',
		'msg.csvUpdated':  'Updated {0} text layer(s)',
		'msg.csvWritten':  'Exported: {0}',
		'msg.duplicated':  'Layer duplicated',
		'msg.renamed':     'Renamed the layer to "{0}"',
		'msg.startFailed': 'Could not start: {0}',
		'msg.pickCsv':     'Pick a CSV file first',
		'msg.helpFailed':  'Could not load the help: {0}',
		'msg.needText':    'Select a text layer first',
	},
};

//---------------------------------------------------------------------------
// サーバのメッセージは英語で統一してある。よく出るものだけ日本語へ寄せる。
const SERVER_JA = {
	'no document is open':            '文書が開かれていません',
	'layer index out of range':       'レイヤ番号が範囲外です',
	'cannot move any further up':     'これ以上上へは動かせません',
	'cannot move any further down':   'これ以上下へは動かせません',
	'the text box is too small':      '枠が小さすぎます',
	'this text layer has no text box': 'このテキストレイヤは枠を持っていません',
	'layer name must not be empty':   'レイヤ名を空にはできません',
	'write access is disabled (start with --allow-write)':
		'書き込みが無効です (--allow-write を付けて起動してください)',
};

//---------------------------------------------------------------------------
let lang = 'en';

export function currentLang() { return lang; }

export function setLang(next) {
	lang = (next === 'ja') ? 'ja' : 'en';
	try { localStorage.setItem('psdtext.lang', lang); } catch (e) { /* private mode */ }
	document.documentElement.lang = lang;
	applyI18n();
}

/// ブラウザの言語設定から既定を決める。日本語環境なら日本語、それ以外は英語。
function browserLang() {
	const list = (navigator.languages && navigator.languages.length)
		? navigator.languages : [navigator.language || ''];
	for (const l of list) {
		const s = String(l).toLowerCase();
		if (s === 'ja' || s.startsWith('ja-')) return 'ja';
		// 先に英語が来ていたら英語で確定する (ja より優先順位が高いということ)
		if (s === 'en' || s.startsWith('en-')) return 'en';
	}
	return 'en';
}

export function initLang() {
	let saved = null;
	try { saved = localStorage.getItem('psdtext.lang'); } catch (e) {}
	// 明示的に選ばれていればそれ、無ければブラウザの言語
	lang = (saved === 'ja' || saved === 'en') ? saved : browserLang();
	document.documentElement.lang = lang;
	return lang;
}

/// 文言を引く。{0} {1} … を引数で差し替える。
export function t(key, ...args) {
	const table = DICT[lang] || DICT.en;
	let s = table[key];
	if (s === undefined) s = (DICT.en[key] !== undefined) ? DICT.en[key] : key;
	return s.replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? args[i] : m));
}

/// サーバから返ったメッセージを表示用に整える
export function serverMessage(msg) {
	if (!msg) return '';
	if (lang === 'ja' && SERVER_JA[msg]) return SERVER_JA[msg];
	return msg;
}

/// data-i18n 属性の付いた要素をまとめて差し替える
export function applyI18n(root = document) {
	root.querySelectorAll('[data-i18n]').forEach(el => {
		el.textContent = t(el.dataset.i18n);
	});
	root.querySelectorAll('[data-i18n-title]').forEach(el => {
		el.title = t(el.dataset.i18nTitle);
	});
	root.querySelectorAll('[data-i18n-ph]').forEach(el => {
		el.placeholder = t(el.dataset.i18nPh);
	});
}
