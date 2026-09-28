// Answer matching (§6.9) and briefings (§6.10): code first, match_answer only when needed.

import { all, blockedCard, Case, topic } from "../lib.ts";
import { answerQuestion } from "../../src/conversation/questions.ts";
import { replyBriefing, startBriefing } from "../../src/conversation/briefing.ts";
import { db } from "../../src/db.ts";
import { topicSame } from "../../src/prompts/conversation.ts";
import { llmJson } from "../../src/llm/gateway.ts";

function ans(name: string, options: string[], text: string, want: string | null | (string | null)[], maxModelCalls = 1): Case {
  const wants = Array.isArray(want) ? want : [want];
  return {
    id: `answers/${name}`,
    run: async () => {
      const t = topic("Test");
      const { question } = blockedCard({ topic_id: t.id, title: "Some card", question: "Which one?", options });
      const out = await answerQuestion(question.id, { text });
      return { out, calls: db().get(`SELECT count(*) n FROM llm_calls`)!.n };
    },
    check: (o) => all([wants.includes(o.out.option), `option ${o.out.option}, want ${wants.join(" or ")}`], [o.calls <= maxModelCalls, `${o.calls} model calls`]),
  };
}

function same(name: string, a: string, b: string, want: string): Case {
  return {
    id: `answers/topic-same-${name}`,
    run: () => {
      const p = topicSame({ a, b });
      return llmJson<any>("topic_same", p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version });
    },
    check: (o) => ({ pass: o.same === want, detail: `${o.same}: ${o.analysis}` }),
  };
}

export const cases: Case[] = [
  ans("code-digit", ["Use the forum estimate", "Leave it out"], "2", "Leave it out", 0),
  ans("code-word", ["Last year's accountant", "A new accountant"], "the first one", "Last year's accountant", 0),
  ans("model-paraphrase", ["Last year's accountant", "A new accountant"], "the one from last year I guess", "Last year's accountant"),
  ans("model-paraphrase-2", ["Use the forum estimate", "Leave it out"], "just skip that number for this kit", "Leave it out"),
  ans("model-free-text", ["Retry", "Cancel", "Add guidance"], "ask the shop by phone instead, their number is on the website", ["Add guidance", null]),
  ans("model-none-fits", ["Gardena", "Hozelock"], "neither, I'll decide next week", null),
  {
    id: "answers/briefing-three-questions",
    run: async () => {
      const t = topic("Garden");
      blockedCard({ topic_id: t.id, title: "A", question: "AquaLine doesn't publish its water use. What now?", options: ["Use the forum estimate", "Leave it out"] });
      blockedCard({ topic_id: t.id, title: "B", question: "Which accountant should get the documents?", options: ["Last year's accountant", "A new accountant"] });
      blockedCard({ topic_id: t.id, title: "C", question: "Request the paid extension to November?", options: ["Yes", "No"] });
      const b = startBriefing();
      const r1 = await replyBriefing(b.id, "one");
      const r2 = await replyBriefing(b.id, "the one from last year");
      const r3 = await replyBriefing(b.id, "skip");
      const qs = db().all(`SELECT status, answer_option FROM questions ORDER BY created_at`);
      return { b, r1, r2, r3, qs, calls: db().get(`SELECT count(*) n FROM llm_calls`)!.n };
    },
    check: (o) => all(
      [o.qs[0].answer_option === "Use the forum estimate", `q1 ${o.qs[0].answer_option}`],
      [o.qs[1].answer_option === "Last year's accountant", `q2 ${o.qs[1].answer_option}`],
      [o.qs[2].status === "open", `q3 ${o.qs[2].status}`],
      [o.calls <= 1, `${o.calls} model calls`],
      [o.r3.ended, "briefing did not end"],
    ),
  },
  same("yes", "Bike repair. Finding a shop that repairs the e-bike.", "E-bike service. Where to get the e-bike serviced and what it costs.", "yes"),
  same("no-same-area", "Raised bed irrigation. Drip kits for the raised beds.", "Balcony plants. Which flowers to plant on the south balcony.", "no"),
];
