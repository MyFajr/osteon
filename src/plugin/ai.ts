/**
 * Optional AI helpers (spec 0005 §3), using the owner's own API key for the provider they pick
 * (Anthropic through its SDK; OpenAI, Gemini, OpenRouter or any OpenAI-compatible server otherwise):
 *  1. find hard terms on cards and write short definitions (cached per device in the vault,
 *     append-only, like the review log, so iCloud never merges a shared file);
 *  2. suggest how to split an overstuffed card into a short front and a back.
 * Never runs during review; nothing is written to a note without the owner's confirmation.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { App, Modal, normalizePath, Notice, requestUrl, Setting, TFile } from "obsidian";
import { z } from "zod";
import type { CardRef } from "../core/collection";
import { cardFaces } from "../core/faces";
import { linesFromBatch, planBatch, type BatchResult } from "../core/ai-batch";
import { AI_PROVIDERS, aiKeyId, chatBody, chatJson, chatUrl } from "../core/ai-providers";
import { formatAiCard, formatAiTerm, parseAiGlossary } from "../core/terms";
import type FlashcardsPlugin from "../main";
import { getSecret, pullKeyFile } from "./secrets";


const BATCH = 10;
const AUTO_LIMIT = 30;
/** From this many cards, offer the Message Batches API (half price, results within 24 hours). */
const BATCH_SUGGEST = 300;
/** Off for 1.0: batch mode has never run against the live service. Turn on once it has. */
const BATCH_OFFERED = false;

/** A submitted batch, saved in the vault so results are collected after a restart or on another device. */
interface PendingBatch {
  id: string;
  model: string;
  created: string;
  cards: Record<string, string[]>;
}

/** Rough per-card cost in USD (about 400 input + 200 output tokens), for the confirm dialog. */
const PER_CARD: Record<string, number> = {
  "claude-opus-5": 0.007,
  "claude-sonnet-5": 0.0028,
  "claude-haiku-4-5": 0.0014,
};

const TermsSchema = z.object({
  cards: z.array(
    z.object({
      id: z.string(),
      terms: z.array(z.object({ term: z.string(), definition: z.string() })),
    }),
  ),
});

const ExplainSchema = z.object({ explanation: z.string(), hook: z.string(), relevant_notes: z.array(z.string()) });

/** Saved after an explanation: the notes the model judged worth opening (paths, one per line). */
const NOTES_MARK = "\n<!--notes\n";

const AskSchema = z.object({ answer: z.string(), note_issue: z.string(), relevant_notes: z.array(z.string()) });

const ASK_SYSTEM = [
  "Студент повторяет одну флеш-карточку и задаёт вопрос по ней.",
  "answer: отвечай напрямую, своими словами и на основе достоверных знаний, максимум 120 слов простого Markdown (короткие списки допустимы, без заголовков). Если не уверен — так и скажи, вместо того чтобы угадывать.",
  "Тебе также дан фрагмент заметки студента, в которой написана карточка. Это контекст, а не источник: в нём могут быть ошибки, поэтому never повторяй утверждение только потому, что оно есть в заметке.",
  "note_issue: если заметка утверждает что-то, противоречащее достоверным фактам, и это важно для карточки или вопроса, скажи максимум в 40 словах, что написано в заметке и что верно. Иначе верни пустую строку. Не помечай формулировки, пропуски или стиль.",
  "relevant_notes: из списка заголовков заметок студента выбери те, что стоит открыть по этому вопросу, скопировав их в точности. Пустой список, если ничего не подходит.",
].join(" ");

/** One exchange in the AI helper panel. */
export interface AskTurn {
  question: string;
  answer: string;
  /** Where the student's note disagrees with the facts, if it does. */
  noteIssue: string;
  /** Paths of the student's notes worth opening for this question. */
  notes: string[];
}

