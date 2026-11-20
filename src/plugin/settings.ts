import type { DeckRename } from "../core/collection";
import { App, normalizePath, Notice, PluginSettingTab, requireApiVersion, Setting } from "obsidian";
import type { SettingDefinition, SettingDefinitionGroup, SettingGroup } from "obsidian";
import type { FilteredDeck } from "../core/filtered";
import { DEFAULT_PAD_BINDINGS, PAD_ACTIONS, resolveAction, type PadAction, type PadBindings } from "../core/gamepad";
import { completePreset, DEFAULT_PRESET_ID, defaultPreset, type Preset } from "../core/presets";
import type FlashcardsPlugin from "../main";
import { DeckOptionsModal } from "./modals/deck-options";
import { AI_PROVIDERS, aiKeyId, isProvider, type AiProvider } from "../core/ai-providers";
import { getSecret, setSecret, writeKeyFile } from "./secrets";

export const ACTIONS = {
  showAnswer: "Показать ответ",
  again: "Снова",
  hard: "Трудно",
  good: "Хорошо",
  easy: "Легко",
  undo: "Отменить",
  editCard: "Изменить карточку",
  openNote: "Открыть заметку",
  aiHelper: "ИИ-помощник (боковая панель)",
  mark: "Пометить",
  flag1: "Красный флажок",
  flag2: "Оранжевый флажок",
  flag3: "Зелёный флажок",
  flag4: "Синий флажок",
  flag5: "Розовый флажок",
  flag6: "Бирюзовый флажок",
  flag7: "Фиолетовый флажок",
  toggleMasks: "Переключать маски (скрытие изображений)",
  revealNext: "Открыть следующий ответ (по одному)",
  revealAll: "Открыть или скрыть все ответы (по одному)",
  bury: "Отложить до завтра",
  suspend: "Приостановить карточку",
  setDue: "Задать срок",
  cardInfo: "Информация о карточке",
  deckOptions: "Параметры колоды",
  decks: "К колодам (в Anki: D)",
  browse: "Обзор (в Anki: B)",
  addCard: "Добавить карточку (в Anki: A)",
  stats: "Статистика из списка колод (в Anki: T)",
  filteredDeck: "Создать отфильтрованную колоду из списка колод (в Anki: F)",
  customStudy: "Выборочное изучение из обзора колоды (в Anki: C)",
  close: "Закрыть занятие",
} as const;
export type ActionName = keyof typeof ACTIONS;

/** Anki's review keys (spec 0003 §2). Space/Enter also mean Good once the answer is shown. */
export const DEFAULT_KEYS: Record<ActionName, string[]> = {
  showAnswer: ["Space", "Enter"],
  again: ["1"],
  hard: ["2"],
  good: ["3"],
  easy: ["4"],
  undo: ["Mod+z", "u"],
  editCard: ["e"],
  openNote: ["n"],
  aiHelper: ["h"],
  mark: ["*"],
  flag1: ["Mod+1"],
  flag2: ["Mod+2"],
  flag3: ["Mod+3"],
  flag4: ["Mod+4"],
  flag5: ["Mod+5"],
  flag6: ["Mod+6"],
  flag7: ["Mod+7"],
  toggleMasks: ["t"],
  revealNext: ["n"],
  revealAll: [","],
  bury: ["-"],
  suspend: ["@"],
  setDue: ["Mod+Shift+D"],
  cardInfo: ["i"],
  deckOptions: ["o"],
  decks: ["d"],
  browse: ["b"],
  addCard: ["a"],
  stats: ["t"],
  filteredDeck: ["f"],
  customStudy: ["c"],
  close: ["Escape"],
};

/** What shows for a moment after an answer (review screen). */
export const ANSWER_FEEDBACK = {
  off: "Ничего",
  line: "Тонкая цветная линия",
  dot: "Цветная точка",
  word: "Мелкое слово",
  pill: "Жирная подпись",
} as const;
export type AnswerFeedback = keyof typeof ANSWER_FEEDBACK;

export type CardTheme = "obsidian" | "anki" | "anking" | "paper" | "contrast" | "image";

export const CARD_THEMES: Record<CardTheme, string> = {
  obsidian: "Как в теме Obsidian",
  anki: "Anki Classic",
  anking: "AnKing",
  paper: "Бумага (сепия)",
  contrast: "Высокий контраст",
  image: "Фоновая картинка",
};

export interface HoverSettings {
  sensitivity: "strict" | "all" | "uncommon" | "off";
  onFront: boolean;
  inNotes: boolean;
  useNotes: boolean;
  useMesh: boolean;
}

export type AiModel = "claude-opus-5" | "claude-sonnet-5" | "claude-haiku-4-5";

export interface AiSettings {
  enabled: boolean;
  /** Which service the helpers call. */
  provider: AiProvider;
  /** The Claude model, when the provider is Anthropic. */
  model: AiModel;
  /** The model name for any other provider, as that provider spells it. */
  otherModel: string;
  /** Server address for the "custom" provider, e.g. http://localhost:11434/v1. */
  baseUrl: string;
  /** Folders whose cards are never sent to the API. */
  excludeFolders: string[];
  /** Look at new or edited cards in the background (small batches only). */
  autoRun: boolean;
  /** Keep a copy of the API key in the plugin folder so the owner's other devices pick it up. */
  syncKey: boolean;
}

