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
            The brief is generated every morning. First brief should appear after the next scheduled run.
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
      todayLabel="Today"
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
      />

      <div className="mt-12 animate-fade-in-up stagger-1 opacity-0">
        <FeedTabs
          marketCount={heroMarket.length}
          cars24Count={heroCars24.length}
          marketPane={marketPane}
          cars24Pane={cars24Pane}
        />
      </div>

      <Footer />
    </main>
  );
}


// ─── Header ────────────────────────────────────────────────────────────────────

function Header({
  date,
  generatedAt,
}: {
  date?: string;
  generatedAt?: string;
}) {
  return (
    <header className="mt-8 mb-4 animate-fade-in-up">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <p className="font-sans text-[12px] font-bold tracking-widest text-apple-400 uppercase">
            Auto Pulse
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
              Updated {formatTime(generatedAt)} IST
            </p>
          </div>
        )}
      </div>
    </header>
  );
}

// ─── Footer ────────────────────────────────────────────────────────────────────

function Footer() {
  return (
    <footer className="mt-24 border-t border-apple-300 pt-8 pb-16 animate-fade-in-up stagger-4 opacity-0">
      <div className="text-[13px] font-medium font-sans">
        <Link href="/how" className="text-apple-blue hover:text-apple-blueHover transition-colors">
          How Auto Pulse works
        </Link>
      </div>
    </footer>
  );
}
