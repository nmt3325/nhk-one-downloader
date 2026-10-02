# 匿名トークン発行と純 Node 版 Widevine CDM

調査当時は「ブラウザの F12 で Bearer をコピー」「pywidevine を spawn」が前提だったが、
この 2 つはどちらも不要になった。その根拠と実測値を残す。

## 1. 匿名 (accountless) トークンはサーバーから直接取れる

ログインなしで `z_at`（Bearer として使える JWT）が発行され、**そのトークンで
ライセンスサーバーからコンテンツ鍵まで取得できる**（end-to-end で確認済み）。

### 手順

**(1) `consentToUse` クッキーを自分でセットする**

以下の JSON を URL エンコードして `consentToUse` に入れる。これがないと同意画面へ戻される。

```json
{
  "status": "optedin",
  "entity": "none",
  "area": { "areaId": "130", "jisx0402": "13101", "postal": "1000001", "pref": "13" }
}
```

**(2) `build_authorize` をリダイレクト追跡で叩く**

```
GET https://www.web.nhk/tix/build_authorize
  ?idp=r-alaz
  &profileType=anonymous
  &redirect_uri=https%3A%2F%2Fwww.web.nhk%2F
  &entity=none
  &area=130&pref=13&jisx0402=13101&postal=1000001
```

**(3) クッキージャーにトークンが入る**

| クッキー | 中身 |
| --- | --- |
| `z_at` | アクセストークン（JWT、実測 697 文字） |
| `authz_type` | `r-alaz` |
| `exp_z_at` / `exp_z_rt` | 各期限 |
| `bff-rt-authz` | リフレッシュ系 |
| `area_permanent` | エリア設定 |

`z_at` のクレーム（実測）:

```
iss         https://r.authz.ac1.nhk
profileType anonymous
scope       get:news get:tv
client_id   13116894440
exp         iat + 28800  (8 時間)
```

### idp の種類

| 値 | 用途 |
| --- | --- |
| `r-alaz` | accountless（匿名。これを使う） |
| `a-alaz` | 海外向け |
| `d-alaz` | 緊急時 |
| `acaz` | アカウントあり |

実装は `lib/auth.js` の `issueAnonymousToken()`。トークンは `~/.nhk-one/token.json`（mode 600）に
キャッシュし、期限切れなら自動で再発行する。

## 2. エンドポイントとヘッダの注意

```
API       https://api.web.nhk/r8
  エピソード  /t/tvepisode/te/<ID>.json
  シリーズ    /l/tvepisode/pl/series-tep-XXXX.json   → { result, nextUrl, count }
ライセンス  https://licence.hsk.st.nhk/widevine/license
CDN       https://archive2.hsk.st.nhk/...
Widevine SystemID  edef8ba979d64acea3c827dcd51d21ed
```

- **Authorization ヘッダは `api.web.nhk` と `licence.hsk.st.nhk` にのみ付ける。**
  CDN（`archive2.hsk.st.nhk`）に付けると HTTP 400。
- VOD の配信期限は約 1 週間。`video[].expires` を見る。
- `video[].detailedVideoDescriptor` がないエピソードは再生不可。

### エピソード JSON の要点

```
identifierGroup.{tvSeriesName, tvEpisodeName, tvSeriesId}
partOfSeries.identifierGroup.tvSeriesPlaylistId
releasedEvent.{startDate, publishedOn.broadcastDisplayName}
video[].{detailedVideoDescriptor, expires, duration(PT44M44S), startDate,
         detailedContentStatus.contentStatus}
```

### descriptor JSON

```json
{
  "allow_multispeed": true,
  "need_L1_hd": false,
  "manifests": [{ "drm_type": "cenc", "bitrate_limit_type": "m6000", "url": "...m3u8" }],
  "thumnails": "...",
  "thumbnail_urls": []
}
```

`bitrate_limit_type` は `m6000` 〜 `m0192`。最高を選んで master m3u8 に入る。

## 3. マスタープレイリストのくせ

- **RESOLUTION 属性がない。** 解像度は init セグメントの VisualSampleEntry から読む。
  CENC なのでサンプルエントリは `avc1` でなく **`encv`**、元の形式は `frma` に入る。
  ボックス先頭から +32 が width、+34 が height。
- BANDWIDTH 6192000 / 3192000 / 1692000 / 832000 / 448000 / 256000、
  パスは `v6000 / v3000 / v1500 / v0768 / v0384 / v0192`。
  実測解像度は 1920x1080 / 1280x720 / 960x540 / 640x360 / 448x252 / 320x180。
- 音声グループは `l5`（am192 / as192）と `l2`（am064 / as064）、各 NAME=main / sub。
- 字幕は `subtl/playlist.m3u8` の 1 本（ja）。
- **同じ映像 URI が音声グループの数だけ重複して並ぶ**ので dedupe が必要
  （9 variants → dedupe で 6）。

## 4. 純 Node 版 Widevine CDM（`lib/widevine.js`）

pywidevine を使わず、Node 標準の `crypto` だけで L3 の鍵取得まで行う。

| 部品 | 実装 |
| --- | --- |
| protobuf | スクラッチの writer / reader（必要なフィールドのみ） |
| WVD パース | v2 / type ANDROID / securityLevel 3。clientId と RSA 2048 秘密鍵を取り出す |
| PSSH | init セグメントを走査して `pssh` ボックスを全部拾い、SystemID で絞る |
| challenge 署名 | RSA-PSS / SHA-1 / saltLength 20 |
| セッション鍵 | RSA-OAEP（hash sha1）で復号 |
| 鍵導出 | AES-CMAC。`ENCRYPTION\0` + msg + `00000080` / `AUTHENTICATION\0` + msg + `00000200` |
| コンテンツ鍵 | AES-128-CBC（autopadding あり、失敗時は no-padding へフォールバック） |
| request_id | Android 式に「4B カウンタ + 8B 乱数」の hex 文字列 |

AES-CMAC は RFC 4493 のテストベクタ 3 本で一致を確認してある。

## 5. E2E 実測ログ

エピソード `35SWR3WU5L`（SONGS、2026-10-01 放送、expires 2026-10-08）:

```
master variants  9 → dedupe 6
audio            4   subtitles 1
映像             447 セグメント / 2684 秒
init             989 B
PSSH             2 箱 (65 B)
tenc default_KID 33eaee1b135b49ea88f71125250848cd
challenge        2381 B
license          HTTP 200 (1117 B)
鍵               SIGNING 1 + CONTENT 3
映像鍵 (KID一致)  2ba1a554219ece6070a29434d0aa3854
```

ツール経由の通し検証（`-q 360`、447 セグメント、並列 8）:
ダウンロードから mux 完了まで 39 秒、228.6 MB、字幕 609 キュー。
出力は `h264 640x360 / aac 48kHz stereo (jpn) / mov_text (jpn)`、尺 44:44.21（API の PT44M44S と一致）、
ffmpeg のデコードチェックでエラーなし。

## 6. 壊れそうなところ

- `build_authorize` のパラメータ名や `consentToUse` の形式が変わると匿名発行が止まる
  → `nhk-token paste` でブラウザの `z_at` を渡せば走る。
- scope が `get:tv` から変わる、またはライセンス側で profileType を見るようになると
  匿名トークンでは 403 になりうる。
- `need_L1_hd: true` のコンテンツは L3 デバイスでは高画質が出ない可能性がある
  （今回の検証サンプルは `false`）。
