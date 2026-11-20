/** Anki's deck options screen, with presets shared between decks (spec 0003 §4). */
import { App, Modal, Notice, Setting } from "obsidian";
import { DEFAULT_PRESET_ID, defaultPreset, newPresetId, presetIdFor, type Preset } from "../../core/presets";
import { MIN_REVIEWS_TO_OPTIMIZE, optimize, sequencesFrom } from "../../core/optimizer";
import { parseSteps } from "../../core/scheduler";
import type FlashcardsPlugin from "../../main";
import { destructive } from "../compat";

export class DeckOptionsModal extends Modal {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    /** The deck whose options are shown, or null to edit the Default preset. */
    private deck: string | null,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  onClose(): void {
    this.plugin.saveSettingsSoon.run();
    this.contentEl.empty();
  }

  /**
   * Anki's "Optimize" (spec 0013): fit FSRS parameters to the review history of every card that
   * uses this preset, show how much better they predict it, and apply them on request.
   */
  private optimizeRow(contentEl: HTMLElement, p: Preset, presetId: string): void {
    const s = this.plugin.settings;
    const histories: Array<ReadonlyArray<{ ts: string; rating: string }>> = [];
    for (const i of this.plugin.items(null)) {
      if (!i.state?.reviews.length) continue;
      if (presetIdFor(i.ref.deck, s.deckPresets, s.presets) !== presetId) continue;
      histories.push(i.state.reviews);
    }
    const seqs = sequencesFrom(histories, s.dayStartHour);
    const usable = seqs.reduce((n, q) => n + q.filter((x, k) => k > 0 && x.t > 0).length, 0);
    const row = new Setting(contentEl)
      .setName("Оптимизировать параметры FSRS")
      .setDesc(
        usable >= MIN_REVIEWS_TO_OPTIMIZE
          ? `Подобрать параметры по истории самого пресета (${usable.toLocaleString()} интервальных повторений по ${seqs.length.toLocaleString()} карточкам). Занимает несколько секунд.`
          : `Нужно не меньше ${MIN_REVIEWS_TO_OPTIMIZE} интервальных повторений в этом пресете; сейчас ${usable.toLocaleString()}. Пока оставьте значения по умолчанию.`,
      );
    if (usable < MIN_REVIEWS_TO_OPTIMIZE) return;
    const out = contentEl.createDiv({ cls: "fc-muted fc-optimize-result" });
    row.addButton((b) =>
      b.setButtonText("Оптимизировать").onClick(async () => {
        b.setDisabled(true);
        out.empty();
        const notice = new Notice("Оптимизация параметров FSRS… 0%", 0);
        let lastYield = performance.now();
        try {
          const res = await optimize(seqs, p.scheduler.weights.length >= 21 ? p.scheduler.weights : undefined, {
            // Yield to the UI about every 150 ms of work, not every iteration: a hidden window's
            // timers are throttled to a second or more, which made per-iteration yields crawl.
            progress: (f) => {
              if (performance.now() - lastYield < 150) return;
              notice.setMessage(`Подбор параметров FSRS… ${Math.round(f * 100)}%`);
              return new Promise<void>((r) => window.setTimeout(() => ((lastYield = performance.now()), r()), 0));
            },
          });
          notice.hide();
          const better = ((1 - res.lossAfter / res.lossBefore) * 100).toFixed(1);
          out.createDiv({
            text:
              res.lossAfter < res.lossBefore - 1e-4
                ? `Логарифмическая потеря (log loss): ${res.lossBefore.toFixed(4)} → ${res.lossAfter.toFixed(4)} (качество выше на ${better}% по ${res.reviews.toLocaleString()} повторениям).`
                : `Текущие параметры уже соответствуют этой истории (логарифмическая потеря: ${res.lossBefore.toFixed(4)}). Менять нечего.`,
          });
          if (res.lossAfter >= res.lossBefore - 1e-4) return;
          out.createEl("code", { text: res.weights.join(", "), cls: "fc-fsrs-params" });
          new Setting(out)
            .setDesc("Их применение пересчитывает каждую карточку этого пресета по её истории, поэтому даты к сроку сдвигаются (как при смене опций FSRS в Anki).")
            .addButton((u) =>
              u.setButtonText("Применить эти параметры").setCta().onClick(async () => {
                p.scheduler.weights = res.weights;
                await this.plugin.saveSettings();
                new Notice("Новые параметры FSRS сохранены для этого пресета.");
                this.render();
              }),
            );
        } catch (e) {
          notice.hide();
          console.error("Flashcards: FSRS optimization failed", e);
          out.setText("Оптимизация не удалась; смотрите консоль разработчика.");
        } finally {
          b.setDisabled(false);
        }
      }),
    );
  }

