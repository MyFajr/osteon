/** Anki's Filtered Deck and Custom Study dialogs (spec 0008). */
import { App, Modal, Notice, Setting } from "obsidian";
import { buildFiltered, customStudyDeck, FILTERED_ORDERS, type CustomStudyKind, type CustomStudyState, type FilteredDeck, type FilteredOrder } from "../../core/filtered";
import { counts } from "../../core/queue";
import type FlashcardsPlugin from "../../main";
import { destructive } from "../compat";

function newId(plugin: FlashcardsPlugin): string {
  let n = 1;
  while (plugin.settings.filteredDecks.some((d) => d.id === `f${n}`)) n++;
  return `f${n}`;
}

/** Create or edit a filtered deck: name, search, limit, order, reschedule; Build. */
export class FilteredDeckModal extends Modal {
  private def: FilteredDeck;

  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    existing?: FilteredDeck,
    preset?: Partial<FilteredDeck>,
  ) {
    super(app);
    this.def = existing
      ? { ...existing }
      : {
          id: newId(plugin),
          name: `Отфильтрованная колода ${plugin.settings.filteredDecks.length + 1}`,
          search: "is:due",
          limit: 100,
          order: "random",
          reschedule: true,
          ...preset,
        };
  }

  onOpen(): void {
    const { contentEl } = this;
    const editing = this.plugin.settings.filteredDecks.some((d) => d.id === this.def.id);
    this.setTitle(editing ? `Отфильтрованная колода: ${this.def.name}` : "Создать отфильтрованную колоду");
    new Setting(contentEl).setName("Название").addText((t) => t.setValue(this.def.name).onChange((v) => (this.def.name = v.trim() || this.def.name)));
    const matchEl = contentEl.createDiv({ cls: "fc-muted fc-filtered-match" });
    const updateMatch = () => {
      const n = buildFiltered(this.plugin.items(null), { ...this.def, limit: Number.MAX_SAFE_INTEGER }, Date.now(), this.plugin.settings.dayStartHour, this.plugin.searchCtx).length;
      matchEl.setText(`Подходит карточек: ${n.toLocaleString()} (приостановленные и отложенные не учитываются).`);
    };
    new Setting(contentEl)
      .setName("Поиск")
      .setDesc("Поиск Anki: deck:OrthoKing is:due, tag:knee, rated:7:1, prop:ivl>30, is:new …")
      .addText((t) => {
        t.setValue(this.def.search).onChange((v) => {
          this.def.search = v;
          updateMatch();
        });
        t.inputEl.addClass("fc-filtered-search");
      });
    contentEl.appendChild(matchEl);
    updateMatch();
    new Setting(contentEl).setName("Ограничить до").addText((t) =>
      t.setValue(String(this.def.limit)).onChange((v) => {
        const n = Math.floor(Number(v));
        if (n > 0) this.def.limit = n;
      }),
    );
    new Setting(contentEl).setName("Карточки отбираются по").addDropdown((d) => {
      for (const [k, label] of Object.entries(FILTERED_ORDERS)) d.addOption(k, label);
      d.setValue(this.def.order).onChange((v) => (this.def.order = v as FilteredOrder));
    });
    new Setting(contentEl)
      .setName("Перепланировать карточки по моим ответам в этой колоде")
      .setDesc("Выкл.: сеанс предпросмотра/зубрёжки. Ответы не записываются, карточки сохраняют расписание.")
      .addToggle((t) => t.setValue(this.def.reschedule).onChange((v) => (this.def.reschedule = v)));
    const buttons = new Setting(contentEl);
    if (editing) {
      buttons.addButton((b) =>
        destructive(b)
          .setButtonText("Удалить")
          .onClick(async () => {
            await this.plugin.deleteFilteredDeck(this.def.id);
            this.close();
          }),
      );
    }
    buttons.addButton((b) => b.setButtonText("Отмена").onClick(() => this.close()));
    buttons.addButton((b) =>
      b
        .setButtonText(editing ? "Пересобрать" : "Собрать")
        .setCta()
        .onClick(async () => {
          const n = await this.plugin.buildFilteredDeck(this.def);
          this.close();
          if (!n) new Notice("По поиску не нашлось ни одной карточки.");
          else void this.plugin.openFiltered(this.def.id);
        }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

const KINDS: Array<[CustomStudyKind, string, string]> = [
  ["newLimit", "Увеличить сегодняшний лимит новых карточек", "Насколько увеличить сегодняшний лимит новых карточек:"],
  ["reviewLimit", "Увеличить сегодняшний лимит карточек повторения", "Насколько увеличить сегодняшний лимит повторений:"],
  ["forgotten", "Повторить забытые карточки", "Повторить карточки, забытые за последние N дней:"],
  ["ahead", "Повторить вперёд", "Повторить вперёд на N дней:"],
  ["preview", "Предпросмотр новых карточек", "Сколько новых карточек предпросмотреть:"],
  ["state", "Учить по состоянию карточек или тегам", "Выбрать столько карточек:"],
];

const DEFAULTS: Record<CustomStudyKind, number> = { newLimit: 10, reviewLimit: 50, forgotten: 1, ahead: 1, preview: 20, state: 100 };

/** Anki's Custom Study dialog for a deck (null = all decks). */
export class CustomStudyModal extends Modal {
  private kind: CustomStudyKind = "newLimit";
  private n = DEFAULTS.newLimit;
  private state: CustomStudyState = "newRandom";
  private tags = "";

  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    private deck: string | null,
  ) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.setTitle(`Выборочное изучение${this.deck ? `: ${this.deck.split("/").pop()}` : ""}`);
    const list = contentEl.createDiv({ cls: "fc-cs-kinds" });
    for (const [k, label] of KINDS) {
      const row = list.createEl("label", { cls: "fc-radio fc-cs-kind" });
      const input = row.createEl("input", { type: "radio" });
      input.name = "fc-cs-kind";
      input.checked = k === this.kind;
      input.onchange = () => {
        this.kind = k;
        this.n = DEFAULTS[k];
        this.render();
      };
      row.appendText(label);
    }
    const q = this.plugin.queue(this.deck);
    const c = counts(q);
    const hint = contentEl.createDiv({ cls: "fc-muted fc-cs-hint" });
    if (this.kind === "newLimit") hint.setText(`Новых осталось на сегодня: ${c.fresh}.`);
    if (this.kind === "reviewLimit") hint.setText(`Повторений осталось на сегодня: ${c.review}.`);
    const label = KINDS.find((x) => x[0] === this.kind)![2];
    new Setting(contentEl).setName(label).addText((t) =>
      t.setValue(String(this.n)).onChange((v) => {
        const n = Math.floor(Number(v));
        if (n > 0) this.n = n;
      }),
    );
    if (this.kind === "state") {
      new Setting(contentEl).setName("Карточки").addDropdown((d) =>
        d
          .addOption("newRandom", "Только новые")
          .addOption("due", "Только карточки к сроку")
          .addOption("reviewRandom", "Все карточки повторений в случайном порядке")
          .addOption("allRandom", "Все карточки в случайном порядке (без перепланирования)")
          .setValue(this.state)
          .onChange((v) => (this.state = v as CustomStudyState)),
      );
      new Setting(contentEl)
        .setName("Только эти теги")
        .setDesc("Необязательно, через пробел, напр. колено high-yield.")
        .addText((t) => t.setValue(this.tags).onChange((v) => (this.tags = v)));
    }
    new Setting(contentEl)
      .addButton((b) => b.setButtonText("Отмена").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Готово").setCta().onClick(() => void this.ok()));
  }

  private async ok(): Promise<void> {
    const { plugin, deck } = this;
    if (this.kind === "newLimit" || this.kind === "reviewLimit") {
      await plugin.extendToday(deck, this.kind === "newLimit" ? "new" : "review", this.n);
      this.close();
      void plugin.openReview(deck);
      return;
    }
    const made = customStudyDeck(deck, this.kind, this.n, { state: this.state, tags: this.tags, limit: this.n });
    // Like Anki, Custom Study reuses one "Выборочное изучение" deck.
    const existing = plugin.settings.filteredDecks.find((d) => (d.name === made.name || d.name === "Custom Study Session" || d.name === "Своё занятие"));
    const def: FilteredDeck = { ...made, id: existing?.id ?? newId(plugin) };
    const n = await plugin.buildFilteredDeck(def);
    this.close();
    if (!n) new Notice("Под эти параметры не подошло ни одной карточки.");
    else void plugin.openFiltered(def.id);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
