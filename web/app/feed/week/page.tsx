import Link from "next/link";
import { getFeedStories, type Story } from "@/lib/supabase";
import { Nav } from "@/components/Nav";
import { StoryRow } from "@/components/StoryRow";

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams?: { tab?: string };
}

export default async function WeekPage({ searchParams }: PageProps) {
  const tab = searchParams?.tab === "cars24" ? "cars24" : "market";

  const [marketStories, cars24Stories] = await Promise.all([
    getFeedStories({
      days: 7,
      buckets: ["MARKET", "COMPETITOR"],
      importance: ["HIGH", "MED", "LOW"],
      excludeBackfill: false,
    }),
    getFeedStories({
      days: 90,
      buckets: ["CARS24_PRESS", "CARS24_PR"],
      importance: ["HIGH", "MED", "LOW"],
      excludeBackfill: false,
    }),
  ]);

  const visible = tab === "cars24" ? cars24Stories : marketStories;
  const grouped = groupByDay(visible);

  return (
    <main className="mx-auto max-w-3xl px-5 sm:px-6 py-12">
      <Nav active="feed" />

      <header className="mb-10 animate-fade-in-up">
        <Link href="/" className="text-[13px] font-semibold text-apple-blue hover:text-apple-blueHover transition-colors">
          ← back to today's brief
        </Link>
        <h1 className="mt-4 font-display text-4xl font-bold text-apple-800 tracking-tight">
          {tab === "cars24" ? "Cars24 — last 90 days" : "Market & Competitors — last 7 days"}
        </h1>
        <p className="mt-2 text-[16px] text-apple-500 font-sans">
          The full archive. Includes all items omitted from the curated brief.
        </p>
      </header>

      <div className="flex items-center gap-6 border-b border-apple-300 mb-10 px-2 animate-fade-in-up stagger-1 opacity-0">
        <SubTabLink href="/feed/week?tab=market" isActive={tab === "market"} label="Market & Competitors" count={marketStories.length} />
        <SubTabLink href="/feed/week?tab=cars24" isActive={tab === "cars24"} label="Cars24" count={cars24Stories.length} />
      </div>

      {visible.length === 0 ? (
        <p className="text-[15px] text-apple-500 py-6 font-sans animate-fade-in-up stagger-2 opacity-0">
          Nothing in this window yet.
        </p>
      ) : (
        <div className="space-y-12 animate-fade-in-up stagger-2 opacity-0">
          {grouped.map(({ day, items }) => (
            <section key={day}>
              <h2 className="font-display text-[18px] font-bold text-apple-800 border-b border-apple-300 pb-3 mb-6">
                {day} <span className="font-mono text-[13px] text-apple-500 ml-2 bg-apple-100 px-2 py-0.5 rounded-full">{items.length}</span>
              </h2>
              <div>
                {items.map((s) => (
                  <StoryRow
                    key={s.id}
                    story={{
                      ...s,
                      story_id: s.id,
                    }}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}

function SubTabLink({
  href,
  isActive,
  label,
  count,
}: {
  href: string;
  isActive: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      className={
        "py-3 text-[15px] flex items-center gap-2 border-b-2 -mb-[1px] transition-all outline-none font-semibold " +
        (isActive
          ? "border-apple-800 text-apple-800"
          : "border-transparent text-apple-400 hover:text-apple-800")
      }
    >
      <span>{label}</span>
      <span className={"font-mono text-[12px] px-2 py-0.5 rounded-full " + (isActive ? "bg-apple-200 text-apple-800" : "bg-apple-100 text-apple-400")}>{count}</span>
    </Link>
  );
}

function groupByDay(stories: Story[]): Array<{ day: string; items: Story[] }> {
  const byDay = new Map<string, Story[]>();
  for (const s of stories) {
    const day = new Date(s.published_at).toLocaleDateString("en-IN", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    const arr = byDay.get(day) ?? [];
    arr.push(s);
    byDay.set(day, arr);
  }
  return Array.from(byDay.entries()).map(([day, items]) => ({ day, items }));
}
