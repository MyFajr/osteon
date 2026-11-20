/**
 * Anki's Add window (key A): pick a deck and a note, type a card, and it's appended to the
 * note. Stays open for the next card, as in Anki.
 */
import { App, Modal, normalizePath, Notice, Setting, TFile } from "obsidian";
import { deckFor, inDeck, renamedDeck } from "../../core/collection";
import { parseNote } from "../../core/parser";
import type FlashcardsPlugin from "../../main";

const LAST_NOTE_KEY = "flashcards-add-last-note";
const NEW_NOTE = "__new__";

export class AddCardModal extends Modal {
  private deck: string;
  private notePath = "";
  private newName = "";

  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
    deck: string | null,
  ) {
    super(app);
    const decks = this.decks();
    this.deck = deck && decks.some((d) => d.toLowerCase() === deck.toLowerCase()) ? deck : decks[0] ?? "";
  }

  private decks(): string[] {
    return [...new Set(this.plugin.index.refs().map((r) => r.deck))].sort((a, b) => a.localeCompare(b));
  }

  private notesIn(deck: string): string[] {
    const paths = new Set<string>();
    for (const r of this.plugin.index.refs()) if (r.deck.toLowerCase() === deck.toLowerCase()) paths.add(r.path);
    // Sub-deck notes come after the deck's own notes.
    for (const r of this.plugin.index.refs()) if (inDeck(r.deck, deck)) paths.add(r.path);
    return [...paths];
  }

  onOpen(): void {
    this.setTitle("Добавить карточку");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const decks = this.decks();
    new Setting(contentEl).setName("Колода").addDropdown((d) => {
      for (const deck of decks) d.addOption(deck, deck.split("/").join(" › "));
      d.setValue(this.deck).onChange((v) => {
        this.deck = v;
        this.notePath = "";
        this.render();
      });
    });

    const notes = this.notesIn(this.deck);
    const last: unknown = this.app.loadLocalStorage(LAST_NOTE_KEY);
    if (!this.notePath) this.notePath = typeof last === "string" && notes.includes(last) ? last : notes[0] ?? NEW_NOTE;
    new Setting(contentEl).setName("Note").addDropdown((d) => {
      for (const p of notes) d.addOption(p, p.replace(/\.md$/, ""));
      d.addOption(NEW_NOTE, "Новая заметка…");
      d.setValue(this.notePath).onChange((v) => {
        this.notePath = v;
        this.render();
      });
    });
    if (this.notePath === NEW_NOTE) {
      new Setting(contentEl)
        .setName("Имя новой заметки")
        .setDesc(`Created in ${this.folderFor(this.deck) || "корне хранилища"}, tagged #flashcards.`)
        .addText((t) => t.setValue(this.newName).onChange((v) => (this.newName = v.trim())));
    }

    const ta = contentEl.createEl("textarea", { cls: "fc-edit-area fc-add-area" });
    ta.rows = 6;
    ta.placeholder =
      "Собственная связка ACL начинается на ==латеральном мыщелке бедренной кости==.\nОбъяснение в строках ниже станет оборотом.\n\n(или  Вопрос :: Ответ   ·   Термин ::: Определение)";
    const add = async () => {
      const text = ta.value.trim();
      if (!text) return;
      if (!parseNote(text).length) {
        new Notice("Это ещё не карточка: добавьте ==cloze== или Вопрос :: Ответ.");
        return;
      }
      const ok = await this.append(text);
      if (ok) {
        ta.value = "";
        ta.focus();
      }
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void add();
      }
    });
    new Setting(contentEl)
      .setDesc("Первая строка — лицевая сторона; строки под ней — обратная. ⌘/Ctrl+Enter добавляет и оставляет окно открытым.")
      .addButton((b) => b.setButtonText("Закрыть").onClick(() => this.close()))
      .addButton((b) => b.setButtonText("Добавить").setCta().onClick(() => void add()));
    window.setTimeout(() => ta.focus(), 0);
  }

  /** The folder a deck's new notes go in: the deck's folder when decks come from folders. */
  private folderFor(deck: string): string {
    const first = this.notesIn(deck)[0];
    if (first) return first.includes("/") ? first.slice(0, first.lastIndexOf("/")) : "";
    return deck === "Default" ? "" : deck;
  }

  private async append(card: string): Promise<boolean> {
    const { vault } = this.app;
    let file: TFile | null;
    if (this.notePath === NEW_NOTE) {
      if (!this.newName) {
        new Notice("Задайте имя новой заметки.");
        return false;
      }
      const folder = this.folderFor(this.deck);
      const path = normalizePath(`${folder ? folder + "/" : ""}${this.newName.replace(/[\\/:*?"<>|]/g, "-")}.md`);
      if (vault.getAbstractFileByPath(path)) {
        new Notice("Заметка с таким именем уже существует.");
        return false;
      }
      if (folder && !vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined);
      // If the folder alone wouldn't put the note in this deck (tag-based decks, such as imported
      // Anki decks), give it the deck's tag.
      const byFolder = renamedDeck(deckFor(path, []), this.plugin.settings.deckRenames);
      const tag = !this.deck || byFolder.toLowerCase() === this.deck.toLowerCase() ? "flashcards" : `flashcards/${this.deck.replace(/\s+/g, "-")}`;
      file = await vault.create(path, `---\ntags: [${tag}]\n---\n\n${card}\n`);
      this.notePath = file.path;
    } else {
      file = vault.getFileByPath(this.notePath);
      if (!file) {
        new Notice("Такой заметки больше нет.");
        return false;
      }
      await vault.process(file, (text) => `${text.replace(/\s*$/, "")}\n\n${card}\n`);
    }
    this.app.saveLocalStorage(LAST_NOTE_KEY, file.path);
    new Notice(`Добавлено в ${file.basename}.`);
    this.render();
    return true;
  }
}
