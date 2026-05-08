import {
  getCompetitorCounts90d,
  getCompetitorSummary,
  getStoriesByCompetitor,
} from "@/lib/supabase";
import { Nav } from "@/components/Nav";
import { CompetitorsClient } from "./CompetitorsClient";

export const dynamic = "force-dynamic";

const COMPETITORS = [
  "Cars24",
  "Spinny",
  "CarDekho",
  "Droom",
  "OLX Autos",
];

interface PageProps {
  searchParams?: { c?: string };
}

export default async function CompetitorsPage({ searchParams }: PageProps) {
  const counts = await getCompetitorCounts90d();

  // Cars24 is always pinned at the bottom of the rail — it's "us, not them."
  // Competitors above are sorted by 90-day story volume (most active first),
  // which is what the reader wants to scan.
  const competitorsOnly = COMPETITORS.filter((c) => c !== "Cars24").sort((a, b) => {
    const diff = (counts[b] ?? 0) - (counts[a] ?? 0);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });
  const ranked = [...competitorsOnly, "Cars24"];

  const selected = (searchParams?.c && ranked.includes(searchParams.c))
    ? searchParams.c
    : (competitorsOnly[0] ?? "Spinny");

  const dataMap: Record<string, any> = {};

  await Promise.all(
    ranked.map(async (c) => {
      const [stories, weekly, quarterly] = await Promise.all([
        getStoriesByCompetitor(c, 90),
        getCompetitorSummary(c, "week"),
        getCompetitorSummary(c, "quarter"),
      ]);
      
      const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
      // Build a story_id → source URL map so the quarterly event ledger can
      // link each event back to its primary source article. Cheaper than a
      // second fetch keyed on the event ids on the client.
      const storyLinks: Record<string, { url: string | null; source: string | null; title: string }> = {};
      for (const s of stories) {
        storyLinks[s.id] = {
          url: s.primary_source_url ?? null,
          source: s.primary_source_name ?? null,
          title: s.title,
        };
      }
      dataMap[c] = {
        thisWeek: stories.filter((s) => new Date(s.published_at).getTime() >= cutoff7d),
        archive: stories.filter((s) => new Date(s.published_at).getTime() < cutoff7d),
        weekly,
        quarterly,
        totalCount: stories.length,
        storyLinks,
      };
    })
  );

  return (
    <main className="mx-auto max-w-6xl px-5 sm:px-6 py-12">
      <Nav active="competitors" />

      <header className="mb-10 animate-fade-in-up">
        <h1 className="font-display text-4xl font-bold text-apple-800 tracking-tight">Competitors</h1>
        <p className="mt-2 text-[16px] text-apple-500 font-sans">
          Per-competitor strategic view. Pick one on the left.
        </p>
      </header>

      <CompetitorsClient 
        ranked={ranked} 
        counts={counts} 
        initialSelected={selected} 
        dataMap={dataMap} 
      />
    </main>
  );
}
