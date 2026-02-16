# メール標準機能 実装計画（2・3・4・5・6）

## 対象機能

| No | 機能 | 概要 |
|----|------|------|
| 2 | 添付ファイル | メールにファイルを添付 |
| 3 | メールテンプレート | 定型文の選択・差込項目 |
| 4 | 署名 | ユーザー署名の自動挿入 |
| 5 | 返信・スレッド | スレッド追跡の強化 |
| 6 | その他 | クイックテキスト、宛先検証 |

---

## Phase 1: 添付ファイル（No.2）

### 1.1 Apex

| タスク | 対象ファイル | 内容 |
|--------|-------------|------|
| 1.1.1 | CustomChatterController.cls | `sendEmail` に `contentDocumentIds` パラメータを追加 |
| 1.1.2 | CustomChatterController.cls | `setEntityAttachments()` で ContentVersionId を添付する処理を追加 |
| 1.1.3 | CustomChatterController.cls | メール添付用 `uploadEmailAttachment` メソッド追加（recordId なしでアップロードし、一時的に保持） |

### 1.2 LWC

| タスク | 対象ファイル | 内容 |
|--------|-------------|------|
| 1.2.1 | chatterLwc.html | メール本文エディタ上に添付ボタン（クリップ）を配置 |
| 1.2.2 | chatterLwc.html | 添付ファイル一覧表示エリア（本文と送信ボタンの間）を追加 |
| 1.2.3 | chatterLwc.js | `emailAttachments` 状態、`handleEmailAttachClick`、`handleEmailFileSelected` 追加 |
| 1.2.4 | chatterLwc.js | `sendEmail` 呼び出し時に `contentDocumentIds` を渡す |
| 1.2.5 | chatterLwc.css | 添付リストのスタイル |

### 1.3 依存関係
- 投稿の添付と同様、hidden input + Apex upload パターンで実装
- メール添付はレコード紐づけなしでアップロードし、送信時に添付 → 一時フォルダ or レコードにアップロードして送信時に ContentVersionId を渡す

---

## Phase 2: メールテンプレート（No.3）

### 2.1 Apex

| タスク | 対象ファイル | 内容 |
|--------|-------------|------|
| 2.1.1 | CustomChatterController.cls | `getEmailTemplates(recordId)` メソッド追加 |
| 2.1.2 | CustomChatterController.cls | EmailTemplate から件名・本文を取得（関連オブジェクトに応じて使用可能なテンプレートのみ） |
| 2.1.3 | CustomChatterController.cls | `getEmailTemplateBody(templateId, recordId)` で差込後の本文・件名を返却（Renderer 使用 or 手動置換） |

### 2.2 LWC

| タスク | 対象ファイル | 内容 |
|--------|-------------|------|
| 2.2.1 | chatterLwc.html | 件名の上に「テンプレート」combobox を追加 |
| 2.2.2 | chatterLwc.js | `templateOptions`、`selectedTemplateId`、wire for `getEmailTemplates` |
| 2.2.3 | chatterLwc.js | テンプレート選択時に `getEmailTemplateBody` を呼び、件名・本文をセット |
| 2.2.4 | chatterLwc.js | 署名挿入との競合を考慮（署名は本文末尾に後から挿入） |

### 2.3 差込項目
- `EmailTemplate` の `HtmlValue` / `Body` に `{!Case.Subject}` などのマージフィールドが含まれる
- `Messaging.renderStoredEmailTemplate(templateId, recordId, null)` で差込後の文字列を取得可能

---

## Phase 3: 署名（No.4）

### 3.1 Apex

| タスク | 対象ファイル | 内容 |
|--------|-------------|------|
| 3.1.1 | CustomChatterController.cls | `getUserEmailSignature()` メソッド追加 |
| 3.1.2 | CustomChatterController.cls | User のメール署名設定を取得（Lightning では User オブジェクトに署名フィールドがあるか要確認） |
| 3.1.3 | 調査 | Lightning の署名: `UserPreferencesEmailSignature` やカスタムメタデータ/設定の利用可否を確認 |

### 3.2 LWC

