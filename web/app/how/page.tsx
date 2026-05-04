import Link from "next/link";

export const metadata = {
  title: "How this works — Cars24 Brief",
  description: "Architecture and design decisions behind the Cars24 daily brief.",
};

export default function HowPage() {
  return (
    <main className="mx-auto max-w-prose px-5 sm:px-6 py-12 sm:py-16">
      <header className="border-b border-apple-300 pb-6 mb-10 animate-fade-in-up">
        <Link href="/" className="font-semibold text-[13px] text-apple-blue hover:text-apple-blueHover transition-colors">
          ← Cars24 Brief
        </Link>
        <h1 className="mt-4 font-display text-4xl font-bold text-apple-800 tracking-tight">How this works</h1>
        <p className="mt-3 text-[16px] text-apple-500 font-sans">
          Architecture, design decisions, and what's deliberately out of scope.
        </p>
      </header>

      <article className="prose-content animate-fade-in-up stagger-1 opacity-0">
        <Section title="The product in one paragraph">
          <p className="text-[16px]">
            Every day this site assembles a 1-page brief on the Indian used-car market and Cars24's competitors —
            ingested from 10 sources, deduplicated into stories, and synthesized into editorial cards with a
            "what this means for Cars24" callout. Built to be read in under two minutes by the leadership team
            with morning coffee.
          </p>
        </Section>

        <Section title="Architecture">
          <Diagram />

          <p className="mt-8 text-[16px]">
            The pipeline runs end-to-end every 2 hours via Supabase pg_cron. The brief is regenerated and
            cached as a single row in <code className="font-mono text-[14px] bg-apple-200 text-apple-800 px-1.5 py-0.5 rounded">daily_briefs</code> at 06:00 IST daily. The website reads
            from that row, so a page load is a single Postgres lookup.
          </p>
        </Section>

        <Section title="Five design decisions worth talking about">
          <DesignDecision
            title="Embeddings as a candidate filter, LLM as the final clusterer"
          >
            Pure-LLM clustering doesn't scale beyond ~12 active clusters per call (token limits + reasoning quality
            collapse). Pure-embedding clustering overfits — every article about "used cars India" ends up looking
            similar; the model can tell two events apart that share vocabulary, embeddings can't.
            <br /><br />
            The hybrid pattern: embed each new article, fetch the 5 cosine-closest existing clusters via pgvector,
            send those candidates + the article to GPT-4o, ask it to pick one or create a new cluster. Scales to
            thousands of clusters; precision stays high because the LLM only sees 5 candidates at a time.
          </DesignDecision>

          <DesignDecision
            title="Single-axis importance, with a per-article Cars24 implication"
          >
            The classifier rates each article on one HIGH/MED/LOW/DROP axis instead of two-axis (impact × Cars24
            relevance). Two-axis is harder for an LLM to keep consistent across hundreds of articles. The
            relevance signal is captured separately, in prose, as the <code className="font-mono text-[14px] bg-apple-200 text-apple-800 px-1.5 py-0.5 rounded">cars24_implication</code> field —
            free text instead of an enum. This is what shows up in italic under each story.
          </DesignDecision>

          <DesignDecision
            title="Synthesis everywhere — never raw lists"
          >
            The hero stories, the per-competitor weekly view, and the per-competitor quarterly view are ALL
            AI-synthesized. The whole product promise is "AI does the synthesis so the reader doesn't have to."
            The moment you show a raw list of headlines, you've broken that promise.
            <br /><br />
            Quarterly summaries use hierarchical summarization (12 weekly summaries → quarterly arcs) instead of
            cramming 90 days of stories into one prompt. Avoids context-window blowup and produces tighter output.
          </DesignDecision>

          <DesignDecision
            title="Quiet-day fallback widens the window automatically"
          >
            Indian auto news doesn't fire 24/7 the way crypto does. On thin days the brief honestly says "Quiet
            last 24 hours — showing the last 48" instead of padding with low-value stories. The window expands
            from 24h → 48h → 72h until we hit 3 HIGH/MED stories, then stops.
            <br /><br />
            The brief is allowed to say "nothing happened today." That preserves the signal.
          </DesignDecision>

          <DesignDecision
            title="Google News RSS for competitor watching, not blog scraping"
          >
            Spinny / CarDekho / Droom / OLX blogs are SEO content with marketing tone — not where you find
            "Spinny raised $283M" or "CarDekho cut 200 jobs." Google News surfaces real press coverage from
            ET Auto, Mint, MoneyControl, etc. — the outlets that actually break business news.
            <br /><br />
            6 of the 10 sources are Google News queries (one per competitor + topic queries for "used cars India"
            and "car depreciation India"). The remaining 4 are direct trade-press RSS for general industry coverage.
          </DesignDecision>
        </Section>

        <Section title="Out of scope (deliberately)">
          <ul className="space-y-5 text-[15px] text-apple-500 font-sans">
            <li>
              <strong className="text-apple-800 block font-display text-[17px] mb-1 font-bold">Auth, accounts, preferences.</strong> A public URL is right for a leadership read.
              For an internal tool used by 100 people, you'd want per-user dashboards.
            </li>
            <li>
              <strong className="text-apple-800 block font-display text-[17px] mb-1 font-bold">Mobile app.</strong> Web is the right form factor for a 1-pager. Native mobile would
              add no value for the use case.
            </li>
            <li>
              <strong className="text-apple-800 block font-display text-[17px] mb-1 font-bold">Search, filters, multi-day archive.</strong> Feature creep for the brief; required for
              an internal tool.
            </li>
            <li>
              <strong className="text-apple-800 block font-display text-[17px] mb-1 font-bold">Push notifications.</strong> The brief is morning-coffee territory. Push would feel like
              spam unless gated to HIGH-only — and HIGH events fire at most a few times a week.
            </li>
            <li>
              <strong className="text-apple-800 block font-display text-[17px] mb-1 font-bold">A/B prompt evaluation.</strong> Every prompt change ships to 100% with no holdout test.
              For production this would be a labelled gold-set + regression suite.
            </li>
            <li>
              <strong className="text-apple-800 block font-display text-[17px] mb-1 font-bold">Editorial feedback loop.</strong> No way for a human reviewer to mark "this cluster was
              wrong, split it" and have the system learn. Would matter once a team starts using it daily.
            </li>
            <li>
              <strong className="text-apple-800 block font-display text-[17px] mb-1 font-bold">Nightly cluster QA pass.</strong> Clusters are decided online and never revisited.
              A nightly recompute would catch drift.
            </li>
          </ul>
        </Section>

        <Section title="Stack">
          <table className="w-full text-[15px] text-apple-500 border-collapse">
            <tbody>
              <Row label="Frontend"   value="Next.js 14 (App Router) on Vercel · React Server Components · Tailwind · TypeScript" />
              <Row label="Database"   value="Supabase Postgres + pgvector (1536-dim cosine, ivfflat index)" />
              <Row label="Backend"    value="Supabase Edge Functions (Deno + TypeScript) · 8 functions · ~2,700 LOC" />
              <Row label="LLM"        value="gpt-4o for classification, routing, synthesis · gpt-4o-mini for pulse context lines · text-embedding-3-small" />
              <Row label="Scheduling" value="pg_cron inside Supabase (every 2h pipeline run + daily 06:00 IST brief)" />
            </tbody>
          </table>
        </Section>

        <p className="mt-16 text-[14px] font-medium">
          <Link href="/" className="text-apple-blue hover:text-apple-blueHover transition-colors">← Back to today's brief</Link>
        </p>
      </article>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-16 first:mt-0">
      <h2 className="font-display text-2xl font-bold text-apple-800 mb-6 tracking-tight">{title}</h2>
      <div className="text-[16px] leading-relaxed text-apple-500 font-sans space-y-4">{children}</div>
    </section>
  );
}

