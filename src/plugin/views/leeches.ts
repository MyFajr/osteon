/** Leeches: cards forgotten again and again, each with a way out (rewrite, crowns, retry, drop). */
import { Component, ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from "obsidian";
import { cardFaces } from "../../core/faces";
import type { QueueItem } from "../../core/queue";
import type FlashcardsPlugin from "../../main";
import { EditCardModal } from "../modals/card";
import { renderWhenVisible } from "./lazy-render";

export const VIEW_LEECHES = "flashcards-leeches";

export class LeechesView extends ItemView {
  private component?: Component;

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: FlashcardsPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_LEECHES;
  }

  getDisplayText(): string {
    return "Leeches";
  }

  getIcon(): string {
    return "bug";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(this.plugin.events.on("changed", renderWhenVisible(this, () => this.render())));
    this.render();
  }

  async onClose(): Promise<void> {
    this.component?.unload();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("fc-leeches");
    this.component?.unload();
    this.component = new Component();
    this.component.load();
    if (!this.plugin.ready) {
      el.createDiv({ cls: "fc-muted", text: "Загрузка карточек…" });
      return;
    }
    const leeches = this.plugin.leeches();
    el.createEl("h3", { text: `Пиявки (${leeches.length})` });
    el.createEl("p", {
      cls: "fc-muted",
      text: "Карточки, которые вы всё забываете (число провалов дошло до порога пиявок колоды). Обычно так бывает, когда карточка требует слишком многого сразу: перепишите её, включите открытие ответов по одному или уберите её.",
    });
    if (!leeches.length) {
      el.createDiv({ cls: "fc-muted", text: "Сейчас пиявок нет." });
      return;
    }
    for (const item of leeches) this.row(el, item);
  }

  private row(parent: HTMLElement, item: QueueItem): void {
    const { ref, state } = item;
    const box = parent.createDiv({ cls: "fc-leech" });
    const meta = box.createDiv({ cls: "fc-leech-meta fc-muted" });
    meta.setText(
      [ref.deck.split("/").join(" › "), `${state?.card.lapses ?? 0} провалов`, state?.suspended ? "suspended" : "", state?.marked ? "★ помечена" : ""]
        .filter(Boolean)
        .join(" · "),
    );
    const faces = cardFaces(ref.card, ref.slot, this.plugin.crownSplitFor(ref));
    const md = (text: string, cls: string) =>
      void MarkdownRenderer.render(this.app, text, box.createDiv({ cls: `markdown-rendered ${cls}` }), ref.path, this.component!);
    md(faces.kind === "basic" ? `${faces.question}\n\n---\n\n${faces.answer}` : faces.answer, "fc-leech-card");
    const bar = box.createDiv({ cls: "fc-leech-actions" });
    const btn = (text: string, title: string, fn: () => Promise<void> | void, cta = false) => {
      const b = bar.createEl("button", { text, cls: cta ? "mod-cta" : "", attr: { "aria-label": title } });
      b.onclick = () => void fn();
    };
    btn("Rewrite", "Исправить карточку и вернуть в повторения", () => {
      new EditCardModal(this.app, this.plugin, ref, () => void this.plugin.resolveLeech(item, "retry", "Переработана и возвращена в повторения.")).open();
    }, true);
    if (ref.card.type === "cloze" && !this.plugin.isCrowned(ref)) {
      btn("🦴 Открывать по одному", "Открыть ответы по одному и вернуть в повторения", async () => {
        await this.plugin.setCrowns([ref], true);
        await this.plugin.resolveLeech(item, "retry", "Её ответы теперь открываются по одному. Возвращается в повторения.");
      });
    }
    btn("Попробовать снова", "Вернуть в занятия как есть", () => this.plugin.resolveLeech(item, "retry", "Возвращено в повторения."));
    btn("Drop", "Оставить приостановленной и убрать из этого списка", () => this.plugin.resolveLeech(item, "drop", "Исключена (приостановлена)."));
    btn("Открыть заметку", "Открыть заметку карточки", () => {
      const file = this.app.vault.getFileByPath(ref.path);
      if (file) void this.app.workspace.getLeaf("tab").openFile(file, { eState: { line: ref.card.startLine } });
      else new Notice("Заметка не найдена.");
    });
  }
}