| タスク | 対象ファイル | 内容 |
|--------|-------------|------|
| 3.2.1 | chatterLwc.js | wire for `getUserEmailSignature` |
| 3.2.2 | chatterLwc.js | メール本文の初期表示時・本文クリア時に署名を自動付与 |
| 3.2.3 | chatterLwc.js | テンプレート選択時は、テンプレート本文の末尾に署名を追加 |

### 3.3 注意
- Salesforce の標準署名は Gmail/Outlook 連携時や一部 UI でのみ自動挿入
- Apex から取得する場合は、`User` のカスタム項目や OrgDefault の設定を検討

---

## Phase 4: 返信・スレッド（No.5）

### 4.1 Apex

| タスク | 対象ファイル | 内容 |
|--------|-------------|------|
| 4.1.1 | CustomChatterController.cls | `getOriginalEmailMessage` の戻り値に `messageId`, `inReplyTo`, `references` を追加 |
| 4.1.2 | CustomChatterController.cls | EmailMessage から Message-ID, In-Reply-To, References を取得 |
| 4.1.3 | CustomChatterController.cls | `sendEmail` で `setInReplyTo()`, `setReferences()` を設定（SingleEmailMessage で対応可否を確認） |

### 4.2 LWC

| タスク | 対象ファイル | 内容 |
|--------|-------------|------|
| 4.2.1 | chatterLwc.js | originalMessage に messageId, inReplyTo, references を保持 |
| 4.2.2 | chatterLwc.js | 送信時にこれらのヘッダを Apex に渡す（既存の getOriginalEmailMessage 拡張で対応） |

### 4.3 注意事項
- `setInReplyTo()`, `setReferences()` は RFC 2822 形式の Message-ID（`<xxx@domain>`）が必要
- Salesforce の EmailMessage ID はそのまま使えない → EmailMessage のヘッダ情報を取得する必要あり
- EmailMessage オブジェクトに `Headers` や Message-ID を格納する項目があるか要確認

---

## Phase 5: その他標準機能（No.6）

### 5.1 クイックテキスト

| タスク | 対象ファイル | 内容 |
|--------|-------------|------|
| 5.1.1 | CustomChatterController.cls | `getQuickTextList()` で QuickText 標準オブジェクトを SOQL 取得 |
| 5.1.2 | chatterLwc.html | 本文エディタ上に「定型句」ボタン or ドロップダウンを追加 |
| 5.1.3 | chatterLwc.js | 定型句選択時に本文のカーソル位置へ挿入（lightning-input-rich-text の setRangeText 使用） |

※ QuickText オブジェクトは標準、最大 4,096 文字、差込項目対応

### 5.2 宛先検証

| タスク | 対象ファイル | 内容 |
|--------|-------------|------|
| 5.2.1 | chatterLwc.js | 送信前にメールアドレス形式の簡易バリデーション（正規表現） |
| 5.2.2 | chatterLwc.js | 重複アドレスの除去（To/Cc/Bcc 間） |
| 5.2.3 | chatterLwc.js | バリデーションエラー時は送信ボタン無効 or トーストで警告 |

---

## 実装順序（推奨）

```
Phase 1: 添付ファイル（ユーザー影響大、基盤となる）
    ↓
Phase 4: 返信・スレッド（Apex 拡張が少ない、早期対応しやすい）
    ↓
Phase 5: その他（クイックテキスト、宛先検証。比較的軽量）
    ↓
Phase 3: 署名（User 設定の取得方法を調査してから）
    ↓
Phase 2: メールテンプレート（差込処理が複雑、最後に）
```

---

## 見積もり（目安）

| Phase | 工数目安 | 備考 |
|-------|----------|------|
| Phase 1 | 2-3h | 投稿添付と類似、Apex 拡張が主 |
| Phase 2 | 3-4h | renderStoredEmailTemplate の利用、テンプレート種別対応 |
| Phase 3 | 1-2h | 署名取得 API の要調査 |
| Phase 4 | 1-2h | SingleEmailMessage のヘッダ対応可否を確認 |
| Phase 5 | 1-2h | クイックテキストの SOQL、宛先バリデーション |

---

## 作成・更新ファイル一覧

| 種別 | ファイル |
|------|----------|
| Apex | CustomChatterController.cls |
| LWC | chatterLwc.html, chatterLwc.js, chatterLwc.css |
| 新規 | （なし：既存を拡張） |