const EXPLAIN_SYSTEM = [
  "Студент-медик всё время ошибается на этой карточке. Помоги сделать так, чтобы она запомнилась.",
  "explanation: максимум в 60 словах и простым языком объясни, почему ответ именно такой (механизм, анатомия или логика).",
  "hook: одна короткая мнемоника до 25 слов (мнемоническое правило, образ для воображения или противопоставление тому, с чем её путают).",
  "Используй только достоверные факты и не выходи за рамки того, что сказано в карточке; если карточка двусмысленна или ты не уверен — так и скажи, вместо того чтобы угадывать.",
  "Простой Markdown, без заголовков.",
  "relevant_notes: тебе также даны заголовки заметок самого студента, найденные по грубому совпадению слов, поэтому многие не по теме. Скопируй в точности только заголовки, которые действительно о предмете этой карточки; пустой список, если таких нет.",
].join(" ");

const SplitSchema = z.object({
  front: z.string(),
  back: z.array(z.string()),
});

const TERMS_SYSTEM = [
  "Ты помогаешь студенту-выпускнику медицинского вуза, готовящемуся к ортопедической хирургии и занимающемуся по флеш-карточкам.",
  "Для каждой карточки перечисли термины, которые студент мог бы не знать или перепутать: эпонимы, аббревиатуры,",
  "классификации, редко встречающиеся анатомические, рентгенологические или клинические термины, а также названия препаратов.",
  "Пропускай бытовые слова и термины, которые знает каждый студент-медик (например: fracture, artery, femur, pain).",
  "Перечисляй только термины, встречающиеся в тексте карточки, в их исходном написании. Для каждого дай простое, точное,",
  "нейтральное определение из одного-двух предложений (до 40 слов). Если таких терминов в карточке нет, верни пустой список.",
].join(" ");

const SPLIT_SYSTEM = [
  "Ты переделываешь перегруженные флеш-карточки для студента-медика. Сохрани все факты; ничего не добавляй.",
  "Верни краткую утвердительную лицевую сторону примерно из 10-15 слов, содержащую один факт, ровно с одним ==cloze== вокруг",
  "ключевого ответа (1-4 слова). Объяснение и прочие детали перенеси в 1-4 короткие строки обратной стороны.",
  "По возможности сохраняй формулировки студента. Только простой Markdown; сохраняй [[links]] и ![[images]] без изменений.",
].join(" ");

export class AiService {
  private running = false;
  private lastStatus = "";

  constructor(private plugin: FlashcardsPlugin) {}

  private get app(): App {
    return this.plugin.app;
  }

  private get keyId(): string {
    return aiKeyId(this.plugin.settings.ai.provider);
  }

  private get isAnthropic(): boolean {
    return this.plugin.settings.ai.provider === "anthropic";
  }

  /** The model in use, as the provider names it. */
  private get modelName(): string {
    const ai = this.plugin.settings.ai;
    return this.isAnthropic ? ai.model : ai.otherModel.trim();
  }

  /** Ready to call: a key (a local "custom" server needs none), and for other providers a model and address. */
  hasKey(): boolean {
    const ai = this.plugin.settings.ai;
    if (this.isAnthropic) return !!getSecret(this.app, this.keyId);
    if (!this.modelName || !chatUrl(ai.provider, ai.baseUrl)) return false;
    return ai.provider === "custom" || !!getSecret(this.app, this.keyId);
  }

  /** With key syncing on, take the key another device saved (it may arrive after startup). */
  async pullKey(): Promise<void> {
    if (!this.plugin.settings.ai.syncKey) return;
    await pullKeyFile(this.app, this.plugin.manifest.dir ?? "", this.keyId);
  }

  private client(): Anthropic {
    // The key belongs to the owner and stays on this device; Obsidian runs in a browser engine.
    return new Anthropic({ apiKey: getSecret(this.app, this.keyId), dangerouslyAllowBrowser: true, maxRetries: 2 });
  }

