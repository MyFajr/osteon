/**
 * Migrate from obsidian-spaced-repetition (spec 0002 §8): preview first, write only on confirm.
 * Also lists overstuffed cards to rewrite ("Нужна переработка").
 */
import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type { CardRef } from "../../core/collection";
import { composeCardSource, newCardId } from "../../core/ids";
import type { LogEvent } from "../../core/log";
import { migrateNote, shapeIssues, type MigrationIssue } from "../../core/migrate";
import type FlashcardsPlugin from "../../main";

interface Preview {
  files: Array<{ file: TFile; changed: boolean; events: number }>;
  cards: number;
  scheduled: number;
  converted: number;
  manual: Array<MigrationIssue & { path: string }>;
  rewrite: Array<MigrationIssue & { path: string }>;
}

function openAt(app: App, path: string, line: number): void {
  const file = app.vault.getFileByPath(path);
  if (file) void app.workspace.getLeaf("tab").openFile(file, { eState: { line: line - 1 } });
}

function issueList(app: App, el: HTMLElement, title: string, items: Array<MigrationIssue & { path: string }>, max = 40): void {
  if (!items.length) return;
  el.createEl("h4", { text: `${title} (${items.length})` });
  const ul = el.createEl("ul", { cls: "fc-issue-list" });
  for (const it of items.slice(0, max)) {
    const li = ul.createEl("li");
    const a = li.createEl("a", { text: `${it.path}:${it.line}` });
    a.onclick = () => openAt(app, it.path, it.line);
    li.createSpan({ text: ` — ${it.reason}`, cls: "fc-muted" });
    li.createDiv({ text: it.text.trim().slice(0, 140), cls: "fc-issue-text" });
  }
  if (items.length > max) el.createDiv({ cls: "fc-muted", text: `…и ещё ${items.length - max}.` });
}

export class MigrateModal extends Modal {
  private folder = "";
  private preview?: Preview;
  private resultEl!: HTMLElement;

  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Перенос из Spaced Repetition");
    const { contentEl } = this;
    contentEl.createEl("p", {
      text:
        "Сохраняет расписание каждой карточки из комментария <!--SR:…-->, убирает комментарий и даёт карточке идентификатор ^fc-. " +
        "Карточки SR с «?» и вопросом в одну строку становятся «вопрос ::». Ничего не записывается, пока вы не нажмёте «Перенести». " +
        "Перед переносом выключите плагин Spaced Repetition (чтобы он не вернул свои комментарии) и сделайте копию папки, если захотите откатить.",
    });
    new Setting(contentEl)
      .setName("Folder")
      .setDesc("Оставьте пустым, чтобы взять все заметки с #flashcards в хранилище.")
      .addText((t) => t.setPlaceholder("напр. Ортопедия").onChange((v) => (this.folder = v.trim().replace(/^\/+|\/+$/g, ""))))
      .addButton((b) => b.setButtonText("Preview").setCta().onClick(() => void this.runPreview()));
    this.resultEl = contentEl.createDiv();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private files(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((f) => {
      if (this.folder && !f.path.startsWith(this.folder + "/")) return false;
      return this.plugin.index.shouldScan(f, this.app.metadataCache.getFileCache(f));
    });
  }

  private async runPreview(): Promise<void> {
    const now = new Date();
    const p: Preview = { files: [], cards: 0, scheduled: 0, converted: 0, manual: [], rewrite: [] };
    let n = 0;
    for (const file of this.files()) {
      const text = await this.app.vault.cachedRead(file);
      const r = migrateNote(text, { now, dayStartHour: this.plugin.settings.dayStartHour, newId: () => `preview${n++}`.slice(-8) });
      p.files.push({ file, changed: r.text !== text, events: r.events.length });
      p.cards += r.cards;
      p.scheduled += r.scheduled;
      p.converted += r.converted;
      p.manual.push(...r.manual.map((m) => ({ ...m, path: file.path })));
      p.rewrite.push(...r.rewrite.map((m) => ({ ...m, path: file.path })));
    }
    this.preview = p;
    const el = this.resultEl;
    el.empty();
    const changed = p.files.filter((f) => f.changed).length;
    el.createEl("p", {
      text:
        `Заметок: ${p.files.length}, карточек: ${p.cards}. Расписаний к импорту: ${p.scheduled}, карточек «?» к преобразованию: ${p.converted}, ` +
        `Будет изменено заметок: ${changed}.`,
    });
    if (changed) {
      new Setting(el).addButton((b) =>
        b
          .setButtonText(`Перенести ${changed} замет${changed === 1 ? "ку" : changed < 5 ? "ки" : "ок"}`)
          .setCta()
          .onClick(async () => {
            b.setDisabled(true);
            await this.migrate();
          }),
      );
    }
    issueList(this.app, el, "Нужна ручная проверка", p.manual);
    issueList(this.app, el, "Нужна переработка (объяснение внутри cloze или слишком длинно)", p.rewrite);
  }