function DesignDecision({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-8 first:mt-0 py-6 border-b border-apple-100">
      <h3 className="font-display text-[19px] font-bold text-apple-800 tracking-tight">{title}</h3>
      <p className="mt-3 text-[15px] leading-relaxed text-apple-500 font-sans">{children}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-b border-apple-200 last:border-b-0">
      <td className="py-4 pr-4 align-top font-bold text-apple-800 w-32 font-display">{label}</td>
      <td className="py-4 align-top leading-relaxed">{value}</td>
    </tr>
  );
}

function Diagram() {
  return (
    <pre className="mt-4 overflow-x-auto py-6 text-[13px] leading-relaxed font-mono text-apple-500 border-b border-apple-100">
{`  10 RSS / Google News sources
        │
        ▼
  rss-ingest          ────►  articles                (raw, deduped by URL)
        │
        ▼
  classify-articles   ────►  + importance,
   gpt-4o                     entities,
                              cars24_implication
        │
        ▼
  route-articles      ────►  + embedding (1536-dim,
   embed → cosine top-5         text-embedding-3-small)
   → gpt-4o decides             cluster_id
                                ▼
                              clusters               (groups of articles
                                                      about the same event)
        │
        ▼
  synthesize-stories  ────►  stories                 (one per cluster:
   gpt-4o                                              title, summary,
                                                       cars24_implication,
                                                       importance)
        │
        ├────►  generate-daily-brief        ────►  daily_briefs
        │       (hero + competitor pulse,
        │        24h→48h→72h fallback)
        │
        └────►  generate-competitor-summary ────►  competitor_summaries
                (week + quarter, hierarchical)
`}
    </pre>
  );
}