  /** Model-specific request options: Opus 5 gets server-side refusal fallbacks and low effort. */
  private modelParams(): Record<string, unknown> {
    const model = this.plugin.settings.ai.model;
    if (model === "claude-opus-5") return { model, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", effort: "low" };
    if (model === "claude-sonnet-5") return { model, effort: "low" };
    return { model };
  }

  /** One request to an OpenAI-compatible provider; the reply is checked against the same schema. */
  private async callChat<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    const ai = this.plugin.settings.ai;
    const key = getSecret(this.app, this.keyId);
    const res = await requestUrl({
      url: chatUrl(ai.provider, ai.baseUrl),
      method: "POST",
      contentType: "application/json",
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      body: JSON.stringify(chatBody(this.modelName, system, user, z.toJSONSchema(schema))),
      throw: false,
    });
    if (res.status === 401 || res.status === 403) throw new Error("ключ API отклонён.");
    if (res.status === 429) throw new Error("превышен лимит запросов; попробуйте через минуту.");
    if (res.status < 200 || res.status >= 300) {
      let msg = "";
      try {
        msg = (res.json as { error?: { message?: string } })?.error?.message ?? "";
      } catch {
        // not JSON
      }
      throw new Error(`Ошибка API ${res.status} ${msg}`.trim());
    }
    const parsed = schema.safeParse(chatJson(res.json));
    if (!parsed.success) throw new Error("Ответ не удалось разобрать.");
    return parsed.data;
  }