  private render(): void {
    const { contentEl } = this;
    const s = this.plugin.settings;
    contentEl.empty();
    this.setTitle(this.deck ? `Настройки: ${this.deck.split("/").join(" › ")}` : "Пресет по умолчанию");
    const presetId = this.deck ? presetIdFor(this.deck, s.deckPresets, s.presets) : DEFAULT_PRESET_ID;
    const p = s.presets[presetId];
    const save = () => this.plugin.saveSettings();

    if (this.deck) {
      const deck = this.deck;
      new Setting(contentEl)
        .setName("Скрыть эту колоду")
        .setDesc("Убирает колоду из списка колод и из «Учить всё». Карточки и история сохраняются; Обзор по-прежнему находит карточки.")
        .addToggle((t) => t.setValue(this.plugin.isDeckHidden(deck)).onChange((v) => void this.plugin.setDeckHidden(deck, v)));
      const deckKey = this.deck.toLowerCase();
      const own = s.deckPresets[deckKey];
      const users = Object.keys(s.deckPresets).filter((d) => s.deckPresets[d] === presetId).length;
      new Setting(contentEl)
        .setName("Профиль настроек")
        .setDesc(
          own
            ? `Используется ${users} колод${users === 1 ? "ой" : "ами"}. Изменения применяются ко всем.`
            : "Наследуется от родительской колоды (или профиля по умолчанию). Выбор профиля здесь переопределяет его для этой колоды и её подколод.",
        )
        .addDropdown((d) => {
          for (const x of Object.values(s.presets)) d.addOption(x.id, x.name);
          d.setValue(presetId).onChange(async (v) => {
            s.deckPresets[deckKey] = v;
            await save();
            this.render();
          });
        })
        .addButton((b) =>
          b.setButtonText("Сохранить во все подколоды").onClick(async () => {
            // Anki's "Сохранить для всех вложенных колод": sub-decks drop their own presets and use this one.
            let n = 0;
            for (const d of Object.keys(s.deckPresets)) {
              if (d.startsWith(deckKey + "/")) {
                delete s.deckPresets[d];
                n++;
              }
            }
            s.deckPresets[deckKey] = presetId;
            await save();
            new Notice(n === 1 ? "Теперь его использует 1 вложенная колода." : `Теперь его используют ${n} вложенных колод.` );
            this.render();
          }),
        )
        .addButton((b) =>
          b.setButtonText("Добавить пресет").onClick(async () => {
            const id = newPresetId(s.presets);
            s.presets[id] = { ...structuredClone(p), id, name: `${p.name} (копия)` };
            s.deckPresets[deckKey] = id;
            await save();
            this.render();
          }),
        );
      if (presetId !== DEFAULT_PRESET_ID) {
        new Setting(contentEl)
          .setName("Название пресета")
          .addText((t) =>
            t.setValue(p.name).onChange((v) => {
              p.name = v.trim() || p.name;
              this.plugin.saveSettingsSoon();
            }),
          )
          .addButton((b) =>
            destructive(b)
              .setButtonText("Удалить пресет")
              .onClick(async () => {
                delete s.presets[presetId];
                for (const d of Object.keys(s.deckPresets)) if (s.deckPresets[d] === presetId) delete s.deckPresets[d];
                await save();
                this.render();
              }),
          );
      }
    }

    const num = (name: string, desc: string, get: () => number, set: (v: number) => void, valid: (v: number) => boolean) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(String(get())).onChange(async (v) => {
            if (v.trim() === "") return;
            const n = Number(v);
            if (!Number.isFinite(n) || !valid(n)) return;
            set(n);
            this.plugin.saveSettingsSoon();
          }),
        );
    const steps = (name: string, desc: string, get: () => string[], set: (v: string[]) => void) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(get().join(" ")).onChange(async (v) => {
            const parsed = parseSteps(v);
            if (!parsed) return;
            set(parsed);
            this.plugin.saveSettingsSoon();
          }),
        );
    const int = (v: number) => Number.isInteger(v) && v >= 0;

    const toggle = (name: string, desc: string, get: () => boolean, set: (v: boolean) => void) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(get()).onChange(async (v) => {
            set(v);
            await save();
          }),
        );
    const choice = <T extends string>(name: string, desc: string, options: Record<T, string>, get: () => T, set: (v: T) => void) =>
      new Setting(contentEl)
        .setName(name)
        .setDesc(desc)
        .addDropdown((d) => {
          for (const [k, label] of Object.entries(options) as Array<[T, string]>) d.addOption(k, label);
          d.setValue(get()).onChange(async (v) => {
            set(v as T);
            await save();
          });
        });

    new Setting(contentEl).setName("Дневные лимиты").setHeading();
    num("Новых карточек в день", "В Anki по умолчанию: 20", () => p.newPerDay, (v) => (p.newPerDay = v), int);
    num("Максимум повторений в день", "В Anki по умолчанию: 200", () => p.reviewsPerDay, (v) => (p.reviewsPerDay = v), int);
    toggle("Новые карточки игнорируют лимит повторений", "Выкл (по умолчанию в Anki): новые карточки прекращаются, когда лимит повторений исчерпан.", () => p.display.newIgnoresReviewLimit, (v) => (p.display.newIgnoresReviewLimit = v));

    new Setting(contentEl).setName("Новые карточки").setHeading();
    steps("Шаги изучения", "напр. 1м 10м 1ч (единицы м, ч, д). В Anki по умолчанию: 1м 10м", () => p.scheduler.learningSteps, (v) => (p.scheduler.learningSteps = v));
    choice("Порядок новых карточек", "Порядок вставки Anki.", { notes: "Порядок в заметках (последовательно)", random: "Случайный" }, () => p.display.newOrder, (v) => (p.display.newOrder = v));

    new Setting(contentEl).setName("Забывания").setHeading();
    steps("Шаги доизучения", "Для карточек, которые вы забыли. В Anki по умолчанию: 10 мин", () => p.scheduler.relearningSteps, (v) => (p.scheduler.relearningSteps = v));
    num("Порог забывания", "Провалов, прежде чем карточка считается пиявкой (и повторно после каждой половины этого числа). В Anki по умолчанию: 8. 0 = выкл.", () => p.leechThreshold, (v) => (p.leechThreshold = v), int);
    choice("Что делать с такой карточкой", "В Anki по умолчанию: только тег (здесь: пометка ★).", { tag: "Только тег (пометка ★)", suspend: "Приостановить карточку" }, () => p.leechAction, (v) => (p.leechAction = v));

    new Setting(contentEl).setName("Порядок показа").setHeading();
    choice(
      "Новые/повторения: порядок",
      "Когда показывать новые карточки.",
      { mix: "Примешивать к повторениям", after: "Показывать после повторений", before: "Показывать до повторений" },
      () => p.display.newReviewMix,
      (v) => (p.display.newReviewMix = v),
    );
    choice(
      "Порядок сортировки повторений",
      "В Anki по умолчанию: сначала срок, затем случайный порядок.",
      { due: "По сроку, затем случайный порядок", ivlAsc: "Возрастающие интервалы", ivlDesc: "Убывающие интервалы", overdue: "Относительная просроченность", random: "Случайный" },
      () => p.display.reviewOrder,
      (v) => (p.display.reviewOrder = v),
    );

    new Setting(contentEl).setName("FSRS").setHeading();
    num(
      "Желаемое удержание",
      "Главный регулятор интервалов повторения. Ниже — длиннее интервалы и меньше повторений (0.85); выше — больше повторений (0.95). В Anki: 0.90",
      () => p.scheduler.desiredRetention,
      (v) => (p.scheduler.desiredRetention = v),
      (v) => v >= 0.7 && v <= 0.99,
    );
    new Setting(contentEl)
      .setName("Параметры FSRS")
      .setDesc("Необязательно. Вставьте параметры из настроек колоды Anki (после Optimize), чтобы использовать их здесь. Пусто = по умолчанию.")
      .addTextArea((t) => {
        t.setValue(p.scheduler.weights.join(", ")).onChange((v) => {
          const nums = v.split(/[\s,]+/).filter(Boolean).map(Number);
          if (v.trim() === "") p.scheduler.weights = [];
          else if (nums.length >= 17 && nums.every(Number.isFinite)) p.scheduler.weights = nums;
          else return;
          this.plugin.saveSettingsSoon();
        });
        t.inputEl.rows = 3;
        t.inputEl.addClass("fc-fsrs-params");
      });
    this.optimizeRow(contentEl, p, presetId);

    new Setting(contentEl).setName("Отложение карточек").setHeading();
    toggle("Откладывать родственные новые карточки", "Остальные новые варианты этой карточки (cloze c2, обратная) ждут до завтра.", () => p.bury.newSiblings, (v) => (p.bury.newSiblings = v));
    toggle("Откладывать родственные карточки повторений", "То же для карточек повторений.", () => p.bury.reviewSiblings, (v) => (p.bury.reviewSiblings = v));
    toggle("Откладывать родственные карточки междневного изучения", "То же для карточек в шагах изучения длиной в день и больше.", () => p.bury.learningSiblings, (v) => (p.bury.learningSiblings = v));

    new Setting(contentEl).setName("Таймеры").setHeading();
    num("Максимум секунд на ответ", "Время ответа для статистики ограничивается этим числом. В Anki по умолчанию: 60", () => p.timer.maxAnswerSecs, (v) => (p.timer.maxAnswerSecs = v), (v) => int(v) && v >= 1 && v <= 7200);
    toggle("Таймер показа ответа", "Таймер в верхней панели, пока вы отвечаете.", () => p.timer.show, (v) => (p.timer.show = v));

    new Setting(contentEl).setName("Автопереход").setHeading();
    contentEl.createDiv({ cls: "setting-item-description", text: "Запускается из меню «Ещё» экрана повторения (⋯ → Автопереход). 0 — выключено." });
    num("Сколько секунд показывать вопрос", "", () => p.autoAdvance.questionSecs, (v) => (p.autoAdvance.questionSecs = v), (v) => v >= 0 && v <= 600);
    num("Сколько секунд показывать ответ", "", () => p.autoAdvance.answerSecs, (v) => (p.autoAdvance.answerSecs = v), (v) => v >= 0 && v <= 600);
    choice(
      "Действие по таймеру",
      "Что происходит, когда время на ответ истекает.",
      { again: "Ответить «Снова»", hard: "Ответить «Трудно»", good: "Ответить «Хорошо»", bury: "Отложить до завтра" },
      () => p.autoAdvance.answerAction,
      (v) => (p.autoAdvance.answerAction = v),
    );

    new Setting(contentEl).setName("Обратная сторона").setHeading();
    new Setting(contentEl)
      .setName("Показывать картинки из раздела заметки")
      .setDesc("Если на обороте карточки нет картинки, показывать картинки из заметки под тем же заголовком.")
      .addToggle((t) =>
        t.setValue(p.sectionFigures).onChange(async (v) => {
          p.sectionFigures = v;
          await save();
        }),
      );
    num("Максимум картинок", "", () => p.maxFigures, (v) => (p.maxFigures = v), (v) => int(v) && v <= 6);

    new Setting(contentEl).setName("Дополнительно").setHeading();
    num("Максимальный интервал (дней)", "В Anki по умолчанию: 36500", () => p.scheduler.maximumInterval, (v) => (p.scheduler.maximumInterval = v), (v) => int(v) && v >= 1);
    new Setting(contentEl)
      .setName("Случайный сдвиг дат")
      .setDesc("Слегка разбрасывать даты повторений, чтобы карточки, выученные вместе, не ходили вместе.")
      .addToggle((t) =>
        t.setValue(p.scheduler.fuzz).onChange(async (v) => {
          p.scheduler.fuzz = v;
          await save();
        }),
      );
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Вернуть значения Anki").onClick(async () => {
        const d = defaultPreset();
        Object.assign(p, { ...d, id: p.id, name: p.name } satisfies Preset);
        await save();
        this.render();
      }),
    );
  }
}
