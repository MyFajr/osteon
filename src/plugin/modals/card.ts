/** Per-card dialogs: edit, card info, set due date (spec 0003 §3, §6). */
import { App, Modal, Notice, Setting } from "obsidian";
import { State } from "ts-fsrs";
import type { CardRef } from "../../core/collection";
import { parseDueInput } from "../../core/due";
import type { LogEvent } from "../../core/log";
import { formatInterval } from "../../core/scheduler";
import type { CardState } from "../../core/state";
import type FlashcardsPlugin from "../../main";

/** Edit a card's source lines without leaving the review (Anki's "Edit"). */
export class EditCardModal extends Modal {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    private ref: CardRef,
    private onSaved: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Изменить карточку");
    const { contentEl } = this;
    contentEl.createDiv({ cls: "setting-item-description", text: `${this.ref.path}, строка ${this.ref.card.startLine + 1}` });
    const ta = contentEl.createEl("textarea", { cls: "fc-edit-area" });
    ta.value = this.ref.card.sourceLines.join("\n");
    ta.rows = Math.min(16, Math.max(4, this.ref.card.sourceLines.length + 2));
    const save = async () => {
      const ok = await this.plugin.editCard(this.ref, ta.value);
      if (!ok) {
        new Notice("Заметка изменилась с момента показа карточки; переоткройте карточку и попробуйте снова.");
        return;
      }
      this.close();
      this.onSaved();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void save();
      }
    });
    new Setting(contentEl)
      .setDesc("⌘/Ctrl+Enter — сохранить. Оставьте тег ^fc-… в конце строки, чтобы карточка сохранила свою историю.")
      .addButton((b) => b.setButtonText("Отмена").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Сохранить").setCta().onClick(() => void save()));
    window.setTimeout(() => ta.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

const RATING_NAME: Record<string, string> = { again: "Снова", hard: "Трудно", good: "Хорошо", easy: "Легко" };

const STATE_NAME: Record<number, string> = {
  [State.New]: "Новые",
  [State.Learning]: "Изучение",
  [State.Review]: "Повторение",
  [State.Relearning]: "Доизучение",
};

function fmtDate(d: Date | string | undefined): string {
  if (!d) return "—";
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** Anki's Card Info, plus which device each review was done on. */
export class CardInfoModal extends Modal {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    private ref: CardRef,
    private state: CardState | undefined,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Информация о карточке");
    const { contentEl } = this;
    const s = this.state;
    const c = s?.card;
    const now = new Date();
    const rows: Array<[string, string]> = [
      ["Колода", this.ref.deck.split("/").join(" › ")],
      ["Заметка", `${this.ref.path}, строка ${this.ref.card.startLine + 1}`],
      ["Карточка", this.ref.key ?? "новая (ID ещё нет)"],
      ["Состояние", c ? STATE_NAME[c.state] : "Новые"],
      ["Первое повторение", fmtDate(s?.reviews[0]?.ts)],
      ["Последнее повторение", fmtDate(s?.reviews[s.reviews.length - 1]?.ts)],
      ["К сроку", c && c.state !== State.New ? fmtDate(c.due) : "—"],
      ["Интервал", c && c.state !== State.New ? formatInterval(c.due.getTime() - (c.last_review?.getTime() ?? now.getTime())) : "—"],
      ["Стабильность", c && c.state !== State.New ? `${c.stability.toFixed(1)} дней` : "—"],
      ["Сложность", c && c.state !== State.New ? `${((c.difficulty / 10) * 100).toFixed(0)}%` : "—"],
      [
        "Вероятность воспроизведения",
        c && c.state !== State.New ? `${(this.plugin.schedulerFor(this.ref).get_retrievability(c, now, false) * 100).toFixed(0)}%` : "—",
      ],
      ["Повторения", String(s?.reviews.length ?? 0)],
      ["Забывания", String(c?.lapses ?? 0)],
      [
        "Среднее время",
        s?.reviews.length ? `${(s.reviews.reduce((a, r) => a + r.ms, 0) / s.reviews.length / 1000).toFixed(1)} с` : "—",
      ],
    ];
    if (s?.suspended) rows.push(["Статус", "Приостановлена"]);
    const table = contentEl.createEl("table", { cls: "fc-info-table" });
    for (const [k, v] of rows) {
      const tr = table.createEl("tr");
      tr.createEl("th", { text: k });
      tr.createEl("td", { text: v });
    }
    if (s?.reviews.length) {
      contentEl.createEl("h4", { text: "История" });
      const h = contentEl.createEl("table", { cls: "fc-info-history" });
      const head = h.createEl("tr");
      for (const col of ["Дата", "Тип", "Оценка", "Интервал", "Время", "Устройство"]) head.createEl("th", { text: col });
      for (const r of [...s.reviews].reverse()) {
        const tr = h.createEl("tr");
        tr.createEl("td", { text: fmtDate(r.ts) });
        tr.createEl("td", { text: STATE_NAME[r.stateBefore] === "Новые" ? "Изучение" : STATE_NAME[r.stateBefore] });
        tr.createEl("td", { text: (RATING_NAME[r.rating] ?? r.rating), cls: `fc-${r.rating}` });
        tr.createEl("td", { text: formatInterval(r.due.getTime() - Date.parse(r.ts)) });
        tr.createEl("td", { text: `${(r.ms / 1000).toFixed(1)} с` });
        tr.createEl("td", { text: r.device ?? "" });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Anki's Set Due Date: 0 = today, 3 = in 3 days, 3-7 = random day in range. */
export class SetDueModal extends Modal {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    private refs: CardRef[],
    private onDone: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.refs.length === 1 ? "Задать срок" : `Задать срок (${this.refs.length} карточек)`);
    const { contentEl } = this;
    let value = "";
    const apply = async () => {
      const now = Date.now();
      if (!parseDueInput(value, now, this.plugin.settings.dayStartHour)) {
        new Notice("Введите 0 (сегодня), число дней или диапазон вида 3-7.");
        return;
      }
      const events: LogEvent[] = [];
      const ordered = [...this.refs].sort((a, b) => a.path.localeCompare(b.path) || b.card.startLine - a.card.startLine);
      for (const ref of ordered) {
        const due = parseDueInput(value, now, this.plugin.settings.dayStartHour)!;
        const key = await this.plugin.ensureKey(ref);
        if (!key) continue;
        events.push({ ts: new Date(now + events.length).toISOString(), type: "reschedule", key, due: due.toISOString() });
      }
      await this.plugin.logEvents(events);
      this.close();
      this.onDone();
    };
    new Setting(contentEl)
      .setName("Через сколько дней показать?")
      .setDesc("0 = сегодня, 1 = завтра, 3–7 = случайный день в этом диапазоне.")
      .addText((t) => {
        t.setPlaceholder("0").onChange((v) => (value = v));
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void apply();
          }
        });
        window.setTimeout(() => t.inputEl.focus(), 0);
      });
    new Setting(contentEl).addButton((b) => b.setButtonText("Установить").setCta().onClick(() => void apply()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
