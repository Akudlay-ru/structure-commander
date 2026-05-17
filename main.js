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
  TFolder,
  normalizePath,
  debounce
} = require("obsidian");

let electronClipboard = null, electronShell = null, nodeFs = null, nodePath = null, childProcess = null, os = null;
try { ({ clipboard: electronClipboard, shell: electronShell } = require("electron")); } catch (e) {}
try { nodeFs = require("fs"); nodePath = require("path"); childProcess = require("child_process"); os = require("os"); } catch (e) {}

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
  lastShowToLevel: 1,
  vaultOrderEnabled: true,
  vaultDryRun: false,
  vaultNumberingStyle: "decimal_2_underscore",
  vaultNumberingTargets: "both",
  vaultNumberingOrder: "folders-first",
  vaultStripOldNumbering: true,
  vaultCustomTemplate: "{N}_{title}",
  vaultCustomZeroPad: 2,
  vaultCustomMarker: "•"
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

const VAULT_NUMBERING_STYLES = [
  { id: "none", label: "нет", orderable: false },
  { id: "decimal_2_underscore", label: "01_Название", orderable: true },
  { id: "decimal_3_underscore", label: "001_Название", orderable: true },
  { id: "latin_upper_underscore", label: "A_Название", orderable: true },
  { id: "latin_lower_underscore", label: "a_Название", orderable: true },
  { id: "cyrillic_upper_underscore", label: "А_Название", orderable: true },
  { id: "cyrillic_lower_underscore", label: "а_Название", orderable: true },
  { id: "roman_upper_underscore", label: "I_Название", orderable: true },
  { id: "roman_lower_underscore", label: "i_Название", orderable: true },
  { id: "dash_marker", label: "- Название", orderable: false },
  { id: "bullet_marker", label: "• Название", orderable: false },
  { id: "custom", label: "Пользовательский шаблон", orderable: true }
];
const VAULT_LATIN_LOWER = "abcdefghijklmnopqrstuvwxyz".split("");
const VAULT_LATIN_UPPER = VAULT_LATIN_LOWER.map((x) => x.toUpperCase());
const VAULT_CYRILLIC_LOWER = ["а","б","в","г","д","е","ж","з","и","к","л","м","н","о","п","р","с","т","у","ф","х","ц","ч","ш","щ","э","ю","я"];
const VAULT_CYRILLIC_UPPER = VAULT_CYRILLIC_LOWER.map((x) => x.toUpperCase());