export interface FlashcardsSettings {
  stateFolder: string;
  cardFolders: string[];
  presets: Record<string, Preset>;
  /** Lower-cased deck path → preset ID. */
  deckPresets: Record<string, string>;
  dayStartHour: number;
  learnAheadMins: number;
  showIntervals: boolean;
  showRemaining: boolean;
  /** The Review Heatmap add-on's year view under the deck list. */
  showHeatmap: boolean;
  /** Reveal a card's answers one at a time (👑) when it asks for at least this many; 0 = off. */
  oneByOneMin: number;
  /** A card answered Again this many times in one day rests until tomorrow; 0 = off (Anki's behaviour). */
  restAfterMisses: number;
  /** Adaptive new cards: hold new cards back while more than `adaptiveNewPile` cards are still in learning today. */
  adaptiveNew: boolean;
  adaptiveNewPile: number;
  /** At startup, check that the vault's pictures are downloaded to this device (iCloud can offload them). */
  checkDownloads: boolean;
  /** Opening this note opens the deck list instead (for a home-screen widget or bookmark); "" = off. */
  homeNote: string;
  /** Cards switched by hand to crowns (true) or away from them (false), by card key. */
  crownOverrides: Record<string, boolean>;
  /** Leeches dealt with on the Leeches screen: card key → its lapses then. */
  leechDone: Record<string, number>;
  /** Filtered decks (spec 0008), including Custom Study's "Своё занятие". */
  filteredDecks: FilteredDeck[];
  /** Decks kept off the deck list and out of "Учить всё" (lower-cased paths); their cards stay. */
  hiddenDecks: string[];
  /** Deck renames (Anki's Rename), applied in order to the names notes give their cards. */
  deckRenames: DeckRename[];
  /** Notes the student linked to a card by hand: card id → note paths (N opens the first). */
  cardNotes: Record<string, string[]>;
  /** Custom Study "увеличить сегодняшний лимит": lower-cased deck → extra cards for one study day. */
  todayExtra: Record<string, { day: number; newExtra: number; reviewExtra: number }>;
  fontSize: number;
  /** Game controller (spec 0010, like Anki's Contanki add-on). */
  gamepad: { enabled: boolean; bindings: PadBindings };
  /** Phone: tap the right side of the back for Good, the left for Again (like AnkiMobile). */
  tapToAnswer: boolean;
  /** How the answer just given (Again, Hard, Good, Easy) shows for a moment, so a key press or tap is seen to register. */
  answerFeedback: AnswerFeedback;
  /** Phone: shake to undo the last answer (like AnkiMobile). */
  shakeToUndo: boolean;
  /** Card theme (the review screen's card area), like Anki's card styling add-ons. */
  cardTheme: CardTheme;
  /** "image" theme: a picture from the vault behind the card, and how much to dim it (0–0.9). */
  cardBackground: string;
  cardBackgroundDim: number;
  /** Exam import (spec 0012): add `weak-area-<source>` to the frontmatter of missed notes. */
  tagExamMisses: boolean;
  keys: Record<ActionName, string[]>;
  hover: HoverSettings;
  ai: AiSettings;
}

export const DEFAULT_SETTINGS: FlashcardsSettings = {
  stateFolder: "Flashcards",
  cardFolders: [],
  presets: { [DEFAULT_PRESET_ID]: defaultPreset() },
  deckPresets: {},
  dayStartHour: 4,
  learnAheadMins: 20,
  showIntervals: true,
  showRemaining: true,
  showHeatmap: true,
  oneByOneMin: 2,
  restAfterMisses: 0,
  adaptiveNew: false,
  adaptiveNewPile: 20,
  checkDownloads: true,
  homeNote: "",
  crownOverrides: {},
  leechDone: {},
  filteredDecks: [],
  hiddenDecks: [],
  deckRenames: [],
  cardNotes: {},
  todayExtra: {},
  fontSize: 20,
  gamepad: { enabled: true, bindings: structuredClone(DEFAULT_PAD_BINDINGS) },
  tapToAnswer: true,
  answerFeedback: "word",
  shakeToUndo: true,
  cardTheme: "obsidian",
  cardBackground: "",
  cardBackgroundDim: 0.6,
  tagExamMisses: true,
  keys: { ...DEFAULT_KEYS },
  hover: { sensitivity: "strict", onFront: false, inNotes: false, useNotes: true, useMesh: true },
  ai: { enabled: false, provider: "anthropic", model: "claude-haiku-4-5", otherModel: "", baseUrl: "", excludeFolders: [], autoRun: true, syncKey: false },
};

