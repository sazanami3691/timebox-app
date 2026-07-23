# timebox-app プロジェクト・マスターインデックス

この文書は、`timebox-app`の実ファイル、責務、依存関係、保存形式、読み込み順を開発者向けにまとめたファイル目次である。機能仕様は[`TIMEBOX_SPEC.md`](./TIMEBOX_SPEC.md)、UI基準は[`UI_STYLE_GUIDE.md`](./UI_STYLE_GUIDE.md)、作業ルールは[`AGENTS.md`](./AGENTS.md)を正とし、この文書はコードをたどるための入口として使う。

## 1. プロジェクト概要

`timebox-app`は、iPadの通常タブ・ホーム画面版WebアプリとPCブラウザを対象にした、サーバー不要の個人用タイムボックスWebアプリである。HTML、CSS、JavaScriptだけで構成し、予定、履歴、現在タイマー、設定をブラウザ内のIndexedDBへ保存する。

現在の主な構成は次のとおり。

- アプリバージョン: `1.5.0`
- IndexedDB: `timebox-app`、`DB_VERSION 1`
- データスキーマ: `SCHEMA_VERSION 1`
- JSONバックアップ形式: `BACKUP_VERSION 1`
- PWAキャッシュ: `timebox-app-shell-1.5.0`
- 実行時の外部ライブラリ、外部API、外部CDN依存: なし
- Node.jsの用途: 標準`node:test`による開発時テストだけ

## 2. ディレクトリ構成

```text
timebox-app/
├─ index.html                 画面、メニュー、ダイアログのHTML
├─ styles.css                共通テーマ、レイアウト、レスポンシブUI
├─ app-version.js            画面とService Workerが共有するバージョン
├─ manifest.webmanifest      PWA Manifest
├─ sw.js                     アプリシェルキャッシュと手動更新
├─ js/                       アプリのJavaScriptモジュール
├─ test/                     node:testによる自動テスト
├─ icons/                    PWA／iPad用PNGアイコン
├─ tools/                    開発用のアイコン生成スクリプト
├─ README.md                 利用者向け概要と操作・確認手順
├─ TIMEBOX_SPEC.md           機能・データ・段階別仕様
├─ UI_STYLE_GUIDE.md         UIデザインと操作基準
├─ AGENTS.md                 Codexのリポジトリ作業ルール
└─ PROJECT_MASTER_INDEX.md   本ファイル
```

## 3. ルート直下のファイル

| ファイル | 役割 |
| --- | --- |
| `index.html` | 日付別予定、タイマー、日別履歴、全期間検索、階層型設定画面、各ダイアログ、更新バナー、トースト領域を定義する。`app-version.js`を通常スクリプトとして先に読み、続いて`js/app.js`をES Moduleとして読む。Manifest、CSS、PWAアイコンは相対パスで参照する。 |
| `styles.css` | 黒背景・白枠・緑アクセントの共通デザイン、カード、フォーム、ダイアログ、検索、設定詳細、並べ替え表示を担当する。`700px`、`430px`の幅と`prefers-reduced-motion`に対応する。 |
| `app-version.js` | `globalThis.TIMEBOX_APP_VERSION`を1か所で定義する。画面側は`js/pwa.js`、Service Worker側は`sw.js`から参照する。 |
| `manifest.webmanifest` | `id`、`start_url`、`scope`を`./`とするGitHub Pagesサブパス対応のPWA設定。standalone表示、テーマ色、192px／512pxアイコンを定義する。 |
| `sw.js` | 同一オリジンのGETだけを扱うService Worker。アプリシェルの事前キャッシュ、ナビゲーションの`index.html`フォールバック、古い同系統キャッシュの削除、`SKIP_WAITING`メッセージによる手動更新を担当する。IndexedDBには触れない。 |
| `.nojekyll` | GitHub Pagesで静的ファイルをそのまま公開するための空ファイル。 |
| `.gitignore` | OS・エディタ・ログ・秘密情報・依存物・生成出力を除外する。 |
| `package.json` | アプリ版と`npm test`を定義する。依存パッケージはなく、テストは`node --test --test-isolation=none`で実行する。 |
| `README.md` | 実装済み機能、利用方法、PWA、バックアップ、PC／iPad確認手順、既知の制限を利用者向けに説明する。 |
| `TIMEBOX_SPEC.md` | 予定、タイマー、履歴、検索、通知、バックアップ、並べ替えなどの決定済み仕様と段階別実装状況を管理する。 |
| `UI_STYLE_GUIDE.md` | 色、枠、余白、44px以上のタッチ領域、iPad優先、フォーカス、ダイアログなどのUI基準を定める。 |
| `AGENTS.md` | 対象リポジトリ、作業ブランチ、安全確認、実装・検証・Git操作のルールを定める。 |

