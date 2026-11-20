/**
 * Anki's Statistics screen (spec 0007 §3): Today, Future Due, Calendar, Reviews, Card Counts,
 * Review Intervals, Card Stability, Card Difficulty, Card Retrievability, Hourly Breakdown,
 * Answer Buttons, Added and True Retention, for one deck or the whole collection.
 */
import { ItemView, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
import { renderWhenVisible } from "./lazy-render";
import { State } from "ts-fsrs";
import type FlashcardsPlugin from "../../main";
import type { QueueItem } from "../../core/queue";
import { formatInterval } from "../../core/scheduler";
import {
  answerButtons,
  cardCounts,
  difficultyPct,
  forecast,
  histogram,
  hourly,
  percentile,
  periodSummary,
  reviewCards,
  reviewsByDay,
  studyDay,
  todaySummary,
  trueRetention,
  type ReviewKind,
  type ReviewRow,
} from "../../core/stats";
import { barChart, donut, type Bar } from "../charts";
import { dateLabel, heatmapData, plural, renderHeatmap } from "../heatmap";

export const VIEW_STATS = "flashcards-stats";

type Range = "month" | "3months" | "year" | "all";
const RANGES: [Range, string][] = [
  ["month", "1 месяц"],
  ["3months", "3 месяца"],
  ["year", "1 год"],
  ["all", "За всё время"],
];
const RANGE_DAYS: Record<Exclude<Range, "all">, number> = { month: 30, "3months": 90, year: 365 };

const KINDS: [ReviewKind, string][] = [
  ["learn", "Изучение"],
  ["relearn", "Доизучение"],
  ["young", "Молодые"],
  ["mature", "Зрелые"],
];

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const mins = (ms: number) => ms / 60000;

function shortDate(day: number, today: number): string {
  const diff = day - today;
  if (Math.abs(diff) < 60) return `${diff} дн.`;
  const m = dateLabel(day).match(/\d+ [а-я]+/);
  return m ? m[0] : dateLabel(day);
}

export class StatsView extends ItemView {
  deck: string | null = null;
  private ranges: Record<string, Range> = {};
  private futureBacklog = true;
  private reviewsTime = false;
  private ivlRange: "month" | "p50" | "p95" | "all" = "p95";
  private yearState: { year?: number } = {};

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: FlashcardsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_STATS;
  }

  getDisplayText(): string {
    return this.deck ? `Statistics: ${this.deck}` : "Статистика";
  }

  getIcon(): string {
    return "bar-chart-3";
  }

  getState(): Record<string, unknown> {
    return { deck: this.deck };
  }

  async setState(state: { deck?: string | null }, result: ViewStateResult): Promise<void> {
    if (state && "deck" in state) this.deck = state.deck ?? null;
    await super.setState(state, result);
    this.render();
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.plugin.events.on("changed", renderWhenVisible(this, () => this.render())));
    this.render();
  }

  private range(id: string, fallback: Range = "month"): Range {
    return this.ranges[id] ?? fallback;
  }

  private rangeFrom(id: string, today: number, firstDay: number, fallback: Range = "month"): number {
    const r = this.range(id, fallback);
    return r === "all" ? Math.min(firstDay, today) : today - RANGE_DAYS[r] + 1;
  }

  render(): void {
    const el = this.contentEl;
    const scroll = el.scrollTop;
    el.empty();
    el.addClass("fc-stats");
    if (!this.plugin.ready) {
      el.createDiv({ cls: "fc-muted", text: "Загрузка карточек…" });
      return;
    }
    const startHour = this.plugin.settings.dayStartHour;
    const now = Date.now();
    const today = studyDay(now, startHour);
    const data = heatmapData(this.plugin, this.deck);
    const { items, rows } = data;
    const firstDay = rows.length ? rows[0].day : today;

    this.header(el);
    this.today(el, rows, today);
    this.futureDue(el, items, today);
    this.section(el, "Календарь", (body) => renderHeatmap(body, this.plugin, this.deck, data, this.yearState, () => this.render()));
    this.reviews(el, rows, today, firstDay);
    this.counts(el, items, now);
    this.intervals(el, items, today);
    this.fsrsGraphs(el, items, now);
    this.hourlyGraph(el, rows, today, firstDay);
    this.buttons(el, rows, today, firstDay);
    this.added(el, items, today, startHour);
    this.retention(el, rows, today);
    el.scrollTop = scroll;
  }

  private header(el: HTMLElement): void {
    const bar = el.createDiv({ cls: "fc-stats-header" });
    bar.createSpan({ text: "Колода: " });
    const select = bar.createEl("select", { cls: "dropdown" });
    select.createEl("option", { text: "Все колоды (коллекция)", value: "" });
    const decks = new Set<string>();
    for (const ref of this.plugin.index.refs()) {
      const parts = ref.deck.split("/");
      for (let i = 1; i <= parts.length; i++) decks.add(parts.slice(0, i).join("/"));
    }
    for (const d of [...decks].sort((a, b) => a.localeCompare(b))) {
      const o = select.createEl("option", { text: d.split("/").join(" › "), value: d });
      if (d === this.deck) o.selected = true;
    }
    select.onchange = () => {
      this.deck = select.value || null;
      this.app.workspace.requestSaveLayout();
      this.render();
    };
  }

  private section(el: HTMLElement, title: string, fill: (body: HTMLElement, controls: HTMLElement) => void): void {
    const card = el.createDiv({ cls: "fc-stats-card" });
    const head = card.createDiv({ cls: "fc-stats-head" });
    head.createEl("h3", { text: title });
    const controls = head.createDiv({ cls: "fc-stats-controls" });
    fill(card.createDiv({ cls: "fc-stats-body" }), controls);
  }

  private rangeRadios(controls: HTMLElement, id: string, fallback: Range = "month", options: [Range, string][] = RANGES): void {
    const current = this.range(id, fallback);
    for (const [r, label] of options) {
      const l = controls.createEl("label", { cls: "fc-radio" });
      const input = l.createEl("input", { type: "radio" });
      input.name = `${id}-range`;
      input.checked = r === current;
      input.onchange = () => {
        this.ranges[id] = r;
        this.render();
      };
      l.appendText(label);
    }
  }

  private summary(body: HTMLElement, lines: [string, string][]): void {
    const t = body.createEl("table", { cls: "fc-stats-summary" });
    for (const [k, v] of lines) {
      const tr = t.createEl("tr");
      tr.createEl("td", { text: k });
      tr.createEl("td", { text: v });
    }
  }

  private browse(query: string): () => void {
    const q = this.deck ? `${query} deck:"${this.deck}"` : query;
    return () => void this.plugin.openBrowse(q);
  }

  // Today ---------------------------------------------------------------------------------------

  private today(el: HTMLElement, rows: ReviewRow[], today: number): void {
    this.section(el, "Сегодня", (body) => {
      const t = todaySummary(rows, today);
      if (!t.cards) {
        body.createDiv({ cls: "fc-muted", text: "Сегодня вы ещё не занимались." });
        return;
      }
      const m = mins(t.ms);
      body.createDiv({ text: `Сегодня изучено ${plural(t.cards, "card")} за ${m.toFixed(2)} мин (${(t.ms / 1000 / t.cards).toFixed(2)} с/карточку)` });
      body.createDiv({ text: `Ответов «Снова»: ${t.again} (${pct(t.cards - t.again, t.cards)} верных)` });
      body.createDiv({ text: `Изучение: ${t.learn}, Повторение: ${t.review}, Доизучение: ${t.relearn}, Фильтровальная: 0` });
      body.createDiv({
        text: t.matureTotal
          ? `Верных ответов на зрелых карточках: ${t.matureCorrect}/${t.matureTotal} (${pct(t.matureCorrect, t.matureTotal)})`
          : "Сегодня зрелые карточки не повторялись.",
      });
    });
  }

  // Future due ----------------------------------------------------------------------------------

  private futureDue(el: HTMLElement, items: QueueItem[], today: number): void {
    this.section(el, "Будущие сроки", (body, controls) => {
      this.rangeRadios(controls, "future", "month", [
        ["month", "1 месяц"],
        ["3months", "3 месяца"],
        ["year", "1 год"],
        ["all", "Все"],
      ]);
      const l = controls.createEl("label", { cls: "fc-radio" });
      const cb = l.createEl("input", { type: "checkbox" });
      cb.checked = this.futureBacklog;
      cb.onchange = () => {
        this.futureBacklog = cb.checked;
        this.render();
      };
      l.appendText("Задолженность");

      const due = forecast(items, today, this.plugin.settings.dayStartHour, this.futureBacklog);
      const r = this.range("future");
      const lastDue = Math.max(today, ...due.keys());
      const end = r === "all" ? lastDue : today + RANGE_DAYS[r] - 1;
      const values: number[] = [];
      const bars: Bar[] = [];
      let cum = 0;
      const cumulative: number[] = [];
      for (let d = today; d <= end; d++) {
        const n = due.get(d) ?? 0;
        values.push(n);
        cum += n;
        cumulative.push(cum);
        bars.push({
          label: d === today ? "Сегодня" : shortDate(d, today),
          title: d === today ? "Сегодня" : `Через ${plural(d - today, "дн.")} (${dateLabel(d)})`,
          segments: [{ value: n, cls: "fc-c-due", label: "К сроку" }],
          onClick: n ? this.browse(`prop:due=${d - today}`) : undefined,
        });
      }
      barChart(body, { bars, line: { values: cumulative, label: "Нарастающим итогом", format: (v) => String(Math.round(v)) } });
      const total = values.reduce((a, b) => a + b, 0);
      this.summary(body, [
        ["Всего:", plural(total, "review")],
        ["Среднее:", `${(total / Math.max(1, values.length)).toFixed(1)} повт./день`],
        ["На завтра:", plural(due.get(today + 1) ?? 0, "review")],
      ]);
    });
  }

  // Reviews -------------------------------------------------------------------------------------

  private reviews(el: HTMLElement, rows: ReviewRow[], today: number, firstDay: number): void {
    this.section(el, "Повторения", (body, controls) => {
      for (const [v, label] of [
        [false, "Количество"],
        [true, "Время"],
      ] as const) {
        const l = controls.createEl("label", { cls: "fc-radio" });
        const input = l.createEl("input", { type: "radio" });
        input.name = "reviews-mode";
        input.checked = this.reviewsTime === v;
        input.onchange = () => {
          this.reviewsTime = v;
          this.render();
        };
        l.appendText(label);
      }
      this.rangeRadios(controls, "reviews");
      const from = this.rangeFrom("reviews", today, firstDay);
      const days = reviewsByDay(rows, from, today);
      const time = this.reviewsTime;
      const val = (d: (typeof days)[number], k: ReviewKind) => (time ? mins(d.ms[k]) : d.count[k]);
      let cum = 0;
      const cumulative: number[] = [];
      const bars: Bar[] = days.map((d) => {
        const total = KINDS.reduce((a, [k]) => a + val(d, k), 0);
        cum += total;
        cumulative.push(cum);
        return {
          label: shortDate(d.day, today),
          title: dateLabel(d.day),
          segments: KINDS.map(([k, label]) => ({ value: val(d, k), cls: `fc-c-${k}`, label })),
          onClick: total ? this.browse(`prop:rated=${d.day - today}`) : undefined,
        };
      });
      const unit = time ? (v: number) => `${v.toFixed(v < 10 ? 1 : 0)}m` : (v: number) => String(Math.round(v));
      barChart(body, { bars, format: unit, line: { values: cumulative, label: "Нарастающим итогом", format: unit } });
      this.legend(body, KINDS.map(([k, l]) => [`fc-c-${k}`, l]));
      const per = days.map((d) => KINDS.reduce((a, [k]) => a + val(d, k), 0));
      const p = periodSummary(per);
      const u = time ? "мин" : "повт.";
      const f = (v: number) => (time ? v.toFixed(1) : String(Math.round(v)));
      this.summary(body, [
        ["Дней занятий:", `${p.daysStudied} of ${p.daysTotal} (${pct(p.daysStudied, p.daysTotal)})`],
        ["Всего:", `${f(p.total)} ${u}`],
        ["Среднее за дни занятий:", `${f(p.avgStudied)} ${u}/день`],
        ["Среднее за период:", `${f(p.avgOverall)} ${u}/день`],
      ]);
    });
  }

  private legend(body: HTMLElement, entries: [string, string][]): void {
    const l = body.createDiv({ cls: "fc-legend" });
    for (const [cls, label] of entries) {
      const s = l.createSpan({ cls: "fc-legend-item" });
      s.createSpan({ cls: `fc-swatch ${cls}` });
      s.appendText(label);
    }
  }

  // Card counts ---------------------------------------------------------------------------------

  private counts(el: HTMLElement, items: QueueItem[], now: number): void {
    this.section(el, "Количество карточек", (body) => {
      const c = cardCounts(items, now);
      donut(body, [
        { label: "Новые", value: c.new, cls: "fc-c-new" },
        { label: "Изучение", value: c.learning, cls: "fc-c-learn" },
        { label: "Доизучение", value: c.relearning, cls: "fc-c-relearn" },
        { label: "Молодые", value: c.young, cls: "fc-c-young" },
        { label: "Зрелые", value: c.mature, cls: "fc-c-mature" },
        { label: "Приостановлены", value: c.suspended, cls: "fc-c-suspended" },
        { label: "Отложено", value: c.buried, cls: "fc-c-buried" },
      ]);
    });
  }

  // Intervals, stability, difficulty, retrievability --------------------------------------------

  private intervals(el: HTMLElement, items: QueueItem[], today: number): void {
    this.section(el, "Интервалы повторений", (body, controls) => {
      for (const [v, label] of [
        ["month", "1 месяц"],
        ["p50", "50%"],
        ["p95", "95%"],
        ["all", "Все"],
      ] as const) {
        const l = controls.createEl("label", { cls: "fc-radio" });
        const input = l.createEl("input", { type: "radio" });
        input.name = "ivl-range";
        input.checked = this.ivlRange === v;
        input.onchange = () => {
          this.ivlRange = v;
          this.render();
        };
        l.appendText(label);
      }
      const ivls = reviewCards(items).map((s) => s.card.scheduled_days);
      if (!ivls.length) {
        body.createDiv({ cls: "fc-muted", text: "До повторений карточки ещё не дошли." });
        return;
      }
      const max =
        this.ivlRange === "month" ? 31
        : this.ivlRange === "p50" ? percentile(ivls, 0.5)
        : this.ivlRange === "p95" ? percentile(ivls, 0.95)
        : Math.max(...ivls);
      this.dayHistogram(body, ivls, Math.max(1, max), "Интервал", (a, b) => `prop:ivl>=${a} prop:ivl<=${b}`);
      const avg = ivls.reduce((a, b) => a + b, 0) / ivls.length;
      this.summary(body, [
        ["Средний интервал:", formatInterval(avg * 86400000)],
        ["Самый долгий интервал:", formatInterval(Math.max(...ivls) * 86400000)],
      ]);
    });
  }

  /** A histogram of day values (intervals, stability) with whole-day bins. */
  private dayHistogram(body: HTMLElement, values: number[], max: number, what: string, search?: (from: number, to: number) => string): void {
    const binCount = Math.min(Math.ceil(max) + 1, 60);
    const bins = histogram(values, 0, Math.ceil(max) + 1, binCount);
    let cum = 0;
    const total = values.length;
    const cumulative: number[] = [];
    const bars: Bar[] = bins.map((b) => {
      cum += b.count;
      cumulative.push((cum / total) * 100);
      const a = Math.ceil(b.from);
      const z = Math.max(a, Math.ceil(b.to) - 1);
      const title = a === z ? `${what}: ${plural(a, "дней")}` : `${what}: ${a}–${z} дн.`;
      return {
        label: `${a}d`,
        title,
        segments: [{ value: b.count, cls: "fc-c-ivl", label: "Карточки" }],
        onClick: b.count && search ? this.browse(search(a, z)) : undefined,
      };
    });
    barChart(body, { bars, line: { values: cumulative, label: "Нарастающим итогом", format: (v) => `${Math.round(v)}%`, max: 100 } });
  }

  private fsrsGraphs(el: HTMLElement, items: QueueItem[], now: number): void {
    const withState = items.filter((i) => i.state && !i.state.suspended && (i.state.card.state === State.Review || i.state.card.state === State.Relearning));
    this.section(el, "Стабильность карточек", (body) => {
      const s = withState.map((i) => i.state!.card.stability);
      if (!s.length) return void body.createDiv({ cls: "fc-muted", text: "До повторений карточки ещё не дошли." });
      this.dayHistogram(body, s, Math.max(1, percentile(s, 0.95)), "Stability", (a, b) => `prop:s>=${a} prop:s<=${b + 1}`);
      this.summary(body, [["Средняя стабильность:", formatInterval((s.reduce((a, b) => a + b, 0) / s.length) * 86400000)]]);
    });
    this.section(el, "Сложность карточек", (body) => {
      const d = withState.map((i) => difficultyPct(i.state!.card.difficulty));
      if (!d.length) return void body.createDiv({ cls: "fc-muted", text: "До повторений карточки ещё не дошли." });
      const bins = histogram(d, 0, 100, 20);
      barChart(body, {
        bars: bins.map((b, i) => ({
          label: `${Math.round(b.from)}%`,
          title: `Сложность ${Math.round(b.from)}–${Math.round(b.to)}%`,
          segments: [{ value: b.count, cls: `fc-c-diff fc-grad-${Math.floor(i / 2)}`, label: "Карточки" }],
        })),
        xTicks: 10,
      });
      this.summary(body, [["Средняя сложность:", `${(d.reduce((a, b) => a + b, 0) / d.length).toFixed(0)}%`]]);
    });
    this.section(el, "Извлекаемость карточек", (body) => {
      const r = withState.map((i) => this.plugin.schedulerFor(i.ref).get_retrievability(i.state!.card, new Date(now), false) * 100);
      if (!r.length) return void body.createDiv({ cls: "fc-muted", text: "До повторений карточки ещё не дошли." });
      const bins = histogram(r, 0, 100, 20);
      barChart(body, {
        bars: bins.map((b, i) => ({
          label: `${Math.round(b.from)}%`,
          title: `Извлекаемость ${Math.round(b.from)}–${Math.round(b.to)}%`,
          segments: [{ value: b.count, cls: `fc-c-retr fc-grad-${9 - Math.floor(i / 2)}`, label: "Карточки" }],
        })),
        xTicks: 10,
      });
      const sum = r.reduce((a, b) => a + b, 0);
      this.summary(body, [
        ["Средняя извлекаемость:", `${(sum / r.length).toFixed(0)}%`],
        ["Приблизительный объём знаний:", plural(Math.round(sum / 100), "card")],
      ]);
    });
  }

  // Hourly, buttons -----------------------------------------------------------------------------

  private hourlyGraph(el: HTMLElement, rows: ReviewRow[], today: number, firstDay: number): void {
    this.section(el, "Разбивка по часам", (body, controls) => {
      this.rangeRadios(controls, "hourly");
      const h = hourly(rows, this.rangeFrom("hourly", today, firstDay));
      const start = this.plugin.settings.dayStartHour;
      const order = Array.from({ length: 24 }, (_, i) => (i + start) % 24);
      barChart(body, {
        bars: order.map((hr) => ({
          label: `${hr}`,
          title: `${hr}:00–${hr + 1}:00`,
          segments: [{ value: h[hr].total, cls: "fc-c-hour", label: "Повторения" }],
        })),
        line: { values: order.map((hr) => (h[hr].total ? (h[hr].correct / h[hr].total) * 100 : 0)), label: "Верно", format: (v) => `${Math.round(v)}%`, max: 100 },
        xTicks: 12,
      });
    });
  }

  private buttons(el: HTMLElement, rows: ReviewRow[], today: number, firstDay: number): void {
    this.section(el, "Кнопки ответов", (body, controls) => {
      this.rangeRadios(controls, "buttons");
      const b = answerButtons(rows, this.rangeFrom("buttons", today, firstDay));
      const groups = [
        ["learning", "Изучение", "fc-c-learn"],
        ["young", "Молодые", "fc-c-young"],
        ["mature", "Зрелые", "fc-c-mature"],
      ] as const;
      const names = ["Снова", "Трудно", "Хорошо", "Легко"];
      const bars: Bar[] = [];
      for (const [g, label, cls] of groups) {
        const total = b[g].reduce((a, v) => a + v, 0);
        b[g].forEach((n, i) =>
          bars.push({ label: `${i + 1}`, title: `${label}: ${names[i]} (${pct(n, total)})`, segments: [{ value: n, cls, label: "Ответы" }] }),
        );
      }
      barChart(body, { bars, xTicks: 12 });
      this.legend(body, groups.map(([, l, c]) => [c, l]));
      this.summary(
        body,
        groups.map(([g, label]) => {
          const total = b[g].reduce((a, v) => a + v, 0);
          return [`${label}:`, `Верно: ${pct(total - b[g][0], total)} (${total - b[g][0]} из ${total})`];
        }),
      );
    });
  }

  // Added ---------------------------------------------------------------------------------------

  private added(el: HTMLElement, items: QueueItem[], today: number, startHour: number): void {
    this.section(el, "Добавлено", (body, controls) => {
      this.rangeRadios(controls, "added");
      // Cards live in notes, so a card's "added" date is its note's creation date.
      const ctime = new Map<string, number>();
      const addedDays: number[] = [];
      for (const { ref } of items) {
        let t = ctime.get(ref.path);
        if (t === undefined) {
          t = this.app.vault.getFileByPath(ref.path)?.stat.ctime ?? 0;
          ctime.set(ref.path, t);
        }
        if (t) addedDays.push(studyDay(t, startHour));
      }
      const first = addedDays.length ? Math.min(...addedDays) : today;
      const from = this.rangeFrom("added", today, first);
      const counts = new Map<number, number>();
      for (const d of addedDays) if (d >= from) counts.set(d, (counts.get(d) ?? 0) + 1);
      const values: number[] = [];
      const bars: Bar[] = [];
      for (let d = from; d <= today; d++) {
        const n = counts.get(d) ?? 0;
        values.push(n);
        bars.push({ label: shortDate(d, today), title: dateLabel(d), segments: [{ value: n, cls: "fc-c-added", label: "Добавлено" }] });
      }
      barChart(body, { bars });
      const p = periodSummary(values);
      this.summary(body, [
        ["Всего:", plural(p.total, "card")],
        ["Среднее:", `${p.avgOverall.toFixed(1)} карт./день`],
      ]);
    });
  }

  // True retention ------------------------------------------------------------------------------

  private retention(el: HTMLElement, rows: ReviewRow[], today: number): void {
    this.section(el, "Истинное удержание", (body) => {
      const t = body.createEl("table", { cls: "fc-retention" });
      const h1 = t.createEl("tr");
      h1.createEl("th");
      for (const g of ["Молодые", "Зрелые", "Всего"]) h1.createEl("th", { text: g, attr: { colspan: "3" } });
      const h2 = t.createEl("tr");
      h2.createEl("th");
      for (let i = 0; i < 3; i++) for (const c of ["Верно", "Неверно", "Удержание"]) h2.createEl("th", { text: c, cls: "fc-num" });
      for (const r of trueRetention(rows, today)) {
        const tr = t.createEl("tr");
        tr.createEl("th", { text: r.label });
        const total = { pass: r.young.pass + r.mature.pass, fail: r.young.fail + r.mature.fail };
        for (const g of [r.young, r.mature, total]) {
          tr.createEl("td", { text: String(g.pass), cls: "fc-num" });
          tr.createEl("td", { text: String(g.fail), cls: "fc-num" });
          tr.createEl("td", { text: g.pass + g.fail ? pct(g.pass, g.pass + g.fail) : "N/A", cls: "fc-num" });
        }
      }
      body.createDiv({ cls: "fc-muted fc-small", text: "Успех — «Трудно», «Хорошо» или «Легко» на карточке повторения. Карточки в изучении не считаются." });
    });
  }
}
