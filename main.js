"use strict";

const {
  Plugin,
  Notice,
  MarkdownView,
  Modal,
  Menu,
  ItemView,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  debounce
} = require("obsidian");

const STRUCTURE_PANEL_VIEW = "structure-commander-panel";

// Русский алфавит без 'ё' и 'й' (визуально похожих на и). 30 букв.
const ALPHA_LIST = ["а","б","в","г","д","е","ж","з","и","к","л","м","н","о","п","р","с","т","у","ф","х","ц","ч","ш","щ","ъ","ы","ь","э","ю","я"];

const DEFAULT_SETTINGS = {
  panelMaxLevel: 6,
  exportMode: "same-folder",
  exportFolder: "_Exports",
  exportAskEachTime: false,
  exportOpenAfter: false,
  exportPromoteToH1: false,
  renumberScope: "document",
  renumberTargets: "headings",
  renumberStyle: "numeric",
  lastPanelSide: "right",
  showEditorToolbar: true,
  toolbarSize: "compact",
  lastShowToLevel: 1
};

// Хоткеи по умолчанию.
// Alt+←/→ для свернуть/развернуть выбраны намеренно: Ctrl+Shift+←/→
// конфликтуют со штатным выделением слова в любом текстовом поле.
const HOTKEYS = {
  "move-current-branch-up":   [{ modifiers: ["Alt", "Shift"], key: "ArrowUp" }],
  "move-current-branch-down": [{ modifiers: ["Alt", "Shift"], key: "ArrowDown" }],
  "promote-current-branch":   [{ modifiers: ["Alt", "Shift"], key: "ArrowLeft" }],
  "demote-current-branch":    [{ modifiers: ["Alt", "Shift"], key: "ArrowRight" }],
  "collapse-current-branch":  [{ modifiers: ["Alt"], key: "ArrowLeft" }],
  "expand-current-branch":    [{ modifiers: ["Alt"], key: "ArrowRight" }]
};

const HOTKEY_LABELS_RU = {
  "move-current-branch-up":   "Ветка выше",
  "move-current-branch-down": "Ветка ниже",
  "promote-current-branch":   "Повысить ветку",
  "demote-current-branch":    "Понизить ветку",
  "collapse-current-branch":  "Свернуть ветку",
  "expand-current-branch":    "Развернуть ветку"
};