## 4. JavaScriptモジュール

### 4.1 統合とコア

| ファイル | 主な責務 | 主な公開／主要インターフェース |
| --- | --- | --- |
| `js/app.js` | アプリのComposition Root兼画面Controller。DOM参照、共有`state`、画面切替、描画、フォームとダイアログ、各モジュールの接続、初期化を担当する。他モジュールへは公開APIを持たない。 | 内部の`initialize`、`showView`、`loadSchedule`、`loadHistory`、`renderSchedule`、`renderTimer`、`renderHistory`、`syncTimer`、予定・履歴・バックアップのイベント処理 |
| `js/core.js` | DOMやIndexedDBに依存しない、予定・日付・タイマー・集計の純粋ロジック。 | `SCHEMA_VERSION`、`ACTIVE_TIMER_STATES`、`validatePlan`、`findClockOverlap`、`classifyClockStart`、`createTimer`、`reduceTimer`、残り／超過／実績時間計算、`aggregateDay`、`validateCopyBatch` |
| `js/db.js` | IndexedDBのRepository相当。DBの初期化、読み取り、単体保存、複数ストアの原子的更新を集約する。 | `initializeDatabase`、日付別／全期間取得、予定・タイマー保存、履歴確定、検索／バックアップスナップショット、履歴編集・削除、並べ替え保存、全置換復元、`databaseInfo` |

### 4.2 機能別ロジックとController／Manager

| ファイル | 主な責務 | 主な公開／主要インターフェース |
| --- | --- | --- |
| `js/backup.js` | JSONバックアップ文書の生成、許可フィールドへのサニタイズ、全件検証、読込、ファイル名生成、Web Share／ダウンロード保存。 | `BACKUP_FORMAT`、`BACKUP_VERSION`、`BackupValidationError`、`validateBackupObject`、`createBackupDocument`、`readBackupFile`、`saveBackupFile` |
| `js/history-edit.js` | 履歴編集値の検証、履歴の再構築、最新履歴選択、関連予定との同期・削除後再調整に使う純粋ロジック。 | `validateHistoryEditInput`、`buildEditedHistory`、`historyRevisionKey`、`chooseLatestHistory`、`syncPlanFromHistory`、`assertHistoryPlanTransactionSafe`、`planAfterHistoryDeletion` |
| `js/search.js` | 検索語のtrim・NFKC・小文字化、予定／履歴の部分一致、安定ソート、表示上限、メモ抜粋を処理する純粋ロジック。 | `SEARCH_RESULT_LIMIT`、`normalizeSearchText`、`searchRecords`、`noteExcerpt` |
| `js/search-view.js` | 検索フォームと結果カードを扱うView Controller。検索ボタン時だけスナップショットを取得し、`textContent`で結果を描画する。 | `createSearchViewController`。生成物は`focus`、`refresh`、`hasResults`を持つ。 |
| `js/settings.js` | 第2段階B設定、設定キー、既定値、音量、予定通知時刻、通知済み台帳の正規化を担当する。 | `SETTINGS_META_KEY`、`NOTIFICATION_LEDGER_META_KEY`、`DEFAULT_SETTINGS`、`normalizeSettings`、予定通知計算、`normalizeNotificationLedger` |
| `js/settings-nav.js` | 設定トップと6つの詳細ページの内部ナビゲーション、戻り先フォーカス、Escape処理を担当する。 | `SETTINGS_PAGES`、`createSettingsNavigation`。生成物は`openDetail`、`openTop`、`handleEscape`、`reset`などを持つ。 |
| `js/alerts.js` | Web Audio APIの終了音、Notification API／Service Worker通知、タイマー終了と予定通知の重複防止、通知済み台帳を管理する。 | `createEndSoundController`、`timerExpirationKey`、`createAlertManager`。Managerは開始、購読、音・通知テスト、権限要求、終了通知、予定通知、音停止を提供する。 |
| `js/wake-lock.js` | Screen Wake Lock APIの機能検出、running中の取得、状態変化・非表示時の解除、再表示時の再同期を管理する。 | `createWakeLockManager`。Managerは`start`、`sync`、`release`、`getState`、`subscribe`を提供する。 |
| `js/pwa.js` | Service Worker登録、オンライン／オフライン表示、新版waiting検出、タイマー状態による更新保留、手動適用、1回だけの再読み込みを管理する。 | `isUpdateBlocked`、`createOneTimeReload`、`createPwaManager`。Managerは`start`、`checkForUpdate`、`applyUpdate`、`notifyTimerStateChanged`、状態購読を提供する。 |
| `js/reorder.js` | pending duration予定の対象判定、リビジョン生成、非破壊の配列移動、連番`order`と変更予定の生成を行う純粋ロジック。 | `REORDER_LONG_PRESS_MS`、`REORDER_CANCEL_DISTANCE_PX`、`canReorderPlan`、`planReorderRevision`、`reorderPlansById`、`buildDurationOrderChanges` |
| `js/reorder-controller.js` | ハンドルのPointer Events、400ms長押し、10px移動キャンセル、DOM上の挿入位置、端スクロール、drop／cancel、保存中の二重実行防止を担当する。 | `movedBeyondThreshold`、`createReorderController`。Controllerは`cancel`、`destroy`、`isDragging`、`isSaving`を提供する。 |

