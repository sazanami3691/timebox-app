export const SETTINGS_PAGES = Object.freeze([
  "update",
  "alerts",
  "schedule-notifications",
  "wake-lock",
  "backup",
  "storage-info"
]);

export function normalizeSettingsPage(value) {
  return SETTINGS_PAGES.includes(value) ? value : "top";
}

export function createSettingsNavigation({ root, onChange = () => {} } = {}) {
  if (!root) throw new Error("設定画面が見つかりません。");
  const top = root.querySelector("[data-settings-top]");
  const detailPages = [...root.querySelectorAll("[data-settings-page]")];
  const rows = [...root.querySelectorAll("button[data-settings-target]")];
  const backButtons = [...root.querySelectorAll("button[data-settings-back]")];
  if (!top || detailPages.length !== SETTINGS_PAGES.length) throw new Error("設定ページの構成が不正です。");
  let currentPage = "top";
  let returnTarget = null;

  function scrollToTop(element) {
    element.scrollTop = 0;
    element.scrollIntoView?.({ block: "start", behavior: "auto" });
  }

  function render({ focus = true } = {}) {
    top.hidden = currentPage !== "top";
    for (const page of detailPages) page.hidden = page.dataset.settingsPage !== currentPage;
    root.dataset.settingsCurrent = currentPage;
    const visible = currentPage === "top"
      ? top
      : detailPages.find((page) => page.dataset.settingsPage === currentPage);
    if (visible) scrollToTop(visible);
    if (focus) {
      (globalThis.requestAnimationFrame ?? ((callback) => globalThis.setTimeout(callback, 0)))(() => {
        if (currentPage === "top" && returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
        else visible?.querySelector("[data-settings-back]")?.focus({ preventScroll: true });
      });
    }
    onChange(currentPage);
  }

  function openDetail(pageName, source = null, options = {}) {
    const normalized = normalizeSettingsPage(pageName);
    if (normalized === "top") return openTop(options);
    returnTarget = source ?? rows.find((row) => row.dataset.settingsTarget === normalized) ?? null;
    currentPage = normalized;
    render(options);
    return currentPage;
  }

  function openTop(options = {}) {
    currentPage = "top";
    render(options);
    return currentPage;
  }

  for (const row of rows) row.addEventListener("click", () => openDetail(row.dataset.settingsTarget, row));
  for (const button of backButtons) button.addEventListener("click", () => openTop());
  render({ focus: false });

  return Object.freeze({
    getPage: () => currentPage,
    handleEscape() {
      if (currentPage === "top") return false;
      openTop();
      return true;
    },
    openDetail,
    openTop,
    reset() {
      returnTarget = null;
      return openTop({ focus: false });
    }
  });
}
