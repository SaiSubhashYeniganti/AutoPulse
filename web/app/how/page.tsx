import Link from "next/link";

export const metadata = {
  title: "How Auto Pulse works",
  description: "A 2-minute read on what Auto Pulse does, how it works, and how it's built.",
};

export default function HowPage() {
  return (
    <main className="mx-auto max-w-prose px-5 sm:px-6 py-12 sm:py-16">
      <header className="border-b border-apple-300 pb-6 mb-10 animate-fade-in-up">
        <Link href="/" className="font-semibold text-[13px] text-apple-blue hover:text-apple-blueHover transition-colors">
          ← Auto Pulse
        </Link>
        <h1 className="mt-4 font-display text-4xl font-bold text-apple-800 tracking-tight">How Auto Pulse works</h1>
        <p className="mt-3 text-[16px] text-apple-500 font-sans">
          A 2-minute read on what it does, how it works, and how it's built.
        </p>
      </header>

      <article className="prose-content animate-fade-in-up stagger-1 opacity-0">
        <Section title="The problem">
          <p className="text-[16px]">
            Tracking the Indian auto market means opening 8–10 sites a day, mentally
            deduping the same story re-syndicated five times, and translating generic
            headlines into <em>"does this affect us?"</em>. That's 30–45 minutes of
            mental work, every day, before a single decision is made.
          </p>
        </Section>

        <Section title="What Auto Pulse does">
          <p className="text-[16px]">
            One page, refreshed every two hours. The 4–6 stories from the Indian auto
            market that actually matter today, each with a one-line read on what it
            means for Cars24. A separate Cars24 tab for press about Cars24 itself.
            A Competitors tab to track each major player week-by-week and
            quarter-by-quarter.
          </p>
          <p className="text-[16px] mt-4">
            Read in 2 minutes. Close the tab.
          </p>
        </Section>

        <Section title="How it works (in plain English)">
          <Step
            n={1}
            title="Ingest"
            body="Every 2 hours we pull the latest articles from 10 sources — trade press RSS feeds plus Google News queries scoped to each competitor and topic. Duplicate URLs are skipped."
          />
          <Step
            n={2}
            title="Classify"
            body="GPT-4o reads each new article and decides how important it is (HIGH / MEDIUM / LOW / DROP), which companies it's about, and whether there's a specific implication for Cars24. Noise — motorsport, generic listicles, our own outbound PR — is dropped here."
          />
          <Step
            n={3}
            title="Cluster"
            body="When 12 outlets cover the same event, we treat it as one story. Each article is converted into a vector fingerprint, matched against existing clusters of the same competitor in a tight time window, and GPT-4o makes the final call on whether to attach or start a new cluster."
          />
          <Step
            n={4}
            title="Synthesize"
            body="For each cluster, GPT-4o reads every member article and writes one editorial story — title, 3-sentence summary, sources linked, and the 'so what for Cars24?' line (suppressed when there's nothing genuine to say)."
          />
          <Step
            n={5}
            title="Compose the brief"
            body="Once a day at 06:05 IST we pick the stories worth surfacing, decide the time window (24h, widening to 48h or 72h on quiet days), and cache the result. Every page load reads from that cached row."
          />
        </Section>

        <Section title="How it's built">
          <table className="w-full text-[15px] text-apple-500 border-collapse">
            <tbody>
              <Row label="Frontend"   value="Next.js web app on Vercel. Auto-deploys from GitHub." />
              <Row label="Backend"    value="Supabase Edge Functions — 7 small TypeScript services, ~2,400 lines total." />
              <Row label="Database"   value="Supabase Postgres with pgvector for similarity search. 7 tables." />
              <Row label="Models"     value="GPT-4o for classification & synthesis. text-embedding-3-small for clustering." />
              <Row label="Scheduling" value="pg_cron inside Supabase. Pipeline every 2h; brief at 06:05 IST." />
              <Row label="Cost"       value="Under $2/month in OpenAI usage. Vercel + Supabase on free tiers." />
            </tbody>
          </table>
        </Section>

        <Section title="What it's not">
          <ul className="space-y-3 text-[16px] text-apple-500 font-sans list-disc pl-5 marker:text-apple-400">
            <li>Not an aggregator. It's an opinionated edit — most ingested articles never surface.</li>
            <li>No accounts, no personalization, no email digest. One URL, anyone with the link can read.</li>
            <li>No mobile app. Web is the right shape for a one-page brief.</li>
            <li>No padding. If today is genuinely quiet, the brief says so.</li>
          </ul>
        </Section>

        <p className="mt-16 text-[14px] font-medium">
          <Link href="/" className="text-apple-blue hover:text-apple-blueHover transition-colors">← Back to today's pulse</Link>
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

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="mt-6 first:mt-0 flex gap-5">
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-apple-100 text-apple-800 font-mono text-[13px] font-bold flex items-center justify-center mt-0.5">
        {n}
      </div>
      <div className="flex-1">
        <h3 className="font-display text-[17px] font-bold text-apple-800 tracking-tight">{title}</h3>
        <p className="mt-1.5 text-[15px] leading-relaxed text-apple-500 font-sans">{body}</p>
      </div>
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
