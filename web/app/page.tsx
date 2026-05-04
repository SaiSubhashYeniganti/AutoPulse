import Link from "next/link";
import { getLatestBrief, getYesterdayBrief, type HeroStory } from "@/lib/supabase";
import { Nav } from "@/components/Nav";
import { FeedTabs } from "@/components/FeedTabs";
import { TimeSegmentControl } from "@/components/TimeSegmentControl";

export const dynamic = "force-dynamic";

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatTime(d: string): string {
  return new Date(d).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

export default async function Page() {
  const today = await getLatestBrief();
  const yesterday = today ? await getYesterdayBrief(today.brief_date) : null;

  if (!today) {
    return (
      <main className="mx-auto max-w-prose px-5 sm:px-6 py-12">
        <Nav active="feed" />
        <Header />
        <div className="mt-12 p-10 text-center animate-fade-in-up border-b border-t border-apple-100">
          <p className="font-display text-2xl text-apple-800 font-semibold">No brief yet.</p>
          <p className="mt-3 text-sm text-apple-500 font-sans">
            The pipeline runs every 2 hours. First brief should appear within 30 minutes of deploy.
          </p>
        </div>
        <Footer />
      </main>
    );
  }

  const heroMarket = today.hero_stories ?? [];
  const heroCars24 = today.hero_cars24 ?? [];
  const weeklyMarket = today.weekly_recap ?? [];
  const weeklyCars24 = today.weekly_cars24 ?? [];

  const yesterdayHero = yesterday?.hero_stories ?? [];

  const marketPane = (
    <TimeSegmentControl
      todayLabel={
        today.is_quiet_day && today.quiet_day_note
          ? `Today — ${today.quiet_day_note}`
          : "Today"
      }
      todayStories={heroMarket}
      weeklyStories={weeklyMarket}
      yesterdayStories={yesterdayHero}
      yesterdayDate={yesterday?.brief_date ?? null}
      seeAllHref="/feed/week?tab=market"
    />
  );

  const cars24Pane = (
    <TimeSegmentControl
      todayLabel="Recent Cars24 mentions"
      todayStories={heroCars24}
      weeklyStories={weeklyCars24}
      weeklyLabel="Earlier in the last 14 days"
      yesterdayStories={[]}
      yesterdayDate={null}
      seeAllHref="/feed/week?tab=cars24"
    />
  );

  return (
    <main className="mx-auto max-w-prose px-5 sm:px-6 py-12">
      <Nav active="feed" />
      <Header
        date={today.brief_date}
        generatedAt={today.generated_at}
        windowHours={today.window_hours}
        isQuietDay={today.is_quiet_day}
        quietNote={today.quiet_day_note}
      />

      <div className="mt-12 animate-fade-in-up stagger-1 opacity-0">
        <FeedTabs
          marketCount={heroMarket.length}
          cars24Count={heroCars24.length}
          marketPane={marketPane}
          cars24Pane={cars24Pane}
        />
      </div>

      <Footer
        cost={today.ai_cost_usd}
        totalStories={today.total_stories_in_window}
        generatedAt={today.generated_at}
      />
    </main>
  );
}


// ─── Header ────────────────────────────────────────────────────────────────────

function Header({
  date,
  generatedAt,
  windowHours,
  isQuietDay,
  quietNote,
}: {
  date?: string;
  generatedAt?: string;
  windowHours?: number;
  isQuietDay?: boolean;
  quietNote?: string | null;
}) {
  return (
    <header className="mt-8 mb-4 animate-fade-in-up">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <p className="font-sans text-[12px] font-bold tracking-widest text-apple-400 uppercase">
            Cars24 Brief
          </p>
          {date && (
            <h1 className="mt-2 font-display text-4xl sm:text-5xl font-bold text-apple-800 tracking-tight">
              {formatDate(date)}
            </h1>
          )}
        </div>
        {generatedAt && (
          <div className="text-left sm:text-right">
            <p className="text-[12px] font-medium text-apple-400">
              Generated {formatTime(generatedAt)} IST
              {windowHours && windowHours > 24 && (
                <span className="block mt-0.5 text-apple-500">Window: {windowHours}h</span>
              )}
            </p>
          </div>
        )}
      </div>
      {isQuietDay && quietNote && (
        <p className="mt-4 text-[15px] text-apple-500 font-sans">{quietNote}</p>
      )}
    </header>
  );
}

// ─── Footer ────────────────────────────────────────────────────────────────────

function Footer({
  cost,
  totalStories,
  generatedAt,
}: {
  cost?: number | null;
  totalStories?: number;
  generatedAt?: string;
}) {
  return (
    <footer className="mt-24 border-t border-apple-300 pt-8 pb-16 animate-fade-in-up stagger-4 opacity-0">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] font-medium text-apple-500 font-sans">
        {typeof cost === "number" && cost > 0 && (
          <>
            <span className="font-mono text-[12px]">Cost: ${cost.toFixed(3)}</span>
            <span className="text-apple-300" aria-hidden>|</span>
          </>
        )}
        {typeof totalStories === "number" && (
          <>
            <span>{totalStories} stor{totalStories === 1 ? "y" : "ies"} in window</span>
            <span className="text-apple-300" aria-hidden>|</span>
          </>
        )}
        <Link href="/how" className="text-apple-blue hover:text-apple-blueHover transition-colors">
          How this works
        </Link>
      </div>
      {generatedAt && (
        <p className="mt-4 font-mono text-[11px] text-apple-400">
          Last refresh: {new Date(generatedAt).toISOString()}
        </p>
      )}
    </footer>
  );
}
