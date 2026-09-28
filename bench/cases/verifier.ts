// Verifier (§5.8): one judge call per criterion, with harness-recorded facts. Mechanical: expected verdict.

import { Case } from "../lib.ts";
import { llmJson } from "../../src/llm/gateway.ts";
import { verifyCriterion } from "../../src/prompts/work.ts";
import { resultText } from "../../src/work/verifier.ts";

function v(name: string, criterion: string, result: Record<string, any>, want: "pass" | "fail", recorded = "", excerpts = ""): Case {
  return {
    id: `verifier/${name}`,
    run: () => {
      const p = verifyCriterion({ criterion, result: resultText(result), recorded, excerpts });
      return llmJson<any>("verify_criterion", p.prompt, p.schema, { maxTokens: p.maxTokens, version: p.version });
    },
    check: (o) => ({ pass: o.verdict === want, detail: `got ${o.verdict}, want ${want}: ${o.analysis}` }),
  };
}

const EMAIL = "Dear Mr. Keller,\n\nThe heating in the living room of flat 3B has stopped working. Could you please arrange a repair before winter?\n\nBest regards,\nAlex";

export const cases: Case[] = [
  v("price-present", "Names the price of an e-bike service, or states that it is not available", { summary: "Velostation Nord repairs e-bikes. An e-bike service costs CHF 149." }, "pass"),
  v("price-missing", "Names the price of an e-bike service, or states that it is not available", { summary: "Velostation Nord repairs e-bikes from Bosch, Shimano and Brose." }, "fail"),
  v("not-available-ok", "Names the water use per dripper, or states that it is not available", { summary: "The AquaLine Basic kit page lists price and coverage, but its water use is not published." }, "pass"),
  v("file-by-record", "The result includes the email text", { summary: "Wrote the email to Mr. Keller asking for the heating repair." }, "pass", "Wrote email_to_landlord.md (48 words)", `--- email_to_landlord.md ---\n${EMAIL}`),
  v("file-claimed-not-written", "The result includes the email text", { summary: "I wrote a polite email to Mr. Keller asking for the heating repair and saved it." }, "fail", "(nothing)"),
  v("recommendation-missing", "Recommends one kit and says why", { summary: "Gardena costs CHF 89.90 (15 m²), Hozelock CHF 59 (10 m²), AquaLine CHF 34.95 (8 m²).", recommendation: null }, "fail"),
  v("recommendation-present", "Recommends one kit and says why", { summary: "Gardena CHF 89.90 (15 m²), Hozelock CHF 59 (10 m²), AquaLine CHF 34.95 (8 m²).", recommendation: "Gardena: the only kit that covers all 12 m² with one set." }, "pass"),
  v("each-item-partial", "Names price and coverage of each kit", { summary: "Gardena CHF 89.90 covers 15 m². Hozelock costs CHF 59. AquaLine covers 8 m²." }, "fail"),
  v("items-list", "Lists up to 3 candidate drip kits, each with a name and one line why it fits", { summary: "Found three kits.", items: [{ name: "Gardena Micro-Drip starter set", note: "classic, extendable" }, { name: "Hozelock Easy Drip kit", note: "cheap and simple" }, { name: "AquaLine Basic kit", note: "budget option" }] }, "pass"),
];
