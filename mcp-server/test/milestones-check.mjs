#!/usr/bin/env node
/**
 * milestones check — PURE. Pins the log-spaced thresholds (10/50/100/250/+250),
 * that non-thresholds return null, the recurring-every-250 rule, and ordinals.
 */
const m = await import("../dist/milestones.js");

let failed = 0;
const ok = (msg) => console.log(`ok    ${msg}`);
const fail = (msg) => { failed++; console.error(`FAIL  ${msg}`); };
const eq = (a, b, msg) => (a === b ? ok(msg) : fail(`${msg} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`));

eq(m.milestoneFor(10), 10, "10 is a milestone");
eq(m.milestoneFor(50), 50, "50 is a milestone");
eq(m.milestoneFor(100), 100, "100 is a milestone");
eq(m.milestoneFor(250), 250, "250 is a milestone");
eq(m.milestoneFor(500), 500, "500 (every 250) is a milestone");
eq(m.milestoneFor(1000), 1000, "1000 is a milestone");
eq(m.milestoneFor(9), null, "9 is not a milestone");
eq(m.milestoneFor(11), null, "11 is not a milestone");
eq(m.milestoneFor(251), null, "251 is not a milestone");
eq(m.milestoneFor(300), null, "300 is not a milestone (not a multiple of 250 past 250)");
eq(m.milestoneFor(0), null, "0 is not a milestone");
eq(m.milestoneFor(-5), null, "negative is not a milestone");

eq(m.buildMilestone(50)?.count, 50, "buildMilestone returns the count");
const msg = m.buildMilestone(50)?.message ?? "";
eq(/50th/.test(msg), true, "message uses the 50th ordinal");
eq(m.buildMilestone(9), null, "buildMilestone(9) is null");
eq(/1,000th/.test(m.milestoneMessage(1000)), true, "milestoneMessage groups thousands and uses 'th'");
eq(/101st/.test(m.milestoneMessage(101)), true, "101 -> 101st");
eq(/111th/.test(m.milestoneMessage(111)), true, "111 -> 111th (teen rule)");

console.log(failed === 0 ? "\n=== PASS (milestones) ===" : `\n=== FAIL (${failed}) ===`);
process.exit(failed === 0 ? 0 : 1);
