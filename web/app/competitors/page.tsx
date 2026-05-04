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

  const ranked = [...COMPETITORS].sort((a, b) => {
    const diff = (counts[b] ?? 0) - (counts[a] ?? 0);
    if (diff !== 0) return diff;
    return a.localeCompare(b);
  });

  const selected = (searchParams?.c && ranked.includes(searchParams.c))
    ? searchParams.c
    : (ranked[0] ?? "Spinny");

  const dataMap: Record<string, any> = {};

  await Promise.all(
    ranked.map(async (c) => {
      const [stories, weekly, quarterly] = await Promise.all([
        getStoriesByCompetitor(c, 90),
        getCompetitorSummary(c, "week"),
        getCompetitorSummary(c, "quarter"),
      ]);
      
      const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
      dataMap[c] = {
        thisWeek: stories.filter((s) => new Date(s.published_at).getTime() >= cutoff7d),
        archive: stories.filter((s) => new Date(s.published_at).getTime() < cutoff7d),
        weekly,
        quarterly,
        totalCount: stories.length,
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
