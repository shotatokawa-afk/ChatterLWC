/* chatterLwc 内のエディタのみ対象。標準画像ボタン（URL入力）を非表示 */
.chatter-lwc-root lightning-input-rich-text .ql-image {
  display: none !important;
}

/* リンクボタンのツールチップが左端で切れる対策：ビューポート中央に固定（親の overflow の影響を受けない） */
.chatter-lwc-root lightning-input-rich-text .ql-tooltip {
  position: fixed !important;
  left: 50vw !important;
  top: 50vh !important;
  transform: translate(-50%, -50%) !important;
  z-index: 10000 !important;
}