  private async call<T>(system: string, user: string, schema: z.ZodType<T>): Promise<T> {
    if (!this.isAnthropic) return this.callChat(system, user, schema);
    const format = betaZodOutputFormat(schema);
    const p = this.modelParams();
    const { effort, ...rest } = p as { effort?: string; model: string };
    let res;
    try {
      res = await this.client().beta.messages.parse({
        ...(rest),
        max_tokens: 8000,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format, ...(effort ? { effort: effort as "low" } : {}) },
      });
    } catch (e) {
      // parse() throws before we see stop_reason when the reply was cut off or declined.
      if (e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError)) {
        throw new Error("Ответ не удалось прочитать (возможно, он был обрезан или отклонён).");
      }
      throw e;
    }
    if (res.stop_reason === "refusal") throw new Error("Модель отклонила этот запрос.");
    if (res.stop_reason === "max_tokens") throw new Error("Ответ оборвался (слишком длинный).");
    if (!res.parsed_output) throw new Error("Ответ не удалось разобрать.");
    return res.parsed_output;
  }

  // ---- the glossary files ---------------------------------------------------------------------

  private get ownFile(): string {
    return normalizePath(`${this.plugin.terms.aiFolder}/${this.plugin.logs.device}.md`);
  }

  private async glossaryTexts(): Promise<string[]> {
    const out: string[] = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (f.path.startsWith(this.plugin.terms.aiFolder + "/")) out.push(await this.app.vault.cachedRead(f));
    }
    return out;
  }

  private async append(lines: string[]): Promise<void> {
    if (!lines.length) return;
    const { vault } = this.app;
    let dir = "";
    for (const part of this.plugin.terms.aiFolder.split("/")) {
      dir = dir ? `${dir}/${part}` : part;
      if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => undefined);
    }
    const text = lines.join("\n") + "\n";
    const existing = vault.getAbstractFileByPath(this.ownFile);
    if (existing instanceof TFile) await vault.append(existing, text);
    else await vault.create(this.ownFile, `# fc-ai-glossary v1 · device ${this.plugin.logs.device} · do not edit by hand\n\n${text}`);
  }

  /** Cards (one per note block) not yet looked at, outside excluded folders. */
  async pendingCards(): Promise<CardRef[]> {
    const done = parseAiGlossary(await this.glossaryTexts()).cards;
    for (const b of await this.pendingBatches()) for (const hs of Object.values(b.batch.cards)) for (const h of hs) done.add(h);
    const excluded = this.plugin.settings.ai.excludeFolders;
    const seen = new Set<string>();
    const out: CardRef[] = [];
    for (const ref of this.plugin.index.refs()) {
      if (ref.card.type === "occlusion") continue;
      if (excluded.some((f) => ref.path.startsWith(f + "/"))) continue;
      const h = ref.card.hash;
      if (done.has(h) || seen.has(h)) continue;
      seen.add(h);
      out.push(ref);
    }
    return out;
  }

  statusText(): string {
    if (!this.hasKey()) return this.isAnthropic ? "Сначала добавьте ключ API." : "Сначала добавьте ключ API и название модели.";
    return this.lastStatus || "Рассматривает ранее не виденные карточки и добавляет определения сложных терминов.";
  }

  // ---- finding terms ----------------------------------------------------------------------------

  private cardText(ref: CardRef): string {
    const f = cardFaces(ref.card, ref.slot);
    const answer = f.kind === "cloze" ? f.answer.replace(/==/g, "") : `${f.question} — ${f.answer}`;
    return `${answer}${f.extra ? `\n${f.extra}` : ""}`.replace(/!\[\[[^\]]*\]\]/g, "").slice(0, 1200);
  }

  private async process(cards: CardRef[]): Promise<number> {
    const model = this.modelName;
    const date = new Date().toISOString().slice(0, 10);
    let found = 0;
    for (let i = 0; i < cards.length; i += BATCH) {
      const batch = cards.slice(i, i + BATCH);
      const user = batch.map((r) => `<card id="${r.card.hash}">\n${this.cardText(r)}\n</card>`).join("\n");
      const out = await this.call(TERMS_SYSTEM, `Cards:\n${user}`, TermsSchema);
      const lines: string[] = [];
      for (const c of out.cards) {
        for (const t of c.terms) {
          if (!t.term.trim() || !t.definition.trim()) continue;
          lines.push(formatAiTerm(t.term, t.definition, model, date));
          found++;
        }
      }
      // Mark every card in the batch as looked at, even those with no hard terms.
      for (const r of batch) lines.push(formatAiCard(r.card.hash));
      await this.append(lines);
    }
    return found;
  }

  /** Background pass for a few new cards (never a large, costly run without asking). */
  async autoRun(): Promise<void> {
    await this.pullKey();
    const s = this.plugin.settings.ai;
    if (s.enabled && this.isAnthropic && this.hasKey()) await this.collectBatches().catch((e) => console.error("Flashcards: collecting AI batches failed", e));
    if (!s.enabled || !s.autoRun || !this.hasKey() || this.running) return;
    const pending = await this.pendingCards();
    if (!pending.length || pending.length > AUTO_LIMIT) {
      if (pending.length > AUTO_LIMIT) this.lastStatus = `${pending.length} карточек ещё не рассмотрено. Нажмите «Запустить», чтобы их обработать.`;
      return;
    }
    await this.run(pending, false);
  }

  async runWithConfirm(): Promise<void> {
    if (!this.hasKey()) {
      new Notice("Сначала добавьте ключ API в настройках Osteon.");
      return;
    }
    if (!this.plugin.settings.ai.enabled) {
      new Notice("Сначала включите «Использовать ИИ» в настройках Osteon.");
      return;
    }
    const pending = await this.pendingCards();
    if (!pending.length) {
      new Notice("Все карточки уже рассмотрены.");
      return;
    }
    const cost = (PER_CARD[this.plugin.settings.ai.model] ?? 0.007) * pending.length;
    const usd = (x: number) => `$${x < 0.01 ? "0.01" : x.toFixed(2)}`;
    const big = BATCH_OFFERED && this.isAnthropic && pending.length >= BATCH_SUGGEST;
    const where = AI_PROVIDERS[this.plugin.settings.ai.provider].label;
    new ConfirmModal(
      this.app,
      `Посмотреть ${pending.length} карточек?`,
      (this.isAnthropic
        ? `Их текст будет отправлен в API Anthropic через ${this.modelName}. Ожидаемая стоимость: около ${usd(cost)} (списывается с вашего API-аккаунта). `
        : `Их текст будет отправлен в ${where} через ${this.modelName}. Стоимость зависит от провайдера и модели. `) +
        "Каждая карточка рассматривается только один раз." +
        (big ? ` Для такого объёма партия (Batch) обойдётся примерно вдвое дешевле (${usd(cost / 2)}), а определения придут в течение 24 часов (обычно быстрее); они добавляются автоматически.` : ""),
      () => void this.run(pending, true),
      big ? { label: "Партия (вдвое дешевле)", onClick: () => void this.submitBatch(pending) } : undefined,
    ).open();
  }

  private async run(cards: CardRef[], manual: boolean): Promise<void> {
    if (this.running) return;
    this.running = true;
    const notice = manual ? new Notice(`Просматриваю ${cards.length} карточек…`, 0) : null;
    try {
      const found = await this.process(cards);
      this.lastStatus = `Последний запуск: ${cards.length} карточек, добавлено ${found} определений терминов.`;
      await this.plugin.terms.rebuild();
      if (manual) new Notice(this.lastStatus);
    } catch (e) {
      this.lastStatus = `Последний запуск завершился ошибкой: ${describe(e)}`;
      console.error("Flashcards: AI term pass failed", e);
      if (manual) new Notice(this.lastStatus, 10000);
    } finally {
      notice?.hide();
      this.running = false;
    }
  }

  // ---- batch mode (big first runs) ---------------------------------------------------------------

  private get batchFolder(): string {
    return normalizePath(`${this.plugin.terms.aiFolder}/batches`);
  }

  private async pendingBatches(): Promise<Array<{ path: string; batch: PendingBatch }>> {
    const { adapter } = this.app.vault;
    if (!(await adapter.exists(this.batchFolder))) return [];
    const out: Array<{ path: string; batch: PendingBatch }> = [];
    for (const f of (await adapter.list(this.batchFolder)).files.filter((x) => x.endsWith(".json"))) {
      try {
        out.push({ path: f, batch: JSON.parse(await adapter.read(f)) as PendingBatch });
      } catch {
        // A half-synced file: try again next time.
      }
    }
    return out;
  }

  /** Send every card in one Message Batches submission; results are collected by `collectBatches`. */
  async submitBatch(cards: CardRef[]): Promise<void> {
    if (this.running) return;
    this.running = true;
    const notice = new Notice(`Отправка ${cards.length} карточек партией…`, 0);
    try {
      const model = this.plugin.settings.ai.model;
      const plan = planBatch(cards.map((r) => ({ hash: r.card.hash, text: this.cardText(r) })), BATCH);
      // The structured-output schema as plain JSON (the helper object also carries a parser).
      const format = JSON.parse(JSON.stringify(betaZodOutputFormat(TermsSchema))) as Record<string, unknown>;
      const effort = model === "claude-haiku-4-5" ? undefined : "low";
      const batch = await this.client().beta.messages.batches.create({
        requests: plan.requests.map((r) => ({
          custom_id: r.customId,
          params: {
            model,
            max_tokens: 8000,
            system: TERMS_SYSTEM,
            messages: [{ role: "user", content: r.user }],
            output_config: { format, ...(effort ? { effort } : {}) },
          } as never,
        })),
      });
      const { adapter } = this.app.vault;
      if (!(await adapter.exists(this.batchFolder))) await this.app.vault.createFolder(this.batchFolder).catch(() => undefined);
      const record: PendingBatch = { id: batch.id, model, created: new Date().toISOString(), cards: plan.cards };
      await adapter.write(normalizePath(`${this.batchFolder}/${batch.id}.json`), JSON.stringify(record));
      this.lastStatus = `Партия отправлена: ${cards.length} карточек в ${plan.requests.length} запросах. Определения добавятся автоматически по завершении (в течение 24 часов).`;
      new Notice(this.lastStatus, 10000);
    } catch (e) {
      this.lastStatus = `Партию не удалось отправить: ${describe(e)}`;
      console.error("Flashcards: AI batch submit failed", e);
      new Notice(this.lastStatus, 10000);
    } finally {
      notice.hide();
      this.running = false;
    }
  }

  /** Collect finished batches: write their definitions, mark their cards, forget the batch. */
  async collectBatches(): Promise<void> {
    const pending = await this.pendingBatches();
    if (!pending.length) return;
    const client = this.client();
    const date = new Date().toISOString().slice(0, 10);
    for (const { path, batch } of pending) {
      const info = await client.beta.messages.batches.retrieve(batch.id);
      if (info.processing_status !== "ended") continue;
      const results: BatchResult[] = [];
      for await (const item of await client.beta.messages.batches.results(batch.id)) {
        const r = item.result;
        if (r.type !== "succeeded" || r.message.stop_reason === "refusal" || r.message.stop_reason === "max_tokens") {
          results.push({ customId: item.custom_id });
          continue;
        }
        const text = r.message.content.find((b) => b.type === "text");
        results.push({ customId: item.custom_id, json: text && "text" in text ? text.text : undefined });
      }
      const out = linesFromBatch(results, batch.cards, batch.model, date);
      await this.append(out.lines);
      await this.app.vault.adapter.remove(path);
      this.lastStatus =
        `Партия завершена: ${out.cardsDone} карточек, добавлено ${out.terms} определений терминов` +
        (out.failedRequests ? `; ${out.failedRequests} запросов не удались, эти карточки будут повторены при следующем запуске.` : ".");
      new Notice(this.lastStatus, 10000);
      await this.plugin.terms.rebuild();
    }
  }

  // ---- explaining a card that keeps being missed (Weak spots) ---------------------------------

  private get explainFile(): string {
    return normalizePath(`${this.plugin.terms.aiFolder}/explanations-${this.plugin.logs.device}.json`);
  }

  private explanations?: Map<string, string>;

  /** Saved explanations from every device (each device writes only its own file). */
  private async loadExplanations(): Promise<Map<string, string>> {
    if (this.explanations) return this.explanations;
    const map = new Map<string, string>();
    const adapter = this.app.vault.adapter;
    try {
      const folder = normalizePath(this.plugin.terms.aiFolder);
      const files = (await adapter.exists(folder)) ? (await adapter.list(folder)).files : [];
      for (const f of files) {
        if (!/\/explanations-[^/]+\.json$/.test(f)) continue;
        try {
          for (const [k, v] of Object.entries(JSON.parse(await adapter.read(f)) as Record<string, string>)) if (typeof v === "string") map.set(k, v);
        } catch {
          // An unreadable file (mid-sync) only means those explanations are asked for again.
        }
      }
    } catch {
      // No folder yet.
    }
    return (this.explanations = map);
  }

  /** The saved explanation for this version of the card, if there is one (no API call). */
  async savedExplanation(ref: CardRef): Promise<string | undefined> {
    return (await this.loadExplanations()).get(`${ref.uid}|${ref.card.hash}`);
  }

  /** Why the answer is what it is, plus a memory hook. Asked once per card version, then saved. */
  async explain(ref: CardRef): Promise<string | null> {
    const saved = await this.savedExplanation(ref);
    if (saved) return saved;
    await this.pullKey();
    if (!this.hasKey() || !this.plugin.settings.ai.enabled) {
      new Notice("Включите ИИ и добавьте ключ API в настройках Osteon, чтобы получать объяснения.");
      return null;
    }
    if (this.plugin.settings.ai.excludeFolders.some((f) => ref.path.startsWith(f + "/"))) {
      new Notice("Эта карточка в папке, содержимое которой никогда не отправляется в API.");
      return null;
    }
    try {
      const candidates = this.noteCandidates(ref);
      const titles = candidates.map((f) => `- ${f.basename}`).join("\n") || "(none)";
      const out = await this.call(EXPLAIN_SYSTEM, `Card:\n${this.cardText(ref)}\n\nThe student's note titles:\n${titles}`, ExplainSchema);
      const picked = new Set(out.relevant_notes.map((t) => t.trim().toLowerCase()));
      const notes = candidates.filter((f) => picked.has(f.basename.toLowerCase())).map((f) => f.path);
      const text = `${out.explanation.trim()}\n\n**Зацепка:** ${out.hook.trim()}${notes.length ? `${NOTES_MARK}${notes.join("\n")}\n-->` : ""}`;
      const map = await this.loadExplanations();
      map.set(`${ref.uid}|${ref.card.hash}`, text);
      const adapter = this.app.vault.adapter;
      let own: Record<string, string> = {};
      try {
        if (await adapter.exists(this.explainFile)) own = JSON.parse(await adapter.read(this.explainFile)) as Record<string, string>;
      } catch {
        own = {};
      }
      own[`${ref.uid}|${ref.card.hash}`] = text;
      const folder = normalizePath(this.plugin.terms.aiFolder);
      if (!(await adapter.exists(folder))) await this.app.vault.createFolder(folder).catch(() => undefined);
      await adapter.write(this.explainFile, JSON.stringify(own, null, 1));
      return text;
    } catch (e) {
      new Notice(`Объяснение не удалось: ${describe(e)}`, 8000);
      return null;
    }
  }

  /** Whether the helpers can run for this card right now; a short reason when they can't. */
  blockedReason(ref: CardRef): string | null {
    const ai = this.plugin.settings.ai;
    if (!ai.enabled || !this.hasKey()) return "Включите ИИ и добавьте ключ API в настройках Osteon, чтобы пользоваться помощником.";
    if (ai.excludeFolders.some((f) => ref.path.startsWith(f + "/"))) return "Эта карточка в папке, содержимое которой никогда не отправляется ИИ-провайдеру.";
    return null;
  }

  /** The lines of the card's note around the card, so answers can lean on the student's own note. */
  private async noteAround(ref: CardRef): Promise<string> {
    const file = this.app.vault.getFileByPath(ref.path);
    if (!file) return "";
    const lines = (await this.app.vault.cachedRead(file)).split("\n");
    const from = Math.max(0, ref.card.startLine - 25);
    const to = Math.min(lines.length, ref.card.endLine + 26);
    return lines
      .slice(from, to)
      .join("\n")
      .replace(/!\[\[[^\]]*\]\]/g, "")
      .replace(/\s\^fc-[a-z0-9]{8}/g, "")
      .slice(0, 3000);
  }

  /**
   * The student's notes that could matter for a card or a question about it: the card's own note
   * (not for imported decks, whose notes are only card storage), the notes the card is linked to
   * or mentions, and notes the question itself names.
   */
  noteCandidates(ref: CardRef, question = ""): TFile[] {
    const out: TFile[] = [];
    const add = (f: TFile | null | undefined) => {
      if (f && !out.some((x) => x.path === f.path)) out.push(f);
    };
    const own = this.app.vault.getFileByPath(ref.path);
    if (own && !this.app.metadataCache.getFileCache(own)?.frontmatter?.["anki-deck"]) add(own);
    for (const f of this.plugin.relatedFor(ref)) add(f);
    if (question) for (const f of this.plugin.terms.relatedNotes(question, [ref.path, ...out.map((f) => f.path)], 3)) add(f);
    // Then notes whose titles share a distinctive word with the card's own sentence or the question
    // (the long Extra of an imported card names too many things in passing).
    for (const f of this.plugin.noteMatches(`${ref.card.front}\n${ref.card.answer}\n${question}`, 4)) add(f);
    return out.slice(0, 8);
  }

  /** A free question about one card (the side panel). Not saved; `history` carries earlier turns. */
  async ask(ref: CardRef, question: string, history: AskTurn[]): Promise<AskTurn> {
    await this.pullKey();
    const blocked = this.blockedReason(ref);
    if (blocked) throw new Error(blocked);
    const candidates = this.noteCandidates(ref, question);
    const earlier = history.map((t) => `Earlier question: ${t.question}\nEarlier answer: ${t.answer}`).join("\n\n");
    const user = [
      `Card:\n${this.cardText(ref)}`,
      `From the student's note (may contain mistakes):\n${await this.noteAround(ref)}`,
      `The student's note titles:\n${candidates.map((f) => `- ${f.basename}`).join("\n") || "(none)"}`,
      earlier,
      `Question: ${question}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      const out = await this.call(ASK_SYSTEM, user, AskSchema);
      const picked = new Set(out.relevant_notes.map((t) => t.trim().toLowerCase()));
      return {
        question,
        answer: out.answer.trim(),
        noteIssue: out.note_issue.trim(),
        notes: candidates.filter((f) => picked.has(f.basename.toLowerCase())).map((f) => f.path),
      };
    } catch (e) {
      throw new Error(describe(e));
    }
  }

  /** A saved explanation split into its text and the notes the model picked for it. */
  static splitExplanation(saved: string): { text: string; notes: string[] } {
    const at = saved.indexOf(NOTES_MARK);
    if (at < 0) return { text: saved, notes: [] };
    return { text: saved.slice(0, at), notes: saved.slice(at + NOTES_MARK.length).replace(/\n?-->\s*$/, "").split("\n").filter(Boolean) };
  }

  // ---- splitting an overstuffed card ------------------------------------------------------------

  async suggestSplit(ref: CardRef): Promise<{ front: string; back: string[] } | null> {
    await this.pullKey();
    if (!this.hasKey() || !this.plugin.settings.ai.enabled) {
      new Notice("Включите ИИ и добавьте ключ API в настройках Osteon, чтобы получать предложения.");
      return null;
    }
    const excluded = this.plugin.settings.ai.excludeFolders;
    if (excluded.some((f) => ref.path.startsWith(f + "/"))) {
      new Notice("Эта карточка в папке, содержимое которой никогда не отправляется в API.");
      return null;
    }
    const src = ref.card.sourceLines
      .join("\n")
      .replace(/\s\^fc-[a-z0-9]{8}/g, "")
      .replace(/<!--SR:.*?-->/g, "");
    try {
      const out = await this.call(SPLIT_SYSTEM, `Card:\n${src}`, SplitSchema);
      // It must still be a card: a non-empty front with exactly one ==cloze== (for cloze cards).
      const clozes = out.front.match(/==[^=]+==/g) ?? [];
      if (!out.front.trim() || (ref.card.type === "cloze" && clozes.length !== 1)) {
        new Notice("В предложении не ровно один cloze, поэтому оно не показано. Попробуйте снова или перепишите вручную.", 8000);
        return null;
      }
      return out;
    } catch (e) {
      new Notice(`Предложение не удалось: ${describe(e)}`, 8000);
      return null;
    }
  }
}

function describe(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) return "ключ API отклонён.";
  if (e instanceof Anthropic.RateLimitError) return "превышен лимит запросов; попробуйте через минуту.";
  if (e instanceof Anthropic.APIConnectionError) return "нет соединения с ИИ-провайдером.";
  if (e instanceof Anthropic.APIError) return `Ошибка API ${e.status ?? ""} ${e.message}`.trim();
  return e instanceof Error ? e.message : String(e);
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private heading: string,
    private body: string,
    private onYes: () => void,
    /** An extra choice beside Run (e.g. "Партия (вдвое дешевле)"). */
    private alt?: { label: string; onClick: () => void },
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(this.heading);
    this.contentEl.createEl("p", { text: this.body });
    const row = new Setting(this.contentEl).addButton((b) => b.setButtonText("Отмена").onClick(() => this.close()));
    if (this.alt) {
      const alt = this.alt;
      row.addButton((b) =>
        b.setButtonText(alt.label).onClick(() => {
          this.close();
          alt.onClick();
        }),
      );
    }
    row.addButton((b) =>
        b
          .setButtonText("Запустить")
          .setCta()
          .onClick(() => {
            this.close();
            this.onYes();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
