// Scoped to the Decky Torrent drawer and routes inside Steam's Game Mode.
export const styles = `
.dt-home, .dt-page {
  --dt-text: #f4f7fb;
  --dt-muted: #b9c9d8;
  --dt-accent: #86d5f4;
  --dt-surface: #22303e;
  --dt-border: #445767;
  --dt-error: #ffb6ab;
  color: var(--dt-text);
}
.dt-home *, .dt-page * { box-sizing: border-box; }
.dt-home { min-width: 0; padding-inline: clamp(8px, 1.6vw, 18px); }
.dt-plugin-title {
  display: flex; flex: 1 1 auto; align-items: center; gap: 6px;
  min-width: 0; width: 100%; margin: 0; padding: 0; box-shadow: none;
}
.dt-plugin-name {
  flex: 1 1 auto; min-width: 0; font-size: clamp(.85rem, 2.1vw, 1.25rem); line-height: 1.1;
}
.dt-plugin-title button.dt-nav-button {
  display: grid; place-items: center; flex: 0 0 38px; box-sizing: border-box;
  width: 38px !important; min-width: 0 !important; height: 32px !important;
  min-height: 0 !important; margin: 0; padding: 0 !important;
}
.dt-nav-button svg { display: block; width: 18px; height: 18px; }
.dt-home h2 { font-size: 1rem; margin: 4px 0 8px; }
.dt-home p { margin: 8px 0; }
.dt-ready { padding: 12px 0; border-top: 1px solid var(--dt-border); overflow-wrap: anywhere; }
.dt-ready-meta { color: var(--dt-muted); font-size: .78rem; margin: 4px 0 10px; }
.dt-path { margin-top: 3px; overflow-wrap: anywhere; }
.dt-muted, .dt-status, .dt-empty { color: var(--dt-muted); }
.dt-error { color: var(--dt-error); overflow-wrap: anywhere; }
.dt-page {
  height: calc(100% - 40px);
  margin-top: 40px;
  min-width: 0;
  overflow: auto;
  scrollbar-color: var(--dt-border) #0f1821;
  background: radial-gradient(ellipse at 20% 0%, #263b4c, transparent 58%), #101922;
}
.dt-page-inner { max-width: 1280px; margin: 0 auto; padding: 20px clamp(16px, 4vw, 56px) 68px; }
.dt-page h1 { margin: 12px 0 0; font-size: clamp(1.85rem, 4vw, 3rem); letter-spacing: -.04em; line-height: 1.05; }
.dt-header { display: flex; justify-content: space-between; align-items: end; flex-wrap: wrap; gap: 12px; }
.dt-header .dt-back { width: auto; min-width: 0; padding-inline: 12px; }
.dt-button-content { display: inline-flex; align-items: center; gap: 7px; }
.dt-store-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.dt-store-tools .dt-search-toggle { width: auto; min-width: 0; }
.dt-filter { width: min(100%, 260px); }
.dt-search { max-width: 520px; margin-top: 12px; }
.dt-store-form {
  max-width: 680px; margin-top: 12px; padding: 12px 16px;
  background: var(--dt-surface); border-radius: 9px;
}
.dt-store-form .dt-store-tools { margin-top: 8px; }
.dt-page .dt-status { min-height: 1em; margin: 8px 0 12px; font-size: .82rem; }
.dt-empty { border: 1px solid var(--dt-border); border-radius: 9px; padding: 20px; margin: 0; }
.dt-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 155px), 1fr)); gap: 14px; }
/* Keep the cover flat even when a Steam theme styles focused DialogButtons. */
.dt-page .dt-grid button.dt-card {
  display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start;
  min-width: 0; width: 100%; min-height: 0; padding: 0 !important; margin: 0;
  text-align: left; cursor: pointer; border: 0 !important; border-radius: 0 !important;
  background: transparent !important; box-shadow: none !important; color: var(--dt-text) !important;
}
.dt-grid .dt-card::before, .dt-grid .dt-card::after { display: none; }
.dt-grid .dt-card:disabled { cursor: default; }
.dt-page .dt-grid button.dt-card:focus-visible,
.dt-page .dt-grid button.dt-card.gpfocus { outline: 0 !important; }
.dt-grid .dt-card:hover .dt-cover,
.dt-grid .dt-card:focus-visible .dt-cover,
.dt-grid .dt-card.gpfocus .dt-cover { filter: brightness(1.15); }
.dt-grid .dt-card:focus-visible strong, .dt-grid .dt-card.gpfocus strong {
  color: var(--dt-accent); text-decoration: underline; text-underline-offset: 3px;
}
.dt-cover {
  display: grid; place-items: center; width: 100%; aspect-ratio: 4 / 5; overflow: hidden;
  background: linear-gradient(145deg, #3c566a, #192632); color: var(--dt-muted); font-size: 1.6rem;
}
.dt-cover img { width: 100%; height: 100%; display: block; object-fit: cover; }
.dt-card-copy { display: grid; gap: 5px; width: 100%; padding-top: 8px; }
.dt-card-copy strong { overflow-wrap: anywhere; font-size: 1rem; line-height: 1.2; }
.dt-card-size { color: var(--dt-muted); font-size: .78rem; font-variant-numeric: tabular-nums; }
.dt-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.dt-page .dt-more { width: auto; margin-top: 16px; }
.dt-transfers { display: grid; gap: 10px; }
.dt-transfer {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 14px 16px;
  border: 1px solid var(--dt-border); border-radius: 9px; background: var(--dt-surface);
}
.dt-transfer-body { flex: 1 1 240px; min-width: 0; overflow-wrap: anywhere; }
.dt-transfer-heading, .dt-transfer-meta { display: flex; justify-content: space-between; gap: 6px 12px; flex-wrap: wrap; }
.dt-state, .dt-transfer-meta { color: var(--dt-muted); font-size: .82rem; }
.dt-transfer-meta { font-variant-numeric: tabular-nums; }
.dt-transfer progress { display: block; width: 100%; height: 8px; margin: 10px 0 6px; accent-color: var(--dt-accent); }
.dt-transfer-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.dt-delete-path { margin-top: 8px; overflow-wrap: anywhere; }
.dt-transfer .dt-delete:not(.gpfocus):not(:focus-visible) { color: var(--dt-error); }
.dt-transfer .dt-transfer-action { flex: 0 0 auto; width: auto; min-width: 110px; }
`;