  private async migrate(): Promise<void> {
    if (!this.preview) return;
    const now = new Date();
    const taken = new Set<string>();
    const newId = () => {
      const id = newCardId((x) => taken.has(x) || this.plugin.index.hasId(x));
      taken.add(id);
      return id;
    };
    const events: LogEvent[] = [];
    let notes = 0;
    for (const { file, changed } of this.preview.files) {
      if (!changed) continue;
      let fileEvents: LogEvent[] = [];
      await this.app.vault.process(file, (text) => {
        const r = migrateNote(text, { now, dayStartHour: this.plugin.settings.dayStartHour, newId });
        fileEvents = r.events;
        return r.text;
      });
      events.push(...fileEvents);
      notes++;
    }
    await this.plugin.logEvents(events);
    new Notice(`Перенесено заметок: ${notes}; расписаний импортировано: ${events.length}.`, 8000);
    this.resultEl.createEl("p", { text: `Готово: заметок перенесено: ${notes}, расписаний импортировано: ${events.length}.`, cls: "fc-congrats" });
  }
}

/**
 * Every card that breaks the short-card rule, across the vault (spec 0002 §7), with an optional
 * AI "Предложить разбиение" for each (spec 0005 §3.1): shown for approval, written only on Accept.
 */
export class RewriteListModal extends Modal {
  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle("Карточки к переработке");
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const seen = new Set<string>();
    const items: Array<{ ref: CardRef; reason: string }> = [];
    for (const ref of this.plugin.index.refs()) {
      const k = `${ref.path}:${ref.card.startLine}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const reason = shapeIssues(ref.card);
      if (reason) items.push({ ref, reason });
    }
    if (!items.length) {
      contentEl.createEl("p", { text: "Каждая карточка — это короткое утверждение. Перерабатывать нечего." });
      return;
    }
    contentEl.createEl("p", {
      text:
        `${items.length} карточ${items.length === 1 ? "ка" : items.length < 5 ? "ки" : "ек"}. Вынесите объяснение из cloze в строку под карточкой; она станет оборотом. ` +
        "Карточка сохраняет свою историю." +
        (this.plugin.settings.ai.enabled ? " «Предложить разбиение» просит ИИ предложить вариант на утверждение." : ""),
    });
    const ul = contentEl.createEl("ul", { cls: "fc-issue-list" });
    for (const { ref, reason } of items.slice(0, 200)) {
      const li = ul.createEl("li");
      const a = li.createEl("a", { text: `${ref.path}:${ref.card.startLine + 1}` });
      a.onclick = () => openAt(this.app, ref.path, ref.card.startLine + 1);
      li.createSpan({ text: ` — ${reason}`, cls: "fc-muted" });
      li.createDiv({ text: ref.card.sourceLines[0].trim().slice(0, 160), cls: "fc-issue-text" });
      if (this.plugin.settings.ai.enabled) {
        const btn = li.createEl("button", { text: "Предложить разбиение", cls: "fc-split-btn" });
        btn.onclick = async () => {
          btn.disabled = true;
          btn.setText("Thinking…");
          const s = await this.plugin.ai.suggestSplit(ref);
          btn.remove();
          if (!s) return;
          const proposed = composeCardSource(ref.card, s.front, s.back);
          const box = li.createDiv({ cls: "fc-split-proposal" });
          box.createEl("pre", { text: proposed });
          const row = box.createDiv({ cls: "fc-split-actions" });
          const accept = row.createEl("button", { text: "Принять", cls: "mod-cta" });
          accept.onclick = async () => {
            const ok = await this.plugin.editCard(ref, proposed);
            if (!ok) new Notice("Заметка изменилась после составления списка; переоткройте список и попробуйте снова.");
            else {
              new Notice("Карточка переработана.");
              this.render();
            }
          };
          row.createEl("button", { text: "Отклонить" }).onclick = () => box.remove();
        };
      }
    }
    if (items.length > 200) contentEl.createDiv({ cls: "fc-muted", text: `…и ещё ${items.length - 200}.` });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