専用の`Service`クラスや`Repository`クラスは置いていない。永続化境界は関数群の`js/db.js`、ブラウザAPIを持つ状態管理は`create...Manager`、DOM固有の操作は`create...Controller`という関数ベースの構成である。例外クラスはバックアップ検証用の`BackupValidationError`だけである。

## 5. 主な依存関係

```text
index.html
├─ styles.css
├─ app-version.js
└─ js/app.js
   ├─ js/core.js
   ├─ js/db.js
   │  ├─ js/core.js
   │  ├─ js/history-edit.js
   │  └─ js/reorder.js
   ├─ js/backup.js
   │  ├─ js/core.js
   │  └─ js/settings.js
   ├─ js/history-edit.js
   │  └─ js/core.js
   ├─ js/search-view.js
   │  └─ js/search.js
   ├─ js/alerts.js
   │  └─ js/settings.js
   ├─ js/pwa.js
   ├─ js/wake-lock.js
   ├─ js/reorder.js
   ├─ js/reorder-controller.js
   │  └─ js/reorder.js
   ├─ js/settings.js
   │  └─ js/core.js
   └─ js/settings-nav.js

sw.js
└─ app-version.js（importScripts）
```

`js/app.js`は各モジュールを結合するが、純粋ロジック同士が`js/app.js`へ依存する逆方向の参照はない。`js/db.js`はトランザクション内の安全判定に限り、履歴編集と並べ替えの純粋関数を利用する。

## 6. 初期化と画面表示

1. ブラウザが`index.html`を読み、読み込み中表示を出す。
2. `app-version.js`が`TIMEBOX_APP_VERSION`を設定し、その後`js/app.js`がES Moduleとして評価される。
3. `js/app.js`がPWA、通知・音、Wake LockのManagerを作り、`initialize()`で購読を開始する。
4. 検索、設定ナビゲーション、並べ替えのControllerを作り、DOMイベントを接続する。
5. `initializeDatabase()`がDBを開き、`meta`へ現在のschema／database versionを記録する。
6. `meta`から設定を読み、`normalizeSettings`で正規化する。未保存なら既定値を保存する。
7. 通知済み台帳を読み、`currentTimer`の`active`レコードを取得する。タイマーがあれば現在時刻との差で`reduceTimer(..., { type: "sync" })`を行い保存する。
8. Wake Lock管理を開始し、今日の予定をIndexedDBから読み込む。
9. 読み込み中表示を隠す。activeタイマーがあればタイマー画面、それ以外は日付別予定画面を表示する。
10. Service Worker登録と更新監視を非同期で開始する。
11. 表示更新用にタイマー同期を1秒間隔、予定通知確認を30秒間隔で行う。正しい残り時間はカウント値ではなく保存済み終了予定時刻と現在時刻との差から求める。

画面切替は`js/app.js`の`showView`が予定、タイマー、履歴、検索、設定を排他的に表示する。検索結果からは対象日を読み直してカードへフォーカスし、設定内のトップ／詳細切替は`js/settings-nav.js`が担当する。

## 7. IndexedDBと保存データ

DBの定義と全操作は`js/db.js`に集約されている。

