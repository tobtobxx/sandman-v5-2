// Triage (§5.5): does a task fit one session? Is information missing? Uses the real triage step.

import { Case } from "../lib.ts";
import { createCard } from "../../src/work/board.ts";
import { triageDecide } from "../../src/work/preflight.ts";

// Only the triage decision (no planner afterwards), so each case costs one call.
function tri(name: string, title: string, goal: string, done_when: string[], want: "yes" | "no" | "missing", role = "research"): Case {
  return {
    id: `triage/${name}`,
    run: () => triageDecide(createCard({ title, goal, done_when, role })),
    check: (o) => {
      const missing = !!o.missing_info;
      const got = missing ? "missing" : o.fits;
      return { pass: got === want, detail: `got ${got}${missing ? ` ("${o.missing_info}")` : ""}, want ${want}. ${o.analysis}` };
    },
  };
}

export const cases: Case[] = [
  tri("simple-lookup", "Library opening hours", "Find the opening hours of the city library.", ["Names the opening hours for each day"], "yes"),
  tri("lookup-two-facts", "E-bike repair at Velostation Nord", "Find out whether Velostation Nord repairs e-bikes and what an e-bike service costs.", ["States whether they repair e-bikes", "Names the price, or states that it is not available"], "yes"),
  tri("deadline-lookup", "Tax extension deadline", "Find until when a private person in the canton of Zurich can request a free tax return extension.", ["Names the deadline"], "yes"),
  tri("compare-four", "Compare health insurers", "Compare the 4 biggest Swiss health insurers on customer satisfaction ratings and recommend one.", ["Names a satisfaction rating for each insurer", "Recommends one"], "no"),
  tri("compare-three-named", "Compare drip kits", "Compare the Gardena Micro-Drip, Hozelock Easy Drip and AquaLine Basic drip kits on price and coverage for 3 raised beds of 4 m² each, and recommend one.", ["Names price and coverage of each kit", "Recommends one kit and says why"], "no"),
  tri("big-trip-plan", "Plan Portugal trip", "Plan a 10-day trip through Portugal in October with hotels, trains and a day-by-day itinerary.", ["Includes a day-by-day plan", "Names a hotel for each night"], "no"),
  tri("missing-date-place", "Book birthday dinner", "Book a table for my birthday dinner.", ["Names the restaurant and time"], "missing"),
  tri("write-enough-info", "Email to landlord", "Write an email to my landlord, Mr. Keller, asking him to repair the heating in the living room before winter.", ["The result includes the email text"], "yes", "write"),
  tri("write-missing-info", "Letter to insurance", "Write a letter to my insurance about my claim.", ["The result includes the letter text"], "missing", "write"),
];

