import Link from "next/link";

interface NavProps {
  active: "feed" | "competitors";
}

export function Nav({ active }: NavProps) {
  return (
    <nav className="mb-10 mt-2">
      <div className="flex items-center gap-8 text-[14px] font-semibold tracking-wide">
        <Link
          href="/"
          className={
            "transition-colors " +
            (active === "feed"
              ? "text-apple-800 border-b-2 border-apple-800 pb-1"
              : "text-apple-400 hover:text-apple-800 pb-1 border-b-2 border-transparent")
          }
        >
          Feed
        </Link>
        <Link
          href="/competitors"
          className={
            "transition-colors " +
            (active === "competitors"
              ? "text-apple-800 border-b-2 border-apple-800 pb-1"
              : "text-apple-400 hover:text-apple-800 pb-1 border-b-2 border-transparent")
          }
        >
          Competitors
        </Link>
      </div>
    </nav>
  );
}