| ストア | keyPath／Index | 保存内容 | 主な利用元 |
| --- | --- | --- | --- |
| `plans` | keyPath `id`、Index `date` | `schemaVersion`、ID、ローカル日付、タイトル、メモ、作業／休憩、duration／clock、分数・開始終了時刻、状態、`order`、作成更新時刻、実績、任意の完了時刻 | 予定画面、タイマー開始、完了欄、検索、履歴同期、並べ替え、バックアップ |
| `history` | keyPath `id`、Index `date`と`planId` | 予定ID、対象日、タイトル、メモ、作業／休憩、完了／スキップ、実績・予定時間、実開始・記録時刻、記録元、schemaVersion | 日別履歴、集計、検索、履歴編集・削除、バックアップ |
| `currentTimer` | keyPath `key` | `key: "active"`の1件。予定ID／日付、表示用タイトル・メモ・種類、running／paused／expired、実開始、終了予定、残り、目標、累積実行、期限超過時刻、更新時刻 | タイマー復帰、同時実行防止、PWA更新保留、並べ替え・履歴編集・復元の競合確認 |
| `meta` | keyPath `key` | `schema`、`phase2b-settings`、`notification-ledger`など責務別のレコード | DB版情報、終了音・音量・予定通知・Wake Lock設定、通知重複防止 |

設定はLocalStorageではなく`meta`ストアの`phase2b-settings`へ保存する。通知権限はブラウザ／OSが管理するためIndexedDBには保存しない。Service WorkerのCache StorageとアプリのIndexedDBは分離されている。

複数データが連動する操作は`js/db.js`の単一トランザクションで行う。

- 予定完了／スキップ: `plans`、`history`、`currentTimer`
- 手動完了: `plans`、`history`
- 履歴編集／削除: `history`、`plans`、`currentTimer`
- duration予定の並べ替え: `plans`、`currentTimer`
- JSON全置換復元: `plans`、`history`、`currentTimer`、`meta`

## 8. JSONバックアップとの関係

`js/db.js`の`getBackupSnapshot()`が`plans`、`history`、指定した設定を同じreadonlyトランザクションで取得し、`js/backup.js`が形式バージョン1の文書へ変換・検証する。

バックアップに含むもの:

- 全予定
- 全履歴
- 正規化済みの`phase2b-settings`
- backup／schema／database／app versionと書き出し日時

含まないもの:

- `currentTimer`
- `notification-ledger`
- Notification APIの権限
- Service Worker登録、Cache Storage
- Undo、ダイアログ、更新待ちなどの一時状態

復元は`replaceAllFromBackup()`がactiveタイマー不在を同じreadwriteトランザクション内で再確認し、予定・履歴・現在タイマーを全置換する。設定とschemaメタを保存し、通知済み台帳だけを削除する。無関係な`meta`キーは全消去しない。

## 9. 機能から担当ファイルを探す

| 機能 | UI統合 | ロジック／Controller | 保存 |
| --- | --- | --- | --- |
| 予定登録・編集・複製・前日コピー | `index.html`、`js/app.js` | `js/core.js` | `js/db.js`の`plans` |
| タイマー・復帰・一時停止・延長・終了待ち | `index.html`、`js/app.js` | `js/core.js` | `js/db.js`の`currentTimer`、結果確定時は`plans`と`history` |
| 日別履歴・集計 | `index.html`、`js/app.js` | `js/core.js`の`aggregateDay` | `js/db.js`の`history` |
| 過去履歴編集・削除 | `index.html`、`js/app.js` | `js/history-edit.js` | `js/db.js`の履歴・予定原子更新 |
| 全期間検索 | `index.html` | `js/search.js`、`js/search-view.js` | `js/db.js`の検索スナップショット |
| 階層型設定UI | `index.html`、`styles.css` | `js/settings-nav.js`、`js/app.js` | 各設定機能に従う |
| 終了音・タイマー終了通知・予定通知 | `index.html`、`js/app.js` | `js/alerts.js`、`js/settings.js` | `meta`の設定と通知済み台帳 |
| Wake Lock | `index.html`、`js/app.js` | `js/wake-lock.js` | 有効設定だけ`meta`へ保存 |
| JSONバックアップ・復元 | `index.html`、`js/app.js` | `js/backup.js` | `js/db.js`のスナップショット／全置換 |
| duration予定の長押し並べ替え | `js/app.js`、`styles.css` | `js/reorder.js`、`js/reorder-controller.js` | `js/db.js`のorder原子更新 |
| PWA登録・オフライン・更新 | `index.html`、`js/app.js` | `js/pwa.js`、`sw.js` | Cache Storage。IndexedDBは変更しない |