module.exports = class StructureCommanderPlugin extends Plugin {

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.cmLanguage = this.loadCodeMirrorLanguage();
    this.lastMarkdownFilePath = "";
    this.toolbars = new WeakMap();   // MarkdownView -> EditorToolbar
    this._panelReadToken = 0;        // защита от устаревших async-read

    this.addSettingTab(new StructureCommanderSettingTab(this.app, this));

    this.registerView(
      STRUCTURE_PANEL_VIEW,
      (leaf) => new StructurePanelView(leaf, this)
    );

    this.addRibbonIcon("list-tree", "Structure Commander", () => {
      this.openStructurePanel("right");
    });

    // — события —
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      if (file instanceof TFile && file.extension && file.extension.toLowerCase() === "md") {
        this.lastMarkdownFilePath = file.path;
      }
      this.refreshStructurePanels();
      this.syncAllToolbars();
    }));

    this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
      this.syncAllToolbars();
      this.refreshStructurePanels();
    }));

    this.registerEvent(this.app.workspace.on("layout-change", () => {
      this.syncAllToolbars();
    }));

    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile && file.extension && file.extension.toLowerCase() === "md") {
        const cur = this.getCurrentMarkdownFile();
        if (cur && cur.path === file.path) {
          this.refreshStructurePanels();
          this.refreshActiveToolbar();
        }
      }
    }));

    this.registerEvent(this.app.workspace.on("editor-change", (editor, info) => {
      this.refreshActiveToolbar();
    }));

    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, view) => {
      this.buildEditorContextMenu(menu, editor, view);
    }));

    // — команды —
    this.registerCommands();

    // — toolbar над редактором —
    this.app.workspace.onLayoutReady(() => this.syncAllToolbars());
  }

  onunload() {
    // снять все toolbar-инъекции
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    leaves.forEach((leaf) => {
      const v = leaf.view;
      if (v instanceof MarkdownView) {
        const tb = this.toolbars.get(v);
        if (tb) { tb.destroy(); this.toolbars.delete(v); }
      }
    });
  }

  registerCommands() {
    this.addCommand({
      id: "open-structure-commander",
      name: "Открыть панель структуры",
      callback: () => this.openStructurePanel("right")
    });

    this.addCommand({
      id: "open-hotkeys-settings",
      name: "Открыть настройки горячих клавиш",
      callback: () => this.openHotkeysSettings()
    });

    this.addCommand({
      id: "open-structure-panel-right",
      name: "Открыть боковую панель структуры справа",
      callback: () => this.openStructurePanel("right")
    });
    this.addCommand({
      id: "open-structure-panel-left",
      name: "Открыть боковую панель структуры слева",
      callback: () => this.openStructurePanel("left")
    });
    this.addCommand({
      id: "open-structure-panel-bottom",
      name: "Открыть боковую панель структуры снизу",
      callback: () => this.openStructurePanel("bottom")
    });
    this.addCommand({
      id: "toggle-structure-panel",
      name: "Скрыть/показать боковую панель структуры",
      callback: () => this.toggleStructurePanel()
    });
    this.addCommand({
      id: "toggle-editor-toolbar",
      name: "Скрыть/показать панель инструментов над редактором",
      callback: () => this.toggleEditorToolbar()
    });

    this.addCommand({
      id: "fold-all-headings",
      name: "Свернуть все заголовки",
      callback: () => this.foldAll()
    });
    this.addCommand({
      id: "unfold-all-headings",
      name: "Развернуть все заголовки (Показать всё)",
      callback: () => this.unfoldAll()
    });

    for (let level = 1; level <= 6; level++) {
      this.addCommand({
        id: "show-document-to-h" + level,
        name: "Показать документ до H" + level,
        callback: () => this.showDocumentToLevel(level)
      });
      this.addCommand({
        id: "set-current-heading-h" + level,
        name: "Поставить текущему заголовку уровень H" + level,
        callback: () => this.setCurrentHeadingLevel(level)
      });
      this.addCommand({
        id: "set-current-branch-root-h" + level,
        name: "Поставить заголовку ветки H" + level + " (с сохранением иерархии)",
        callback: () => this.setCurrentBranchRootLevel(level)
      });
    }

    this.addCommand({
      id: "collapse-current-branch",
      name: "Свернуть текущую ветку",
      hotkeys: HOTKEYS["collapse-current-branch"],
      callback: () => this.collapseCurrentBranch()
    });
    this.addCommand({
      id: "expand-current-branch",
      name: "Развернуть текущую ветку",
      hotkeys: HOTKEYS["expand-current-branch"],
      callback: () => this.expandCurrentBranch()
    });
    this.addCommand({
      id: "toggle-current-branch-fold",
      name: "Переключить сворачивание текущей ветки",
      callback: () => this.toggleCurrentBranchFold()
    });

    for (let depth = 1; depth <= 6; depth++) {
      this.addCommand({
        id: "show-current-branch-depth-" + depth,
        name: "Показать текущую ветку до глубины " + depth,
        callback: () => this.showCurrentBranchDepth(depth)
      });
    }

    this.addCommand({
      id: "promote-current-heading",
      name: "Повысить только текущий заголовок",
      callback: () => this.shiftCurrentHeading(-1)
    });
    this.addCommand({
      id: "demote-current-heading",
      name: "Понизить только текущий заголовок",
      callback: () => this.shiftCurrentHeading(1)
    });

    this.addCommand({
      id: "promote-current-branch",
      name: "Повысить (заголовок/текст/список)",
      hotkeys: HOTKEYS["promote-current-branch"],
      callback: () => this.shiftLineAtCursor(-1)
    });
    this.addCommand({
      id: "demote-current-branch",
      name: "Понизить (заголовок/текст/список)",
      hotkeys: HOTKEYS["demote-current-branch"],
      callback: () => this.shiftLineAtCursor(1)
    });

    this.addCommand({
      id: "copy-current-branch",
      name: "Скопировать текущую ветку",
      callback: () => this.copyCurrentBranch()
    });
    this.addCommand({
      id: "export-current-branch",
      name: "Экспортировать ветку в .md",
      callback: () => this.openExportBranchModal()
    });

    this.addCommand({
      id: "move-current-branch-up",
      name: "Ветка выше",
      hotkeys: HOTKEYS["move-current-branch-up"],
      callback: () => this.moveCurrentBranch(-1)
    });
    this.addCommand({
      id: "move-current-branch-down",
      name: "Ветка ниже",
      hotkeys: HOTKEYS["move-current-branch-down"],
      callback: () => this.moveCurrentBranch(1)
    });

    this.addCommand({
      id: "normalize-heading-levels",
      name: "Исправить пропуски уровней",
      callback: () => this.normalizeHeadingLevels()
    });
    this.addCommand({
      id: "renumber-structure",
      name: "Перенумеровать структуру…",
      callback: () => this.openRenumberModal("renumber")
    });
    this.addCommand({
      id: "remove-structure-numbering",
      name: "Удалить нумерацию…",
      callback: () => this.openRenumberModal("remove")
    });
    this.addCommand({
      id: "emoji-number-structure",
      name: "Заменить нумерацию на emoji-цифры…",
      callback: () => this.openRenumberModal("emoji")
    });
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  loadCodeMirrorLanguage() {
    try {
      if (typeof require !== "undefined") {
        return require("@codemirror/language");
      }
    } catch (e) {
      return null;
    }
    return null;
  }

  // ─────────────────────── контекст: вью / редактор / файл ───────────────────────

  getMarkdownView(silent) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || !view.editor) {
      if (!silent) new Notice("Откройте Markdown-заметку");
      return null;
    }
    if (view.file instanceof TFile) this.lastMarkdownFilePath = view.file.path;
    return view;
  }

  getEditor(silent) {
    const view = this.getMarkdownView(silent);
    return view ? view.editor : null;
  }

  getCurrentMarkdownFile() {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file instanceof TFile) {
      this.lastMarkdownFilePath = view.file.path;
      return view.file;
    }
    if (this.lastMarkdownFilePath) {
      const file = this.app.vault.getAbstractFileByPath(this.lastMarkdownFilePath);
      if (file instanceof TFile) return file;
    }
    return null;
  }

  // ─────────────────────── хоткеи: чтение и подписи ───────────────────────

  getHotkeyLabel(commandId) {
    const fullId = this.manifest.id + ":" + commandId;
    try {
      if (this.app.hotkeyManager && typeof this.app.hotkeyManager.getHotkeys === "function") {
        const hk = this.app.hotkeyManager.getHotkeys(fullId);
        if (hk && hk.length) return formatHotkey(hk[0]);
      }
    } catch (e) { /* fallthrough */ }

    try {
      if (this.app.hotkeyManager && typeof this.app.hotkeyManager.getDefaultHotkeys === "function") {
        const hk = this.app.hotkeyManager.getDefaultHotkeys(fullId);
        if (hk && hk.length) return formatHotkey(hk[0]);
      }
    } catch (e) { /* fallthrough */ }

    const fb = HOTKEYS[commandId];
    if (fb && fb.length) return formatHotkey(fb[0]);
    return "";
  }

  labelWithHotkey(label, commandId) {
    const hk = this.getHotkeyLabel(commandId);
    return hk ? label + "\u00A0\u00A0\u00A0" + hk : label;
  }

  // ─────────────────────── контекстное меню редактора ───────────────────────

  buildEditorContextMenu(menu, editor, view) {
    if (!editor || !(view instanceof MarkdownView)) return;

    const headings = this.getHeadings(editor);
    if (headings.length === 0) return;

    const currentHeading = this.getCurrentHeadingSilently(editor);
    const docMaxLevel = headings.reduce((m, h) => Math.max(m, h.level), 1);

    menu.addSeparator();

    // ── 1. «Развернуть/свернуть» — подменю ──
    menu.addItem((item) => {
      item.setTitle("Развернуть/свернуть").setIcon("chevrons-up-down");
      const sub = (typeof item.setSubmenu === "function") ? item.setSubmenu() : null;
      if (!sub) {
        item.onClick(() => this.toggleCurrentBranchFold());
        return;
      }
      sub.addItem((it) => it
        .setTitle(this.labelWithHotkey("Развернуть", "expand-current-branch"))
        .setIcon("chevrons-down")
        .onClick(() => this.expandCurrentBranch()));
      sub.addItem((it) => it
        .setTitle(this.labelWithHotkey("Свернуть", "collapse-current-branch"))
        .setIcon("chevrons-up")
        .onClick(() => this.collapseCurrentBranch()));
      sub.addSeparator();
      sub.addItem((it) => it
        .setTitle("Показать/скрыть панель структуры")
        .setIcon("panel-right")
        .onClick(() => this.toggleStructurePanel()));
      sub.addItem((it) => it
        .setTitle("Показать/скрыть панель инструментов")
        .setIcon("layout-panel-top")
        .onClick(() => this.toggleEditorToolbar()));
    });

    // ── 2. «Показать до» — подменю с реально существующими уровнями ──
    menu.addItem((item) => {
      item.setTitle("Показать до").setIcon("eye");
      const sub = (typeof item.setSubmenu === "function") ? item.setSubmenu() : null;
      if (!sub) {
        item.onClick(() => this.showDocumentToLevel(docMaxLevel));
        return;
      }
      const presentLevels = uniqueSortedLevels(headings);
      presentLevels.forEach((lv) => {
        const cmdId = "show-document-to-h" + lv;
        const hk = this.getHotkeyLabel(cmdId);
        const title = "H" + lv + (hk ? "   " + hk : "");
        sub.addItem((x) => x.setTitle(title).onClick(() => this.showDocumentToLevel(lv)));
      });
      sub.addSeparator();
      sub.addItem((x) => x
        .setTitle("Показать всё")
        .setIcon("expand")
        .onClick(() => this.unfoldAll()));
    });

    // ── 3. «Уровень | Перенос» — все стрелки + повысить-до/понизить-до ──
    menu.addItem((item) => {
      item.setTitle("Уровень | Перенос").setIcon("move-vertical");
      const sub = (typeof item.setSubmenu === "function") ? item.setSubmenu() : null;
      if (!sub) {
        item.onClick(() => this.shiftCurrentBranch(1));
        return;
      }

      sub.addItem((it) => it
        .setTitle(this.labelWithHotkey("Повысить", "promote-current-branch"))
        .setIcon("arrow-left")
        .onClick(() => this.shiftLineAtCursor(-1)));

      sub.addItem((it) => it
        .setTitle(this.labelWithHotkey("Понизить", "demote-current-branch"))
        .setIcon("arrow-right")
        .onClick(() => this.shiftLineAtCursor(1)));

      sub.addItem((it) => it
        .setTitle(this.labelWithHotkey("Вверх", "move-current-branch-up"))
        .setIcon("arrow-up")
        .onClick(() => this.moveCurrentBranch(-1)));

      sub.addItem((it) => it
        .setTitle(this.labelWithHotkey("Вниз", "move-current-branch-down"))
        .setIcon("arrow-down")
        .onClick(() => this.moveCurrentBranch(1)));

      // Точечные «Повысить до Hx» / «Понизить до Hx»
      if (currentHeading) {
        const branchHeadings = headings.filter((h) =>
          h.line >= currentHeading.line &&
          h.line <= this.getBranchEndLine(editor, currentHeading));
        const branchMaxLevel = branchHeadings.reduce((m, h) => Math.max(m, h.level), currentHeading.level);

        sub.addSeparator();

        sub.addItem((it) => {
          it.setTitle("Понизить до").setIcon("arrow-right");
          const ds = (typeof it.setSubmenu === "function") ? it.setSubmenu() : null;
          if (!ds) { it.onClick(() => this.shiftCurrentBranch(1)); return; }
          let any = false;
          for (let target = currentHeading.level + 1; target <= 6; target++) {
            const delta = target - currentHeading.level;
            if (branchMaxLevel + delta > 6) break;
            any = true;
            const t = target;
            const cmdId = "set-current-branch-root-h" + t;
            const hk = this.getHotkeyLabel(cmdId);
            const title = "H" + t + (hk ? "   " + hk : "");
            ds.addItem((x) => x.setTitle(title).onClick(() => this.setCurrentBranchRootLevel(t)));
          }
          if (!any) {
            ds.addItem((x) => x.setTitle("Невозможно: глубина уже H6").setDisabled(true));
          }
        });

        sub.addItem((it) => {
          it.setTitle("Повысить до").setIcon("arrow-left");
          const ps = (typeof it.setSubmenu === "function") ? it.setSubmenu() : null;
          if (!ps) { it.onClick(() => this.shiftCurrentBranch(-1)); return; }
          let any = false;
          for (let target = currentHeading.level - 1; target >= 1; target--) {
            any = true;
            const t = target;
            const cmdId = "set-current-branch-root-h" + t;
            const hk = this.getHotkeyLabel(cmdId);
            const title = "H" + t + (hk ? "   " + hk : "");
            ps.addItem((x) => x.setTitle(title).onClick(() => this.setCurrentBranchRootLevel(t)));
          }
          if (!any) {
            ps.addItem((x) => x.setTitle("Невозможно: уже H1").setDisabled(true));
          }
        });
      }
    });

    // ── 4. Нумерация ──
    menu.addItem((item) => {
      item.setTitle("Нумерация").setIcon("list-ordered");
      const sub = (typeof item.setSubmenu === "function") ? item.setSubmenu() : null;
      if (!sub) {
        item.onClick(() => this.openRenumberModal("renumber"));
        return;
      }
      sub.addItem((x) => x.setTitle("Перенумеровать…").onClick(() => this.openRenumberModal("renumber")));
      sub.addItem((x) => x.setTitle("Удалить нумерацию…").onClick(() => this.openRenumberModal("remove")));
      sub.addItem((x) => x.setTitle("Emoji-цифры…").onClick(() => this.openRenumberModal("emoji")));
      sub.addSeparator();
      sub.addItem((x) => x.setTitle("Исправить пропуски уровней").onClick(() => this.normalizeHeadingLevels()));
    });

    // ── 5. Экспорт ветки ──
    menu.addItem((item) => item
      .setTitle("Экспорт ветки…")
      .setIcon("download")
      .onClick(() => this.openExportBranchModal()));
  }

  // ─────────────────────── парсинг заголовков ───────────────────────

  /**
   * Заголовки текущего редактора. ATX (# ... ######), игнорирует код-блоки.
   * Возвращает [{line, level, text, title}, ...].
   */
  getHeadings(editor) {
    const lines = [];
    const total = editor.lineCount();
    for (let i = 0; i < total; i++) lines.push(editor.getLine(i));
    return parseHeadingsFromLines(lines);
  }

  getCurrentHeadingSilently(editor) {
    const cursor = editor.getCursor();
    const headings = this.getHeadings(editor);
    let cur = null;
    for (let i = 0; i < headings.length; i++) {
      if (headings[i].line <= cursor.line) cur = headings[i];
      else break;
    }
    return cur;
  }

  getCurrentHeading(editor) {
    const c = this.getCurrentHeadingSilently(editor);
    if (!c) {
      new Notice("Курсор не находится внутри ветки заголовков");
      return null;
    }
    return c;
  }

  getBranchEndLine(editor, heading) {
    const headings = this.getHeadings(editor);
    let endLine = editor.lineCount() - 1;
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      if (h.line <= heading.line) continue;
      if (h.level <= heading.level) { endLine = h.line - 1; break; }
    }
    return endLine;
  }

  getBranch(editor, heading) {
    return {
      startLine: heading.line,
      endLine: this.getBranchEndLine(editor, heading),
      level: heading.level,
      heading
    };
  }

  // ─────────────────────── свернуть / развернуть ───────────────────────

  async foldAll() {
    const editor = this.getEditor(); if (!editor) return;
    if (!this.foldAllDirect(editor)) this.executeCommand("editor:fold-all");
  }

  async unfoldAll() {
    const editor = this.getEditor(); if (!editor) return;
    const ok = this.unfoldRangeDirect(editor, 0, editor.lineCount() - 1);
    if (!ok) this.executeCommand("editor:unfold-all");
  }

  async showDocumentToLevel(level) {
    const editor = this.getEditor(); if (!editor) return;
    const headings = this.getHeadings(editor);
    if (!headings.length) { new Notice("В документе нет заголовков"); return; }
    const toFold = headings.filter((h) => h.level >= level).reverse();

    this.settings.lastShowToLevel = level;
    this.saveSettings();
    this.refreshActiveToolbar();

    if (this.cmLanguage && editor.cm) {
      this.unfoldRangeDirect(editor, 0, editor.lineCount() - 1);
      this.foldHeadingsDirect(editor, toFold);
      new Notice("Показано до H" + level);
      return;
    }
    await this.fallbackFoldHeadings(editor, toFold, true);
    new Notice("Показано до H" + level);
  }

  async collapseCurrentBranch() {
    const editor = this.getEditor(); if (!editor) return;
    const heading = this.getCurrentHeading(editor); if (!heading) return;

    if (this.cmLanguage && editor.cm) {
      this.foldHeadingsDirect(editor, [heading]);
    } else {
      await this.toggleHeadingFoldFallback(editor, heading.line);
    }
  }

  async expandCurrentBranch() {
    const editor = this.getEditor(); if (!editor) return;
    const heading = this.getCurrentHeading(editor); if (!heading) return;

    const branch = this.getBranch(editor, heading);
    const ok = this.unfoldRangeDirect(editor, branch.startLine, branch.endLine);
    if (ok) return;

    // Точечный fallback: тогглим конкретный заголовок. Никаких unfold-all.
    await this.toggleHeadingFoldFallback(editor, heading.line);
  }

  async toggleCurrentBranchFold() {
    const editor = this.getEditor(); if (!editor) return;
    const heading = this.getCurrentHeading(editor); if (!heading) return;
    await this.toggleHeadingFoldFallback(editor, heading.line);
  }

  async showCurrentBranchDepth(depth) {
    const editor = this.getEditor(); if (!editor) return;
    const root = this.getCurrentHeading(editor); if (!root) return;

    const branch = this.getBranch(editor, root);
    const targetLevel = Math.min(6, root.level + depth - 1);
    const toFold = this.getHeadings(editor)
      .filter((h) => h.line >= branch.startLine && h.line <= branch.endLine && h.level > targetLevel)
      .reverse();

    if (this.cmLanguage && editor.cm) {
      this.unfoldRangeDirect(editor, branch.startLine, branch.endLine);
      this.foldHeadingsDirect(editor, toFold);
      new Notice("Ветка показана до глубины " + depth);
      return;
    }
    await this.fallbackFoldHeadings(editor, toFold, true);
    new Notice("Ветка показана до глубины " + depth);
  }

  foldAllDirect(editor) {
    const headings = this.getHeadings(editor).slice().reverse();
    return this.foldHeadingsDirect(editor, headings);
  }

  foldHeadingsDirect(editor, headings) {
    if (!this.cmLanguage || !editor.cm || !this.cmLanguage.foldEffect) return false;
    const view = editor.cm;
    const effects = [];
    const seen = Object.create(null);

    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      if (seen[h.line]) continue;
      seen[h.line] = true;

      const endLine = this.getBranchEndLine(editor, h);
      if (endLine <= h.line) continue;

      const from = this.safePosToOffset(editor, { line: h.line, ch: editor.getLine(h.line).length });
      const to   = this.safePosToOffset(editor, { line: endLine, ch: editor.getLine(endLine).length });
      if (from !== null && to !== null && to > from) {
        effects.push(this.cmLanguage.foldEffect.of({ from, to }));
      }
    }
    if (!effects.length) return true;
    try { view.dispatch({ effects }); return true; }
    catch (e) { console.error(e); return false; }
  }

  unfoldRangeDirect(editor, startLine, endLine) {
    if (!this.cmLanguage || !editor.cm || !this.cmLanguage.unfoldEffect || !this.cmLanguage.foldedRanges) return false;
    const view = editor.cm;
    const from = this.safePosToOffset(editor, { line: Math.max(0, startLine), ch: 0 });
    const safeEnd = Math.min(editor.lineCount() - 1, endLine);
    const to = this.safePosToOffset(editor, { line: safeEnd, ch: editor.getLine(safeEnd).length });
    if (from === null || to === null) return false;

    const effects = [];
    try {
      this.cmLanguage.foldedRanges(view.state).between(from, to, (a, b) => {
        effects.push(this.cmLanguage.unfoldEffect.of({ from: a, to: b }));
      });
      if (effects.length) view.dispatch({ effects });
      return true;
    } catch (e) { console.error(e); return false; }
  }

  safePosToOffset(editor, pos) {
    try { if (typeof editor.posToOffset === "function") return editor.posToOffset(pos); }
    catch (e) { return null; }
    return null;
  }

  async fallbackFoldHeadings(editor, headings, unfoldFirst) {
    const cursor = editor.getCursor();
    if (unfoldFirst) {
      this.executeCommand("editor:unfold-all");
      await sleep(30);
    }
    for (let i = 0; i < headings.length; i++) {
      await this.toggleHeadingFoldFallback(editor, headings[i].line);
      await sleep(10);
    }
    editor.setCursor(cursor);
  }

  async toggleHeadingFoldFallback(editor, line) {
    const cursor = editor.getCursor();
    editor.setCursor({ line, ch: 0 });
    this.executeCommand("editor:toggle-fold");
    await sleep(10);
    editor.setCursor(cursor);
  }

  executeCommand(id) {
    try { this.app.commands.executeCommandById(id); return true; }
    catch (e) { console.error(e); new Notice("Не удалось выполнить команду: " + id); return false; }
  }

  // ─────────────────────── уровни заголовков ───────────────────────

  setCurrentHeadingLevel(level) {
    const editor = this.getEditor(); if (!editor) return;
    const h = this.getCurrentHeading(editor); if (!h) return;
    if (level === h.level) return;
    this.replaceHeadingLevel(editor, h.line, level);
    this.refreshStructurePanels(); this.refreshActiveToolbar();
    new Notice("Заголовок: H" + level);
  }

  setCurrentBranchRootLevel(level) {
    const editor = this.getEditor(); if (!editor) return;
    const root = this.getCurrentHeading(editor); if (!root) return;
    const delta = level - root.level;
    if (delta === 0) { new Notice("Уровень не изменился"); return; }

    // Проверка границ всей ветки
    const branch = this.getBranch(editor, root);
    let minL = root.level, maxL = root.level;
    for (let l = branch.startLine; l <= branch.endLine; l++) {
      const t = editor.getLine(l);
      const m = t.match(/^(#{1,6})(\s+.+)$/);
      if (!m) continue;
      const lv = m[1].length;
      if (lv < minL) minL = lv;
      if (lv > maxL) maxL = lv;
    }
    if (minL + delta < 1) { new Notice("Операция невозможна: ветка содержит H" + minL); return; }
    if (maxL + delta > 6) { new Notice("Операция невозможна: ветка ушла бы за H6"); return; }

    this.shiftBranch(editor, root, delta);
    this.refreshStructurePanels(); this.refreshActiveToolbar();
    new Notice("Заголовок ветки: H" + level);
  }

  shiftCurrentHeading(delta) {
    const editor = this.getEditor(); if (!editor) return;
    const h = this.getCurrentHeading(editor); if (!h) return;
    const next = clamp(h.level + delta, 1, 6);
    if (next === h.level) { new Notice("Дальше менять уровень нельзя"); return; }
    this.replaceHeadingLevel(editor, h.line, next);
    this.refreshStructurePanels(); this.refreshActiveToolbar();
    new Notice("Заголовок: H" + next);
  }

  shiftCurrentBranch(delta) {
    const editor = this.getEditor(); if (!editor) return;
    const root = this.getCurrentHeading(editor); if (!root) return;

    // защита границ
    const branch = this.getBranch(editor, root);
    let minL = root.level, maxL = root.level;
    for (let l = branch.startLine; l <= branch.endLine; l++) {
      const t = editor.getLine(l);
      const m = t.match(/^(#{1,6})(\s+.+)$/);
      if (!m) continue;
      const lv = m[1].length;
      if (lv < minL) minL = lv;
      if (lv > maxL) maxL = lv;
    }
    if (minL + delta < 1) { new Notice("Операция невозможна: ветка содержит H" + minL); return; }
    if (maxL + delta > 6) { new Notice("Операция невозможна: ветка ушла бы за H6"); return; }

    this.shiftBranch(editor, root, delta);
    this.refreshStructurePanels(); this.refreshActiveToolbar();
    new Notice(delta < 0 ? "Ветка повышена" : "Ветка понижена");
  }

  shiftBranch(editor, root, delta) {
    const branch = this.getBranch(editor, root);
    const replacements = [];
    for (let line = branch.startLine; line <= branch.endLine; line++) {
      const text = editor.getLine(line);
      const m = text.match(/^(#{1,6})(\s+.+)$/);
      if (!m) continue;
      const cur = m[1].length;
      const nxt = clamp(cur + delta, 1, 6);
      if (nxt === cur) continue;
      replacements.push({ line, text: "#".repeat(nxt) + m[2] });
    }
    this.applyLineReplacements(editor, replacements);
  }

  replaceHeadingLevel(editor, line, level) {
    const text = editor.getLine(line);
    const m = text.match(/^(#{1,6})(\s+.+)$/);
    if (!m) { new Notice("Текущая строка — не заголовок"); return; }
    this.applyLineReplacements(editor, [{ line, text: "#".repeat(level) + m[2] }]);
  }

  /**
   * Универсальный shift по Alt+Shift+←/→.
   *
   * Цепочка типов «снизу вверх по абстракции»:
   *   stage 0  → обычный текст
   *   stage 1  → "- " маркированный
   *   stage 2  → "1. " нумерованный точкой
   *   stage 3  → "1) " нумерованный скобкой
   *   stage 4  → "а) " буквенный со скобкой (а, б, в, …)
   *
   * delta = +1 (понизить, →): двигаемся 0→1→2→3→4. На 4 — некуда дальше.
   * delta = -1 (повысить, ←): 4→3→2→1→0→H6. Из H6 поднимаем как заголовок.
   *
   * Заголовок Hn — отдельная ветка: повышение/понижение через shiftCurrentBranch,
   * H6 в одиночку при понижении → текст (stage 0).
   *
   * Поддерживается выделение нескольких строк: операция применяется ко всем строкам
   * выделения как одной транзакцией; нумерация при этом делается сквозной для
   * соседствующих строк-нумерованных-списков.
   */
  shiftLineAtCursor(delta) {
    const editor = this.getEditor(); if (!editor) return;

    // Определяем диапазон строк
    let startLine, endLine;
    const hasSel = editor.somethingSelected && editor.somethingSelected();
    if (hasSel) {
      const selFrom = editor.getCursor("from");
      const selTo   = editor.getCursor("to");
      startLine = selFrom.line;
      endLine   = selTo.line;
      if (selTo.ch === 0 && endLine > startLine) endLine -= 1;
    } else {
      const c = editor.getCursor();
      startLine = endLine = c.line;
    }

    // Если выделена ровно одна строка — старая ветка-логика для заголовков.
    if (startLine === endLine) {
      this._shiftSingleLine(editor, startLine, delta);
      return;
    }

    // Многострочное выделение: применяем построчно. Заголовки в выделении трактуем
    // как «строка-заголовок», то есть при понижении — Hn → Hn+1 (без всей ветки),
    // при повышении — Hn → Hn-1; H6→текст и текст→H6 — как обычно.
    const replacements = [];
    let prevWasNumberedDot = false; // 1.
    let prevWasNumberedParen = false; // 1)
    let prevWasAlpha = false; // а)
    let dotCounter = 0, parenCounter = 0, alphaCounter = 0;

    // Начальные значения счётчиков — продолжение от предыдущей строки выше выделения,
    // если она того же типа и при операции мы переводим в этот тип.
    // Чтобы не усложнять — при groupe-операции просто считаем заново с 1
    // в пределах выделения для каждого нового стейка.

    for (let line = startLine; line <= endLine; line++) {
      const raw = editor.getLine(line);
      const transformed = this._transformLineForGroup(raw, delta);
      if (transformed.text === null) continue; // пропуск (пустая строка и т.п.)

      // Постпроцесс: пересчёт нумерации для нумерованных стейков
      if (transformed.stage === 2) {
        // 1.
        if (!prevWasNumberedDot) dotCounter = 1; else dotCounter++;
        prevWasNumberedDot = true; prevWasNumberedParen = false; prevWasAlpha = false;
        const t = transformed.text.replace(/^(\s*)1\./, "$1" + dotCounter + ".");
        replacements.push({ line, text: t });
      } else if (transformed.stage === 3) {
        if (!prevWasNumberedParen) parenCounter = 1; else parenCounter++;
        prevWasNumberedDot = false; prevWasNumberedParen = true; prevWasAlpha = false;
        const t = transformed.text.replace(/^(\s*)1\)/, "$1" + parenCounter + ")");
        replacements.push({ line, text: t });
      } else if (transformed.stage === 4) {
        if (!prevWasAlpha) alphaCounter = 1; else alphaCounter++;
        prevWasNumberedDot = false; prevWasNumberedParen = false; prevWasAlpha = true;
        const letter = ALPHA_LIST[(alphaCounter - 1) % ALPHA_LIST.length];
        const t = transformed.text.replace(/^(\s*)а\)/, "$1" + letter + ")");
        replacements.push({ line, text: t });
      } else {
        prevWasNumberedDot = false; prevWasNumberedParen = false; prevWasAlpha = false;
        replacements.push({ line, text: transformed.text });
      }
    }

    if (!replacements.length) {
      new Notice("Нечего преобразовывать");
      return;
    }
    this.applyLineReplacements(editor, replacements);
    this.refreshStructurePanels(); this.refreshActiveToolbar();
    new Notice("Преобразовано строк: " + replacements.length);
  }

  /**
   * Возвращает stage 0..4 + tail (текст без префикса) + indent.
   * stage: 0=text, 1="- ", 2="1.", 3="1)", 4="а)", -1=heading, -2=empty.
   */
  _detectLineStage(raw) {
    if (raw == null) return { stage: -2, indent: "", tail: "", level: 0 };
    if (!raw.trim()) return { stage: -2, indent: "", tail: "", level: 0 };

    const headingMatch = raw.match(/^(#{1,6})(\s+)(.+)$/);
    if (headingMatch) return { stage: -1, indent: "", tail: headingMatch[3], level: headingMatch[1].length };

    // - foo / * foo / + foo
    const m1 = raw.match(/^(\s*)([-*+])\s+(.*)$/);
    if (m1) return { stage: 1, indent: m1[1], tail: m1[3], level: 0 };

    // 1. foo
    const m2 = raw.match(/^(\s*)\d+\.\s+(.*)$/);
    if (m2) return { stage: 2, indent: m2[1], tail: m2[2], level: 0 };

    // 1) foo
    const m3 = raw.match(/^(\s*)\d+\)\s+(.*)$/);
    if (m3) return { stage: 3, indent: m3[1], tail: m3[2], level: 0 };

    // а) foo / а. foo  (поддерживаем и латиницу как fallback)
    const m4 = raw.match(/^(\s*)([а-яa-z])[\.\)]\s+(.*)$/);
    if (m4) return { stage: 4, indent: m4[1], tail: m4[3], level: 0 };

    // обычный текст
    return { stage: 0, indent: raw.match(/^\s*/)[0], tail: raw.replace(/^\s+/, ""), level: 0 };
  }

  /**
   * Преобразование одной строки в новую стадию (без пересчёта нумерации).
   * Возвращает { text, stage }. text=null — пропускаем.
   */
  _transformLineForGroup(raw, delta) {
    const info = this._detectLineStage(raw);

    // Пустая
    if (info.stage === -2) return { text: null, stage: -2 };

    // Заголовок
    if (info.stage === -1) {
      const lv = info.level;
      if (delta > 0) {
        if (lv < 6) return { text: "#".repeat(lv + 1) + " " + info.tail, stage: -1 };
        // H6 → текст
        return { text: info.tail, stage: 0 };
      } else {
        if (lv > 1) return { text: "#".repeat(lv - 1) + " " + info.tail, stage: -1 };
        return { text: raw, stage: -1 }; // некуда
      }
    }

    // Не-заголовок: stage 0..4
    let next = info.stage + (delta > 0 ? 1 : -1);
    // Границы
    if (delta > 0 && info.stage === 4) return { text: raw, stage: 4 }; // некуда
    if (delta < 0 && info.stage === 0) {
      // 0 → H6
      return { text: "###### " + info.tail, stage: -1 };
    }
    if (next < 0) next = 0;
    if (next > 4) next = 4;

    return { text: this._stageToPrefix(next, info.indent) + info.tail, stage: next };
  }

  _stageToPrefix(stage, indent) {
    switch (stage) {
      case 0: return indent;
      case 1: return indent + "- ";
      case 2: return indent + "1. ";   // счётчик пересчитается в shiftLineAtCursor
      case 3: return indent + "1) ";
      case 4: return indent + "а) ";
      default: return indent;
    }
  }

  /** Однострочный shift — оригинальная логика (заголовки = вся ветка). */
  _shiftSingleLine(editor, line, delta) {
    const raw = editor.getLine(line);
    if (raw == null) return;

    const info = this._detectLineStage(raw);

    if (info.stage === -1) {
      // Заголовок — повышаем/понижаем всю ветку
      const lv = info.level;
      if (delta > 0 && lv === 6) {
        const heading = this.getCurrentHeadingSilently(editor);
        if (heading) {
          this.applyLineReplacements(editor, [{ line, text: info.tail }]);
          this.refreshStructurePanels(); this.refreshActiveToolbar();
          new Notice("H6 → обычный текст");
          return;
        }
      }
      this.shiftCurrentBranch(delta);
      return;
    }

    if (info.stage === -2) {
      new Notice("Пустая строка — нечего преобразовывать");
      return;
    }

    // Списки/текст: 0..4 цепочка
    if (delta > 0 && info.stage === 4) {
      new Notice("Дальше понижать некуда (а)");
      return;
    }
    if (delta < 0 && info.stage === 0) {
      // Текст → H6
      this.applyLineReplacements(editor, [{ line, text: "###### " + info.tail }]);
      this.refreshStructurePanels(); this.refreshActiveToolbar();
      new Notice("Текст → H6");
      return;
    }

    const nextStage = info.stage + (delta > 0 ? 1 : -1);
    let prefix;
    if (nextStage === 0) prefix = info.indent;
    else if (nextStage === 1) prefix = info.indent + "- ";
    else if (nextStage === 2) {
      const n = this._continueCounterAbove(editor, line, /^(\s*)(\d+)\.\s/, info.indent);
      prefix = info.indent + n + ". ";
    } else if (nextStage === 3) {
      const n = this._continueCounterAbove(editor, line, /^(\s*)(\d+)\)\s/, info.indent);
      prefix = info.indent + n + ") ";
    } else if (nextStage === 4) {
      const n = this._continueCounterAboveAlpha(editor, line, info.indent);
      const letter = ALPHA_LIST[(n - 1) % ALPHA_LIST.length];
      prefix = info.indent + letter + ") ";
    }

    this.applyLineReplacements(editor, [{ line, text: prefix + info.tail }]);
    this.refreshStructurePanels(); this.refreshActiveToolbar();
    new Notice(["Текст", "- список", "1. список", "1) список", "а) список"][nextStage]);
  }

  /** Найти выше последовательную нумерацию (того же отступа) и вернуть следующее число. */
  _continueCounterAbove(editor, line, regex, indent) {
    let n = 0;
    for (let i = line - 1; i >= 0; i--) {
      const t = editor.getLine(i);
      const m = t.match(regex);
      if (!m) break;
      if (m[1] !== indent) break;
      n = parseInt(m[2], 10);
      break; // достаточно соседней верхней
    }
    return n + 1;
  }

  _continueCounterAboveAlpha(editor, line, indent) {
    for (let i = line - 1; i >= 0; i--) {
      const t = editor.getLine(i);
      const m = t.match(/^(\s*)([а-я])\)\s/);
      if (!m) break;
      if (m[1] !== indent) break;
      const idx = ALPHA_LIST.indexOf(m[2]);
      if (idx < 0) break;
      return (idx + 2);
    }
    return 1;
  }

  /**
   * Все строковые замены — одной транзакцией → один Ctrl+Z.
   */
  applyLineReplacements(editor, replacements) {
    if (!replacements || !replacements.length) return;
    replacements = replacements.slice().sort((a, b) => a.line - b.line);

    const changes = replacements.map((r) => {
      const old = editor.getLine(r.line);
      return {
        from: { line: r.line, ch: 0 },
        to:   { line: r.line, ch: old.length },
        text: r.text
      };
    });

    if (typeof editor.transaction === "function") {
      editor.transaction({ changes });
    } else {
      // Старые сборки Obsidian — по очереди (несколько undo, но иначе никак).
      for (let i = changes.length - 1; i >= 0; i--) {
        editor.replaceRange(changes[i].text, changes[i].from, changes[i].to);
      }
    }
  }

  // ─────────────────────── копирование / экспорт ───────────────────────

  async copyCurrentBranch() {
    const editor = this.getEditor(); if (!editor) return;
    const root = this.getCurrentHeading(editor); if (!root) return;
    const branch = this.getBranch(editor, root);

    const lines = [];
    for (let l = branch.startLine; l <= branch.endLine; l++) lines.push(editor.getLine(l));
    const text = lines.join("\n");
    try { await navigator.clipboard.writeText(text); new Notice("Ветка скопирована"); }
    catch (e) { console.error(e); new Notice("Не удалось скопировать ветку"); }
  }

  openExportBranchModal() {
    const editor = this.getEditor(); if (!editor) return;
    const file = this.getCurrentMarkdownFile();
    if (!file) { new Notice("Нет активной Markdown-заметки"); return; }
    const root = this.getCurrentHeading(editor); if (!root) return;
    new ExportBranchModal(this.app, this, editor, file, root).open();
  }

  async exportBranch(editor, file, root, options) {
    const branch = this.getBranch(editor, root);
    const rawLines = [];
    for (let l = branch.startLine; l <= branch.endLine; l++) rawLines.push(editor.getLine(l));

    let lines = rawLines.slice();

    if (options.promoteToH1) {
      // Сдвигаем все заголовки так, чтобы верхний заголовок стал H1
      const delta = 1 - root.level;
      lines = lines.map((t) => {
        const m = t.match(/^(#{1,6})(\s+.+)$/);
        if (!m) return t;
        const newLv = clamp(m[1].length + delta, 1, 6);
        return "#".repeat(newLv) + m[2];
      });
    }

    const branchText = lines.join("\n").replace(/\s+$/g, "") + "\n";
    const baseName = sanitizeFileName(stripHeadingMarks(root.text)) || "Экспорт ветки";
    let targetFolder = "";

    if (options.mode === "same-folder") {
      targetFolder = file.parent ? file.parent.path : "";
    } else if (options.mode === "folder") {
      targetFolder = normalizePath(options.folder || this.settings.exportFolder || "_Exports");
      await this.ensureFolder(targetFolder);
    } else {
      targetFolder = file.parent ? file.parent.path : "";
    }

    const targetPath = await this.getUniqueMarkdownPath(targetFolder, baseName);
    await this.app.vault.create(targetPath, branchText);

    this.settings.exportMode = options.mode;
    this.settings.exportFolder = options.folder || this.settings.exportFolder;
    this.settings.exportOpenAfter = !!options.openAfter;
    this.settings.exportPromoteToH1 = !!options.promoteToH1;
    this.settings.exportAskEachTime = !!options.askEachTime;
    await this.saveSettings();

    if (options.openAfter) {
      const created = this.app.vault.getAbstractFileByPath(targetPath);
      if (created instanceof TFile) {
        await this.app.workspace.getLeaf(true).openFile(created);
      }
    }

    new Notice("Ветка экспортирована: " + targetPath);
  }

  async ensureFolder(folderPath) {
    const clean = normalizePath(folderPath || "");
    if (!clean) return;
    const parts = clean.split("/").filter(Boolean);
    let cur = "";
    for (const p of parts) {
      cur = cur ? cur + "/" + p : p;
      const ex = this.app.vault.getAbstractFileByPath(cur);
      if (!ex) await this.app.vault.createFolder(cur);
    }
  }

  async getUniqueMarkdownPath(folder, baseName) {
    const cf = normalizePath(folder || "");
    const cb = sanitizeFileName(baseName || "Экспорт ветки") || "Экспорт ветки";
    let path = cf ? cf + "/" + cb + ".md" : cb + ".md";
    let i = 2;
    while (this.app.vault.getAbstractFileByPath(path)) {
      path = cf ? cf + "/" + cb + " " + i + ".md" : cb + " " + i + ".md";
      i++;
    }
    return path;
  }

  // ─────────────────────── перемещение ветки ───────────────────────

  /**
   * Перемещение без поиска «своего уровня».
   *
   * Базовая логика:
   *   - обычная строка двигается между соседними строками;
   *   - выделение двигается как выбранный диапазон строк;
   *   - ветка заголовка/списка переносится целиком только если строка свёрнута;
   *   - свёрнутые блоки выше/ниже воспринимаются как один видимый блок.
   *
   * Это намеренно НЕ Word-like sibling jump. Иначе снова получаем цирк:
   * код ищет соседа того же уровня, не находит — и запрещает движение.
   */
  moveCurrentBranch(direction) {
    const editor = this.getEditor(); if (!editor) return;

    let startLine, endLine;
    let restoreSelection = null;

    if (editor.somethingSelected && editor.somethingSelected()) {
      const selFrom = editor.getCursor("from");
      const selTo   = editor.getCursor("to");
      startLine = selFrom.line;
      endLine   = selTo.line;

      // В Obsidian/CodeMirror выделение целых строк часто приходит как
      // from: начало первой строки, to: начало строки ПОСЛЕ выделения.
      // Старый код превращал 3 выделенные строки в диапазон 0..2,
      // но потом восстанавливал selection до строки 2, ch 0 — то есть уже
      // только 2 строки. Дальше оно закономерно сжималось до одной.
      const toIsExclusiveLineStart = selTo.ch === 0 && endLine > startLine;
      if (toIsExclusiveLineStart) endLine -= 1;

      restoreSelection = {
        fromCh: selFrom.ch,
        toCh: selTo.ch,
        lineCount: endLine - startLine + 1,
        toIsExclusiveLineStart
      };
    } else {
      const cursor = editor.getCursor();
      const range = this.computeVisibleMoveRangeAtLine(editor, cursor.line);
      if (!range) { new Notice("Нечего перемещать"); return; }
      startLine = range.startLine;
      endLine   = range.endLine;
    }

    const neighbor = direction < 0
      ? this.findPreviousVisibleMoveBlock(editor, startLine)
      : this.findNextVisibleMoveBlock(editor, endLine);

    if (!neighbor) {
      new Notice(direction < 0 ? "Уже наверху" : "Уже внизу");
      return;
    }

    const targetLine = direction < 0 ? neighbor.startLine : neighbor.endLine + 1;
    const newStartLine = this.moveBlock(editor, startLine, endLine, targetLine);

    if (restoreSelection && newStartLine !== null && typeof editor.setSelection === "function") {
      const totalAfter = editor.lineCount();
      let toLine, toCh;

      if (restoreSelection.toIsExclusiveLineStart) {
        // Для построчного выделения конец должен оставаться на строке ПОСЛЕ
        // выделенного блока, иначе каждое перемещение будет съедать одну строку.
        toLine = newStartLine + restoreSelection.lineCount;
        toCh = 0;
      } else {
        toLine = newStartLine + restoreSelection.lineCount - 1;
        toCh = restoreSelection.toCh;
      }

      toLine = clamp(toLine, 0, Math.max(0, totalAfter - 1));
      editor.setSelection(
        { line: newStartLine, ch: restoreSelection.fromCh },
        { line: toLine, ch: toCh }
      );
    }

    this.refreshStructurePanels(); this.refreshActiveToolbar();
    new Notice(direction < 0 ? "Перемещено выше" : "Перемещено ниже");
  }

  /** Совместимость со старым именем. */
  computeBranchRangeAtLine(editor, line) {
    return this.computeVisibleMoveRangeAtLine(editor, line);
  }

  /**
   * Диапазон перемещения от строки.
   * Если строка свёрнута — переносим весь скрытый блок.
   * Если строка не свёрнута — переносим только саму строку.
   */
  computeVisibleMoveRangeAtLine(editor, line) {
    const total = editor.lineCount();
    if (line < 0 || line >= total) return null;

    const folded = this.getFoldedLineRangeStartingAt(editor, line);
    if (folded) return { startLine: folded.startLine, endLine: folded.endLine };

    return { startLine: line, endLine: line };
  }

  /** Старое имя оставлено, чтобы не ломать возможные внутренние вызовы. */
  computeWordMoveBlockAtLine(editor, line) {
    return this.computeVisibleMoveRangeAtLine(editor, line);
  }

  /**
   * Предыдущий видимый блок:
   *   - обычная строка → одна строка;
   *   - если попали в скрытую часть свёрнутого блока → весь свёрнутый блок;
   *   - если предыдущая видимая строка сама свёрнута → весь свёрнутый блок.
   */
  findPreviousVisibleMoveBlock(editor, startLine) {
    if (startLine <= 0) return null;
    let line = startLine - 1;

    const containing = this.getFoldedLineRangeContaining(editor, line);
    if (containing) return containing;

    const starting = this.getFoldedLineRangeStartingAt(editor, line);
    if (starting) return starting;

    return { startLine: line, endLine: line };
  }

  /**
   * Следующий видимый блок:
   *   - обычная строка → одна строка;
   *   - если следующая видимая строка свёрнута → весь свёрнутый блок;
   *   - если каким-то образом попали внутрь скрытой части → весь соответствующий блок.
   */
  findNextVisibleMoveBlock(editor, endLine) {
    const total = editor.lineCount();
    if (endLine >= total - 1) return null;
    let line = endLine + 1;

    const containing = this.getFoldedLineRangeContaining(editor, line);
    if (containing) return containing;

    const starting = this.getFoldedLineRangeStartingAt(editor, line);
    if (starting) return starting;

    return { startLine: line, endLine: line };
  }

  /** Старые имена оставлены как алиасы. */
  findNextWordMoveBlock(editor, endLine) {
    return this.findNextVisibleMoveBlock(editor, endLine);
  }

  findPreviousWordMoveBlock(editor, startLine) {
    return this.findPreviousVisibleMoveBlock(editor, startLine);
  }

  getWordOutlineLevel(editor, line) {
    const h = this.headingAtLine(editor, line);
    if (h) return h.level;

    const raw = editor.getLine(line);
    if (raw == null || !raw.trim()) return null;

    const indent = indentWidth((raw.match(/^\s*/) || [""])[0]);
    return 7 + Math.floor(indent / 2);
  }

  headingAtLine(editor, line) {
    const raw = editor.getLine(line) || "";
    if (!/^#{1,6}\s+/.test(raw)) return null;
    return this.getHeadings(editor).find((h) => h.line === line) || null;
  }

  nextNonEmptyLine(editor, fromLine) {
    for (let i = fromLine; i < editor.lineCount(); i++) {
      if ((editor.getLine(i) || "").trim()) return i;
    }
    return -1;
  }

  /**
   * Все свёрнутые диапазоны CodeMirror/Obsidian как диапазоны строк.
   * Fold обычно начинается на строке-заголовке/родителе и заканчивается
   * на последней скрытой строке блока.
   */
  getFoldedLineRanges(editor) {
    if (!this.cmLanguage || !editor || !editor.cm || !this.cmLanguage.foldedRanges) return [];
    if (typeof editor.offsetToPos !== "function" || typeof editor.posToOffset !== "function") return [];

    const total = editor.lineCount();
    if (total <= 0) return [];

    let from = null, to = null;
    try {
      from = editor.posToOffset({ line: 0, ch: 0 });
      const lastLine = total - 1;
      to = editor.posToOffset({ line: lastLine, ch: editor.getLine(lastLine).length });
    } catch (e) { return []; }
    if (from === null || to === null) return [];

    const ranges = [];
    try {
      this.cmLanguage.foldedRanges(editor.cm.state).between(from, to, (a, b) => {
        try {
          const p1 = editor.offsetToPos(a);
          const p2 = editor.offsetToPos(b);
          if (!p1 || !p2) return;
          const startLine = p1.line;
          const endLine = Math.max(p1.line, p2.line);
          if (endLine > startLine) ranges.push({ startLine, endLine });
        } catch (e) { /* noop */ }
      });
    } catch (e) { return []; }

    ranges.sort((x, y) => x.startLine - y.startLine || x.endLine - y.endLine);
    return ranges;
  }

  getFoldedLineRangeStartingAt(editor, line) {
    const ranges = this.getFoldedLineRanges(editor);
    for (let i = 0; i < ranges.length; i++) {
      if (ranges[i].startLine === line) return ranges[i];
    }
    return null;
  }

  getFoldedLineRangeContaining(editor, line) {
    const ranges = this.getFoldedLineRanges(editor);
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (line > r.startLine && line <= r.endLine) return r;
    }
    return null;
  }

  /**
   * Пересчитать номер строки после перемещения блока [startLine..endLine]
   * в позицию targetLine исходного документа.
   */
  mapLineAfterMove(line, startLine, endLine, targetLine, insertAt) {
    const size = endLine - startLine + 1;

    // Линия была внутри переносимого блока.
    if (line >= startLine && line <= endLine) {
      return insertAt + (line - startLine);
    }

    // Блок ушёл вниз: промежуточные строки поднялись на размер блока.
    if (targetLine > endLine) {
      if (line > endLine && line < targetLine) return line - size;
      return line;
    }

    // Блок ушёл вверх: промежуточные строки опустились на размер блока.
    if (targetLine < startLine) {
      if (line >= targetLine && line < startLine) return line + size;
      return line;
    }

    return line;
  }

  /**
   * Восстановить fold-диапазоны после полной замены текста.
   * Без этого CodeMirror теряет свёртку, и повторное нажатие начинает
   * двигать уже одну строку вместо всей свёрнутой ветки.
   */
  restoreFoldedLineRanges(editor, ranges) {
    if (!ranges || !ranges.length) return false;
    if (!this.cmLanguage || !editor || !editor.cm || !this.cmLanguage.foldEffect) return false;
    if (typeof editor.posToOffset !== "function") return false;

    const effects = [];
    const total = editor.lineCount();

    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      const startLine = clamp(r.startLine, 0, total - 1);
      const endLine = clamp(r.endLine, 0, total - 1);
      if (endLine <= startLine) continue;

      try {
        const from = editor.posToOffset({ line: startLine, ch: editor.getLine(startLine).length });
        const to = editor.posToOffset({ line: endLine, ch: editor.getLine(endLine).length });
        if (from !== null && to !== null && to > from) {
          effects.push(this.cmLanguage.foldEffect.of({ from, to }));
        }
      } catch (e) { /* noop */ }
    }

    if (!effects.length) return false;

    try {
      editor.cm.dispatch({ effects });
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  /**
   * Повторное восстановление fold-state после того, как Obsidian/CodeMirror
   * закончат обработку курсора и scrollIntoView. Без этого курсор на строке
   * свёрнутого родителя иногда провоцирует авто-разворачивание уже после нашей
   * первой попытки восстановить fold. Да, редактор тоже умеет жить своей жизнью.
   */
  scheduleRestoreFoldedLineRanges(editor, ranges) {
    if (!ranges || !ranges.length) return;
    const copy = ranges.map((r) => ({ startLine: r.startLine, endLine: r.endLine }));
    const restore = () => {
      try { this.restoreFoldedLineRanges(editor, copy); }
      catch (e) { /* noop */ }
    };
    setTimeout(restore, 0);
    setTimeout(restore, 30);
  }

  /**
   * Атомарное перемещение [startLine..endLine] так, чтобы НОВАЯ позиция
   * первой строки блока оказалась на месте targetLine исходного документа.
   */
  moveBlock(editor, startLine, endLine, targetLine) {
    const total = editor.lineCount();
    if (startLine < 0 || endLine >= total || startLine > endLine) return null;
    if (targetLine < 0) targetLine = 0;
    if (targetLine > total) targetLine = total;
    if (targetLine >= startLine && targetLine <= endLine + 1) return startLine;

    // Снимок всех текущих fold-диапазонов до replaceRange. Полная замена текста
    // сбрасывает fold state, поэтому его надо перенести на новые номера строк.
    const foldedBefore = this.getFoldedLineRanges(editor);

    const allLines = [];
    for (let i = 0; i < total; i++) allLines.push(editor.getLine(i));

    const block = allLines.slice(startLine, endLine + 1);
    const removed = allLines.slice(0, startLine).concat(allLines.slice(endLine + 1));

    let insertAt = targetLine;
    if (targetLine > endLine) insertAt = targetLine - (endLine - startLine + 1);
    insertAt = clamp(insertAt, 0, removed.length);

    const foldedAfter = foldedBefore.map((r) => {
      return {
        startLine: this.mapLineAfterMove(r.startLine, startLine, endLine, targetLine, insertAt),
        endLine: this.mapLineAfterMove(r.endLine, startLine, endLine, targetLine, insertAt)
      };
    }).filter((r) => r.endLine > r.startLine);

    const finalLines = removed.slice(0, insertAt).concat(block).concat(removed.slice(insertAt));

    const lastLine = total - 1;
    const lastCh = editor.getLine(lastLine).length;
    editor.replaceRange(finalLines.join("\n"), { line: 0, ch: 0 }, { line: lastLine, ch: lastCh });

    const cursorLine = clamp(insertAt, 0, finalLines.length - 1);
    editor.setCursor({ line: cursorLine, ch: 0 });

    try {
      editor.scrollIntoView({ from: { line: cursorLine, ch: 0 }, to: { line: cursorLine, ch: 0 } }, true);
    } catch (e) { /* noop */ }

    // Восстанавливаем свёртку ПОСЛЕ установки курсора и прокрутки. И затем
    // повторяем это отложенно, потому что Obsidian может асинхронно раскрыть
    // fold под курсором уже после replaceRange/setCursor.
    this.restoreFoldedLineRanges(editor, foldedAfter);
    this.scheduleRestoreFoldedLineRanges(editor, foldedAfter);

    return cursorLine;
  }

  // ─────────────────────── нормализация уровней ───────────────────────

  normalizeHeadingLevels() {
    const editor = this.getEditor(); if (!editor) return;
    const headings = this.getHeadings(editor);
    if (!headings.length) { new Notice("В документе нет заголовков"); return; }

    let prev = 0;
    const replacements = [];
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      let nx = h.level;
      if (i === 0 && nx > 1) nx = 1;
      else if (prev > 0 && nx > prev + 1) nx = prev + 1;
      prev = nx;
      if (nx !== h.level) {
        const t = editor.getLine(h.line);
        const m = t.match(/^(#{1,6})(\s+.+)$/);
        if (m) replacements.push({ line: h.line, text: "#".repeat(nx) + m[2] });
      }
    }

    if (!replacements.length) { new Notice("Уровни уже нормальные"); return; }
    this.applyLineReplacements(editor, replacements);
    this.refreshStructurePanels(); this.refreshActiveToolbar();
    new Notice("Исправлено заголовков: " + replacements.length);
  }

  // ─────────────────────── перенумерация ───────────────────────

  openRenumberModal(mode) {
    const editor = this.getEditor(); if (!editor) return;
    new RenumberModal(this.app, this, editor, mode).open();
  }

  /**
   * Возвращает список замен (без применения). Используется и для применения,
   * и для предпросмотра.
   */
  collectRenumberReplacements(editor, options) {
    const scope   = options.scope   || this.settings.renumberScope   || "document";
    const targets = options.targets || this.settings.renumberTargets || "headings";
    const style   = options.style   || this.settings.renumberStyle   || "numeric";
    const action  = options.action  || "renumber";

    let startLine = 0, endLine = editor.lineCount() - 1;

    if (scope === "branch") {
      const root = this.getCurrentHeading(editor);
      if (!root) return null;
      const b = this.getBranch(editor, root);
      startLine = b.startLine; endLine = b.endLine;
    } else if (scope === "selection") {
      const sel = editor.listSelections && editor.listSelections()[0];
      if (sel) {
        const a = sel.anchor.line, h = sel.head.line;
        startLine = Math.min(a, h); endLine = Math.max(a, h);
      }
    }

    const replacements = [];
    if (targets === "headings" || targets === "both") {
      if (action === "remove") this.collectRemoveHeadingNumbering(editor, startLine, endLine, replacements);
      else                     this.collectRenumberHeadings(editor, startLine, endLine, style, replacements);
    }
    if (targets === "bullets" || targets === "both") {
      if (action === "remove") this.collectRemoveListNumbering(editor, startLine, endLine, replacements);
      else                     this.collectRenumberLists(editor, startLine, endLine, style, replacements);
    }
    return replacements;
  }

  async applyRenumber(editor, options) {
    // Сохраняем позицию курсора и скролла
    const cursor = editor.getCursor();
    let scroll = null;
    try { scroll = editor.getScrollInfo && editor.getScrollInfo(); } catch (e) {}

    const replacements = this.collectRenumberReplacements(editor, options);
    if (!replacements) return;
    if (!replacements.length) { new Notice("Нечего менять"); return; }

    this.applyLineReplacements(editor, replacements);

    this.settings.renumberScope   = options.scope   || this.settings.renumberScope;
    this.settings.renumberTargets = options.targets || this.settings.renumberTargets;
    this.settings.renumberStyle   = options.style   || this.settings.renumberStyle;
    await this.saveSettings();

    try { editor.setCursor(cursor); } catch (e) {}
    if (scroll && typeof editor.scrollTo === "function") {
      try { editor.scrollTo(scroll.left, scroll.top); } catch (e) {}
    }

    this.refreshStructurePanels(); this.refreshActiveToolbar();
    new Notice("Изменено строк: " + replacements.length);
  }

  collectRenumberHeadings(editor, startLine, endLine, style, replacements) {
    const counters = [0, 0, 0, 0, 0, 0, 0];
    let inFence = false; let fenceMarker = "";

    for (let line = startLine; line <= endLine; line++) {
      const text = editor.getLine(line);
      const fence = text.match(/^\s*(```+|~~~+)/);
      if (fence) {
        const mk = fence[1].charAt(0);
        if (!inFence) { inFence = true; fenceMarker = mk; }
        else if (mk === fenceMarker) { inFence = false; fenceMarker = ""; }
        continue;
      }
      if (inFence) continue;

      const m = text.match(/^(#{1,6})(\s+)(.+)$/);
      if (!m) continue;
      const level = m[1].length;
      counters[level] += 1;
      for (let i = level + 1; i <= 6; i++) counters[i] = 0;

      const path = [];
      for (let j = 1; j <= level; j++) if (counters[j] > 0) path.push(counters[j]);

      const cleanTitle = stripNumberPrefix(m[3]);
      const prefix = (style === "emoji") ? emojiPath(path) : path.join(".") + ".";
      replacements.push({
        line,
        text: m[1] + m[2] + prefix + " " + cleanTitle
      });
    }
  }

  collectRemoveHeadingNumbering(editor, startLine, endLine, replacements) {
    let inFence = false, fenceMarker = "";
    for (let line = startLine; line <= endLine; line++) {
      const text = editor.getLine(line);
      const fence = text.match(/^\s*(```+|~~~+)/);
      if (fence) {
        const mk = fence[1].charAt(0);
        if (!inFence) { inFence = true; fenceMarker = mk; }
        else if (mk === fenceMarker) { inFence = false; fenceMarker = ""; }
        continue;
      }
      if (inFence) continue;

      const m = text.match(/^(#{1,6})(\s+)(.+)$/);
      if (!m) continue;
      const cleanTitle = stripNumberPrefix(m[3]);
      if (cleanTitle !== m[3]) replacements.push({ line, text: m[1] + m[2] + cleanTitle });
    }
  }

  collectRenumberLists(editor, startLine, endLine, style, replacements) {
    const counters = {};
    for (let line = startLine; line <= endLine; line++) {
      const text = editor.getLine(line);
      if (!text.trim() || /^#{1,6}\s+/.test(text)) {
        for (const k in counters) delete counters[k];
        continue;
      }
      const m = text.match(/^(\s*)(?:[-*+]|\d+[.)]|(?:\d️⃣)+|[①②③④⑤⑥⑦⑧⑨⑩])\s+(.+)$/);
      if (!m) continue;
      const indent = m[1].replace(/\t/g, "    ").length;
      counters[indent] = (counters[indent] || 0) + 1;
      Object.keys(counters).forEach((k) => { if (Number(k) > indent) delete counters[k]; });

      const number = counters[indent];
      const prefix = (style === "emoji") ? emojiNumber(number) + "." : number + ".";
      replacements.push({ line, text: m[1] + prefix + " " + stripNumberPrefix(m[2]) });
    }
  }

  collectRemoveListNumbering(editor, startLine, endLine, replacements) {
    for (let line = startLine; line <= endLine; line++) {
      const text = editor.getLine(line);
      const m = text.match(/^(\s*)(?:\d+[.)]|(?:\d️⃣)+\.?|[①②③④⑤⑥⑦⑧⑨⑩])\s+(.+)$/);
      if (!m) continue;
      replacements.push({ line, text: m[1] + "- " + stripNumberPrefix(m[2]) });
    }
  }

  // ─────────────────────── боковая панель ───────────────────────

  async openStructurePanel(side) {
    let leaf = null;
    const selected = side || this.settings.lastPanelSide || "right";
    try {
      if (selected === "left" && typeof this.app.workspace.getLeftLeaf === "function") {
        leaf = this.app.workspace.getLeftLeaf(false);
      } else if (selected === "right" && typeof this.app.workspace.getRightLeaf === "function") {
        leaf = this.app.workspace.getRightLeaf(false);
      } else if (selected === "bottom") {
        leaf = this.app.workspace.getLeaf("split", "horizontal");
      }
    } catch (e) { leaf = null; }

    if (!leaf) leaf = this.app.workspace.getLeaf(true);

    await leaf.setViewState({ type: STRUCTURE_PANEL_VIEW, active: true });
    this.settings.lastPanelSide = selected;
    await this.saveSettings();
    this.app.workspace.revealLeaf(leaf);
    this.refreshStructurePanels();
  }

  closeStructurePanel() {
    const leaves = this.app.workspace.getLeavesOfType(STRUCTURE_PANEL_VIEW);
    if (!leaves.length) { new Notice("Панель структуры не открыта"); return; }
    leaves.forEach((leaf) => leaf.detach());
    new Notice("Панель структуры скрыта");
  }

  async toggleStructurePanel() {
    const leaves = this.app.workspace.getLeavesOfType(STRUCTURE_PANEL_VIEW);
    if (leaves.length) {
      this.closeStructurePanel();
    } else {
      await this.openStructurePanel(this.settings.lastPanelSide || "right");
    }
  }

  async toggleEditorToolbar() {
    this.settings.showEditorToolbar = !this.settings.showEditorToolbar;
    await this.saveSettings();
    this.syncAllToolbars();
    new Notice(this.settings.showEditorToolbar ? "Панель инструментов показана" : "Панель инструментов скрыта");
  }

  refreshStructurePanels() {
    try {
      const leaves = this.app.workspace.getLeavesOfType(STRUCTURE_PANEL_VIEW);
      leaves.forEach((leaf) => {
        if (leaf.view && typeof leaf.view.scheduleRender === "function") leaf.view.scheduleRender();
      });
    } catch (e) {}
  }

  async jumpToHeading(file, line) {
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file);
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.editor) {
      view.editor.setCursor({ line, ch: 0 });
      view.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
    }
  }

  openHotkeysSettings() {
    try {
      if (this.app.setting && typeof this.app.setting.open === "function") this.app.setting.open();
      if (this.app.setting && typeof this.app.setting.openTabById === "function") this.app.setting.openTabById("hotkeys");
      new Notice("Настройки → Hotkeys. Ищите: Structure");
    } catch (e) {
      console.error(e);
      new Notice("Откройте: Настройки → Hotkeys, и найдите команду Structure");
    }
  }

  // ─────────────────────── toolbar над редактором ───────────────────────

  syncAllToolbars() {
    if (!this.settings.showEditorToolbar) {
      // снять все
      const leaves = this.app.workspace.getLeavesOfType("markdown");
      leaves.forEach((leaf) => {
        const v = leaf.view;
        if (v instanceof MarkdownView) {
          const t = this.toolbars.get(v);
          if (t) { t.destroy(); this.toolbars.delete(v); }
        }
      });
      return;
    }
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    leaves.forEach((leaf) => {
      const v = leaf.view;
      if (!(v instanceof MarkdownView)) return;
      let tb = this.toolbars.get(v);
      if (!tb) { tb = new EditorToolbar(this, v); this.toolbars.set(v, tb); }
      tb.attach(); tb.refresh();
    });
  }

  refreshActiveToolbar() {
    const v = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!v) return;
    const tb = this.toolbars.get(v);
    if (tb) tb.refresh();
  }
};

// ═══════════════════════════════════════════════════════════════════════════════
// HotkeyCaptureModal — модальное окно для быстрого назначения хоткея
// (запись комбинации клавиш и сохранение через app.hotkeyManager).
// ═══════════════════════════════════════════════════════════════════════════════
class HotkeyCaptureModal extends Modal {
  constructor(app, plugin, commandId, commandName) {
    super(app);
    this.plugin = plugin;
    this.commandId = commandId;
    this.commandName = commandName;
    this.captured = null; // { modifiers: [...], key: "..." }
    this._keyHandler = null;
  }

  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass("structure-commander-small-modal");

    el.createEl("h2", { text: "Назначить хоткей" });
    el.createDiv({ cls: "structure-commander-muted", text: this.commandName });

    // Текущий хоткей
    const current = this.plugin.getHotkeyLabel(this.commandId);
    const currentDiv = el.createDiv({ cls: "scmd-hk-current" });
    currentDiv.setText("Текущий: " + (current || "не назначен"));

    // Зона захвата
    const cap = el.createDiv({ cls: "scmd-hk-capture" });
    cap.setText("Нажмите комбинацию клавиш…");
    cap.setAttribute("tabindex", "0");
    setTimeout(() => cap.focus(), 50);

    this._keyHandler = (evt) => {
      // Игнорируем чистые модификаторы — ждём «настоящую» клавишу
      const onlyModifier = ["Control", "Shift", "Alt", "Meta", "AltGraph"].includes(evt.key);
      if (onlyModifier) return;

      evt.preventDefault();
      evt.stopPropagation();

      const modifiers = [];
      if (evt.ctrlKey)  modifiers.push("Ctrl");
      if (evt.metaKey)  modifiers.push("Meta");
      if (evt.altKey)   modifiers.push("Alt");
      if (evt.shiftKey) modifiers.push("Shift");

      const key = HotkeyCaptureModal.normalizeKey(evt.key, evt.code);
      if (!key) return;

      this.captured = { modifiers, key };
      cap.setText("Поймано: " + this.formatHk(this.captured));
      cap.classList.add("scmd-hk-captured");
    };

    cap.addEventListener("keydown", this._keyHandler);

    // Кнопки
    const btns = el.createDiv({ cls: "structure-modal-buttons" });
    const ok = btns.createEl("button", { text: "Сохранить" });
    ok.addClass("mod-cta");
    ok.onclick = () => this.save();
    const clear = btns.createEl("button", { text: "Очистить" });
    clear.onclick = () => this.clearHotkey();
    const cancel = btns.createEl("button", { text: "Отмена" });
    cancel.onclick = () => this.close();
    const fallback = btns.createEl("button", { text: "Открыть настройки Hotkeys" });
    fallback.onclick = () => { this.close(); this.plugin.openHotkeysSettings(); };
  }

  formatHk(hk) {
    if (!hk) return "";
    const parts = (hk.modifiers || []).slice();
    parts.push(hk.key);
    return parts.join(" + ");
  }

  static normalizeKey(key, code) {
    // Numpad — особый случай. Browser возвращает key="1", code="Numpad1".
    if (code && code.startsWith("Numpad")) return code; // "Numpad1"
    if (key === " " || key === "Spacebar") return " ";
    if (key.length === 1) return key.toUpperCase();
    return key; // "ArrowUp", "Enter", "Tab", "F5" и т.д.
  }

  async save() {
    if (!this.captured) {
      new Notice("Сначала нажмите комбинацию клавиш");
      return;
    }
    const ok = this._setHotkey(this.commandId, [this.captured]);
    if (ok) {
      new Notice("Хоткей сохранён: " + this.formatHk(this.captured));
      this.plugin.refreshActiveToolbar();
      this.close();
    } else {
      new Notice("Не удалось сохранить — открываю настройки Hotkeys");
      this.plugin.openHotkeysSettings();
      this.close();
    }
  }

  async clearHotkey() {
    const ok = this._setHotkey(this.commandId, []);
    if (ok) {
      new Notice("Хоткей удалён");
      this.plugin.refreshActiveToolbar();
      this.close();
    } else {
      this.plugin.openHotkeysSettings();
      this.close();
    }
  }

  /** Использует внутреннее API Obsidian для записи хоткея. */
  _setHotkey(commandId, hotkeys) {
    try {
      const hm = this.app.hotkeyManager;
      if (!hm) return false;
      // Полный id команды: "<plugin-id>:<command-id>"
      const fullId = commandId.includes(":") ? commandId : ("structure-commander:" + commandId);
      if (typeof hm.setHotkeys === "function") {
        hm.setHotkeys(fullId, hotkeys);
      } else if (typeof hm.removeHotkeys === "function" && typeof hm.addHotkey === "function") {
        hm.removeHotkeys(fullId);
        hotkeys.forEach((hk) => hm.addHotkey(fullId, hk));
      } else {
        return false;
      }
      // Сохранение конфига
      if (typeof hm.save === "function") hm.save();
      return true;
    } catch (e) {
      console.error("HotkeyCaptureModal._setHotkey error:", e);
      return false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class EditorToolbar {
  constructor(plugin, view) {
    this.plugin = plugin;
    this.view = view;          // MarkdownView
    this.host = null;          // div toolbar
    this.attached = false;

    this.scheduleRefresh = debounce(() => this.refresh(), 120, true);

    // Обновлять toolbar при движении курсора
    this._cursorHandler = () => this.scheduleRefresh();
  }

  /** Привязать toolbar к контейнеру view, если ещё не привязан. */
  attach() {
    if (this.attached) {
      // Может потребоваться перенести toolbar, если DOM пересоздан.
      if (this.host && this.host.isConnected) return;
    }
    const container = this.findHostContainer();
    if (!container) return;

    if (!this.host) this.buildHost();

    // Не дублируем
    const existing = container.querySelector(":scope > .scmd-toolbar");
    if (existing && existing !== this.host) existing.remove();

    if (this.host.parentElement !== container) {
      container.prepend(this.host);
    }
    this.attached = true;

    // подписка на курсор
    try {
      const ed = this.view.editor;
      if (ed && ed.cm && typeof ed.cm.dom !== "undefined") {
        ed.cm.dom.addEventListener("keyup", this._cursorHandler);
        ed.cm.dom.addEventListener("mouseup", this._cursorHandler);
      }
    } catch (e) { /* noop */ }
  }

  findHostContainer() {
    // Размещаем toolbar внутри .view-content, перед .markdown-source-view / preview.
    // Это узкая горизонтальная плашка, она не перекрывает текст — она его «толкает» вниз.
    const root = this.view.containerEl;
    if (!root) return null;
    return root.querySelector(".view-content") || root;
  }

  buildHost() {
    const host = document.createElement("div");
    host.className = "scmd-toolbar";
    host.setAttribute("role", "toolbar");
    host.setAttribute("aria-label", "Structure Commander");

    const btns = [
      { id: "move-current-branch-up",   icon: "↑", label: "Ветка выше" },
      { id: "move-current-branch-down", icon: "↓", label: "Ветка ниже" },
      { id: "promote-current-branch",   icon: "←", label: "Повысить ветку" },
      { id: "demote-current-branch",    icon: "→", label: "Понизить ветку" },
      { id: "collapse-current-branch",  icon: "−", label: "Свернуть ветку" },
      { id: "expand-current-branch",    icon: "+", label: "Развернуть ветку" }
    ];

    btns.forEach((b) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "scmd-tb-btn";
      el.dataset.cmd = b.id;
      el.textContent = b.icon;
      this.applyTooltip(el, b.label, b.id);
      el.addEventListener("click", (e) => { e.preventDefault(); this.runCommand(b.id); });
      el.addEventListener("contextmenu", (e) => { e.preventDefault(); this.openButtonContextMenu(b.id, b.label, el); });
      host.appendChild(el);
    });

    // — выпадающее «Показать: Hn ▾»
    const showWrap = document.createElement("div");
    showWrap.className = "scmd-tb-dd";
    const showBtn = document.createElement("button");
    showBtn.type = "button";
    showBtn.className = "scmd-tb-btn scmd-tb-btn-text scmd-tb-show";
    showBtn.dataset.kind = "show";
    showBtn.textContent = "Показать: H" + (this.plugin.settings.lastShowToLevel || 1) + " ▾";
    showBtn.title = "Свернуть ниже выбранного уровня";
    showBtn.addEventListener("click", (e) => { e.preventDefault(); this.openShowToMenu(showBtn); });
    showWrap.appendChild(showBtn);
    host.appendChild(showWrap);

    // — назначить уровень текущему заголовку
    const lvlWrap = document.createElement("div");
    lvlWrap.className = "scmd-tb-dd";
    const lvlBtn = document.createElement("button");
    lvlBtn.type = "button";
    lvlBtn.className = "scmd-tb-btn scmd-tb-btn-text scmd-tb-level";
    lvlBtn.dataset.kind = "level";
    lvlBtn.textContent = "H? ▾";
    lvlBtn.title = "Уровень текущего заголовка";
    lvlBtn.addEventListener("click", (e) => { e.preventDefault(); this.openLevelMenu(lvlBtn); });
    lvlWrap.appendChild(lvlBtn);
    host.appendChild(lvlWrap);

    // — №
    const numBtn = document.createElement("button");
    numBtn.type = "button";
    numBtn.className = "scmd-tb-btn";
    numBtn.textContent = "№";
    numBtn.title = "Перенумеровать структуру";
    numBtn.addEventListener("click", (e) => { e.preventDefault(); this.plugin.openRenumberModal("renumber"); });
    numBtn.addEventListener("contextmenu", (e) => { e.preventDefault(); this.openNumberingMenu(numBtn); });
    host.appendChild(numBtn);

    // — спейсер «протолкнёт» × вправо
    const spacer = document.createElement("div");
    spacer.className = "scmd-tb-spacer";
    host.appendChild(spacer);

    // — × скрыть тулбар
    const hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.className = "scmd-tb-btn scmd-tb-hide";
    hideBtn.textContent = "×";
    hideBtn.title = "Скрыть панель инструментов (включается в настройках или командой)";
    hideBtn.addEventListener("click", (e) => { e.preventDefault(); this.plugin.toggleEditorToolbar(); });
    host.appendChild(hideBtn);

    this.host = host;
  }

  applyTooltip(el, label, commandId) {
    const hk = this.plugin.getHotkeyLabel(commandId);
    el.title = hk ? label + "  (" + hk + ")" : label;
    el.setAttribute("aria-label", el.title);
  }

  runCommand(commandId) {
    switch (commandId) {
      case "move-current-branch-up":   return this.plugin.moveCurrentBranch(-1);
      case "move-current-branch-down": return this.plugin.moveCurrentBranch(1);
      case "promote-current-branch":   return this.plugin.shiftCurrentBranch(-1);
      case "demote-current-branch":    return this.plugin.shiftCurrentBranch(1);
      case "collapse-current-branch":  return this.plugin.collapseCurrentBranch();
      case "expand-current-branch":    return this.plugin.expandCurrentBranch();
    }
  }

  openButtonContextMenu(commandId, label, anchor) {
    const m = new Menu();
    const currentHk = this.plugin.getHotkeyLabel(commandId);
    m.addItem((it) => it
      .setTitle("Назначить хоткей" + (currentHk ? "  (сейчас: " + currentHk + ")" : ""))
      .setIcon("keyboard")
      .onClick(() => new HotkeyCaptureModal(this.plugin.app, this.plugin, commandId, label).open()));
    m.addItem((it) => it
      .setTitle("Открыть настройки Hotkeys")
      .onClick(() => this.plugin.openHotkeysSettings()));
    const r = anchor.getBoundingClientRect();
    m.showAtPosition({ x: r.left, y: r.bottom });
  }

  openShowToMenu(anchor) {
    const editor = this.plugin.getEditor(true);
    if (!editor) { new Notice("Откройте Markdown-заметку"); return; }
    const headings = this.plugin.getHeadings(editor);
    const levels = uniqueSortedLevels(headings);

    const m = new Menu();
    if (!levels.length) {
      m.addItem((it) => it.setTitle("В документе нет заголовков").setDisabled(true));
    } else {
      levels.forEach((lv) => {
        const cmdId = "show-document-to-h" + lv;
        const hk = this.plugin.getHotkeyLabel(cmdId);
        const title = "H" + lv + (hk ? "   " + hk : "");
        m.addItem((it) => it.setTitle(title).onClick(() => this.plugin.showDocumentToLevel(lv)));
      });
      m.addSeparator();
      m.addItem((it) => it.setTitle("Показать всё").setIcon("expand").onClick(() => this.plugin.unfoldAll()));
    }
    const r = anchor.getBoundingClientRect();
    m.showAtPosition({ x: r.left, y: r.bottom });
  }

  openLevelMenu(anchor) {
    const editor = this.plugin.getEditor(true);
    if (!editor) { new Notice("Откройте Markdown-заметку"); return; }
    const cur = this.plugin.getCurrentHeadingSilently(editor);

    const m = new Menu();
    if (!cur) {
      m.addItem((it) => it.setTitle("Курсор не в ветке заголовков").setDisabled(true));
    } else {
      m.addItem((it) => it
        .setTitle("Текущий: H" + cur.level + " — " + truncate(cur.title, 40))
        .setDisabled(true));
      m.addSeparator();
      for (let lv = 1; lv <= 6; lv++) {
        const t = lv;
        const cmdId = "set-current-heading-h" + lv;
        const hk = this.plugin.getHotkeyLabel(cmdId);
        const title = (lv === cur.level ? "✓ " : "    ") + "H" + lv + " (только этот заголовок)" + (hk ? "   " + hk : "");
        m.addItem((it) => it.setTitle(title).onClick(() => this.plugin.setCurrentHeadingLevel(t)));
      }
      m.addSeparator();
      for (let lv = 1; lv <= 6; lv++) {
        if (lv === cur.level) continue;
        const t = lv;
        const cmdId = "set-current-branch-root-h" + lv;
        const hk = this.plugin.getHotkeyLabel(cmdId);
        const title = "Заголовок → H" + lv + " (вся ветка)" + (hk ? "   " + hk : "");
        m.addItem((it) => it.setTitle(title).onClick(() => this.plugin.setCurrentBranchRootLevel(t)));
      }
    }
    const r = anchor.getBoundingClientRect();
    m.showAtPosition({ x: r.left, y: r.bottom });
  }

  openNumberingMenu(anchor) {
    const m = new Menu();
    const mk = (cmdId, title, fn) => {
      const hk = this.plugin.getHotkeyLabel(cmdId);
      const t = title + (hk ? "   " + hk : "");
      m.addItem((it) => it.setTitle(t).onClick(fn));
    };
    mk("renumber-structure",        "Перенумеровать…",       () => this.plugin.openRenumberModal("renumber"));
    mk("remove-structure-numbering", "Удалить нумерацию…",   () => this.plugin.openRenumberModal("remove"));
    mk("emoji-number-structure",    "Emoji-цифры…",          () => this.plugin.openRenumberModal("emoji"));
    m.addSeparator();
    mk("normalize-heading-levels",  "Исправить пропуски уровней", () => this.plugin.normalizeHeadingLevels());
    const r = anchor.getBoundingClientRect();
    m.showAtPosition({ x: r.left, y: r.bottom });
  }

  refresh() {
    if (!this.host || !this.host.isConnected) return;
    const editor = this.view.editor;
    if (!editor) return;

    const headings = this.plugin.getHeadings(editor);
    const cur = this.plugin.getCurrentHeadingSilently(editor);
    const lvlBtn = this.host.querySelector('.scmd-tb-level');

    if (lvlBtn) {
      lvlBtn.textContent = (cur ? "H" + cur.level : "H?") + " ▾";
      lvlBtn.classList.toggle("scmd-tb-disabled", !cur);
    }

    const showBtn = this.host.querySelector('.scmd-tb-show');
    if (showBtn) {
      const lv = this.plugin.settings.lastShowToLevel || 1;
      showBtn.textContent = "Показать: H" + lv + " ▾";
    }

    // Если в файле нет заголовков — гасим базовые операции
    const noHeadings = headings.length === 0;
    this.host.classList.toggle("scmd-tb-empty", noHeadings);

    // Обновляем tooltip на случай смены хоткея
    this.host.querySelectorAll('.scmd-tb-btn[data-cmd]').forEach((el) => {
      const id = el.dataset.cmd;
      const labels = {
        "move-current-branch-up":   "Ветка выше",
        "move-current-branch-down": "Ветка ниже",
        "promote-current-branch":   "Повысить ветку",
        "demote-current-branch":    "Понизить ветку",
        "collapse-current-branch":  "Свернуть ветку",
        "expand-current-branch":    "Развернуть ветку"
      };
      this.applyTooltip(el, labels[id] || id, id);
    });
  }

  destroy() {
    try {
      const ed = this.view && this.view.editor;
      if (ed && ed.cm && ed.cm.dom) {
        ed.cm.dom.removeEventListener("keyup", this._cursorHandler);
        ed.cm.dom.removeEventListener("mouseup", this._cursorHandler);
      }
    } catch (e) { /* noop */ }
    if (this.host && this.host.parentElement) this.host.parentElement.removeChild(this.host);
    this.host = null;
    this.attached = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// StructurePanelView — компактная боковая панель структуры.
// Сделана ближе к встроенной Outline-панели Obsidian: только дерево заголовков,
// без отдельного пульта, поиска, счётчиков и кнопочного зоопарка.
// ═══════════════════════════════════════════════════════════════════════════════
class StructurePanelView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.maxLevel = plugin.settings.panelMaxLevel || 6;
    this._readToken = 0;
    this.panelCollapsed = new Set(); // локальная свёртка только внутри панели, редактор не трогаем
    this.scheduleRender = debounce(() => this.render(), 180, true);
  }

  getViewType() { return STRUCTURE_PANEL_VIEW; }
  getDisplayText() { return "Структура"; }
  getIcon() { return "list-tree"; }

  async onOpen() {
    this.render();
    this.registerEvent(this.app.workspace.on("editor-change", () => this.scheduleRender()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRender()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.scheduleRender()));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      const cur = this.plugin.getCurrentMarkdownFile();
      if (cur && file && file.path === cur.path) this.scheduleRender();
    }));
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("structure-panel-root");

    // Локальные стили держим здесь, чтобы main.js можно было заменить одним файлом
    // без обязательного обновления styles.css. Да, CSS внутри JS выглядит как ремонт
    // изолентой, зато не ломает установку.
    this.ensureInlineStyles(container);

    const file = this.plugin.getCurrentMarkdownFile();
    const body = container.createDiv({ cls: "scmd-outline" });

    if (!file) {
      body.createDiv({ cls: "scmd-outline-empty", text: "Откройте Markdown-заметку" });
      return;
    }

    this.bodyEl = body;
    this.fileForRender = file;

    const myToken = ++this._readToken;
    this.app.vault.cachedRead(file).then((text) => {
      if (myToken !== this._readToken) return;
      this.allHeadings = parseHeadingsFromLines(String(text || "").split(/\r?\n/));
      this.renderList();
    });
  }

  ensureInlineStyles(container) {
    if (container.querySelector("style[data-scmd-outline-style]")) return;
    const style = container.createEl("style");
    style.setAttribute("data-scmd-outline-style", "true");
    style.textContent = `
      .structure-panel-root {
        padding: 0;
        overflow: hidden;
      }
      .structure-panel-root .scmd-outline {
        height: 100%;
        overflow: auto;
        padding: 4px 0 8px 0;
        font-size: var(--font-ui-small);
        color: var(--text-normal);
      }
      .structure-panel-root .scmd-outline-empty {
        color: var(--text-muted);
        padding: 8px 12px;
      }
      .structure-panel-root .scmd-outline-list {
        position: relative;
        padding: 2px 0;
      }
      .structure-panel-root .scmd-outline-item {
        position: relative;
        display: flex;
        align-items: center;
        gap: 4px;
        min-height: 22px;
        line-height: 22px;
        padding: 0 8px 0 6px;
        border-radius: var(--radius-s);
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .structure-panel-root .scmd-outline-item:hover {
        background: var(--background-modifier-hover);
      }
      .structure-panel-root .scmd-outline-item-active {
        background: var(--background-modifier-hover);
        color: var(--text-accent);
      }
      .structure-panel-root .scmd-outline-toggle {
        width: 12px;
        min-width: 12px;
        color: var(--text-faint);
        font-size: 11px;
        text-align: center;
      }
      .structure-panel-root .scmd-outline-title {
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .structure-panel-root .scmd-outline-level-1 { padding-left: 4px;  font-weight: 500; }
      .structure-panel-root .scmd-outline-level-2 { padding-left: 18px; }
      .structure-panel-root .scmd-outline-level-3 { padding-left: 32px; }
      .structure-panel-root .scmd-outline-level-4 { padding-left: 46px; }
      .structure-panel-root .scmd-outline-level-5 { padding-left: 60px; }
      .structure-panel-root .scmd-outline-level-6 { padding-left: 74px; }
      .structure-panel-root .scmd-outline-level-2::before,
      .structure-panel-root .scmd-outline-level-3::before,
      .structure-panel-root .scmd-outline-level-4::before,
      .structure-panel-root .scmd-outline-level-5::before,
      .structure-panel-root .scmd-outline-level-6::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1px;
        background: var(--background-modifier-border);
        opacity: 0.8;
      }
      .structure-panel-root .scmd-outline-level-2::before { left: 10px; }
      .structure-panel-root .scmd-outline-level-3::before { left: 24px; }
      .structure-panel-root .scmd-outline-level-4::before { left: 38px; }
      .structure-panel-root .scmd-outline-level-5::before { left: 52px; }
      .structure-panel-root .scmd-outline-level-6::before { left: 66px; }
    `;
  }

  renderList() {
    if (!this.bodyEl) return;
    const body = this.bodyEl;
    const file = this.fileForRender;
    if (!file || !this.allHeadings) return;

    body.empty();

    const all = this.allHeadings;

    if (!all.length) {
      body.createDiv({ cls: "scmd-outline-empty", text: "Нет заголовков" });
      return;
    }

    let activeLine = -1;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file && view.file.path === file.path && view.editor) {
      const cur = this.plugin.getCurrentHeadingSilently(view.editor);
      if (cur) activeLine = cur.line;
    }

    const list = body.createDiv({ cls: "scmd-outline-list" });
    const hasChildren = new Set();
    for (let i = 0; i < all.length - 1; i++) {
      const h = all[i];
      const n = all[i + 1];
      if (n && n.level > h.level) hasChildren.add(h.line);
    }

    const visible = this.getPanelVisibleHeadings(all, hasChildren);
    if (!visible.length) {
      body.createDiv({ cls: "scmd-outline-empty", text: "Нет заголовков" });
      return;
    }

    visible.forEach((h) => {
      const item = list.createDiv({
        cls: "scmd-outline-item scmd-outline-level-" + h.level
      });
      if (h.line === activeLine) item.addClass("scmd-outline-item-active");
      item.title = "Строка " + (h.line + 1);

      const canCollapse = hasChildren.has(h.line);
      const isCollapsed = this.isPanelCollapsed(h);
      const toggle = item.createSpan({ cls: "scmd-outline-toggle" });
      toggle.setText(canCollapse ? (isCollapsed ? "›" : "⌄") : "");
      if (canCollapse) {
        toggle.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.togglePanelHeading(h);
        });
      }

      item.createSpan({ cls: "scmd-outline-title", text: h.title || "(без названия)" });

      item.addEventListener("click", () => this.plugin.jumpToHeading(file, h.line));
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openItemContextMenu(h, e.clientX, e.clientY);
      });
    });
  }

  panelKey(heading) {
    const file = this.fileForRender;
    return (file ? file.path : "") + ":" + heading.line;
  }

  isPanelCollapsed(heading) {
    return this.panelCollapsed.has(this.panelKey(heading));
  }

  togglePanelHeading(heading) {
    const key = this.panelKey(heading);
    if (this.panelCollapsed.has(key)) this.panelCollapsed.delete(key);
    else this.panelCollapsed.add(key);
    this.renderList();
  }

  setPanelHeadingCollapsed(heading, collapsed) {
    const key = this.panelKey(heading);
    if (collapsed) this.panelCollapsed.add(key);
    else this.panelCollapsed.delete(key);
    this.renderList();
  }

  getPanelVisibleHeadings(all, hasChildren) {
    const visible = [];
    const collapsedStack = [];

    for (let i = 0; i < all.length; i++) {
      const h = all[i];

      while (collapsedStack.length && collapsedStack[collapsedStack.length - 1].level >= h.level) {
        collapsedStack.pop();
      }

      const hiddenByPanel = collapsedStack.length > 0;
      if (!hiddenByPanel && h.level <= this.maxLevel) visible.push(h);

      // Сворачиваем только внутри панели: не вызываем collapseCurrentBranch/expandCurrentBranch
      // и не меняем fold-состояние редактора.
      if (!hiddenByPanel && hasChildren.has(h.line) && this.isPanelCollapsed(h)) {
        collapsedStack.push({ level: h.level, line: h.line });
      }
    }

    return visible;
  }

  openItemContextMenu(heading, x, y) {
    const m = new Menu();
    m.addItem((it) => it.setTitle("Перейти").setIcon("arrow-right-circle")
      .onClick(() => this.plugin.jumpToHeading(this.fileForRender, heading.line)));
    m.addSeparator();
    m.addItem((it) => it.setTitle("Свернуть в панели").onClick(() => {
      this.setPanelHeadingCollapsed(heading, true);
    }));
    m.addItem((it) => it.setTitle("Развернуть в панели").onClick(() => {
      this.setPanelHeadingCollapsed(heading, false);
    }));
    m.addSeparator();
    m.addItem((it) => it.setTitle("Ветку выше").onClick(async () => {
      await this.plugin.jumpToHeading(this.fileForRender, heading.line);
      await sleep(30);
      this.plugin.moveCurrentBranch(-1);
    }));
    m.addItem((it) => it.setTitle("Ветку ниже").onClick(async () => {
      await this.plugin.jumpToHeading(this.fileForRender, heading.line);
      await sleep(30);
      this.plugin.moveCurrentBranch(1);
    }));
    m.addItem((it) => it.setTitle("Повысить").onClick(async () => {
      await this.plugin.jumpToHeading(this.fileForRender, heading.line);
      await sleep(30);
      this.plugin.shiftLineAtCursor(-1);
    }));
    m.addItem((it) => it.setTitle("Понизить").onClick(async () => {
      await this.plugin.jumpToHeading(this.fileForRender, heading.line);
      await sleep(30);
      this.plugin.shiftLineAtCursor(1);
    }));
    m.addSeparator();
    m.addItem((it) => it.setTitle("Экспорт ветки…").onClick(async () => {
      await this.plugin.jumpToHeading(this.fileForRender, heading.line);
      await sleep(30);
      this.plugin.openExportBranchModal();
    }));
    m.showAtPosition({ x, y });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// StructureCommanderModal — общий «пульт» (по ribbon-иконке).
// ═══════════════════════════════════════════════════════════════════════════════
class StructureCommanderModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }

  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass("structure-commander-modal");

    el.createEl("h2", { text: "Structure Commander" });

    this.section(el, "Боковая панель", [
      ["Открыть справа", () => this.plugin.openStructurePanel("right")],
      ["Открыть слева",  () => this.plugin.openStructurePanel("left")],
      ["Открыть снизу",  () => this.plugin.openStructurePanel("bottom")]
    ]);

    this.section(el, "Документ", [
      ["Свернуть всё",   () => this.plugin.foldAll()],
      ["Показать всё",   () => this.plugin.unfoldAll()]
    ]);

    this.levelButtons(el, "Показать документ до уровня", (lv) => this.plugin.showDocumentToLevel(lv));

    this.section(el, "Текущая ветка", [
      [this.plugin.labelWithHotkey("Свернуть ветку",   "collapse-current-branch"),  () => this.plugin.collapseCurrentBranch()],
      [this.plugin.labelWithHotkey("Развернуть ветку", "expand-current-branch"),    () => this.plugin.expandCurrentBranch()],
      ["Тумблер сворачивания",                                                       () => this.plugin.toggleCurrentBranchFold()],
      ["Скопировать ветку",                                                          () => this.plugin.copyCurrentBranch()],
      ["Экспорт ветки…",                                                             () => this.plugin.openExportBranchModal()],
      [this.plugin.labelWithHotkey("Ветка выше",       "move-current-branch-up"),   () => this.plugin.moveCurrentBranch(-1)],
      [this.plugin.labelWithHotkey("Ветка ниже",       "move-current-branch-down"), () => this.plugin.moveCurrentBranch(1)]
    ]);

    const depthWrap = el.createDiv({ cls: "structure-commander-section" });
    depthWrap.createEl("h3", { text: "Показать ветку до глубины" });
    const depthBtns = depthWrap.createDiv({ cls: "structure-commander-buttons" });
    for (let d = 1; d <= 6; d++) {
      this.button(depthBtns, String(d), () => this.plugin.showCurrentBranchDepth(d));
    }

    this.section(el, "Уровни", [
      ["Заголовок выше",                                                               () => this.plugin.shiftCurrentHeading(-1)],
      ["Заголовок ниже",                                                               () => this.plugin.shiftCurrentHeading(1)],
      [this.plugin.labelWithHotkey("Повысить ветку", "promote-current-branch"),        () => this.plugin.shiftCurrentBranch(-1)],
      [this.plugin.labelWithHotkey("Понизить ветку", "demote-current-branch"),         () => this.plugin.shiftCurrentBranch(1)],
      ["Исправить пропуски уровней",                                                   () => this.plugin.normalizeHeadingLevels()]
    ]);

    this.section(el, "Нумерация", [
      ["Перенумеровать…",        () => this.plugin.openRenumberModal("renumber")],
      ["Удалить нумерацию…",     () => this.plugin.openRenumberModal("remove")],
      ["Emoji-цифры…",           () => this.plugin.openRenumberModal("emoji")]
    ]);

    this.levelButtons(el, "Уровень текущему заголовку",
      (lv) => this.plugin.setCurrentHeadingLevel(lv));
    this.levelButtons(el, "Заголовок ветки → уровень (с сохранением иерархии)",
      (lv) => this.plugin.setCurrentBranchRootLevel(lv));

    el.createDiv({ cls: "structure-commander-note", text:
      "Ветка определяется по ближайшему заголовку выше курсора. Хоткеи меняются: Настройки → Hotkeys → Structure." });
  }

  section(parent, title, actions) {
    const w = parent.createDiv({ cls: "structure-commander-section" });
    w.createEl("h3", { text: title });
    const btns = w.createDiv({ cls: "structure-commander-buttons" });
    actions.forEach((a) => this.button(btns, a[0], a[1]));
  }

  levelButtons(parent, title, cb) {
    const w = parent.createDiv({ cls: "structure-commander-section" });
    w.createEl("h3", { text: title });
    const btns = w.createDiv({ cls: "structure-commander-buttons structure-commander-levels" });
    for (let lv = 1; lv <= 6; lv++) this.button(btns, "H" + lv, () => cb(lv));
  }

  button(parent, title, cb) {
    const b = parent.createEl("button", { text: title });
    b.onclick = async () => {
      try { await cb(); }
      catch (e) { console.error(e); new Notice("Ошибка Structure Commander"); }
    };
    return b;
  }

  onClose() { this.contentEl.empty(); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ExportBranchModal — экспорт ветки в .md.
// ═══════════════════════════════════════════════════════════════════════════════
class ExportBranchModal extends Modal {
  constructor(app, plugin, editor, file, root) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.file = file;
    this.root = root;
    this.mode         = plugin.settings.exportMode || "same-folder";
    this.folder       = plugin.settings.exportFolder || "_Exports";
    this.askEachTime  = !!plugin.settings.exportAskEachTime;
    this.openAfter    = !!plugin.settings.exportOpenAfter;
    this.promoteToH1  = !!plugin.settings.exportPromoteToH1;
  }

  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass("structure-commander-small-modal");

    el.createEl("h2", { text: "Экспорт ветки" });
    el.createDiv({ cls: "structure-commander-muted", text: stripHeadingMarks(this.root.text) });

    // Куда сохранить
    const modes = [
      ["same-folder", "Рядом с текущей заметкой"],
      ["folder",      "В указанную папку"],
      ["ask",         "Спрашивать каждый раз"]
    ];
    const wrap = el.createDiv({ cls: "structure-radio-block" });
    wrap.createDiv({ cls: "structure-radio-title", text: "Куда сохранить" });
    modes.forEach((m) => {
      const lab = wrap.createEl("label");
      const inp = lab.createEl("input", { type: "radio" });
      inp.name = "scmd-export-mode";
      inp.value = m[0];
      inp.checked = (this.mode === m[0]);
      inp.onchange = () => { this.mode = m[0]; };
      lab.createSpan({ text: " " + m[1] });
    });

    new Setting(el)
      .setName("Папка")
      .setDesc("Используется в режиме «В указанную папку».")
      .addText((t) => {
        t.setPlaceholder("_Exports");
        t.setValue(this.folder);
        t.onChange((v) => { this.folder = v || "_Exports"; });
      });

    // Чекбоксы
    new Setting(el).setName("Открыть файл после экспорта")
      .addToggle((tg) => tg.setValue(this.openAfter).onChange((v) => { this.openAfter = v; }));

    new Setting(el).setName("Привести верхний заголовок к H1")
      .setDesc("При экспорте сдвинуть уровни так, чтобы заголовок ветки стал H1.")
      .addToggle((tg) => tg.setValue(this.promoteToH1).onChange((v) => { this.promoteToH1 = v; }));

    const btns = el.createDiv({ cls: "structure-modal-buttons" });
    const ok = btns.createEl("button", { text: "Экспорт" });
    ok.addClass("mod-cta");
    ok.onclick = () => this.submit();
    const cancel = btns.createEl("button", { text: "Отмена" });
    cancel.onclick = () => this.close();

    this.scope.register([], "Enter", (evt) => { evt.preventDefault(); this.submit(); return false; });
  }

  async submit() {
    await this.plugin.exportBranch(this.editor, this.file, this.root, {
      mode: this.mode,
      folder: this.folder,
      openAfter: this.openAfter,
      promoteToH1: this.promoteToH1,
      askEachTime: this.askEachTime
    });
    this.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RenumberModal — перенумерация / удаление / emoji с предпросмотром.
// ═══════════════════════════════════════════════════════════════════════════════
class RenumberModal extends Modal {
  constructor(app, plugin, editor, mode) {
    super(app);
    this.plugin = plugin;
    this.editor = editor;
    this.mode = mode || "renumber";
    this.scopeValue = plugin.settings.renumberScope   || "document";
    this.targets    = plugin.settings.renumberTargets || "headings";
    this.style      = (mode === "emoji") ? "emoji" : (plugin.settings.renumberStyle || "numeric");
  }

  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass("structure-commander-small-modal");

    const title = (this.mode === "remove") ? "Удалить нумерацию"
                : (this.mode === "emoji")  ? "Emoji-нумерация"
                                            : "Перенумеровать структуру";
    el.createEl("h2", { text: title });

    // Область
    this.radioGroup(el, "Область", "scmd-rn-scope", [
      ["document",  "Весь документ"],
      ["branch",    "Текущая ветка"],
      ["selection", "Выделенный фрагмент"]
    ], this.scopeValue, (v) => { this.scopeValue = v; this.refreshPreview(); });

    // Что менять
    this.radioGroup(el, "Что менять", "scmd-rn-targets", [
      ["headings", "Только заголовки"],
      ["bullets",  "Только списки"],
      ["both",     "Заголовки и списки"]
    ], this.targets, (v) => { this.targets = v; this.refreshPreview(); });

    if (this.mode !== "remove") {
      this.radioGroup(el, "Стиль", "scmd-rn-style", [
        ["numeric", "Цифры: 1. / 1.1."],
        ["emoji",   "Emoji: 1️⃣ / 1️⃣.1️⃣"]
      ], this.style, (v) => { this.style = v; this.refreshPreview(); });
    }

    // Предпросмотр
    this.previewBox = el.createDiv({ cls: "structure-commander-preview" });
    this.previewBox.createEl("h3", { text: "Предпросмотр" });
    this.previewList = this.previewBox.createDiv({ cls: "structure-preview-list" });
    this.previewCount = this.previewBox.createDiv({ cls: "structure-commander-muted" });

    const btns = el.createDiv({ cls: "structure-modal-buttons" });
    const ok = btns.createEl("button", { text: "Применить" });
    ok.addClass("mod-cta");
    ok.onclick = () => this.submit();
    const cancel = btns.createEl("button", { text: "Отмена" });
    cancel.onclick = () => this.close();

    this.scope.register([], "Enter", (evt) => { evt.preventDefault(); this.submit(); return false; });

    this.refreshPreview();
  }

  radioGroup(parent, title, name, options, selected, onChange) {
    const w = parent.createDiv({ cls: "structure-radio-block" });
    w.createDiv({ cls: "structure-radio-title", text: title });
    options.forEach((o) => {
      const lab = w.createEl("label");
      const inp = lab.createEl("input", { type: "radio" });
      inp.name = name; inp.value = o[0];
      inp.checked = (selected === o[0]);
      inp.onchange = () => onChange(o[0]);
      lab.createSpan({ text: " " + o[1] });
    });
  }

  refreshPreview() {
    if (!this.previewList) return;
    this.previewList.empty();

    const action = (this.mode === "remove") ? "remove" : "renumber";
    const style  = (this.mode === "emoji")  ? "emoji"  : this.style;

    const reps = this.plugin.collectRenumberReplacements(this.editor, {
      scope: this.scopeValue, targets: this.targets,
      style, action
    });

    if (!reps) {
      this.previewCount.setText("Нет ветки под курсором.");
      return;
    }
    if (!reps.length) {
      this.previewCount.setText("Нечего менять.");
      return;
    }

    const sample = reps.slice(0, 8);
    sample.forEach((r) => {
      const row = this.previewList.createDiv({ cls: "structure-preview-row" });
      const before = this.editor.getLine(r.line);
      row.createDiv({ cls: "structure-preview-before", text: truncate(before, 80) });
      row.createDiv({ cls: "structure-preview-arrow",  text: "→" });
      row.createDiv({ cls: "structure-preview-after",  text: truncate(r.text,  80) });
    });

    this.previewCount.setText("Будет изменено строк: " + reps.length
      + (reps.length > sample.length ? " (показаны первые " + sample.length + ")" : ""));
  }

  async submit() {
    const action = (this.mode === "remove") ? "remove" : "renumber";
    const style  = (this.mode === "emoji")  ? "emoji"  : this.style;
    await this.plugin.applyRenumber(this.editor, {
      scope: this.scopeValue, targets: this.targets,
      style, action
    });
    this.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Settings tab.
// ═══════════════════════════════════════════════════════════════════════════════
class StructureCommanderSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Structure Commander" });

    // ── Полный список команд с быстрой записью хоткеев ──
    this.renderHotkeysSection(containerEl);

    new Setting(containerEl)
      .setName("Глубина боковой панели по умолчанию")
      .setDesc("До какого уровня показывать заголовки в боковой панели.")
      .addDropdown((dd) => {
        dd.addOption("1", "До H1");
        dd.addOption("2", "До H2");
        dd.addOption("3", "До H3");
        dd.addOption("4", "До H4");
        dd.addOption("5", "До H5");
        dd.addOption("6", "Все");
        dd.setValue(String(this.plugin.settings.panelMaxLevel || 6));
        dd.onChange(async (v) => {
          this.plugin.settings.panelMaxLevel = Number(v);
          await this.plugin.saveSettings();
          this.plugin.refreshStructurePanels();
        });
      });

    new Setting(containerEl)
      .setName("Открыть боковую панель")
      .addButton((b) => b.setButtonText("Справа").onClick(() => this.plugin.openStructurePanel("right")))
      .addButton((b) => b.setButtonText("Слева").onClick(() => this.plugin.openStructurePanel("left")))
      .addButton((b) => b.setButtonText("Снизу").onClick(() => this.plugin.openStructurePanel("bottom")));

    new Setting(containerEl)
      .setName("Toolbar над редактором")
      .setDesc("Показывать узкую панель кнопок над Markdown-редактором.")
      .addToggle((tg) => {
        tg.setValue(this.plugin.settings.showEditorToolbar !== false)
          .onChange(async (v) => {
            this.plugin.settings.showEditorToolbar = v;
            await this.plugin.saveSettings();
            this.plugin.syncAllToolbars();
          });
      });

    new Setting(containerEl)
      .setName("Папка экспорта")
      .setDesc("Используется в режиме «В указанную папку».")
      .addText((t) => {
        t.setPlaceholder("_Exports");
        t.setValue(this.plugin.settings.exportFolder || "_Exports");
        t.onChange(async (v) => {
          this.plugin.settings.exportFolder = v || "_Exports";
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Сбросить настройки")
      .setDesc("Вернуть настройки плагина к значениям по умолчанию.")
      .addButton((b) => {
        b.setButtonText("Сбросить");
        b.setWarning();
        b.onClick(async () => {
          this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
          await this.plugin.saveSettings();
          this.display();
          this.plugin.refreshStructurePanels();
          this.plugin.syncAllToolbars();
          new Notice("Настройки сброшены");
        });
      });

    const note = containerEl.createDiv({ cls: "structure-commander-muted" });
    note.setText("Плагин видит коллизии хоткеев внутри Obsidian. Глобальные перехваты Windows или других приложений из Obsidian не проверяются.");
  }

  /**
   * Полный список команд плагина с быстрой записью хоткеев прямо в настройках.
   * Группы — для удобства восприятия. Каждая строка: название + текущий хоткей + кнопка «Изменить».
   */
  renderHotkeysSection(containerEl) {
    const wrap = containerEl.createDiv({ cls: "scmd-hk-section" });
    wrap.createEl("h3", { text: "Хоткеи команд" });
    wrap.createDiv({
      cls: "structure-commander-muted",
      text: "Нажмите «Изменить», затем введите комбинацию клавиш — она применится сразу. Кнопка «Открыть полные настройки Hotkeys» откроет штатный редактор Obsidian."
    });

    const groups = [
      ["Перемещение и уровни", [
        ["move-current-branch-up",   "Ветка выше"],
        ["move-current-branch-down", "Ветка ниже"],
        ["promote-current-branch",   "Повысить (заголовок/текст/список)"],
        ["demote-current-branch",    "Понизить (заголовок/текст/список)"]
      ]],
      ["Сворачивание", [
        ["collapse-current-branch", "Свернуть ветку"],
        ["expand-current-branch",   "Развернуть ветку"],
        ["fold-all-headings",       "Свернуть все заголовки"],
        ["unfold-all-headings",     "Развернуть всё"],
        ["toggle-current-branch-fold", "Переключить сворачивание ветки"]
      ]],
      ["Показ до уровня", [
        ["show-document-to-h1", "Показать документ до H1"],
        ["show-document-to-h2", "Показать документ до H2"],
        ["show-document-to-h3", "Показать документ до H3"],
        ["show-document-to-h4", "Показать документ до H4"],
        ["show-document-to-h5", "Показать документ до H5"],
        ["show-document-to-h6", "Показать документ до H6"]
      ]],
      ["Поставить уровень текущему заголовку", [
        ["set-current-heading-h1", "Текущий заголовок → H1"],
        ["set-current-heading-h2", "Текущий заголовок → H2"],
        ["set-current-heading-h3", "Текущий заголовок → H3"],
        ["set-current-heading-h4", "Текущий заголовок → H4"],
        ["set-current-heading-h5", "Текущий заголовок → H5"],
        ["set-current-heading-h6", "Текущий заголовок → H6"]
      ]],
      ["Поставить уровень всей ветке (с сохранением иерархии)", [
        ["set-current-branch-root-h1", "Заголовок ветки → H1"],
        ["set-current-branch-root-h2", "Заголовок ветки → H2"],
        ["set-current-branch-root-h3", "Заголовок ветки → H3"],
        ["set-current-branch-root-h4", "Заголовок ветки → H4"],
        ["set-current-branch-root-h5", "Заголовок ветки → H5"],
        ["set-current-branch-root-h6", "Заголовок ветки → H6"]
      ]],
      ["Панель структуры и тулбар", [
        ["open-structure-panel-right",  "Открыть панель структуры справа"],
        ["open-structure-panel-left",   "Открыть панель структуры слева"],
        ["open-structure-panel-bottom", "Открыть панель структуры снизу"],
        ["toggle-structure-panel",      "Скрыть/показать боковую панель"],
        ["toggle-editor-toolbar",       "Скрыть/показать панель инструментов"]
      ]],
      ["Прочее", [
        ["promote-current-heading",     "Повысить только текущий заголовок"],
        ["demote-current-heading",      "Понизить только текущий заголовок"],
        ["copy-current-branch",         "Скопировать ветку"],
        ["export-current-branch",       "Экспорт ветки"],
        ["normalize-heading-levels",    "Исправить пропуски уровней"],
        ["renumber-structure",          "Перенумеровать структуру"],
        ["remove-structure-numbering",  "Удалить нумерацию"],
        ["emoji-number-structure",      "Emoji-цифры"]
      ]]
    ];

    groups.forEach(([groupTitle, items]) => {
      wrap.createEl("h4", { text: groupTitle, cls: "scmd-hk-group" });
      const list = wrap.createDiv({ cls: "scmd-hk-list" });
      items.forEach(([cmdId, label]) => this.makeHotkeyRow(list, cmdId, label));
    });

    new Setting(wrap)
      .setName("Полный редактор Hotkeys")
      .setDesc("Открыть штатный редактор горячих клавиш Obsidian.")
      .addButton((b) => b.setButtonText("Открыть Hotkeys").onClick(() => this.plugin.openHotkeysSettings()));
  }

  makeHotkeyRow(parent, cmdId, label) {
    const row = parent.createDiv({ cls: "scmd-hk-row" });
    const lbl = row.createDiv({ cls: "scmd-hk-row-label", text: label });
    const cur = row.createDiv({ cls: "scmd-hk-row-current" });
    const refresh = () => {
      const hk = this.plugin.getHotkeyLabel(cmdId);
      cur.setText(hk || "не назначен");
      cur.classList.toggle("scmd-hk-row-empty", !hk);
    };
    refresh();

    const editBtn = row.createEl("button", { text: "Изменить", cls: "scmd-hk-row-btn" });
    editBtn.addEventListener("click", () => {
      const modal = new HotkeyCaptureModal(this.plugin.app, this.plugin, cmdId, label);
      const orig = modal.onClose ? modal.onClose.bind(modal) : null;
      modal.onClose = () => {
        if (orig) orig();
        refresh();
      };
      modal.open();
    });

    const clearBtn = row.createEl("button", { text: "×", cls: "scmd-hk-row-clear" });
    clearBtn.title = "Удалить хоткей";
    clearBtn.addEventListener("click", () => {
      try {
        const hm = this.plugin.app.hotkeyManager;
        const fullId = "structure-commander:" + cmdId;
        if (hm) {
          if (typeof hm.setHotkeys === "function") hm.setHotkeys(fullId, []);
          else if (typeof hm.removeHotkeys === "function") hm.removeHotkeys(fullId);
          if (typeof hm.save === "function") hm.save();
        }
        refresh();
        this.plugin.refreshActiveToolbar();
      } catch (e) { console.error(e); }
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers (не зависят от плагина).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Парсер ATX-заголовков. Игнорирует fenced code blocks.
 * Принимает массив строк, возвращает [{line, level, text, title}].
 */
function parseHeadingsFromLines(lines) {
  const headings = [];
  let inFence = false; let fenceMarker = "";

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    const fence = text.match(/^\s*(```+|~~~+)/);
    if (fence) {
      const mk = fence[1].charAt(0);
      if (!inFence) { inFence = true; fenceMarker = mk; }
      else if (mk === fenceMarker) { inFence = false; fenceMarker = ""; }
      continue;
    }
    if (inFence) continue;

    // ATX: 1..6 диезов, минимум один пробел, дальше — содержимое.
    // Пустые "## " без текста пропускаем (требование «не ломаться на пустых»).
    const m = text.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) {
      headings.push({ line, level: m[1].length, text, title: m[2].trim() });
    }
  }
  return headings;
}

function uniqueSortedLevels(headings) {
  const set = {};
  headings.forEach((h) => { set[h.level] = true; });
  return Object.keys(set).map(Number).sort((a, b) => a - b);
}

function sleep(ms) { return new Promise((r) => window.setTimeout(r, ms)); }

function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

function indentWidth(s) {
  return String(s || "").replace(/\t/g, "    ").length;
}

function truncate(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function sanitizeFileName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 120);
}

function stripHeadingMarks(text) {
  return String(text || "").replace(/^#{1,6}\s+/, "").trim();
}

/**
 * Снимает префикс-нумерацию любого вида:
 *  - 1.  / 1)  / 1.2.  / 1.2.3.
 *  - 1️⃣  / 1️⃣2️⃣  / 1️⃣.2️⃣  / 1️⃣2️⃣.3️⃣
 *  - ① ② … ⑩
 *  - ➊ ➋ … ➓
 *  - 1 - / 12 — и т.п.
 */
function stripNumberPrefix(text) {
  let value = String(text || "").trim();

  // emoji-цифры (любая длина), возможно с точечной иерархией:
  // 1️⃣2️⃣.3️⃣4️⃣  и т.п.
  const emojiSeq = "(?:\\d\\uFE0F?\\u20E3)+";
  const emojiPath = "(?:" + emojiSeq + "(?:\\." + emojiSeq + ")*)";
  value = value.replace(new RegExp("^(?:" + emojiPath + ")[.)]?\\s+"), "");

  // обычные цифры с иерархией: 1.2.3.  /  1)
  // Точка/скобка после цифр обязательны — иначе перехватим формат "12 — Тире"
  value = value.replace(/^(?:\d+(?:\.\d+)*[.)])\s+/, "");

  // кружочки и стрелочные числа
  value = value.replace(/^[①②③④⑤⑥⑦⑧⑨⑩](?:\.[①②③④⑤⑥⑦⑧⑨⑩])*[.)]?\s+/, "");
  value = value.replace(/^[➊➋➌➍➎➏➐➑➒➓]\s+/, "");

  // X — / X –
  value = value.replace(/^\d+\s*[-–—]\s+/, "");

  return value.trim();
}

const EMOJI_DIGITS = {
  0: "0\uFE0F\u20E3", 1: "1\uFE0F\u20E3", 2: "2\uFE0F\u20E3",
  3: "3\uFE0F\u20E3", 4: "4\uFE0F\u20E3", 5: "5\uFE0F\u20E3",
  6: "6\uFE0F\u20E3", 7: "7\uFE0F\u20E3", 8: "8\uFE0F\u20E3",
  9: "9\uFE0F\u20E3"
};

function emojiNumber(n) {
  return String(n).split("").map((ch) => EMOJI_DIGITS[ch] || ch).join("");
}

function emojiPath(path) {
  return path.map((n) => emojiNumber(n)).join(".");
}

function formatHotkey(hotkey) {
  if (!hotkey) return "";
  const mods = hotkey.modifiers || [];
  const key = hotkey.key || "";
  const parts = mods.slice();
  parts.push(formatKey(key));
  return parts.join("+");
}

function formatKey(key) {
  const map = {
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    Mod: "Ctrl"
  };
  return map[key] || key;
}
