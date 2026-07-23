// One-off generator for the two PDF corpus files. Content is kept factually
// consistent with the txt/json docs so multi-hop and grounding are testable.
// pdfkit is a devDependency and is never imported by the app.
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import PDFDocument from "pdfkit";

const OUT = "corpus";

function write(name: string, build: (doc: PDFKit.PDFDocument) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 56, size: "A4" });
    const stream = createWriteStream(join(OUT, name));
    doc.pipe(stream);
    build(doc);
    doc.end();
    stream.on("finish", () => resolve());
    stream.on("error", reject);
  });
}

const h1 = (d: PDFKit.PDFDocument, t: string) =>
  d.font("Helvetica-Bold").fontSize(18).text(t).moveDown(0.6);
const h2 = (d: PDFKit.PDFDocument, t: string) =>
  d.font("Helvetica-Bold").fontSize(13).text(t).moveDown(0.3);
const p = (d: PDFKit.PDFDocument, t: string) =>
  d.font("Helvetica").fontSize(11).text(t, { align: "left" }).moveDown(0.5);
const row = (d: PDFKit.PDFDocument, cells: string[], widths: number[]) => {
  const y = d.y;
  let x = d.x;
  d.font("Helvetica").fontSize(10);
  cells.forEach((c, i) => {
    d.text(c, x, y, { width: widths[i] - 6 });
    x += widths[i];
  });
  d.moveDown(0.4);
};

async function main() {
  await write("curriculum_handbook.pdf", (d) => {
    h1(d, "Scaler Academy — Program Handbook (2026)");
    p(d, "This handbook describes the structure of the Software Development and System Design program. The program runs for 15 months of live, instructor-led classes delivered online on weekends and two weekday evenings.");
    h2(d, "Learning Outcomes");
    p(d, "By the end of the program a learner can design and implement data structures and algorithms, build scalable backend systems, reason about distributed system trade-offs, and clear technical interviews at product companies.");
    h2(d, "Attendance and Certification");
    p(d, "A verified certificate of completion is awarded to learners who maintain at least 80% attendance, clear every module assessment, and submit the capstone project. Attendance is tracked automatically from live-class join logs.");

    d.addPage();
    h2(d, "Module Breakdown");
    p(d, "The curriculum is organised into six modules delivered over 15 months. The table below summarises the sequence.");
    row(d, ["Module", "Weeks", "Focus"], [140, 70, 260]);
    row(d, ["Foundations of Programming", "1-6", "Language mastery, complexity analysis"], [140, 70, 260]);
    row(d, ["Data Structures & Algorithms", "7-22", "Arrays, trees, graphs, dynamic programming"], [140, 70, 260]);
    row(d, ["Low-Level Design", "23-30", "OOP, design patterns, concurrency"], [140, 70, 260]);
    row(d, ["High-Level & System Design", "31-44", "Scalability, caching, databases, queues"], [140, 70, 260]);
    row(d, ["Specialisation Elective", "45-52", "Backend, Android, or Frontend depth"], [140, 70, 260]);
    row(d, ["Capstone Project", "53-60", "End-to-end system, reviewed by mentors"], [140, 70, 260]);

    d.addPage();
    h2(d, "Capstone Project");
    p(d, "The capstone is a graded, individual project built over the final eight weeks. Learners design and ship a production-style system, defend their architecture in a review, and receive written feedback. Passing the capstone is mandatory for both certification and placement eligibility.");
    h2(d, "Mentorship");
    p(d, "Each learner is paired with an industry mentor for fortnightly one-on-one sessions covering progress, doubts, and interview readiness. Mentors are senior engineers from product companies.");
  });

  await write("placement_report.pdf", (d) => {
    h1(d, "Scaler — Placement & Outcomes Report (2025 Cohort)");
    p(d, "This report summarises placement outcomes for learners of the 2025 graduating cohort who were eligible for career services. Eligibility requires program completion with at least 80% attendance and a cleared capstone project.");
    h2(d, "Headline Numbers");
    p(d, "Median CTC: Rs. 24.5 lakh per annum. Highest CTC: Rs. 1.1 crore per annum. Average hike over previous salary: 105%. Share of eligible learners placed within six months: 84%.");

    d.addPage();
    h2(d, "Top Recruiters");
    p(d, "The table below lists representative hiring partners and the roles offered.");
    row(d, ["Company", "Roles", "Offers"], [180, 200, 90]);
    row(d, ["Amazon", "SDE-1, SDE-2", "38"], [180, 200, 90]);
    row(d, ["Flipkart", "Software Engineer", "27"], [180, 200, 90]);
    row(d, ["Uber", "Backend Engineer", "12"], [180, 200, 90]);
    row(d, ["Swiggy", "SDE, SRE", "19"], [180, 200, 90]);
    row(d, ["Atlassian", "Full-Stack Engineer", "9"], [180, 200, 90]);

    d.addPage();
    h2(d, "How Placement Support Works");
    p(d, "Career services include mock interviews, resume reviews, and referrals to hiring partners. Support is available for 12 months after program completion. Placement is not guaranteed; outcomes depend on individual performance in employer interviews.");
    h2(d, "Eligibility Recap");
    p(d, "Learners who withdraw, defer, or fall below the attendance threshold forfeit placement eligibility for their cohort. Eligibility can be regained by completing the program with a later cohort.");
  });

  console.log("wrote corpus/curriculum_handbook.pdf and corpus/placement_report.pdf");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