/** Load saved settings, filling defaults and upgrading the v0.1 layout. */
export function mergeSettings(saved: Record<string, unknown> | null): FlashcardsSettings {
  const s = (saved ?? {}) as Partial<FlashcardsSettings> & {
    scheduler?: Preset["scheduler"];
    queue?: { newPerDay?: number; reviewsPerDay?: number; dayStartHour?: number; learnAheadMins?: number };
  };
  const presets: Record<string, Preset> = {};
  for (const [id, p] of Object.entries(s.presets ?? {})) presets[id] = completePreset({ ...p, id });
  if (!presets[DEFAULT_PRESET_ID]) {
    // v0.1 kept one set of options at the top level; it becomes the Default preset.
    presets[DEFAULT_PRESET_ID] = completePreset({
      id: DEFAULT_PRESET_ID,
      name: "Default",
      ...(s.queue?.newPerDay !== undefined ? { newPerDay: s.queue.newPerDay } : {}),
      ...(s.queue?.reviewsPerDay !== undefined ? { reviewsPerDay: s.queue.reviewsPerDay } : {}),
      ...(s.scheduler ? { scheduler: s.scheduler } : {}),
    });
  }
  const out: FlashcardsSettings = {
    ...DEFAULT_SETTINGS,
    stateFolder: s.stateFolder ?? DEFAULT_SETTINGS.stateFolder,
    cardFolders: s.cardFolders ?? [],
    presets,
    deckPresets: s.deckPresets ?? {},
    dayStartHour: s.dayStartHour ?? s.queue?.dayStartHour ?? DEFAULT_SETTINGS.dayStartHour,
    learnAheadMins: s.learnAheadMins ?? s.queue?.learnAheadMins ?? DEFAULT_SETTINGS.learnAheadMins,
    showIntervals: s.showIntervals ?? true,
    showRemaining: s.showRemaining ?? true,
    showHeatmap: s.showHeatmap ?? true,
    oneByOneMin: s.oneByOneMin ?? 2,
    restAfterMisses: Number.isInteger(s.restAfterMisses) && s.restAfterMisses! >= 0 ? s.restAfterMisses! : 0,
    adaptiveNew: s.adaptiveNew ?? false,
    adaptiveNewPile: Number.isInteger(s.adaptiveNewPile) && s.adaptiveNewPile! > 0 ? s.adaptiveNewPile! : 20,
    checkDownloads: s.checkDownloads ?? true,
    homeNote: typeof s.homeNote === "string" ? s.homeNote : "",
    crownOverrides: s.crownOverrides ?? {},
    leechDone: s.leechDone ?? {},
    filteredDecks: Array.isArray(s.filteredDecks) ? s.filteredDecks : [],
    cardNotes: s.cardNotes && typeof s.cardNotes === "object" ? (s.cardNotes) : {},
    deckRenames: Array.isArray(s.deckRenames)
      ? s.deckRenames.filter((r): r is DeckRename => !!r && typeof r.from === "string" && typeof r.to === "string" && !!r.from && !!r.to)
      : [],
    hiddenDecks: Array.isArray(s.hiddenDecks) ? s.hiddenDecks.filter((d): d is string => typeof d === "string") : [],
    todayExtra: s.todayExtra ?? {},
    fontSize: s.fontSize ?? 20,
    gamepad: {
      enabled: s.gamepad?.enabled ?? true,
      bindings: s.gamepad?.bindings
        ? (Object.fromEntries((["question", "answer", "review", "decks", "all"] as const).map((c) => [c, s.gamepad!.bindings[c] ?? {}])) as PadBindings)
        : structuredClone(DEFAULT_PAD_BINDINGS),
    },
    tapToAnswer: s.tapToAnswer ?? true,
    answerFeedback: s.answerFeedback && s.answerFeedback in ANSWER_FEEDBACK ? s.answerFeedback : "word",
    shakeToUndo: s.shakeToUndo ?? true,
    cardTheme: s.cardTheme && s.cardTheme in CARD_THEMES ? s.cardTheme : "obsidian",
    cardBackground: s.cardBackground ?? "",
    cardBackgroundDim: s.cardBackgroundDim ?? 0.6,
    tagExamMisses: s.tagExamMisses ?? true,
    keys: withUndoU({ ...DEFAULT_KEYS, ...(s.keys ?? {}) }),
    hover: { ...DEFAULT_SETTINGS.hover, ...(s.hover ?? {}) },
    ai: { ...DEFAULT_SETTINGS.ai, ...(s.ai ?? {}) },
  };
  if (!isProvider(out.ai.provider)) out.ai.provider = "anthropic";
  return out;
}

/** U joined Cmd/Ctrl+Z as Undo in 0.19.0; settings saved before then still say just Mod+z. */
/** Run an async handler when a text box is changed, without handing the event system a promise. */
function onChange(el: HTMLElement, fn: () => Promise<void>): void {
  el.addEventListener("change", () => void fn());
}

function withUndoU(keys: Record<ActionName, string[]>): Record<ActionName, string[]> {
  if (keys.undo.length === 1 && keys.undo[0] === "Mod+z") keys.undo = ["Mod+z", "u"];
  return keys;
}

/** "Mod+z", "Space", "1", "@" from a keyboard event. Shift is implied by printable characters. */
export function keyString(e: KeyboardEvent): string {
  let key = e.key === " " ? "Space" : e.key;
  const printable = key.length === 1;
  if (printable) key = key.toLowerCase();
  let out = "";
  if (e.metaKey || e.ctrlKey) out += "Mod+";
  if (e.altKey) out += "Alt+";
  // With Mod held, keep Shift explicit (Mod+Shift+D); on its own it's implied by the character.
  if (e.shiftKey && (!printable || e.metaKey || e.ctrlKey)) out += "Shift+";
  return out + key;
}

export function normaliseKey(k: string): string {
  const parts = k.trim().split("+");
  const key = parts.pop() ?? "";
  if (!key) return "";
  const mods = parts.map((p) => (/^(cmd|ctrl|meta|mod)$/i.test(p) ? "Mod" : p[0].toUpperCase() + p.slice(1).toLowerCase()));
  const base = key.length === 1 ? key.toLowerCase() : key[0].toUpperCase() + key.slice(1);
  return [...mods, base].join("+");
}