module.exports = class StructureCommanderPlugin extends Plugin {

  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.cmLanguage = this.loadCodeMirrorLanguage();
    this.lastMarkdownFilePath = "";
    this.toolbars = new WeakMap();   // MarkdownView -> EditorToolbar
    this._panelReadToken = 0;        // защита от устаревших async-read
    this.lastVaultTargetPath = "";
    this.vaultUndoStack = [];
    this.vaultRedoStack = [];

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

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (file && file.path) this.lastVaultTargetPath = file.path;
      this.buildVaultContextMenu(menu, file);
    }));

    this.registerDomEvent(document, "keydown", (evt) => this.handleVaultUndoRedoKeydown(evt));

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
      name: "Открыть Structure Commander",
      callback: () => new StructureCommanderModal(this.app, this).open()
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

    this.addCommand({ id: "renumber-vault-folder", name: "Пронумеровать текущую папку vault…", callback: () => this.openVaultRenumberModal("renumber") });
    this.addCommand({ id: "remove-vault-numbering", name: "Удалить нумерацию текущей папки vault…", callback: () => this.openVaultRenumberModal("remove") });
    this.addCommand({ id: "move-vault-item-up", name: "Файл/папка выше", callback: () => this.moveVaultItem(-1) });
    this.addCommand({ id: "move-vault-item-down", name: "Файл/папка ниже", callback: () => this.moveVaultItem(1) });
    this.addCommand({ id: "promote-vault-item", name: "Файл/папка на уровень выше", callback: () => this.moveVaultItemOut() });
    this.addCommand({ id: "demote-vault-item", name: "Файл/папка внутрь предыдущей папки", callback: () => this.moveVaultItemIntoPreviousFolder() });
    this.addCommand({ id: "undo-vault-operation", name: "Отменить файловую операцию", callback: () => this.undoVaultOperation() });
    this.addCommand({ id: "redo-vault-operation", name: "Повторить файловую операцию", callback: () => this.redoVaultOperation() });
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
    if (this.isVaultTreeContext()) return this.toggleVaultFolder(false);
    const editor = this.getEditor(); if (!editor) return;
    const heading = this.getCurrentHeading(editor); if (!heading) return;

    if (this.cmLanguage && editor.cm) {
      this.foldHeadingsDirect(editor, [heading]);
    } else {
      await this.toggleHeadingFoldFallback(editor, heading.line);
    }
  }

  async expandCurrentBranch() {
    if (this.isVaultTreeContext()) return this.toggleVaultFolder(true);
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
    if (this.isVaultTreeContext()) return delta < 0 ? this.moveVaultItemOut() : this.moveVaultItemIntoPreviousFolder();
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

  moveCurrentBranch(direction) {
    if (this.isVaultTreeContext()) return this.moveVaultItem(direction);
    const editor = this.getEditor(); if (!editor) return;

    // 1) Есть выделение → двигаем диапазон выделенных строк целиком (как блок).
    //    Цель — найти соседнюю «ветку того же уровня» относительно граничного заголовка
    //    выделения, иначе сдвиг на одну строку выше/ниже соседа.
    if (editor.somethingSelected && editor.somethingSelected()) {
      const selFrom = editor.getCursor("from");
      const selTo   = editor.getCursor("to");
      let startLine = selFrom.line;
      let endLine   = selTo.line;
      // Если выделение заканчивается в начале строки (ch === 0) и захватывает >0 строк —
      // "хвостовая" строка фактически не выделена; стандарт текстовых редакторов.
      if (selTo.ch === 0 && endLine > startLine) endLine -= 1;

      this.moveLineRange(editor, startLine, endLine, direction);
      this.refreshStructurePanels(); this.refreshActiveToolbar();
      return;
    }

    // 2) Нет выделения → старая логика: перенос всей ветки относительно соседа того же уровня.
    const root = this.getCurrentHeading(editor); if (!root) return;

    const headings = this.getHeadings(editor);
    const cur = this.getBranch(editor, root);

    let sibling = null;
    if (direction < 0) {
      for (let i = headings.length - 1; i >= 0; i--) {
        const h = headings[i];
        if (h.line >= root.line) continue;
        if (h.level < root.level) break;
        if (h.level === root.level) { sibling = h; break; }
      }
      if (!sibling) { new Notice("Нет предыдущей ветки того же уровня"); return; }
      const sb = this.getBranch(editor, sibling);
      this.moveBlock(editor, cur.startLine, cur.endLine, sb.startLine);
      this.refreshStructurePanels(); this.refreshActiveToolbar();
      new Notice("Ветка перемещена выше");
      return;
    }

    for (let j = 0; j < headings.length; j++) {
      const h = headings[j];
      if (h.line <= root.line) continue;
      if (h.line <= cur.endLine) continue;
      if (h.level < root.level) break;
      if (h.level === root.level) { sibling = h; break; }
    }
    if (!sibling) { new Notice("Нет следующей ветки того же уровня"); return; }
    const nb = this.getBranch(editor, sibling);
    this.moveBlock(editor, cur.startLine, cur.endLine, nb.endLine + 1);
    this.refreshStructurePanels(); this.refreshActiveToolbar();
    new Notice("Ветка перемещена ниже");
  }

  /**
   * Перемещает диапазон строк [startLine..endLine] на одну строку
   * выше/ниже (direction = -1 / +1). Если в диапазоне есть заголовок и
   * следующая строка тоже заголовок того же уровня — диапазон перепрыгивает
   * целую соседнюю ветку (соседи переставляются как блоки).
   */
  moveLineRange(editor, startLine, endLine, direction) {
    const total = editor.lineCount();
    if (startLine < 0 || endLine >= total || startLine > endLine) return;

    if (direction < 0) {
      if (startLine === 0) { new Notice("Уже наверху"); return; }
      // Если строка startLine — заголовок и строка startLine-1 (или сосед) тоже заголовок —
      // перепрыгиваем соседнюю ветку. Иначе двигаем на одну строку.
      const targetLine = this.findMoveTargetUp(editor, startLine);
      this.moveBlock(editor, startLine, endLine, targetLine, { preserveSelection: true });
      new Notice("Перемещено выше");
    } else {
      if (endLine >= total - 1) { new Notice("Уже внизу"); return; }
      const targetLine = this.findMoveTargetDown(editor, endLine);
      this.moveBlock(editor, startLine, endLine, targetLine, { preserveSelection: true });
      new Notice("Перемещено ниже");
    }
  }

  findMoveTargetUp(editor, startLine) {
    const text = editor.getLine(startLine);
    const m = text.match(/^(#{1,6})(\s+.+)$/);
    if (m) {
      // Это заголовок — ищем заголовок того же уровня выше и его branch.startLine.
      const headings = this.getHeadings(editor);
      const myLv = m[1].length;
      let prev = null;
      for (let i = headings.length - 1; i >= 0; i--) {
        const h = headings[i];
        if (h.line >= startLine) continue;
        if (h.level < myLv) break;
        if (h.level === myLv) { prev = h; break; }
      }
      if (prev) {
        const pb = this.getBranch(editor, prev);
        return pb.startLine;
      }
    }
    // обычный текст — на одну строку выше
    return startLine - 1;
  }

  findMoveTargetDown(editor, endLine) {
    // Если последняя строка диапазона — заголовок, то целевая = конец следующей ветки + 1.
    // Иначе — endLine + 2 (сдвиг на одну строку вниз).
    const text = editor.getLine(endLine);
    const m = text.match(/^(#{1,6})(\s+.+)$/);
    if (m) {
      const headings = this.getHeadings(editor);
      const myLv = m[1].length;
      let next = null;
      for (let j = 0; j < headings.length; j++) {
        const h = headings[j];
        if (h.line <= endLine) continue;
        if (h.level < myLv) break;
        if (h.level === myLv) { next = h; break; }
      }
      if (next) {
        const nb = this.getBranch(editor, next);
        return nb.endLine + 1;
      }
    }
    return endLine + 2;
  }

  /**
   * Атомарное перемещение [startLine..endLine] так, чтобы НОВАЯ позиция
   * первой строки блока оказалась на месте targetLine исходного документа.
   *
   * Важные детали, которые уже однажды ломались, конечно же:
   *   - выделение после перемещения сохраняется на всём перенесённом блоке;
   *   - если внутри переносимого блока были свёрнутые заголовки, они остаются свёрнутыми;
   *   - один Ctrl+Z откатывает всю замену.
   */
  moveBlock(editor, startLine, endLine, targetLine, options) {
    options = options || {};
    const total = editor.lineCount();
    if (startLine < 0 || endLine >= total || startLine > endLine) return null;
    if (targetLine < 0) targetLine = 0;
    if (targetLine > total) targetLine = total;
    if (targetLine >= startLine && targetLine <= endLine + 1) return null; // нет смещения

    const blockLen = endLine - startLine + 1;
    const foldedRelativeLines = this.captureFoldedHeadingRelativeLines(editor, startLine, endLine);

    // Соберём «строки» как массив, без склейки концов файла.
    const allLines = [];
    for (let i = 0; i < total; i++) allLines.push(editor.getLine(i));

    const block = allLines.slice(startLine, endLine + 1);
    const before = allLines.slice(0, startLine);
    const after  = allLines.slice(endLine + 1);

    const removed = before.concat(after);

    // targetLine задавался относительно исходного документа.
    // Если target идёт ПОСЛЕ удалённого блока, его индекс в removed уменьшается
    // на размер блока.
    let insertAt = targetLine;
    if (targetLine > endLine) insertAt = targetLine - blockLen;
    insertAt = clamp(insertAt, 0, removed.length);

    const finalLines = removed.slice(0, insertAt).concat(block).concat(removed.slice(insertAt));

    // Полная замена содержимого даёт стабильную транзакцию и не плодит пустые строки.
    const lastLine = total - 1;
    const lastCh   = editor.getLine(lastLine).length;
    const newText = finalLines.join("\n");
    editor.replaceRange(newText, { line: 0, ch: 0 }, { line: lastLine, ch: lastCh });

    const newStart = clamp(insertAt, 0, finalLines.length - 1);
    const newEnd = clamp(insertAt + blockLen - 1, 0, finalLines.length - 1);

    // Восстановить выделение именно как диапазон строк. Конец ставим в начало
    // следующей строки, чтобы повторное Alt+Shift+↑/↓ не теряло последнюю строку.
    if (options.preserveSelection) {
      const from = { line: newStart, ch: 0 };
      const to = (newEnd + 1 < finalLines.length)
        ? { line: newEnd + 1, ch: 0 }
        : { line: newEnd, ch: finalLines[newEnd].length };
      try {
        if (typeof editor.setSelection === "function") editor.setSelection(from, to);
        else editor.setCursor(from);
      } catch (e) { editor.setCursor(from); }
      try { editor.scrollIntoView({ from, to }, true); } catch (e) { /* noop */ }
    } else {
      const cursorLine = newStart;
      editor.setCursor({ line: cursorLine, ch: 0 });
      try {
        editor.scrollIntoView({ from: { line: cursorLine, ch: 0 }, to: { line: cursorLine, ch: 0 } }, true);
      } catch (e) { /* noop */ }
    }

    this.restoreFoldedHeadingRelativeLines(editor, newStart, foldedRelativeLines);
    return { startLine: newStart, endLine: newEnd };
  }

  captureFoldedHeadingRelativeLines(editor, startLine, endLine) {
    const result = [];
    if (!this.cmLanguage || !editor || !editor.cm || !this.cmLanguage.foldedRanges) return result;
    const headings = this.getHeadings(editor).filter((h) => h.line >= startLine && h.line <= endLine);
    if (!headings.length) return result;

    const view = editor.cm;
    for (const h of headings) {
      const lineText = editor.getLine(h.line) || "";
      const from = this.safePosToOffset(editor, { line: h.line, ch: lineText.length });
      const branchEnd = this.getBranchEndLine(editor, h);
      const to = this.safePosToOffset(editor, { line: branchEnd, ch: (editor.getLine(branchEnd) || "").length });
      if (from === null || to === null || to <= from) continue;
      try {
        let isFolded = false;
        this.cmLanguage.foldedRanges(view.state).between(from, to, (a, b) => {
          if (Math.abs(a - from) <= 3 || (a >= from && a <= from + 3)) isFolded = true;
        });
        if (isFolded) result.push(h.line - startLine);
      } catch (e) { /* ignore fold API quirks */ }
    }
    return result;
  }

  restoreFoldedHeadingRelativeLines(editor, newStartLine, relativeLines) {
    if (!relativeLines || !relativeLines.length || !this.cmLanguage || !editor || !editor.cm) return;
    const toFold = [];
    for (const rel of relativeLines) {
      const line = newStartLine + rel;
      if (line < 0 || line >= editor.lineCount()) continue;
      const text = editor.getLine(line) || "";
      const m = text.match(/^(#{1,6})(\s+.+)$/);
      if (!m) continue;
      toFold.push({ line, level: m[1].length, text, title: text.replace(/^#{1,6}\s+/, "").trim() });
    }
    if (!toFold.length) return;
    try { window.setTimeout(() => this.foldHeadingsDirect(editor, toFold), 0); }
    catch (e) { /* noop */ }
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
    if (this.isVaultTreeContext()) return this.openVaultRenumberModal(mode === "remove" ? "remove" : "renumber");
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



  // ─────────────────────── vault tree: файлы, папки, меню, undo/redo ───────────────────────

  isVaultTreeContext() {
    if (!this.settings.vaultOrderEnabled) return false;
    try {
      const ae = document.activeElement;
      if (!ae || !ae.closest) return false;
      return !!ae.closest('.workspace-leaf-content[data-type="file-explorer"], .nav-files-container, .nav-folder, .nav-file, .tree-item-self');
    } catch (e) { return false; }
  }

  getVaultTarget(silent) {
    let p = "";
    try {
      const ae = document.activeElement;
      const node = ae && ae.closest ? ae.closest('[data-path]') : null;
      if (node) p = node.getAttribute('data-path') || "";
    } catch (e) {}
    if (!p) p = this.lastVaultTargetPath || "";
    if (!p) {
      const cur = this.getCurrentMarkdownFile();
      if (cur) p = cur.path;
    }
    const target = p ? this.app.vault.getAbstractFileByPath(p) : null;
    if (!target && !silent) new Notice("Не выбран файл или папка в дереве vault");
    return target;
  }

  getVaultFolderForAction(target) {
    if (target instanceof TFolder) return target;
    if (target instanceof TFile && target.parent) return target.parent;
    return this.app.vault.getRoot ? this.app.vault.getRoot() : null;
  }

  buildVaultContextMenu(menu, file) {
    if (!file) return;
    menu.addSeparator();
    menu.addItem((item) => {
      item.setTitle("Файл").setIcon("file-cog");
      const sub = typeof item.setSubmenu === "function" ? item.setSubmenu() : null;
      const targetMenu = sub || menu;
      targetMenu.addItem((it) => it.setTitle("Открыть в проводнике").setIcon("folder-open").onClick(() => this.openInExplorer(file)));
      targetMenu.addItem((it) => it.setTitle("Скопировать путь").setIcon("copy").onClick(() => this.copyVaultPath(file)));
      targetMenu.addItem((it) => it.setTitle("Скопировать файл в буфер").setIcon("clipboard-copy").onClick(() => this.copyFileToClipboard(file)));
      targetMenu.addItem((it) => {
        it.setTitle("Отправить").setIcon("send");
        const sendSub = typeof it.setSubmenu === "function" ? it.setSubmenu() : null;
        if (!sendSub) { it.onClick(() => this.openSendToFolder()); return; }
        this.fillSendToMenu(sendSub, file);
      });
      targetMenu.addSeparator();
      targetMenu.addItem((it) => it.setTitle("Режим отработки: " + (this.settings.vaultDryRun ? "вкл" : "выкл")).setIcon("test-tube").onClick(async () => {
        this.settings.vaultDryRun = !this.settings.vaultDryRun;
        await this.saveSettings();
        new Notice("Режим отработки: " + (this.settings.vaultDryRun ? "включён" : "выключен"));
      }));
      targetMenu.addSeparator();
      targetMenu.addItem((it) => it.setTitle("Ctrl+Z — отменить файловую операцию").setIcon("undo-2").onClick(() => this.undoVaultOperation()).setDisabled(!this.vaultUndoStack.length));
      targetMenu.addItem((it) => it.setTitle("Ctrl+Y — повторить файловую операцию").setIcon("redo-2").onClick(() => this.redoVaultOperation()).setDisabled(!this.vaultRedoStack.length));
    });

    menu.addSeparator();
    menu.addItem((it) => it.setTitle("Structure: перенумеровать папку…").setIcon("list-ordered").onClick(() => { this.lastVaultTargetPath = file.path; this.openVaultRenumberModal("renumber"); }));
    menu.addItem((it) => it.setTitle("Structure: удалить нумерацию…").setIcon("eraser").onClick(() => { this.lastVaultTargetPath = file.path; this.openVaultRenumberModal("remove"); }));
    menu.addItem((it) => it.setTitle(this.labelWithHotkey("Файл/папка выше", "move-current-branch-up")).setIcon("arrow-up").onClick(() => { this.lastVaultTargetPath = file.path; this.moveVaultItem(-1); }));
    menu.addItem((it) => it.setTitle(this.labelWithHotkey("Файл/папка ниже", "move-current-branch-down")).setIcon("arrow-down").onClick(() => { this.lastVaultTargetPath = file.path; this.moveVaultItem(1); }));
    menu.addItem((it) => it.setTitle(this.labelWithHotkey("На уровень выше", "promote-current-branch")).setIcon("arrow-left").onClick(() => { this.lastVaultTargetPath = file.path; this.moveVaultItemOut(); }));
    menu.addItem((it) => it.setTitle(this.labelWithHotkey("Внутрь предыдущей папки", "demote-current-branch")).setIcon("arrow-right").onClick(() => { this.lastVaultTargetPath = file.path; this.moveVaultItemIntoPreviousFolder(); }));
  }

  handleVaultUndoRedoKeydown(evt) {
    if (!this.isVaultTreeContext()) return;
    const key = String(evt.key || "").toLowerCase();
    if ((evt.ctrlKey || evt.metaKey) && !evt.shiftKey && key === "z") {
      evt.preventDefault(); evt.stopPropagation(); this.undoVaultOperation();
    } else if ((evt.ctrlKey || evt.metaKey) && !evt.shiftKey && key === "y") {
      evt.preventDefault(); evt.stopPropagation(); this.redoVaultOperation();
    }
  }

  fullVaultPath(file) {
    try { return this.app.vault.adapter.getFullPath(file.path); }
    catch (e) { return file.path; }
  }

  openInExplorer(file) {
    const full = this.fullVaultPath(file);
    if (electronShell && typeof electronShell.showItemInFolder === "function") {
      electronShell.showItemInFolder(full);
      return;
    }
    new Notice("Открытие в проводнике доступно только в desktop Obsidian");
  }

  async copyVaultPath(file) {
    const full = this.fullVaultPath(file);
    try {
      if (electronClipboard) electronClipboard.writeText(full);
      else await navigator.clipboard.writeText(full);
      new Notice("Путь скопирован");
    } catch (e) { console.error(e); new Notice("Не удалось скопировать путь"); }
  }

  copyFileToClipboard(file) {
    if (!childProcess || typeof process === "undefined" || process.platform !== "win32") {
      new Notice("Копирование файла в буфер реализовано для Windows desktop");
      return;
    }
    const full = this.fullVaultPath(file);
    const ps = `Set-Clipboard -LiteralPath ${JSON.stringify(full)}`;
    childProcess.execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { windowsHide: true }, (err) => {
      if (err) { console.error(err); new Notice("Не удалось скопировать файл в буфер"); }
      else new Notice("Файл скопирован в буфер");
    });
  }

  sendToFolderPath() {
    if (typeof process === "undefined" || process.platform !== "win32" || !process.env.APPDATA || !nodePath) return "";
    return nodePath.join(process.env.APPDATA, "Microsoft", "Windows", "SendTo");
  }

  fillSendToMenu(menu, file) {
    const folder = this.sendToFolderPath();
    if (!folder || !nodeFs || !nodeFs.existsSync(folder)) {
      menu.addItem((x) => x.setTitle("SendTo недоступен").setDisabled(true));
      return;
    }
    let entries = [];
    try { entries = nodeFs.readdirSync(folder).filter((x) => !x.startsWith(".")); } catch (e) { entries = []; }
    if (!entries.length) { menu.addItem((x) => x.setTitle("Пункты не найдены").setDisabled(true)); return; }
    entries.slice(0, 30).forEach((name) => {
      const fullSendTo = nodePath.join(folder, name);
      const label = name.replace(/\.(lnk|url|DeskLink|MAPIMail|mydocs)$/i, "");
      menu.addItem((it) => it.setTitle(label).onClick(() => this.runSendToTarget(fullSendTo, file)));
    });
    menu.addSeparator();
    menu.addItem((it) => it.setTitle("Открыть папку SendTo").setIcon("folder-open").onClick(() => this.openSendToFolder()));
  }

  openSendToFolder() {
    const p = this.sendToFolderPath();
    if (p && electronShell) electronShell.openPath(p);
    else new Notice("Папка SendTo недоступна");
  }

  runSendToTarget(sendToPath, file) {
    if (!childProcess || typeof process === "undefined" || process.platform !== "win32") { new Notice("SendTo доступен только в Windows desktop"); return; }
    const fullFile = this.fullVaultPath(file);
    const cmd = `Start-Process -FilePath ${JSON.stringify(sendToPath)} -ArgumentList @(${JSON.stringify(fullFile)})`;
    childProcess.execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd], { windowsHide: true }, (err) => {
      if (err) { console.error(err); new Notice("Не удалось выполнить SendTo"); }
    });
  }

  pushVaultHistory(label, moves) {
    if (!moves || !moves.length) return;
    this.vaultUndoStack.push({ label, moves: moves.map((m) => ({ oldPath: m.oldPath, newPath: m.newPath })) });
    if (this.vaultUndoStack.length > 50) this.vaultUndoStack.shift();
    this.vaultRedoStack = [];
  }

  async undoVaultOperation() {
    const op = this.vaultUndoStack.pop();
    if (!op) { new Notice("Нет файловых операций для отмены"); return; }
    const reverse = op.moves.slice().reverse().map((m) => ({ oldPath: m.newPath, newPath: m.oldPath }));
    const ok = await this.applyVaultPathMoves(reverse, false, "Отмена: " + op.label);
    if (ok) this.vaultRedoStack.push(op);
  }

  async redoVaultOperation() {
    const op = this.vaultRedoStack.pop();
    if (!op) { new Notice("Нет файловых операций для повтора"); return; }
    const ok = await this.applyVaultPathMoves(op.moves, false, "Повтор: " + op.label);
    if (ok) this.vaultUndoStack.push(op);
  }

  async applyVaultPathMoves(moves, pushHistory, label) {
    const plan = [];
    for (const m of moves) {
      const f = this.app.vault.getAbstractFileByPath(m.oldPath);
      if (!f) { new Notice("Не найдено: " + m.oldPath); return false; }
      plan.push({ file: f, oldPath: m.oldPath, newPath: m.newPath, oldName: f.name, newName: m.newPath.split('/').pop() });
    }
    return await this.applyVaultRenamePlan(plan, { pushHistory, label: label || "Файловая операция" });
  }

  openVaultRenumberModal(action) {
    const target = this.getVaultTarget(true);
    const folder = this.getVaultFolderForAction(target);
    if (!folder) { new Notice("Не удалось определить папку vault"); return; }
    new VaultRenumberModal(this.app, this, folder, action || "renumber").open();
  }

  getVaultChildren(folder, options) {
    const targets = (options && options.targets) || this.settings.vaultNumberingTargets || "both";
    const order = (options && options.order) || this.settings.vaultNumberingOrder || "folders-first";
    let arr = (folder.children || []).filter((x) => {
      if (x instanceof TFolder) return targets === "folders" || targets === "both";
      if (x instanceof TFile) return (targets === "notes" || targets === "both") && x.extension && x.extension.toLowerCase() === "md";
      return false;
    });
    const byName = (a, b) => this.cleanVaultDisplayName(a).localeCompare(this.cleanVaultDisplayName(b), undefined, { numeric: true, sensitivity: "base" });
    arr.sort((a, b) => {
      if (order === "folders-first" && (a instanceof TFolder) !== (b instanceof TFolder)) return a instanceof TFolder ? -1 : 1;
      if (order === "notes-first" && (a instanceof TFolder) !== (b instanceof TFolder)) return a instanceof TFile ? -1 : 1;
      return byName(a, b);
    });
    return arr;
  }

  cleanVaultDisplayName(file) {
    const parsed = splitVaultName(file);
    return stripVaultNumberingPrefix(parsed.base);
  }

  collectVaultRenamePlan(folder, options) {
    const action = options.action || "renumber";
    const styleId = options.style || this.settings.vaultNumberingStyle || "decimal_2_underscore";
    const items = this.getVaultChildren(folder, options);
    const plan = [];
    items.forEach((item, idx) => {
      const parsed = splitVaultName(item);
      const cleanBase = (options.stripOld !== false) ? stripVaultNumberingPrefix(parsed.base) : parsed.base;
      const nextBase = action === "remove" ? cleanBase : makeVaultNumberedBase(cleanBase, idx + 1, styleId, options);
      const nextName = nextBase + parsed.ext;
      if (nextName !== item.name) {
        const parentPath = item.parent && item.parent.path ? item.parent.path : "";
        const newPath = normalizePath(parentPath ? parentPath + "/" + nextName : nextName);
        plan.push({ file: item, oldPath: item.path, newPath, oldName: item.name, newName: nextName });
      }
    });
    return plan;
  }

  validateVaultRenamePlan(plan) {
    const targetSet = new Set();
    const oldSet = new Set(plan.map((p) => p.oldPath));
    for (const p of plan) {
      if (targetSet.has(p.newPath)) return "Два элемента получают один путь: " + p.newPath;
      targetSet.add(p.newPath);
      const exists = this.app.vault.getAbstractFileByPath(p.newPath);
      if (exists && !oldSet.has(p.newPath)) return "Уже существует: " + p.newPath;
    }
    return "";
  }

  async applyVaultRenamePlan(plan, options) {
    options = options || {};
    const err = this.validateVaultRenamePlan(plan);
    if (err) { new Notice(err); return false; }
    if (!plan.length) { new Notice("Нечего менять"); return true; }
    if (this.settings.vaultDryRun) {
      console.log("Structure Commander dry-run", plan.map((p) => [p.oldPath, p.newPath]));
      new Notice("Режим отработки: план выведен в консоль, файлы не изменены");
      return false;
    }
    const tmpPlan = [];
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const parentPath = p.file.parent && p.file.parent.path ? p.file.parent.path : "";
      const tmpName = "__sc_tmp_" + Date.now() + "_" + i + "__" + p.file.name;
      const tmpPath = normalizePath(parentPath ? parentPath + "/" + tmpName : tmpName);
      tmpPlan.push(Object.assign({}, p, { tmpPath }));
    }
    try {
      for (const p of tmpPlan) await this.renameVaultFile(p.file, p.tmpPath);
      for (const p of tmpPlan) {
        const tmpFile = this.app.vault.getAbstractFileByPath(p.tmpPath);
        if (!tmpFile) throw new Error("Временный путь не найден: " + p.tmpPath);
        await this.renameVaultFile(tmpFile, p.newPath);
      }
      if (options.pushHistory !== false) this.pushVaultHistory(options.label || "Файловая операция", plan);
      new Notice((options.label || "Переименовано") + ": " + plan.length);
      return true;
    } catch (e) { console.error(e); new Notice("Ошибка файловой операции. Проверьте vault вручную"); return false; }
  }

  async renameVaultFile(file, newPath) {
    if (this.app.fileManager && typeof this.app.fileManager.renameFile === "function") return await this.app.fileManager.renameFile(file, newPath);
    return await this.app.vault.rename(file, newPath);
  }

  async moveVaultItem(direction) {
    const target = this.getVaultTarget(); if (!target) return;
    const folder = target.parent; if (!folder) { new Notice("Элемент уже в корне или недоступен"); return; }
    const styleId = this.detectVaultOrderStyle(target.name) || this.settings.vaultNumberingStyle || "decimal_2_underscore";
    const style = VAULT_NUMBERING_STYLES.find((x) => x.id === styleId);
    if (!style || !style.orderable) { new Notice("Для этого стиля нельзя менять порядок вверх/вниз"); return; }
    const items = this.getVaultChildren(folder, { targets: "both", order: this.settings.vaultNumberingOrder || "folders-first" });
    const idx = items.findIndex((x) => x.path === target.path);
    const swapIdx = idx + (direction < 0 ? -1 : 1);
    if (idx < 0 || swapIdx < 0 || swapIdx >= items.length) { new Notice(direction < 0 ? "Уже наверху" : "Уже внизу"); return; }
    const reordered = items.slice();
    const tmp = reordered[idx]; reordered[idx] = reordered[swapIdx]; reordered[swapIdx] = tmp;
    const plan = [];
    reordered.forEach((item, i) => {
      const parsed = splitVaultName(item);
      const cleanBase = stripVaultNumberingPrefix(parsed.base);
      const nextBase = makeVaultNumberedBase(cleanBase, i + 1, styleId, this.settings);
      const nextName = nextBase + parsed.ext;
      if (nextName !== item.name) {
        const parentPath = item.parent && item.parent.path ? item.parent.path : "";
        plan.push({ file: item, oldPath: item.path, newPath: normalizePath(parentPath ? parentPath + "/" + nextName : nextName), oldName: item.name, newName: nextName });
      }
    });
    await this.applyVaultRenamePlan(plan, { label: direction < 0 ? "Файл/папка выше" : "Файл/папка ниже" });
  }

  async moveVaultItemOut() {
    const target = this.getVaultTarget(); if (!target) return;
    const parent = target.parent;
    if (!parent || !parent.parent) { new Notice("Уже в корне vault"); return; }
    const newPath = normalizePath((parent.parent.path ? parent.parent.path + "/" : "") + target.name);
    if (this.app.vault.getAbstractFileByPath(newPath)) { new Notice("Уже существует: " + newPath); return; }
    await this.applyVaultRenamePlan([{ file: target, oldPath: target.path, newPath, oldName: target.name, newName: target.name }], { label: "На уровень выше" });
  }

  async moveVaultItemIntoPreviousFolder() {
    const target = this.getVaultTarget(); if (!target) return;
    const parent = target.parent; if (!parent) { new Notice("Нет родительской папки"); return; }
    const siblings = (parent.children || []).slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    const idx = siblings.findIndex((x) => x.path === target.path);
    let prevFolder = null;
    for (let i = idx - 1; i >= 0; i--) if (siblings[i] instanceof TFolder) { prevFolder = siblings[i]; break; }
    if (!prevFolder) { new Notice("Нет предыдущей папки-соседа"); return; }
    if (target instanceof TFolder && (prevFolder.path === target.path || prevFolder.path.startsWith(target.path + "/"))) { new Notice("Нельзя переместить папку внутрь самой себя"); return; }
    const newPath = normalizePath(prevFolder.path + "/" + target.name);
    if (this.app.vault.getAbstractFileByPath(newPath)) { new Notice("Уже существует: " + newPath); return; }
    await this.applyVaultRenamePlan([{ file: target, oldPath: target.path, newPath, oldName: target.name, newName: target.name }], { label: "Внутрь предыдущей папки" });
  }

  detectVaultOrderStyle(name) {
    const base = splitVaultName({ name }).base;
    if (/^\d{3}_/.test(base)) return "decimal_3_underscore";
    if (/^\d{2}_/.test(base)) return "decimal_2_underscore";
    if (/^[A-Z]_/.test(base)) return "latin_upper_underscore";
    if (/^[a-z]_/.test(base)) return "latin_lower_underscore";
    if (/^[А-Я]_/.test(base)) return "cyrillic_upper_underscore";
    if (/^[а-я]_/.test(base)) return "cyrillic_lower_underscore";
    if (/^(?:M|CM|D|CD|C|XC|L|XL|X|IX|V|IV|I)+_/.test(base)) return "roman_upper_underscore";
    if (/^(?:m|cm|d|cd|c|xc|l|xl|x|ix|v|iv|i)+_/.test(base)) return "roman_lower_underscore";
    return "";
  }

  toggleVaultFolder(expand) {
    const target = this.getVaultTarget(true);
    if (!(target instanceof TFolder)) { new Notice("Выберите папку в дереве vault"); return; }
    try {
      const selector = '[data-path="' + target.path.replace(/"/g, '\\"') + '"]';
      const el = document.querySelector(selector);
      const trigger = el && (el.querySelector('.tree-item-icon, .nav-folder-collapse-indicator') || el);
      if (trigger) trigger.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    } catch (e) { console.error(e); }
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
// StructurePanelView — боковая панель с поиском и фильтром.
// Уровень заголовка передаётся ВИЗУАЛЬНО (отступ + жирность + цвет),
// без подписей "H1/H2/...".
// ═══════════════════════════════════════════════════════════════════════════════
class StructurePanelView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.maxLevel = plugin.settings.panelMaxLevel || 6;
    this.search = "";
    this._readToken = 0;
    this.scheduleRender = debounce(() => this.render(), 220, true);
  }

  getViewType() { return STRUCTURE_PANEL_VIEW; }
  getDisplayText() { return "Структура"; }
  getIcon() { return "list-tree"; }

  async onOpen() {
    this.render();
    // Подсветка активной ветки при движении курсора
    this.registerEvent(this.app.workspace.on("editor-change", () => this.scheduleRender()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.scheduleRender()));
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("structure-panel-root");

    const file = this.plugin.getCurrentMarkdownFile();

    // ── header ──
    const header = container.createDiv({ cls: "structure-panel-header" });
    header.createDiv({ cls: "structure-panel-title", text: "Структура" });

    const select = header.createEl("select", { cls: "structure-panel-level-select" });
    [
      ["1", "До H1"],
      ["2", "До H2"],
      ["3", "До H3"],
      ["4", "До H4"],
      ["5", "До H5"],
      ["6", "До H6"],
      ["all", "Все"]
    ].forEach((p) => {
      const o = select.createEl("option");
      o.value = p[0]; o.text = p[1];
      if (
        (p[0] === "all" && this.maxLevel >= 6) ||
        (p[0] !== "all" && Number(p[0]) === this.maxLevel)
      ) o.selected = true;
    });
    select.addEventListener("change", async () => {
      this.maxLevel = (select.value === "all") ? 6 : Number(select.value);
      this.plugin.settings.panelMaxLevel = this.maxLevel;
      await this.plugin.saveSettings();
      this.render();
    });

    const refresh = header.createEl("button", { cls: "structure-panel-icon-btn", text: "↻" });
    refresh.title = "Обновить";
    refresh.addEventListener("click", () => this.render());

    const closeBtn = header.createEl("button", { cls: "structure-panel-icon-btn", text: "×" });
    closeBtn.title = "Скрыть панель";
    closeBtn.addEventListener("click", () => this.plugin.closeStructurePanel());

    // ── search ──
    const searchRow = container.createDiv({ cls: "structure-panel-searchrow" });
    const searchInput = searchRow.createEl("input", { type: "text", cls: "structure-panel-search" });
    searchInput.placeholder = "Поиск по заголовкам";
    searchInput.value = this.search;
    searchInput.addEventListener("input", () => {
      this.search = searchInput.value || "";
      this.renderList();
    });

    if (!file) {
      container.createDiv({ cls: "structure-panel-empty", text: "Откройте Markdown-заметку" });
      return;
    }

    const body = container.createDiv({ cls: "structure-panel-body" });
    body.createDiv({ cls: "structure-panel-file", text: file.name });

    this.bodyEl = body;
    this.fileForRender = file;

    // Защита от race condition — увеличиваем токен и ждём только свой результат.
    const myToken = ++this._readToken;
    this.app.vault.cachedRead(file).then((text) => {
      if (myToken !== this._readToken) return;
      this.allHeadings = parseHeadingsFromLines(String(text || "").split(/\r?\n/));
      this.renderList();
    });
  }

  renderList() {
    if (!this.bodyEl) return;
    const body = this.bodyEl;
    const file = this.fileForRender;
    if (!file || !this.allHeadings) return;

    // Очищаем тело, оставляем строку файла
    const fileLine = body.querySelector(".structure-panel-file");
    body.empty();
    if (fileLine) body.appendChild(fileLine);

    const all = this.allHeadings;
    let filtered = all.filter((h) => h.level <= this.maxLevel);
    const q = this.search.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((h) => h.title.toLowerCase().includes(q));
    }

    // Счётчик
    const counter = body.createDiv({ cls: "structure-panel-counter" });
    counter.setText(filtered.length + " / " + all.length);

    if (filtered.length === 0) {
      body.createDiv({ cls: "structure-panel-empty", text: q ? "Ничего не найдено" : "Нет заголовков" });
      return;
    }

    // Текущий заголовок (для подсветки)
    let activeLine = -1;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view && view.file && view.file.path === file.path && view.editor) {
      const cur = this.plugin.getCurrentHeadingSilently(view.editor);
      if (cur) activeLine = cur.line;
    }

    const list = body.createDiv({ cls: "structure-panel-list" });

    filtered.forEach((h) => {
      const item = list.createDiv({ cls: "structure-panel-item structure-panel-level-" + h.level });
      item.setText(h.title || "(без названия)");
      if (h.line === activeLine) item.addClass("structure-panel-item-active");
      item.title = "Строка " + (h.line + 1);
      item.addEventListener("click", () => this.plugin.jumpToHeading(file, h.line));
      item.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.openItemContextMenu(h, e.clientX, e.clientY);
      });
    });
  }

  openItemContextMenu(heading, x, y) {
    const m = new Menu();
    m.addItem((it) => it.setTitle("Перейти").setIcon("arrow-right-circle")
      .onClick(() => this.plugin.jumpToHeading(this.fileForRender, heading.line)));
    m.addSeparator();
    m.addItem((it) => it.setTitle("Свернуть ветку").onClick(async () => {
      await this.plugin.jumpToHeading(this.fileForRender, heading.line);
      await sleep(30);
      this.plugin.collapseCurrentBranch();
    }));
    m.addItem((it) => it.setTitle("Развернуть ветку").onClick(async () => {
      await this.plugin.jumpToHeading(this.fileForRender, heading.line);
      await sleep(30);
      this.plugin.expandCurrentBranch();
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
      this.plugin.shiftCurrentBranch(-1);
    }));
    m.addItem((it) => it.setTitle("Понизить").onClick(async () => {
      await this.plugin.jumpToHeading(this.fileForRender, heading.line);
      await sleep(30);
      this.plugin.shiftCurrentBranch(1);
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
// VaultRenumberModal — перенумерация заметок и папок vault.
// ═══════════════════════════════════════════════════════════════════════════════
class VaultRenumberModal extends Modal {
  constructor(app, plugin, folder, action) {
    super(app);
    this.plugin = plugin;
    this.folder = folder;
    this.action = action || "renumber";
    this.targets = plugin.settings.vaultNumberingTargets || "both";
    this.order = plugin.settings.vaultNumberingOrder || "folders-first";
    this.style = plugin.settings.vaultNumberingStyle || "decimal_2_underscore";
    this.stripOld = plugin.settings.vaultStripOldNumbering !== false;
    this.customTemplate = plugin.settings.vaultCustomTemplate || "{N}_{title}";
    this.zeroPad = plugin.settings.vaultCustomZeroPad || 2;
    this.marker = plugin.settings.vaultCustomMarker || "•";
  }
  onOpen() {
    const el = this.contentEl;
    el.empty();
    el.addClass("structure-commander-small-modal");
    el.createEl("h2", { text: this.action === "remove" ? "Удалить нумерацию vault" : "Перенумеровать vault" });
    el.createDiv({ cls: "structure-commander-muted", text: "Папка: " + (this.folder.path || "/") });
    this.radioGroup(el, "Что менять", "scmd-vault-targets", [["both","Заметки и папки"],["notes","Только заметки .md"],["folders","Только папки"]], this.targets, (v) => { this.targets = v; this.refreshPreview(); });
    this.radioGroup(el, "Порядок", "scmd-vault-order", [["folders-first","Сначала папки"],["notes-first","Сначала заметки"],["name","По имени"]], this.order, (v) => { this.order = v; this.refreshPreview(); });
    if (this.action !== "remove") {
      new Setting(el).setName("Стиль").setDesc("Для файлов нет точек и скобок. Только безопасные префиксы.").addDropdown((dd) => {
        VAULT_NUMBERING_STYLES.forEach((s) => dd.addOption(s.id, s.label));
        dd.setValue(this.style);
        dd.onChange((v) => { this.style = v; this.refreshCustomVisibility(); this.refreshPreview(); });
      });
      this.customBlock = el.createDiv({ cls: "structure-commander-section" });
      this.customBlock.createEl("h3", { text: "Пользовательский шаблон" });
      new Setting(this.customBlock).setName("Шаблон").setDesc("Обязателен {title}. Для порядка нужен {n}, {N}, {a}, {A}, {ru}, {RU}, {i} или {I}.").addText((t) => t.setValue(this.customTemplate).onChange((v) => { this.customTemplate = v || "{N}_{title}"; this.refreshPreview(); }));
      new Setting(this.customBlock).setName("Разрядность {N}").addText((t) => t.setValue(String(this.zeroPad)).onChange((v) => { this.zeroPad = Math.max(1, Math.min(4, parseInt(v, 10) || 2)); this.refreshPreview(); }));
      new Setting(this.customBlock).setName("Маркер {mark}").addText((t) => t.setValue(this.marker).onChange((v) => { this.marker = v || "•"; this.refreshPreview(); }));
    }
    new Setting(el).setName("Удалять старую служебную нумерацию перед новой").addToggle((tg) => tg.setValue(this.stripOld).onChange((v) => { this.stripOld = v; this.refreshPreview(); }));
    this.previewBox = el.createDiv({ cls: "structure-commander-preview" });
    this.previewBox.createEl("h3", { text: "Предпросмотр" });
    this.previewList = this.previewBox.createDiv({ cls: "structure-preview-list" });
    this.previewCount = this.previewBox.createDiv({ cls: "structure-commander-muted" });
    const btns = el.createDiv({ cls: "structure-modal-buttons" });
    const ok = btns.createEl("button", { text: "Применить" }); ok.addClass("mod-cta"); ok.onclick = () => this.submit();
    btns.createEl("button", { text: "Отмена" }).onclick = () => this.close();
    this.refreshCustomVisibility(); this.refreshPreview();
  }
  radioGroup(parent, title, name, options, selected, onChange) {
    const w = parent.createDiv({ cls: "structure-radio-block" }); w.createDiv({ cls: "structure-radio-title", text: title });
    options.forEach((o) => { const lab = w.createEl("label"); const inp = lab.createEl("input", { type: "radio" }); inp.name = name; inp.value = o[0]; inp.checked = selected === o[0]; inp.onchange = () => onChange(o[0]); lab.createSpan({ text: " " + o[1] }); });
  }
  refreshCustomVisibility() { if (this.customBlock) this.customBlock.style.display = this.style === "custom" ? "block" : "none"; }
  getOptions() { return { action: this.action, targets: this.targets, order: this.order, style: this.style, stripOld: this.stripOld, customTemplate: this.customTemplate, zeroPad: this.zeroPad, marker: this.marker }; }
  refreshPreview() {
    if (!this.previewList) return; this.previewList.empty();
    if (this.style === "custom") { const err = validateVaultCustomTemplate(this.customTemplate); if (err) { this.previewCount.setText(err); return; } }
    const plan = this.plugin.collectVaultRenamePlan(this.folder, this.getOptions());
    const err = this.plugin.validateVaultRenamePlan(plan); if (err) { this.previewCount.setText(err); return; }
    if (!plan.length) { this.previewCount.setText("Нечего менять."); return; }
    plan.slice(0, 10).forEach((p) => { const row = this.previewList.createDiv({ cls: "structure-preview-row" }); row.createDiv({ cls: "structure-preview-before", text: p.oldName }); row.createDiv({ cls: "structure-preview-arrow", text: "→" }); row.createDiv({ cls: "structure-preview-after", text: p.newName }); });
    this.previewCount.setText("Будет изменено: " + plan.length + (plan.length > 10 ? " (показаны первые 10)" : ""));
  }
  async submit() {
    if (this.style === "custom") { const err = validateVaultCustomTemplate(this.customTemplate); if (err) { new Notice(err); return; } }
    const opts = this.getOptions();
    const plan = this.plugin.collectVaultRenamePlan(this.folder, opts);
    const ok = await this.plugin.applyVaultRenamePlan(plan, { label: this.action === "remove" ? "Удаление нумерации vault" : "Нумерация vault" });
    if (ok) {
      this.plugin.settings.vaultNumberingTargets = this.targets; this.plugin.settings.vaultNumberingOrder = this.order; this.plugin.settings.vaultNumberingStyle = this.style; this.plugin.settings.vaultStripOldNumbering = this.stripOld; this.plugin.settings.vaultCustomTemplate = this.customTemplate; this.plugin.settings.vaultCustomZeroPad = this.zeroPad; this.plugin.settings.vaultCustomMarker = this.marker;
      await this.plugin.saveSettings(); this.close();
    }
  }
  onClose() { this.contentEl.empty(); }
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
      .setName("Управление деревом vault хоткеями")
      .setDesc("Если фокус в файловом дереве, Alt+Shift+стрелки работают с файлами и папками.")
      .addToggle((tg) => tg.setValue(this.plugin.settings.vaultOrderEnabled !== false).onChange(async (v) => { this.plugin.settings.vaultOrderEnabled = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Режим отработки файловых операций")
      .setDesc("Показывает план в консоли и не переименовывает файлы.")
      .addToggle((tg) => tg.setValue(!!this.plugin.settings.vaultDryRun).onChange(async (v) => { this.plugin.settings.vaultDryRun = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("Стиль нумерации vault по умолчанию")
      .addDropdown((dd) => { VAULT_NUMBERING_STYLES.forEach((st) => dd.addOption(st.id, st.label)); dd.setValue(this.plugin.settings.vaultNumberingStyle || "decimal_2_underscore"); dd.onChange(async (v) => { this.plugin.settings.vaultNumberingStyle = v; await this.plugin.saveSettings(); }); })
      .addButton((b) => b.setButtonText("Перенумеровать vault…").onClick(() => this.plugin.openVaultRenumberModal("renumber")));

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
      ["Vault: файлы и папки", [
        ["renumber-vault-folder", "Пронумеровать текущую папку vault"],
        ["remove-vault-numbering", "Удалить нумерацию текущей папки vault"],
        ["move-vault-item-up", "Файл/папка выше"],
        ["move-vault-item-down", "Файл/папка ниже"],
        ["promote-vault-item", "Файл/папка на уровень выше"],
        ["demote-vault-item", "Файл/папка внутрь предыдущей папки"],
        ["undo-vault-operation", "Отменить файловую операцию"],
        ["redo-vault-operation", "Повторить файловую операцию"]
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



function splitVaultName(file) {
  const name = String(file && file.name ? file.name : "");
  if (file instanceof TFolder) return { base: name, ext: "" };
  const idx = name.lastIndexOf(".");
  if (idx > 0) return { base: name.slice(0, idx), ext: name.slice(idx) };
  return { base: name, ext: "" };
}
function stripVaultNumberingPrefix(name) {
  let v = String(name || "").trim();
  v = v.replace(/^\d{1,4}_\s*/, "");
  v = v.replace(/^(?:[A-Za-z]|[А-Яа-я])_\s*/, "");
  v = v.replace(/^(?:M|CM|D|CD|C|XC|L|XL|X|IX|V|IV|I|m|cm|d|cd|c|xc|l|xl|x|ix|v|iv|i)+_\s*/, "");
  v = v.replace(/^(?:[-•])\s+/, "");
  return v.trim() || String(name || "").trim();
}
function makeVaultNumberedBase(title, index, styleId, options) {
  title = String(title || "").trim();
  switch (styleId) {
    case "none": return title;
    case "decimal_2_underscore": return String(index).padStart(2, "0") + "_" + title;
    case "decimal_3_underscore": return String(index).padStart(3, "0") + "_" + title;
    case "latin_upper_underscore": return alphaByIndex(index, VAULT_LATIN_UPPER) + "_" + title;
    case "latin_lower_underscore": return alphaByIndex(index, VAULT_LATIN_LOWER) + "_" + title;
    case "cyrillic_upper_underscore": return alphaByIndex(index, VAULT_CYRILLIC_UPPER) + "_" + title;
    case "cyrillic_lower_underscore": return alphaByIndex(index, VAULT_CYRILLIC_LOWER) + "_" + title;
    case "roman_upper_underscore": return toRoman(index).toUpperCase() + "_" + title;
    case "roman_lower_underscore": return toRoman(index).toLowerCase() + "_" + title;
    case "dash_marker": return "- " + title;
    case "bullet_marker": return "• " + title;
    case "custom": return applyVaultCustomTemplate(title, index, options || {});
    default: return String(index).padStart(2, "0") + "_" + title;
  }
}
function alphaByIndex(index, alphabet) {
  let n = index, out = "";
  while (n > 0) { n--; out = alphabet[n % alphabet.length] + out; n = Math.floor(n / alphabet.length); }
  return out;
}
function toRoman(num) {
  const map = [[1000,"M"],[900,"CM"],[500,"D"],[400,"CD"],[100,"C"],[90,"XC"],[50,"L"],[40,"XL"],[10,"X"],[9,"IX"],[5,"V"],[4,"IV"],[1,"I"]];
  let n = Math.max(1, Math.min(3999, Number(num) || 1)); let res = "";
  for (const [v, s] of map) while (n >= v) { res += s; n -= v; }
  return res;
}
function validateVaultCustomTemplate(tpl) {
  tpl = String(tpl || "");
  if (!tpl.includes("{title}")) return "В шаблоне обязателен токен {title}";
  if (/[\\/:*?"<>|]/.test(tpl)) return "Шаблон содержит запрещённые для имени файла символы";
  return "";
}
function applyVaultCustomTemplate(title, index, options) {
  const tpl = String(options.customTemplate || "{N}_{title}");
  const pad = Math.max(1, Math.min(4, Number(options.zeroPad) || 2));
  const marker = String(options.marker || "•");
  return tpl.replaceAll("{title}", title).replaceAll("{n}", String(index)).replaceAll("{N}", String(index).padStart(pad, "0")).replaceAll("{a}", alphaByIndex(index, VAULT_LATIN_LOWER)).replaceAll("{A}", alphaByIndex(index, VAULT_LATIN_UPPER)).replaceAll("{ru}", alphaByIndex(index, VAULT_CYRILLIC_LOWER)).replaceAll("{RU}", alphaByIndex(index, VAULT_CYRILLIC_UPPER)).replaceAll("{i}", toRoman(index).toLowerCase()).replaceAll("{I}", toRoman(index).toUpperCase()).replaceAll("{mark}", marker);
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
