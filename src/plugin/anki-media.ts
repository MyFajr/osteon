/**
 * "Скопировать картинки Anki в хранилище" (desktop only): a big shared deck is exported from Anki without
 * media (a package with media can be too large to import), and this copies just the pictures its
 * imported cards embed, straight from Anki's own collection.media folder.
 */
import { App, FileSystemAdapter, Modal, Notice, Platform, Setting } from "obsidian";
import { planMediaCopy } from "../core/anki/convert";
import type FlashcardsPlugin from "../main";

type NodeFs = typeof import("fs");
type NodePath = typeof import("path");
type NodeOs = typeof import("os");

function node(): { fs: NodeFs; path: NodePath; os: NodeOs } | null {
  if (!Platform.isDesktopApp) return null;
  const req = (window as unknown as { require?: (m: string) => unknown }).require;
  if (!req) return null;
  return { fs: req("fs") as NodeFs, path: req("path") as NodePath, os: req("os") as NodeOs };
}

/** Anki's collection.media folders on this computer, one per profile. */
export function ankiMediaFolders(): Array<{ profile: string; dir: string }> {
  const n = node();
  if (!n) return [];
  const { fs, path, os } = n;
  const roots = [
    path.join(os.homedir(), "Library/Application Support/Anki2"),
    process.env.APPDATA ? path.join(process.env.APPDATA, "Anki2") : "",
    path.join(os.homedir(), ".local/share/Anki2"),
  ].filter((r) => r && fs.existsSync(r));
  const out: Array<{ profile: string; dir: string }> = [];
  for (const root of roots) {
    for (const profile of fs.readdirSync(root)) {
      const dir = path.join(root, profile, "collection.media");
      if (fs.existsSync(dir)) out.push({ profile, dir });
    }
  }
  return out;
}

/**
 * Vault paths of pictures that imported Anki notes embed but that aren't in the vault yet. Checked on
 * disk, not in Obsidian's file list, which can lag behind files moved or deleted outside Obsidian.
 */
function missingEmbeds(app: App): string[] {
  const n = node();
  const base = app.vault.adapter instanceof FileSystemAdapter ? app.vault.adapter.getBasePath() : "";
  const onDisk = (rel: string) => (n && base ? n.fs.existsSync(n.path.join(base, rel)) : !!app.vault.getAbstractFileByPath(rel));
  const missing = new Set<string>();
  for (const f of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(f);
    if (!cache?.frontmatter?.["anki-deck"]) continue;
    for (const e of cache.embeds ?? []) {
      const link = e.link.split("#")[0];
      if (!/\/media\//.test(link) || onDisk(link)) continue;
      missing.add(link);
    }
  }
  return [...missing];
}

export class AnkiMediaModal extends Modal {
  private dir = "";

  constructor(
    app: App,
    private plugin: FlashcardsPlugin,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.setTitle("Скопировать картинки Anki в хранилище");
    const n = node();
    if (!n || !(this.app.vault.adapter instanceof FileSystemAdapter)) {
      contentEl.createEl("p", { text: "Работает только в настольной версии. Запустите на компьютере; картинки затем синхронизируются на ваш телефон." });
      return;
    }
    const missing = missingEmbeds(this.app);
    if (!missing.length) {
      contentEl.createEl("p", { text: "Все картинки, которые используют импортированные карточки Anki, уже в хранилище." });
      return;
    }
    contentEl.createEl("p", {
      text: `${missing.length.toLocaleString()} картинок, используемых импортированными карточками Anki, пока нет в хранилище. Выберите папку медиа Anki (профиль, из которого шёл импорт), чтобы скопировать их. В самом Anki ничего не меняется.`,
    });
    const found = ankiMediaFolders();
    this.dir = found[0]?.dir ?? "";
    if (found.length)
      new Setting(contentEl).setName("Профиль Anki").addDropdown((d) => {
        for (const f of found) d.addOption(f.dir, f.profile);
        d.setValue(this.dir).onChange((v) => (this.dir = v));
      });
    new Setting(contentEl)
      .setName("Или путь к папке")
      .setDesc("Папка collection.media, если вашей нет в списке.")
      .addText((t) => t.setPlaceholder("/path/to/collection.media").onChange((v) => (this.dir = v.trim() || found[0]?.dir || "")));
    new Setting(contentEl).addButton((b) =>
      b.setButtonText("Копировать картинки").setCta().onClick(() => {
        this.close();
        void copyPictures(this.plugin, this.dir, missing);
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

async function copyPictures(plugin: FlashcardsPlugin, dir: string, missing: string[]): Promise<void> {
  const n = node()!;
  const { fs, path } = n;
  if (!dir || !fs.existsSync(dir)) {
    new Notice("Такой папки медиа Anki не существует.");
    return;
  }
  const base = (plugin.app.vault.adapter as FileSystemAdapter).getBasePath();
  const byName = new Map<string, string[]>(); // vault file name → vault paths wanting it
  for (const p of missing) {
    const name = p.slice(p.lastIndexOf("/") + 1);
    byName.set(name, [...(byName.get(name) ?? []), p]);
  }
  const { copy, notFound } = planMediaCopy(byName.keys(), fs.readdirSync(dir));
  const notice = new Notice("Копирование картинок…", 0);
  let done = 0;
  let bytes = 0;
  for (const [orig, safe] of copy) {
    for (const rel of byName.get(safe) ?? []) {
      const dest = path.join(base, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(dir, orig), dest);
      bytes += fs.statSync(dest).size;
    }
    if (++done % 250 === 0) {
      notice.setMessage(`Копирование картинок… ${done.toLocaleString()} / ${copy.length.toLocaleString()}`);
      await new Promise((r) => window.setTimeout(r, 0));
    }
  }
  notice.hide();
  new Notice(
    `Скопировано ${done.toLocaleString()} картинок (${(bytes / 1e9).toFixed(2)} ГБ)` +
      (notFound.length ? `; ${notFound.length.toLocaleString()} не нашлось в той папке Anki.` : ".") +
      " Obsidian может потратить время на их индексацию в первый раз.",
    15000,
  );
}