/** Read a setting by its key; a dot reaches into a nested group ("ai.enabled"). */
export function getSettingPath(settings: object, key: string): unknown {
  let at: unknown = settings;
  for (const part of key.split(".")) {
    if (at === null || typeof at !== "object" || !Object.prototype.hasOwnProperty.call(at, part)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

/** Write a setting by its key. A key that isn't a setting is refused, not created (false). */
export function setSettingPath(settings: object, key: string, value: unknown): boolean {
  const parts = key.split(".");
  const last = parts.pop() ?? "";
  const parent = parts.length ? getSettingPath(settings, parts.join(".")) : settings;
  if (parent === null || typeof parent !== "object" || !Object.prototype.hasOwnProperty.call(parent, last)) return false;
  (parent as Record<string, unknown>)[last] = value;
  return true;
}

type Row = SettingDefinition;
/** A headed section of the tab. */
interface Section extends SettingDefinitionGroup {
  type: "group";
  items: Row[];
}

/**
 * The settings tab, as a list of definitions (Obsidian 1.13 draws and searches them). A plain on/off
 * or choice is a `control` bound to its settings key; anything with a side effect, a button or its
 * own layout is a `render` row. Before 1.13, `display()` draws the same list by hand.
 *
 * Obsidian asks for the list once, when the plugin loads, and again only on `update()`; it runs the
 * `render` rows each time the tab opens. So anything that can change (values, status text) is read
 * inside `render`, and a row's name must be unique in its section (Obsidian matches rows by it).
 */
export class FlashcardsSettingTab extends PluginSettingTab {
  /** The theme sample's holder while it is on screen, so the theme rows can redraw it. */
  private sample: HTMLElement | null = null;
  /** Before 1.13: the rows that come and go, so they can be shown and hidden in place. */
  private legacyRows: Array<{ el: HTMLElement; visible: () => boolean }> = [];
  /** Drawn by hand into a window of its own (the Decks page's Settings button), not by Obsidian's settings. */
  private inModal = false;

  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
  ) {
    super(app, plugin);
  }

  hide(): void {
    this.plugin.saveSettingsSoon.run();
    super.hide();
  }

  getControlValue(key: string): unknown {
    return getSettingPath(this.plugin.settings, key);
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (setSettingPath(this.plugin.settings, key, value)) await this.plugin.saveSettings();
  }

  /** Obsidian 1.13+ draws the settings screen itself; a window of our own is always drawn by hand. */
  private native(): boolean {
    return !this.inModal && requireApiVersion("1.13.0");
  }

  /** Draw the whole tab by hand into `el` (the Decks page's settings window). */
  drawInto(el: HTMLElement): void {
    this.inModal = true;
    this.containerEl = el;
    this.drawLegacy();
  }

  /** Draw every row again (for rows whose text depends on what was just changed). */
  private redraw(): void {
    if (this.inModal) return this.drawLegacy();
    if (requireApiVersion("1.13.0")) this.update();
    else this.drawLegacy();
  }

  /** Show or hide the rows that depend on another setting (the background picture rows). */
  private refreshVisible(): void {
    if (this.inModal) return this.toggleLegacyRows();
    if (requireApiVersion("1.13.0")) this.refreshDomState();
    else this.toggleLegacyRows();
  }

  private toggleLegacyRows(): void {
    for (const row of this.legacyRows) row.el.toggle(row.visible());
  }

  private drawSample(): void {
    if (!this.sample) return;
    this.sample.empty();
    renderThemeSample(this.app, this.sample, this.plugin.settings);
  }

  /** Obsidian before 1.13 calls this; newer versions draw from `getSettingDefinitions()` and skip it. */
  display(): void {
    this.drawLegacy();
  }

  private drawLegacy(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.legacyRows = [];
    const draw = (def: Row) => {
      const setting = new Setting(containerEl).setName(def.name);
      if (def.desc) setting.setDesc(def.desc);
      const { visible, control } = def;
      if (typeof visible === "function") {
        this.legacyRows.push({ el: setting.settingEl, visible });
        setting.settingEl.toggle(visible());
      }
      // No row here uses the group argument (setting groups came with 1.11).
      if (def.render) def.render(setting, null as unknown as SettingGroup);
      else if (control?.type === "toggle") {
        setting.addToggle((t) => t.setValue(this.getControlValue(control.key) === true).onChange((v) => void this.setControlValue(control.key, v)));
      } else if (control?.type === "dropdown") {
        setting.addDropdown((d) =>
          d
            .addOptions(control.options)
            .setValue(String(this.getControlValue(control.key)))
            .onChange((v) => void this.setControlValue(control.key, v)),
        );
      }
    };
    for (const item of this.getSettingDefinitions()) {
      if (!("type" in item)) {
        draw(item);
        continue;
      }
      if (item.heading) new Setting(containerEl).setName(item.heading).setHeading();
      item.items.forEach(draw);
    }
  }

  /** Game controller: on/off, a button tester, and the bindings per side (like Contanki). */
  private gamepadRows(save: () => Promise<void>): Row[] {
    const s = this.plugin.settings;
    return [
      {
        name: "Использовать геймпад",
        desc: "Как в дополнении Contanki для Anki (например 8BitDo Micro в режиме геймпада). Кнопки сначала настроены под ваш профиль Anki 8BitDo Micro.",
        control: { type: "toggle", key: "gamepad.enabled" },
      },
      {
        name: "Какая кнопка за что отвечает?",
        desc: "Нажмите «Проверить», затем кнопку на геймпаде, чтобы увидеть её номер.",
        render: (setting) => {
          setting.addButton((b) =>
            b.setButtonText("Test").onClick(() => {
              b.setButtonText("Нажмите кнопку…");
              this.plugin.gamepad.listener = (n) => {
                this.plugin.gamepad.listener = null;
                const dir = { 100: " (влево)", 101: " (вправо)", 102: " (вверх)", 103: " (вниз)" }[n as 100] ?? "";
                b.setButtonText(`Button ${n}${dir}`);
              };
            }),
          );
        },
      },
      {
        name: "Buttons",
        desc: "Что делает каждая кнопка геймпада на стороне вопроса, стороне ответа и в списке колод.",
        render: (setting) => {
          setting.settingEl.addClass("fc-setting-stack");
          const table = setting.settingEl.createEl("table", { cls: "fc-pad-table fc-setting-wide" });
          const draw = () => {
            table.empty();
            const head = table.createEl("tr");
            for (const h of ["Кнопка", "Сторона вопроса", "Сторона ответа", "Список колод"]) head.createEl("th", { text: h });
            const b = s.gamepad.bindings;
            const buttons = new Set<number>();
            for (const ctx of ["question", "answer", "review", "decks", "all"] as const) for (const k of Object.keys(b[ctx])) buttons.add(Number(k));
            for (const n of [...buttons].sort((x, y) => x - y)) {
              const tr = table.createEl("tr");
              const dir = { 100: " ←", 101: " →", 102: " ↑", 103: " ↓" }[n as 100] ?? "";
              tr.createEl("td", { text: `${n}${dir}` });
              for (const ctx of ["question", "answer", "decks"] as const) {
                const sel = tr.createEl("td").createEl("select", { cls: "dropdown" });
                sel.createEl("option", { text: "—", value: "" });
                for (const [k, label] of Object.entries(PAD_ACTIONS)) sel.createEl("option", { text: label, value: k });
                sel.value = resolveAction(b, n, ctx === "decks" ? "decks" : ctx);
                sel.onchange = async () => {
                  b[ctx][String(n)] = sel.value as PadAction;
                  await save();
                };
              }
            }
          };
          draw();
          setting
            .addButton((btn) =>
              btn.setButtonText("Добавить кнопку").onClick(() => {
                btn.setButtonText("Нажмите её на геймпаде…");
                this.plugin.gamepad.listener = async (n) => {
                  this.plugin.gamepad.listener = null;
                  s.gamepad.bindings.all[String(n)] ??= "";
                  await save();
                  btn.setButtonText("Добавить кнопку");
                  draw();
                };
              }),
            )
            .addButton((btn) =>
              btn.setButtonText("Вернуть мой профиль 8BitDo Micro").onClick(async () => {
                s.gamepad.bindings = structuredClone(DEFAULT_PAD_BINDINGS);
                await save();
                draw();
              }),
            );
          // Drawing the row again only clears its controls, so take the table away with it.
          return () => table.remove();
        },
      },
    ];
  }

  /** Card theme dropdown with a live sample card (and the background picture options). */
  private themeRows(save: () => Promise<void>): Row[] {
    const s = this.plugin.settings;
    const picture = () => s.cardTheme === "image";
    return [
      {
        name: "Тема карточек",
        desc: "Как выглядят карточки во время занятия. Образец ниже обновляется сразу же.",
        render: (setting) => {
          setting.addDropdown((d) => {
            for (const [k, label] of Object.entries(CARD_THEMES)) d.addOption(k, label);
            d.setValue(s.cardTheme).onChange(async (v) => {
              s.cardTheme = v as CardTheme;
              await save();
              this.refreshVisible();
              this.drawSample();
            });
          });
        },
      },
      {
        name: "Фоновое изображение",
        desc: "Картинка из хранилища, например Attachments/Background.jpg",
        visible: picture,
        render: (setting) => {
          setting.addText((t) =>
            t.setValue(s.cardBackground).onChange(async (v) => {
              s.cardBackground = v.trim().replace(/^!?\[\[|\]\]$/g, "");
              await save();
              this.drawSample();
            }),
          );
        },
      },
      {
        name: "Затемнить картинку",
        desc: "Затемнение сохраняет читаемость текста.",
        visible: picture,
        render: (setting) => {
          // Obsidian 1.13 shows the value beside the slider; before that it is written out here.
          const shown = this.native() ? null : setting.controlEl.createSpan({ text: String(s.cardBackgroundDim) });
          setting.addSlider((sl) =>
            sl
              .setLimits(0, 0.9, 0.05)
              .setValue(s.cardBackgroundDim)
              .onChange(async (v) => {
                s.cardBackgroundDim = v;
                shown?.setText(String(v));
                await save();
                this.drawSample();
              }),
          );
        },
      },
      {
        name: "Пример карточки",
        searchable: false,
        render: (setting) => {
          setting.settingEl.addClass("fc-setting-stack");
          const holder = setting.settingEl.createDiv({ cls: "fc-setting-wide" });
          this.sample = holder;
          this.drawSample();
          return () => {
            holder.remove();
            if (this.sample === holder) this.sample = null;
          };
        },
      },
    ];
  }

  getSettingDefinitions(): Array<Row | Section> {
    const s = this.plugin.settings;
    const save = async () => this.plugin.saveSettings();
    const keyId = () => aiKeyId(s.ai.provider);
    const folders = (v: string) => v.split(",").map((x) => x.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean);

    const toggle = (name: string, desc: string, key: string): Row => ({ name, desc: desc || undefined, control: { type: "toggle", key } });
    const num = (name: string, desc: string, get: () => number, set: (v: number) => void, valid: (v: number) => boolean): Row => ({
      name,
      desc: desc || undefined,
      render: (setting) => {
        setting.addText((t) =>
          t.setValue(String(get())).onChange((v) => {
            if (v.trim() === "") return;
            const n = Number(v);
            if (!Number.isFinite(n) || !valid(n)) return;
            set(n);
            this.plugin.saveSettingsSoon();
          }),
        );
      },
    });

    const decks: Section = {
      type: "group",
      heading: "Колоды",
      items: [
        {
          name: "Presets",
          desc:
            "Дневные лимиты, шаги изучения, желаемое удержание и другое живут в пресетах, как в Anki. " +
            "Параметры колоды открываются по иконке шестерёнки в списке колод; здесь редактируется пресет Default.",
          render: (setting) => {
            setting.addButton((b) => b.setButtonText("Изменить пресет Default").onClick(() => new DeckOptionsModal(this.app, this.plugin, null).open()));
          },
        },
      ],
    };

    const cards: Section = {
      type: "group",
      heading: "Карточки",
      items: [
        // Folder settings re-scan the vault, so they apply when the field loses focus, not per keystroke.
        {
          name: "Папки карточек",
          desc: "Заметки с тегом #flashcards сканируются всегда. Также сканировать каждую заметку в этих папках (через запятую).",
          render: (setting) => {
            setting.addText((t) => {
              t.setValue(s.cardFolders.join(", "));
              onChange(t.inputEl, async () => {
                s.cardFolders = folders(t.getValue());
                await this.plugin.applyFolderSettings();
              });
            });
          },
        },
        {
          name: "Папка данных занятия",
          desc:
            "Где хранится история повторений (подпапка на каждое устройство). Не должно начинаться с точки, чтобы синхронизироваться. " +
            "Смена папки не переносит существующую историю: сначала перенесите старую папку в проводнике файлов.",
          render: (setting) => {
            setting.addText((t) => {
              t.setValue(s.stateFolder);
              onChange(t.inputEl, async () => {
                const folder = t.getValue().trim().replace(/^\/+|\/+$/g, "");
                if (!folder || folder.startsWith(".")) {
                  new Notice("Папка данных повторений не может быть пустой или начинаться с точки.");
                  t.setValue(s.stateFolder);
                  return;
                }
                if (folder === s.stateFolder) return;
                const old = s.stateFolder;
                s.stateFolder = folder;
                await this.plugin.applyFolderSettings();
                if (this.app.vault.getAbstractFileByPath(`${old}/reviews`)) {
                  new Notice(`История повторений в «${old}/reviews» больше не читается. Переместите её в «${folder}/», чтобы сохранить.`, 10000);
                }
              });
            });
          },
        },
        toggle("Помечать пропущенные темы экзаменов", "При импорте результатов экзаменов тег weak-area-nbme (или -cms, -amboss…) добавляется к заметкам с пропущенными темами.", "tagExamMisses"),
      ],
    };

    const review: Section = {
      type: "group",
      heading: "Повторение",
      items: [
        toggle("Показывать интервалы на кнопках", "", "showIntervals"),
        toggle("Показывать оставшееся число карточек", "", "showRemaining"),
        toggle("Показывать тепловую карту повторений под списком колод", "Как дополнение Review Heatmap для Anki. Полные графики — в разделе «Статистика».", "showHeatmap"),
        num(
          "Открывать ответы по одному (🦴)",
          "Когда карточка требует хотя бы столько ответов, оборот прячет каждый из них за 🦴 (список отдельными строками внутри одного cloze считается несколькими ответами). N открывает следующий, клик — тот же, запятая — все. 0 выключает. Костяная кнопка над карточкой включает это только для неё.",
          () => s.oneByOneMin,
          (v) => (s.oneByOneMin = v),
          (v) => Number.isInteger(v) && v >= 0,
        ),
        toggle(
          "Адаптивные новые карточки",
          "Придерживает новые карточки, пока вы дорабатываете много карточек в изучении сегодня, и возвращает их по мере разбора. Выкл.: новые карточки подчиняются только дневному лимиту своей колоды, как в Anki.",
          "adaptiveNew",
        ),
        num(
          "Адаптивные новые: ставить на паузу, если карточек в изучении больше этого числа",
          "Используется только при включённой опции «Адаптивные новые карточки». По умолчанию: 20.",
          () => s.adaptiveNewPile,
          (v) => (s.adaptiveNewPile = v),
          (v) => Number.isInteger(v) && v > 0,
        ),
        num(
          "Уводить карточку на отдых после стольких промахов за день",
          "После стольких ответов «Снова» за день карточка уходит до завтра вместо повторения и попадает в «Слабые места» в списке колод. 0 — выключить (в Anki повторяется без конца).",
          () => s.restAfterMisses,
          (v) => (s.restAfterMisses = v),
          (v) => Number.isInteger(v) && v >= 0,
        ),
        toggle(
          "Предупреждать, если картинки не скачаны",
          "При запуске Osteon читает несколько картинок, чтобы проверить, что они на этом устройстве. iCloud может выгрузить их с телефона, из-за чего карточки и заметки с картинками подвисают.",
          "checkDownloads",
        ),
        {
          name: "Заметка-ярлык",
          desc: "Открытие этой заметки вместо этого открывает список колод. Добавьте её в закладки или нацельте виджет Obsidian на домашнем экране на неё, чтобы попадать к карточкам в одно касание. Укажите путь вида «Flashcards.md»; оставьте пустым, чтобы отключить (так стоит сделать, чтобы править саму заметку).",
          render: (setting) => {
            setting
              .addText((t) =>
                t
                  .setPlaceholder("Flashcards.md")
                  .setValue(s.homeNote)
                  .onChange(async (v) => {
                    s.homeNote = v.trim();
                    await save();
                  }),
              )
              .addButton((b) =>
                b.setButtonText("Создать заметку").onClick(async () => {
                  const path = normalizePath(/\.md$/i.test(s.homeNote) ? s.homeNote : `${s.homeNote || "Flashcards"}.md`);
                  s.homeNote = path;
                  await save();
                  if (!this.app.vault.getAbstractFileByPath(path)) {
                    await this.app.vault.create(path, "Эта заметка — ярлык: открытие показывает список колод Osteon.\nОтменить это можно в Настройки → Osteon → Заметка-ярлык.\n");
                  }
                  new Notice(`Заметка-ярлык: ${path}`);
                  this.redraw();
                }),
              );
          },
        },
        num("Размер шрифта карточек (px)", "", () => s.fontSize, (v) => (s.fontSize = v), (v) => v >= 10 && v <= 48),
        ...this.themeRows(save),
      ],
    };

    // The phone and timing rows have always followed the controller's, under its heading.
    const controller: Section = {
      type: "group",
      heading: "Геймпад",
      items: [
        ...this.gamepadRows(save),
        toggle(
          "Отвечать касанием (телефон)",
          "На стороне ответа правая треть экрана значит «Хорошо», левая треть — «Снова», как в AnkiMobile. На карточках с показом по одному правая часть сначала открывает следующий ответ.",
          "tapToAnswer",
        ),
        {
          name: "Показывать, какой ответ дан",
          desc: "После каждого ответа короткий знак над кнопками подтверждает, что нажатие или касание зарегистрировано, и показывает, каким ответ он был (красный — «Снова», серый — «Трудно», зелёный — «Хорошо», синий — «Легко»).",
          control: { type: "dropdown", key: "answerFeedback", options: ANSWER_FEEDBACK },
        },
        toggle("Встряхнуть для отмены (телефон)", "Встряхните телефон, чтобы отменить последний ответ, как в AnkiMobile. iOS при первом запуске запросит доступ к датчикам движения.", "shakeToUndo"),
        num("Следующий день начинается в (час)", "В Anki по умолчанию: 4 (4 утра)", () => s.dayStartHour, (v) => (s.dayStartHour = v), (v) => Number.isInteger(v) && v >= 0 && v <= 23),
        num("Предел изучения вперёд (минуты)", "В Anki по умолчанию: 20", () => s.learnAheadMins, (v) => (s.learnAheadMins = v), (v) => v >= 0),
      ],
    };

    const keys: Section = {
      type: "group",
      heading: "Клавиши занятия",
      items: [
        { name: "Несколько клавиш разделяйте запятыми", desc: "Примеры: 1, Space, Enter, Mod+z (Cmd или Ctrl), Mod+Shift+D, Escape." },
        ...(Object.keys(ACTIONS) as ActionName[]).map(
          (action): Row => ({
            name: ACTIONS[action],
            render: (setting) => {
              setting.addText((t) =>
                t
                  .setPlaceholder(DEFAULT_KEYS[action].join(", "))
                  .setValue(s.keys[action].join(", "))
                  .onChange((v) => {
                    s.keys[action] = v.split(",").map(normaliseKey).filter(Boolean);
                    this.plugin.saveSettingsSoon();
                  }),
              );
            },
          }),
        ),
        {
          name: "Сбросить клавиши к значениям Anki",
          render: (setting) => {
            setting.addButton((b) =>
              b.setButtonText("Сбросить").onClick(async () => {
                s.keys = { ...DEFAULT_KEYS };
                await save();
                this.redraw();
              }),
            );
          },
        },
      ],
    };

    const meshDesc = "Медицинский словарь Национальной библиотеки медицины США, бесплатен с указанием источника. Скачивается один раз на устройство (около 30 МБ) и хранится на устройстве, а не в хранилище.";
    const hover: Section = {
      type: "group",
      heading: "Подсказки медицинских терминов",
      items: [
        {
          name: "Подчёркивать термины",
          desc: "Термины на карточке подчёркиваются; наведите курсор (Mac) или коснитесь (iPhone), чтобы увидеть определение. Режим «Только сложные термины» работает как в AMBOSS: простые слова вроде pelvis или fracture не подчёркиваются. Заголовки ваших заметок подчёркиваются всегда.",
          render: (setting) => {
            setting.addDropdown((d) =>
              d
                .addOption("strict", "Только сложные термины (как в AMBOSS)")
                .addOption("uncommon", "Редкие слова")
                .addOption("all", "Все медицинские термины")
                .addOption("off", "Выкл.")
                .setValue(s.hover.sensitivity)
                .onChange(async (v) => {
                  s.hover.sensitivity = v as typeof s.hover.sensitivity;
                  await save();
                  this.plugin.terms.rebuildSoon();
                }),
            );
          },
        },
        toggle("Также на лицевой стороне карточек", "По умолчанию выключено: определение может подсказать ответ.", "hover.onFront"),
        toggle("Также в заметках (режим чтения)", "", "hover.inNotes"),
        {
          name: "Использовать мои заметки",
          desc: "Заметка, чей заголовок или псевдоним совпадает с термином, даёт определение (первый абзац и картинки).",
          render: (setting) => {
            setting.addToggle((t) =>
              t.setValue(s.hover.useNotes).onChange(async (v) => {
                s.hover.useNotes = v;
                await save();
                this.plugin.terms.rebuildSoon();
              }),
            );
          },
        },
        {
          name: "Список «Мои термины»",
          desc: "Ваши собственные определения и список слов без подчёркивания.",
          render: (setting) => {
            setting.setDesc(`Ваши собственные определения и список слов без подчёркивания: ${s.stateFolder}/glossary/My terms.md`).addButton((b) => b.setButtonText("Открыть").onClick(() => void this.plugin.terms.openMyTerms()));
          },
        },
        {
          name: "Словарь MeSH",
          desc: meshDesc,
          render: (setting) => {
            setting
              .setDesc(`${meshDesc} ${this.plugin.terms.meshStatus()}`)
              .addToggle((t) =>
                t.setValue(s.hover.useMesh).onChange(async (v) => {
                  s.hover.useMesh = v;
                  await save();
                  this.plugin.terms.rebuildSoon();
                }),
              )
              .addButton((b) =>
                b.setButtonText(this.plugin.terms.hasMesh() ? "Обновить" : "Скачать").onClick(async () => {
                  b.setDisabled(true);
                  await this.plugin.terms.downloadMesh();
                  this.redraw();
                }),
              );
          },
        },
      ],
    };

    const modelDesc = "Название модели точно как у вашего провайдера. Для определений терминов хватает небольшой недорогой модели.";
    const ai: Section = {
      type: "group",
      heading: "ИИ-помощники",
      items: [
        {
          name: "Optional",
          desc:
            "Используется ваш собственный ключ API от выбранного провайдера (оплачивается ему) или модель на вашем же компьютере. " +
            "Когда включено, текст карточек отправляется выбранному провайдеру, чтобы находить сложные термины и составлять краткие определения (кэш хранится в хранилище, " +
            "чтобы каждую карточку смотрели один раз), объяснять карточки, которые вы постоянно забываете, и предлагать разбиения перегруженных карточек.",
        },
        {
          name: "Provider",
          desc: "У каждого провайдера свой ключ. «Другой» работает с любым сервисом, принимающим запросы в формате OpenAI, включая Ollama и LM Studio.",
          render: (setting) => {
            setting.addDropdown((d) => {
              for (const [id, p] of Object.entries(AI_PROVIDERS)) d.addOption(id, p.label);
              d.setValue(s.ai.provider).onChange(async (v) => {
                s.ai.provider = v as AiProvider;
                if (!s.ai.otherModel.trim()) s.ai.otherModel = AI_PROVIDERS[s.ai.provider].model ?? "";
                await save();
                if (s.ai.syncKey) await writeKeyFile(this.app, this.plugin.manifest.dir ?? "", getSecret(this.app, keyId()));
                // The key, server and model rows all follow the provider.
                this.redraw();
              });
            });
          },
        },
        {
          name: "Адрес сервера",
          desc: "Базовый адрес сервиса, например http://localhost:11434/v1 для Ollama.",
          visible: () => s.ai.provider === "custom",
          render: (setting) => {
            setting.addText((t) => {
              t.setPlaceholder("https://…/v1").setValue(s.ai.baseUrl);
              onChange(t.inputEl, async () => {
                s.ai.baseUrl = t.getValue().trim();
                await save();
              });
            });
          },
        },
        {
          name: "Ключ API",
          desc: "Хранится только на этом устройстве и никогда в хранилище, если не включена опция «Синхронизировать ключ с моими другими устройствами» ниже.",
          render: (setting) => {
            setting.addText((t) => {
              t.inputEl.type = "password";
              const placeholder = () => (getSecret(this.app, keyId()) ? "•••••••• (сохранено)" : AI_PROVIDERS[s.ai.provider].keyHint);
              t.setPlaceholder(placeholder());
              t.inputEl.addEventListener("change", () => {
                setSecret(this.app, keyId(), t.getValue().trim());
                t.setValue("");
                t.setPlaceholder(placeholder());
                const key = getSecret(this.app, keyId());
                if (s.ai.syncKey) void writeKeyFile(this.app, this.plugin.manifest.dir ?? "", key);
                new Notice(key ? (s.ai.syncKey ? "Ключ API сохранён и синхронизирован с вашими другими устройствами." : "Ключ API сохранён на этом устройстве.") : "Ключ API удалён.");
              });
            });
          },
        },
        {
          name: "Синхронизировать ключ с моими другими устройствами",
          desc:
            "Хранит копию ключа в файле в папке плагина хранилища, чтобы телефон или второй компьютер подхватили его без ввода. " +
            "Тот, кто получит копию скрытой папки настроек хранилища, получит и ключ, так что для общего хранилища держите выключенным. Выключение удаляет файл.",
          render: (setting) => {
            setting.addToggle((t) =>
              t.setValue(s.ai.syncKey).onChange(async (v) => {
                s.ai.syncKey = v;
                await save();
                await writeKeyFile(this.app, this.plugin.manifest.dir ?? "", v ? getSecret(this.app, keyId()) : "");
                if (v && !getSecret(this.app, keyId())) new Notice("Введите ключ на этом устройстве или подождите, пока он придёт с другого.");
              }),
            );
          },
        },
        toggle("Использовать ИИ", "", "ai.enabled"),
        {
          name: "Модель",
          desc: "Opus 5 — самый способный; Haiku 4.5 обходится примерно в пять раз дешевле.",
          visible: () => s.ai.provider === "anthropic",
          control: {
            type: "dropdown",
            key: "ai.model",
            options: { "claude-opus-5": "Claude Opus 5", "claude-sonnet-5": "Claude Sonnet 5", "claude-haiku-4-5": "Claude Haiku 4.5" } satisfies Record<AiModel, string>,
          },
        },
        {
          name: "Модель",
          desc: modelDesc,
          visible: () => s.ai.provider !== "anthropic",
          render: (setting) => {
            if (!s.ai.otherModel.trim()) setting.setDesc(`Нужно, чтобы ИИ-помощники работали. ${modelDesc}`);
            setting.addText((t) => {
              t.setPlaceholder("Название модели").setValue(s.ai.otherModel);
              onChange(t.inputEl, async () => {
                s.ai.otherModel = t.getValue().trim();
                await save();
              });
            });
          },
        },
        {
          name: "Никогда не отправлять карточки из этих папок",
          desc: "Перечислите папки через запятую.",
          render: (setting) => {
            setting.addText((t) => {
              t.setValue(s.ai.excludeFolders.join(", "));
              onChange(t.inputEl, async () => {
                s.ai.excludeFolders = folders(t.getValue());
                await save();
              });
            });
          },
        },
        toggle("Показывать новые карточки автоматически", "Небольшими партиями (до 30 карточек), пока Obsidian открыт. Для больших прогонов всегда запрашивается подтверждение.", "ai.autoRun"),
        {
          name: "Найти сложные термины сейчас",
          render: (setting) => {
            setting.setDesc(this.plugin.ai.statusText()).addButton((b) => b.setButtonText("Запустить").onClick(() => void this.plugin.ai.runWithConfirm()));
          },
        },
      ],
    };

    return [decks, cards, review, controller, keys, hover, ai, { name: "Установленная версия", desc: this.plugin.manifest.version, searchable: false }];
  }
}

/** Apply a card theme to the review screen's card element (class + background picture). */
export function applyCardTheme(app: App, root: HTMLElement, card: HTMLElement, s: FlashcardsSettings): void {
  for (const k of Object.keys(CARD_THEMES)) root.removeClass(`fc-theme-${k}`);
  root.addClass(`fc-theme-${s.cardTheme}`);
  card.setCssStyles({ backgroundImage: "" });
  if (s.cardTheme !== "image" || !s.cardBackground) return;
  const file = app.metadataCache.getFirstLinkpathDest(s.cardBackground, "") ?? app.vault.getFileByPath(s.cardBackground);
  if (!file) return;
  const dim = Math.min(0.9, Math.max(0, s.cardBackgroundDim));
  card.style.backgroundImage = `linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), url("${app.vault.getResourcePath(file)}")`;
}

/** A small sample card (front and back) in the chosen theme, for the settings tab. */
export function renderThemeSample(app: App, el: HTMLElement, s: FlashcardsSettings): void {
  const root = el.createDiv({ cls: "fc-review fc-theme-sample" });
  const card = root.createDiv({ cls: "fc-card" });
  card.style.fontSize = `${Math.round(s.fontSize * 0.85)}px`;
  const q = card.createDiv({ cls: "fc-question markdown-rendered" });
  q.appendText("Собственная связка ACL начинается на ");
  q.createSpan({ cls: "fc-cloze", text: "[...]" });
  q.appendText(".");
  card.createEl("hr", { cls: "fc-answer-rule" });
  const a = card.createDiv({ cls: "fc-question markdown-rendered" });
  a.appendText("Собственная связка ACL начинается на ");
  a.createEl("mark", { text: "латеральном мыщелке бедренной кости" });
  a.appendText(".");
  card.createDiv({ cls: "fc-extra", text: "Задняя часть стенки межмыщелковой вырезки, позади гребня головки бедра (resident's ridge)." });
  applyCardTheme(app, root, card, s);
}