## 10. PWA、バージョン、キャッシュ

- `app-version.js`がアプリ版の共通参照元である。
- `index.html`が`app-version.js`を`js/app.js`より先に読み、`js/pwa.js`が画面上の版表示に使う。
- `sw.js`は`importScripts("./app-version.js")`で同じ版を読み、`timebox-app-shell-${TIMEBOX_APP_VERSION}`をキャッシュ名にする。
- `APP_SHELL`には、起動に必要なHTML、CSS、全JavaScriptモジュール、Manifest、アイコンだけを相対パスで列挙する。
- install時に無条件の`skipWaiting`は行わない。新Workerはwaitingとなり、`js/pwa.js`がユーザーの更新操作後に`SKIP_WAITING`を送る。
- running／paused／expiredタイマー中は`js/pwa.js`が更新適用を保留する。`controllerchange`後の再読み込みは1回だけに制限する。
- activate時は`timebox-app-shell-`で始まる旧版キャッシュだけを削除する。IndexedDB、設定、ユーザーデータは削除しない。

新しい実行時静的ファイルを追加・改名・削除した場合は、実ファイル、HTML／import参照、`sw.js`の`APP_SHELL`、関連テストを同時に確認する。Markdown文書や開発専用テスト・ツールはアプリシェルへ含めない。

## 11. テスト

| ファイル | 主な検証対象 |
| --- | --- |
| `test/core.test.js` | 時刻重複、duration計測、早期／遅延開始、タイマー状態遷移、時刻復帰、延長、超過、集計、前日コピー |
| `test/phase2b.test.js` | 設定既定値・音量、予定通知時刻と重複防止、終了音、通知権限、Wake Lock状態遷移 |
| `test/phase2c1.test.js` | バックアップ生成・厳格検証・ファイル制限・保存方法、全置換トランザクション、復元UI、PWA互換性 |
| `test/phase2c2.test.js` | 検索正規化・並び、履歴編集検証、予定同期、削除後再調整、DB原子性、C1バックアップ互換性 |
| `test/phase2c3.test.js` | 並べ替え対象・純粋関数・長押しController・DB競合確認、設定トップ／詳細ナビゲーション、版・APP_SHELL・保存形式 |
| `test/pwa.test.js` | Manifest、相対参照、アイコン、APP_SHELL実在性、Service Worker責務、版一致、手動更新、接続表示、`.nojekyll` |
| `test/static.test.js` | HTML ID重複、ローカル資産参照、主要画面とダイアログの存在 |

テストは外部テストライブラリを使わず、`npm test`で全ファイルを実行する。DOMやブラウザAPIが必要な箇所はテスト用の最小スタブと静的検査を組み合わせている。iPadの実タッチ、通知、音、Wake Lock、ファイル共有、ホーム画面版、Service Workerの実動作は実機／ブラウザ確認も必要である。

## 12. アセットと開発ツール

- `icons/`: `icons/apple-touch-icon.png`（180px）、`icons/icon-192.png`、`icons/icon-512.png`をまとめて管理する。Manifest、HTML、Service Worker、通知アイコンから参照される。
- `tools/generate-icons.ps1`: Windowsの`System.Drawing`だけを使い、上記3画像を同じ意匠で再生成する開発用スクリプト。実行時アプリからは読み込まれない。

画像以外のフォント、音声、ライブラリを外部から取得しない。終了音は`js/alerts.js`がWeb Audio APIで生成する。

## 13. このインデックスを更新する基準

次の場合は、関連するコード変更と同じコミットでこの文書を更新する。

- ファイルまたはディレクトリを追加、削除、改名、移動した
- ファイルの責務や機能の担当先を変更した
- import、HTML参照、主要な呼び出し順、初期化順、Service Workerの読み込み順を変更した
- 公開export、Controller／Managerの公開メソッド、Repository相当のDB関数を変更した
- IndexedDBのDB名・版・ストア・Index・主要保存形式、設定キー、バックアップ形式や対象範囲を変更した
- アプリバージョン、Manifest、APP_SHELL、キャッシュ更新方式を変更した
- テストファイルの追加・削除、または担当する検証範囲を大きく変更した

誤字修正や局所的な内部実装など、この目次へ影響しない小さな変更では不要な書き換えを行わない。更新時は必ず実ファイル、import／export、HTML参照、IndexedDB定義、`APP_SHELL`、テストを再確認し、推測ではなく現在のコードと一致させる。
